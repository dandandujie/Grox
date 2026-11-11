// Package service implements the typed API the Grox frontend calls.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dandandujie/grox/internal/catalog"
	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/store"
)

// Service owns the workspace and is bound to the frontend as Grox.
type Service struct {
	mu     sync.Mutex
	dir    string
	st     *store.Store
	emitMu sync.Mutex
	emit   func(model.Event)

	engines       []model.EngineInfo
	engineFetched time.Time
	catalogMu     sync.Mutex

	turns map[string]*turnControl
	stop  chan struct{}
	once  sync.Once

	phoneMu       sync.Mutex
	phoneServer   *http.Server
	phoneListener net.Listener
	phoneErr      string
	phoneSubMu    sync.Mutex
	phoneSubs     map[chan model.Event]struct{}

	composioToolsMu sync.Mutex
	composioTools   []model.ComposioTool
	composioToolsAt time.Time

	approvalMu       sync.Mutex
	approvalServer   *http.Server
	approvalListener net.Listener
	approvalTokens   map[string]claudeHookTarget
	hookApprovals    map[string]*claudeHookApproval
	questionWaiters  map[string]*questionWaiter

	webhookMu        sync.Mutex
	webhookServer    *http.Server
	webhookListener  net.Listener
	webhookErr       string
	webhookReplays   map[string]time.Time
	lastMemoryUpkeep time.Time

	apiMu       sync.Mutex
	apiServer   *http.Server
	apiListener net.Listener
	apiErr      string
	apiSubMu    sync.Mutex
	apiSubs     map[chan model.Event]struct{}

	oauthMu     sync.Mutex
	oauthTokens map[string]mcpOAuthToken
}

type turnControl struct {
	cancel   context.CancelFunc
	botID    string
	groupID  string
	threadID string
}

// New returns a service for the workspace at dir. The workspace itself is
// opened by Open, after MyGo's generator has had a chance to run without
// touching the person's real data.
func New(dir string, emit func(model.Event)) (*Service, error) {
	return &Service{
		dir: dir, emit: emit, turns: map[string]*turnControl{}, stop: make(chan struct{}),
		phoneSubs:      map[chan model.Event]struct{}{},
		apiSubs:        map[chan model.Event]struct{}{},
		oauthTokens:    map[string]mcpOAuthToken{},
		approvalTokens: map[string]claudeHookTarget{}, hookApprovals: map[string]*claudeHookApproval{},
		questionWaiters: map[string]*questionWaiter{}, webhookReplays: map[string]time.Time{},
	}, nil
}

// Open loads the workspace. It is a package function, not a method, so it is
// not exposed to the page.
func Open(s *Service) error {
	st, err := store.Open(s.dir)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.st = st
	s.mu.Unlock()
	s.startApprovalServer()
	s.startWebhookServer()
	if s.st.State.Settings.APIEnabled {
		s.startAPIServer()
	}
	s.startPhoneIfEnabled()
	return nil
}

// StartScheduler begins routine scheduling. It is intentionally not a method:
// the page cannot start or stop the scheduler.
func StartScheduler(s *Service) { s.start() }

// setEmitter attaches the page event sink.
func (s *Service) setEmitter(fn func(model.Event)) {
	s.emitMu.Lock()
	s.emit = fn
	s.emitMu.Unlock()
}

func (s *Service) emitEvent(ev model.Event) {
	s.emitMu.Lock()
	fn := s.emit
	s.emitMu.Unlock()
	if fn != nil {
		fn(ev)
	}
	s.phoneSubMu.Lock()
	for ch := range s.phoneSubs {
		select {
		case ch <- ev:
		default:
		}
	}
	s.phoneSubMu.Unlock()
	s.apiSubMu.Lock()
	for ch := range s.apiSubs {
		select {
		case ch <- ev:
		default:
		}
	}
	s.apiSubMu.Unlock()
}

// start begins the routine scheduler.
func (s *Service) start() {
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-ticker.C:
				s.runDueRoutines()
				s.runMemoryUpkeep()
			}
		}
	}()
}

// Close stops timers and flushes the workspace. It is a package function so
// the page cannot shut the app down through the binding.
func Close(s *Service) { s.shutdown() }

// shutdown stops timers and flushes the workspace.
func (s *Service) shutdown() {
	s.once.Do(func() { close(s.stop) })
	s.stopApprovalServer()
	s.stopWebhookServer()
	s.stopAPIServer()
	s.stopPhone()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st == nil {
		return
	}
	for _, t := range s.turns {
		t.cancel()
	}
	_ = s.st.SaveState()
}

// Bootstrap loads everything the page needs for its first paint.
func (s *Service) Bootstrap(ctx context.Context) (model.Bootstrap, error) {
	return s.bootstrap(ctx, false)
}

// RefreshCatalog re-probes the local CLIs and returns a fresh bootstrap.
func (s *Service) RefreshCatalog(ctx context.Context) (model.Bootstrap, error) {
	return s.bootstrap(ctx, true)
}

