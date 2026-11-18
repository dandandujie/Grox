package browser

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagedProxyBlocksPrivateHTTPAndHTTPS(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr, err := startProxy(ctx, dialPublic)
	if err != nil {
		t.Fatal(err)
	}
	proxyURL, err := url.Parse("http://" + addr)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 3 * time.Second}
	res, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("private proxy HTTP returned %v", res.Status)
	}
	tlsURL := "https" + strings.TrimPrefix(server.URL, "http")
	if res, err := client.Get(tlsURL); err == nil {
		res.Body.Close()
		t.Fatal("private proxy CONNECT succeeded")
	}
	if hits.Load() != 0 {
		t.Fatal("the local site received a private browser request")
	}
}

func TestManagedBrowserWorkflow(t *testing.T) {
	if os.Getenv("GROX_TEST_BROWSER") != "1" {
		t.Skip("set GROX_TEST_BROWSER=1 to run Chrome against the isolated HTTP fixture")
	}
	var forbiddenHits atomic.Int32
	commits := make(chan string, 1)
	private := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forbiddenHits.Add(1)
	}))
	defer private.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/save":
			data, _ := io.ReadAll(io.LimitReader(r.Body, 100))
			commits <- string(data)
			_, _ = fmt.Fprint(w, "saved")
			return
		case "/redirect":
			http.Redirect(w, r, private.URL+"/hidden", http.StatusFound)
			return
		case "/next":
			_, _ = fmt.Fprintf(w, "<title>Next page</title><body>Navigation confirmed<img src=%q></body>", private.URL+"/image")
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, `<!doctype html><title>Managed fixture</title>
			<label>Note <input id="note"></label>
			<label>Secret <input type="password" value="static-password"></label>
			<button id="save">Save note</button><a href="/next?private=sample">Next</a>
			<p id="status">Waiting</p>
			<script>
			document.querySelector("#save").onclick = async () => {
				const response = await fetch("/save", {method:"POST",body:document.querySelector("#note").value});
				document.querySelector("#status").textContent = await response.text();
			};
			</script>`)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	session := newSession(ctx, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "fixture.grox.test:80" {
			return nil, fmt.Errorf("the test proxy only connects to fixture.grox.test")
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	})
	defer session.Close()

	first, err := session.Navigate(ctx, "http://fixture.grox.test/?token=secret-example")
	if err != nil {
		t.Fatal(err)
	}
	if first.Title != "Managed fixture" || first.URL != "http://fixture.grox.test/" || len(first.Elements) != 3 {
		t.Fatalf("unexpected browser inspection: %+v", first)
	}
	if first.Elements[2].Href != "http://fixture.grox.test/next" {
		t.Fatalf("not redacted: %s", first.Elements[2].Href)
	}
	if err := session.Type(ctx, first.Elements[0].Ref, "one quiet note"); err != nil {
		t.Fatal(err)
	}
	if err := session.Click(ctx, first.Elements[1].Ref); err == nil {
		t.Fatal("a stale element reference was accepted")
	}
	current, err := session.Inspect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Click(ctx, current.Elements[1].Ref); err != nil {
		t.Fatal(err)
	}
	select {
	case committed := <-commits:
		if committed != "one quiet note" {
			t.Fatalf("actual browser submitted %q", committed)
		}
	case <-ctx.Done():
		t.Fatal("browser did not submit the form")
	}
	image, err := session.Screenshot(ctx)
	if err != nil || !bytes.HasPrefix(image, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("browser screenshot: %d bytes, %v", len(image), err)
	}
	second, err := session.Navigate(ctx, "http://fixture.grox.test/next")
	if err != nil || !strings.Contains(second.Text, "Navigation confirmed") {
		t.Fatalf("next page: %+v, %v", second, err)
	}
	previous, err := session.Back(ctx)
	if err != nil || previous.Title != first.Title {
		t.Fatalf("browser back: %+v, %v", previous, err)
	}
	if _, err := session.Navigate(ctx, "http://fixture.grox.test/redirect"); err == nil {
		t.Fatal("browser followed a redirect to a forbidden origin")
	}
	if forbiddenHits.Load() != 0 {
		t.Fatal("Chrome bypassed proxy restrictions for a private destination")
	}
}
