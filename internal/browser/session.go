package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	cdpbrowser "github.com/chromedp/cdproto/browser"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

type Element struct {
	Ref   string `json:"ref"`
	Tag   string `json:"tag"`
	Label string `json:"label"`
	Href  string `json:"href,omitempty"`
}

type Inspection struct {
	URL      string    `json:"url"`
	Title    string    `json:"title"`
	Text     string    `json:"text"`
	Elements []Element `json:"elements"`
}

type Session struct {
	parent context.Context
	stop   context.CancelFunc
	dial   dialBrowser
	mu     sync.Mutex
	tab    context.Context
	clean  func()
	world  runtime.ExecutionContextID
	serial uint64
	last   Inspection
}

func NewSession(parent context.Context) *Session {
	return newSession(parent, dialPublic)
}

func newSession(parent context.Context, dial dialBrowser) *Session {
	ctx, stop := context.WithCancel(parent)
	return &Session{parent: ctx, stop: stop, dial: dial}
}

func (s *Session) Close() {
	s.stop()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clean != nil {
		s.clean()
		s.clean = nil
	}
}

func (s *Session) start(call context.Context) error {
	if s.tab != nil {
		return nil
	}
	life, cancel := context.WithCancel(s.parent)
	proxy, err := startProxy(life, s.dial)
	if err != nil {
		cancel()
		return err
	}
	opts := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	opts = append(opts,
		chromedp.ProxyServer("http://"+proxy),
		chromedp.Flag("proxy-bypass-list", "<-loopback>"),
		chromedp.Flag("disable-quic", true),
		chromedp.Flag("disable-popup-blocking", false),
		chromedp.Flag("force-webrtc-ip-handling-policy", "disable_non_proxied_udp"),
		chromedp.Flag("webrtc-ip-handling-policy", "disable_non_proxied_udp"),
		chromedp.Flag("use-mock-keychain", true),
		chromedp.Flag("password-store", "basic"),
		chromedp.WindowSize(1240, 800),
	)
	alloc, cleanup := chromedp.NewExecAllocator(life, opts...)
	tab, closeTab := chromedp.NewContext(alloc)
	closeAll := func() {
		cancel()
		closeTab()
		cleanup()
	}
	stopStartup := context.AfterFunc(call, cancel)
	_, err = chromedp.Run(tab, func(ctx context.Context, _ *chromedp.Target) (cdp.Empty, error) {
		return cdp.Call(ctx, chromedp.FromContext(ctx).Browser, cdpbrowser.SetDownloadBehavior,
			cdpbrowser.SetDownloadBehaviorParams{Behavior: cdpbrowser.SetDownloadBehaviorBehaviorDeny})
	})
	stopStartup()
	if err != nil {
		closeAll()
		return fmt.Errorf("start isolated Chrome or Chromium: %w", err)
	}
	s.tab, s.clean = tab, closeAll
	return nil
}

func (s *Session) operation(ctx context.Context) (context.Context, func(), error) {
	call, timeout := context.WithTimeout(ctx, 25*time.Second)
	s.mu.Lock()
	if err := call.Err(); err != nil {
		s.mu.Unlock()
		timeout()
		return nil, nil, err
	}
	if err := s.start(call); err != nil {
		s.mu.Unlock()
		timeout()
		return nil, nil, err
	}
	tab, cancel := context.WithCancel(s.tab)
	stop := context.AfterFunc(call, cancel)
	return tab, func() {
		stop()
		cancel()
		timeout()
		s.mu.Unlock()
	}, nil
}

func ValidateURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || len(raw) > 4096 {
		return fmt.Errorf("enter an HTTP or HTTPS URL without embedded credentials")
	}
	return nil
}

func PublicURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" {
		return ""
	}
	parsed.User, parsed.RawQuery, parsed.Fragment = nil, "", ""
	parsed.ForceQuery = false
	return parsed.String()
}

func (s *Session) Navigate(ctx context.Context, raw string) (Inspection, error) {
	if err := ValidateURL(raw); err != nil {
		return Inspection{}, err
	}
	tab, done, err := s.operation(ctx)
	if err != nil {
		return Inspection{}, err
	}
	defer done()
	s.invalidate()
	response, err := chromedp.RunResponse(tab, chromedp.Navigate(raw))
	if err != nil {
		return Inspection{}, err
	}
	if response != nil && response.Status >= 400 {
		return Inspection{}, fmt.Errorf("browser could not open %s (HTTP %d)", PublicURL(response.URL), response.Status)
	}
	return s.inspect(tab)
}

func (s *Session) Inspect(ctx context.Context) (Inspection, error) {
	tab, done, err := s.operation(ctx)
	if err != nil {
		return Inspection{}, err
	}
	defer done()
	return s.inspect(tab)
}