func (s *Service) bootstrap(ctx context.Context, force bool) (model.Bootstrap, error) {
	engines := s.detectEngines(ctx, force)

	s.mu.Lock()
	s.engines = engines
	availability := s.availabilityLocked(engines)
	defaultModel := catalog.DefaultModel(availability)
	providers := catalog.Providers(availability, defaultModel)
	for pi := range providers {
		for mi := range providers[pi].Models {
			providers[pi].Models[mi].Available = availability[providers[pi].ID] || providers[pi].ID == "local"
		}
	}
	apps := s.appsLocked()
	secrets := s.st.SecretStatus()
	s.st.Normalize()
	state := s.snapshotLocked()
	settings := state.Settings
	s.mu.Unlock()
	phone := s.PhoneInfo()
	if s.composioKey() != "" && len(s.cachedComposioTools()) == 0 {
		go s.warmComposioTools()
	}

	return model.Bootstrap{
		State:     state,
		Providers: providers,
		Apps:      apps,
		Engines:   engines,
		Secrets:   secrets,
		Phone:     phone,
		Version:   model.AppVersion,
		Platform:  runtime.GOOS,
		DataDir:   s.st.Dir,
		DemoMode:  settings.EngineMode == "demo" || defaultModel == "grox-demo",
	}, nil
}

func (s *Service) detectEngines(ctx context.Context, force bool) []model.EngineInfo {
	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()
	if !force && len(s.engines) > 0 && time.Since(s.engineFetched) < 2*time.Minute {
		return s.engines
	}
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	engines := catalog.Engines(probeCtx)
	s.engines = engines
	s.engineFetched = time.Now()
	return engines
}

func (s *Service) availabilityLocked(engines []model.EngineInfo) map[string]bool {
	ready := map[string]bool{}
	for _, e := range engines {
		if e.Status == "ready" {
			ready[e.ProviderID] = true
		}
	}
	available := map[string]bool{
		"grok":   ready["grok"] || s.st.Key("xai") != "",
		"claude": ready["claude"] || s.st.Key("anthropic") != "",
		"openai": ready["openai"] || s.st.Key("openai") != "",
		"google": ready["google"] || s.st.Key("google") != "",
		"local":  true,
	}
	if strings.TrimSpace(s.st.State.Settings.APIBaseURL) != "" && s.st.Key("api") != "" {
		available["custom"] = true
	}
	return available
}

func (s *Service) appsLocked() []model.AppEntry {
	apps := catalog.Apps()
	for i := range apps {
		if c, ok := s.st.State.Connections[apps[i].ID]; ok {
			apps[i].Connected = c.Connected
			apps[i].Account = c.Account
		}
	}
	return apps
}

func (s *Service) snapshotLocked() model.AppState {
	data, err := json.Marshal(s.st.State)
	if err != nil {
		return s.st.State
	}
	var out model.AppState
	if err := json.Unmarshal(data, &out); err != nil {
		return s.st.State
	}
	return out
}

func (s *Service) touchLocked() {
	s.st.State.Revision++
	s.st.State.UpdatedAt = time.Now()
}

func (s *Service) saveLocked() {
	_ = s.st.SaveState()
}

// emitStateLocked copies and emits the whole document. Callers hold s.mu.
func (s *Service) emitStateLocked() {
	state := s.snapshotLocked()
	rev := state.Revision
	s.emitEvent(model.Event{Type: "state", Revision: rev, State: &state})
}

func (s *Service) findBotLocked(id string) *model.Bot {
	for i := range s.st.State.Bots {
		if s.st.State.Bots[i].ID == id {
			return &s.st.State.Bots[i]
		}
	}
	return nil
}

func (s *Service) findThreadLocked(bot *model.Bot, id string) *model.Thread {
	for i := range bot.Threads {
		if bot.Threads[i].ID == id {
			return &bot.Threads[i]
		}
	}
	return nil
}

func (s *Service) findMessageLocked(t *model.Thread, id string) *model.Message {
	for i := range t.Messages {
		if t.Messages[i].ID == id {
			return &t.Messages[i]
		}
	}
	return nil
}

func (s *Service) modelByIDLocked(id string) model.Model {
	engines := s.engines
	availability := s.availabilityLocked(engines)
	providers := catalog.Providers(availability, id)
	for _, p := range providers {
		for _, m := range p.Models {
			if m.ID == id {
				return m
			}
		}
	}
	return model.Model{ID: id, Name: id, Provider: "local", ProviderName: "On this Mac", Accent: "#38bdf8", Available: true}
}

func cloneBot(in model.Bot) model.Bot {
	data, _ := json.Marshal(in)
	var out model.Bot
	_ = json.Unmarshal(data, &out)
	return out
}

func cloneThread(in model.Thread) model.Thread {
	data, _ := json.Marshal(in)
	var out model.Thread
	_ = json.Unmarshal(data, &out)
	return out
}

func cloneMessage(in model.Message) model.Message {
	data, _ := json.Marshal(in)
	var out model.Message
	_ = json.Unmarshal(data, &out)
	return out
}

