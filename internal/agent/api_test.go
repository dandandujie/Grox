package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

func TestRunAPIStream(t *testing.T) {
	var called bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	sink := &fakeSink{}
	req := Request{
		Bot:        model.Bot{Name: "Test", Soul: "Be brief."},
		UserText:   "Hi",
		Model:      model.Model{ID: "test-model", Provider: "openai"},
		APIBaseURL: server.URL + "/v1",
		APIKey:     "test",
	}
	result, err := runAPI(context.Background(), req, sink)
	if err != nil {
		t.Fatal(err)
	}
	if !called || result != "Hello" || sink.text.String() != "Hello" {
		t.Fatalf("called=%v result=%q sink=%q", called, result, sink.text.String())
	}
}

func TestRunAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no access", http.StatusUnauthorized)
	}))
	defer server.Close()
	_, err := runAPI(context.Background(), Request{
		Bot: model.Bot{Name: "Test"}, UserText: "Hi",
		Model:      model.Model{ID: "m", Provider: "openai"},
		APIBaseURL: server.URL,
	}, &fakeSink{})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected a 401 error, got %v", err)
	}
}