func (s *Session) Back(ctx context.Context) (Inspection, error) {
	tab, done, err := s.operation(ctx)
	if err != nil {
		return Inspection{}, err
	}
	defer done()
	history, err := chromedp.Run(tab, chromedp.NavigationEntries())
	if err != nil {
		return Inspection{}, err
	}
	if history.CurrentIndex <= 0 || history.CurrentIndex >= int64(len(history.Entries)) {
		return Inspection{}, fmt.Errorf("there is no previous browser page")
	}
	entry := history.Entries[history.CurrentIndex-1]
	s.invalidate()
	_, err = chromedp.Run(tab, func(ctx context.Context, target *chromedp.Target) (cdp.Empty, error) {
		return cdp.Call(ctx, target, page.NavigateToHistoryEntry, page.NavigateToHistoryEntryParams{EntryID: entry.ID})
	})
	if err != nil {
		return Inspection{}, err
	}

	// Restoring a cached page can skip the load event. Check the active
	// history entry and document readiness instead.
	tick := time.NewTicker(45 * time.Millisecond)
	defer tick.Stop()
	for {
		active, err := chromedp.Run(tab, chromedp.NavigationEntries())
		if err == nil && active.CurrentIndex >= 0 && active.CurrentIndex < int64(len(active.Entries)) &&
			active.Entries[active.CurrentIndex].ID == entry.ID {
			current, err := chromedp.Run(tab, chromedp.Evaluate[bool](
				"document.readyState !== 'loading' && location.href === "+quoted(entry.URL),
			))
			if err == nil && current {
				return s.inspect(tab)
			}
		}
		select {
		case <-tab.Done():
			return Inspection{}, fmt.Errorf("previous page did not become ready: %w", tab.Err())
		case <-tick.C:
		}
	}
}

func quoted(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func (s *Session) Screenshot(ctx context.Context) ([]byte, error) {
	tab, done, err := s.operation(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	return chromedp.Run(tab, chromedp.CaptureScreenshot())
}

func (s *Session) invalidate() {
	s.world = 0
	s.last = Inspection{}
}

func (s *Session) inspect(tab context.Context) (Inspection, error) {
	id, err := chromedp.Run(tab, func(ctx context.Context, target *chromedp.Target) (runtime.ExecutionContextID, error) {
		tree, err := cdp.Call(ctx, target, page.GetFrameTree, cdp.Empty{})
		if err != nil {
			return 0, err
		}
		world, err := cdp.Call(ctx, target, page.CreateIsolatedWorld, page.CreateIsolatedWorldParams{
			FrameID: tree.FrameTree.Frame.ID, WorldName: "grox-browser",
		})
		return world.ExecutionContextID, err
	})
	if err != nil {
		return Inspection{}, err
	}
	s.serial++
	s.invalidate()
	inspection, err := chromedp.Run(tab, chromedp.Evaluate[Inspection](
		fmt.Sprintf("(%s)(%d)", inspectExpression, s.serial),
		func(params *runtime.EvaluateParams) { params.ContextID = id },
	))
	if err != nil {
		return Inspection{}, err
	}
	inspection.URL = PublicURL(inspection.URL)
	for i := range inspection.Elements {
		inspection.Elements[i].Href = PublicURL(inspection.Elements[i].Href)
	}
	s.world, s.last = id, inspection
	return inspection, nil
}

var validRef = regexp.MustCompile(`^e[1-9][0-9]{0,9}-[1-9][0-9]{0,2}$`)

// Describe returns the explicit page and control shown in the last inspection.
func (s *Session) Describe(ref string) (Element, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.describe(ref)
}

func (s *Session) describe(ref string) (Element, string, error) {
	if validRef.MatchString(ref) {
		for _, element := range s.last.Elements {
			if element.Ref == ref {
				return element, s.last.URL, nil
			}
		}
	}
	return Element{}, "", fmt.Errorf("element reference expired. Inspect the page again")
}

func (s *Session) Click(ctx context.Context, ref string) error {
	return s.act(ctx, "click", ref, "")
}

func (s *Session) Type(ctx context.Context, ref, text string) error {
	if len(text) > 4096 {
		return fmt.Errorf("browser text must be at most 4096 bytes")
	}
	return s.act(ctx, "type", ref, text)
}

func (s *Session) act(ctx context.Context, action, ref, text string) error {
	tab, done, err := s.operation(ctx)
	if err != nil {
		return err
	}
	defer done()
	if _, _, err := s.describe(ref); err != nil {
		return err
	}
	payload, err := json.Marshal([]string{action, ref, text})
	if err != nil {
		return err
	}
	world := s.world
	result, err := chromedp.Run(tab, chromedp.Evaluate[string](
		"("+actExpression+")(..."+string(payload)+")",
		func(params *runtime.EvaluateParams) { params.ContextID = world },
	))
	s.invalidate()
	if err != nil {
		return fmt.Errorf("browser action could not be confirmed; inspect the page before retrying: %w", err)
	}
	if message := strings.TrimSpace(result); message != "" {
		return fmt.Errorf("%s", message)
	}
	return nil
}