func cloneRoutine(in model.Routine) model.Routine {
	data, _ := json.Marshal(in)
	var out model.Routine
	_ = json.Unmarshal(data, &out)
	return out
}

func newID(prefix string) string {
	return prefix + "-" + fmt.Sprintf("%x", time.Now().UnixNano())
}

func (s *Service) UpdateSettings(settings model.Settings) (model.Settings, error) {
	s.mu.Lock()
	cur := &s.st.State.Settings
	switch settings.Theme {
	case "midnight", "daylight", "atelier", "foundry":
		cur.Theme = settings.Theme
	case "":
	default:
		cur.Theme = "midnight"
	}
	if settings.Language == "en" || settings.Language == "zh" {
		cur.Language = settings.Language
	}
	if settings.SidebarWidth >= 240 && settings.SidebarWidth <= 480 {
		cur.SidebarWidth = settings.SidebarWidth
	}
	cur.Advanced = settings.Advanced
	cur.Onboarded = settings.Onboarded
	cur.ReduceMotion = settings.ReduceMotion
	cur.Notifications = settings.Notifications
	cur.Sounds = settings.Sounds
	switch settings.EngineMode {
	case "auto", "demo", "grok", "claude", "codex", "gemini", "api":
		cur.EngineMode = settings.EngineMode
	}
	if settings.InputPricePerMillion >= 0 && settings.InputPricePerMillion <= 10000 {
		cur.InputPricePerMillion = settings.InputPricePerMillion
	}
	if settings.OutputPricePerMillion >= 0 && settings.OutputPricePerMillion <= 10000 {
		cur.OutputPricePerMillion = settings.OutputPricePerMillion
	}
	cur.APIBaseURL = strings.TrimSpace(settings.APIBaseURL)
	cur.APIModel = strings.TrimSpace(settings.APIModel)
	out := *cur
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

func (s *Service) SetSecret(name, value string) (model.SecretStatus, error) {
	allowed := map[string]bool{"xai": true, "openai": true, "anthropic": true, "google": true, "composio": true, "api": true}
	if !allowed[name] {
		return model.SecretStatus{}, fmt.Errorf("unknown key %q", name)
	}
	if err := s.st.SetSecret(name, strings.TrimSpace(value)); err != nil {
		return model.SecretStatus{}, err
	}
	s.catalogMu.Lock()
	s.engineFetched = time.Time{}
	s.catalogMu.Unlock()
	s.mu.Lock()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	status := s.st.SecretStatus()
	s.mu.Unlock()
	return status, nil
}

func (s *Service) ClearSecret(name string) (model.SecretStatus, error) {
	if err := s.st.ClearSecret(name); err != nil {
		return model.SecretStatus{}, err
	}
	s.catalogMu.Lock()
	s.engineFetched = time.Time{}
	s.catalogMu.Unlock()
	s.mu.Lock()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	status := s.st.SecretStatus()
	s.mu.Unlock()
	return status, nil
}

func (s *Service) SetConnection(appID string, connected bool) (model.AppEntry, error) {
	s.mu.Lock()
	c, ok := s.st.State.Connections[appID]
	if !ok {
		s.mu.Unlock()
		return model.AppEntry{}, fmt.Errorf("unknown app %q", appID)
	}
	c.ID = appID
	c.Connected = connected
	if connected {
		c.ConnectedAt = time.Now()
		if c.Account == "" {
			c.Account = "App account"
		}
	} else {
		c.Account = ""
		c.ConnectedAt = time.Time{}
	}
	s.st.State.Connections[appID] = c
	var entry model.AppEntry
	for _, app := range catalog.Apps() {
		if app.ID == appID {
			entry = app
			break
		}
	}
	entry.Connected = connected
	entry.Account = c.Account
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return entry, nil
}

func (s *Service) ExportWorkspace(ctx context.Context) (string, error) {
	s.mu.Lock()
	data, err := json.MarshalIndent(s.st.State, "", "  ")
	s.mu.Unlock()
	if err != nil {
		return "", err
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, "Downloads")
	if _, err := os.Stat(dir); err != nil {
		dir = s.st.Dir
	}
	name := "grox-workspace-" + time.Now().Format("2006-01-02-1504") + ".json"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func (s *Service) ResetWorkspace() error {
	s.mu.Lock()
	for _, t := range s.turns {
		t.cancel()
	}
	s.turns = map[string]*turnControl{}
	if err := s.st.Reset(time.Now()); err != nil {
		s.mu.Unlock()
		return err
	}
	_ = os.RemoveAll(filepath.Join(s.st.Dir, "attachments"))
	s.st.Normalize()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	s.stopPhone()
	return nil
}

func (s *Service) RevealDataFolder() error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", s.st.Dir)
	case "windows":
		cmd = exec.Command("explorer", s.st.Dir)
	default:
		cmd = exec.Command("xdg-open", s.st.Dir)
	}
	return cmd.Start()
}

// sortedRuns returns newest first.
func sortedRuns(in []model.Run) []model.Run {
	out := append([]model.Run(nil), in...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	return out
}
