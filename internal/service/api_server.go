package service

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

const apiTokenSecret = "api:token"

func (s *Service) ensureAPITokenLocked() string {
	if token := strings.TrimSpace(s.st.Secrets[apiTokenSecret]); token != "" {
		return token
	}
	token := randomToken()
	s.st.Secrets[apiTokenSecret] = token
	_ = s.st.SaveSecrets()
	return token
}

func (s *Service) apiBaseURL() string {
	s.apiMu.Lock()
	defer s.apiMu.Unlock()
	if s.apiListener == nil {
		return ""
	}
	return "http://" + s.apiListener.Addr().String()
}

func (s *Service) startAPIServer() {
	s.apiMu.Lock()
	if s.apiListener != nil {
		s.apiMu.Unlock()
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.apiErr = err.Error()
		s.apiMu.Unlock()
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"ok\":true,\"service\":\"grox\"}\n"))
	})
	mux.HandleFunc("/v1/", s.handleAPI)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	s.apiListener = listener
	s.apiServer = server
	s.apiErr = ""
	s.apiMu.Unlock()
	go func() { _ = server.Serve(listener) }()
}

func (s *Service) stopAPIServer() {
	s.apiMu.Lock()
	server := s.apiServer
	listener := s.apiListener
	s.apiServer = nil
	s.apiListener = nil
	s.apiMu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

// GetAPIInfo reports the automation API without returning its bearer token.
func (s *Service) GetAPIInfo() model.APIInfo {
	s.apiMu.Lock()
	base := ""
	if s.apiListener != nil {
		base = "http://" + s.apiListener.Addr().String()
	}
	errText := s.apiErr
	s.apiMu.Unlock()
	s.mu.Lock()
	enabled := s.st.State.Settings.APIEnabled
	configured := strings.TrimSpace(s.st.Secrets[apiTokenSecret]) != ""
	s.mu.Unlock()
	return model.APIInfo{Enabled: enabled, URL: base, Error: errText, TokenConfigured: configured}
}

// SetAPIEnabled starts or stops the loopback automation API and returns the
// freshly generated token when enabling.
func (s *Service) SetAPIEnabled(enabled bool) (model.APIInfo, error) {
	s.mu.Lock()
	s.st.State.Settings.APIEnabled = enabled
	token := ""
	if enabled {
		token = s.ensureAPITokenLocked()
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	if enabled {
		s.startAPIServer()
	} else {
		s.stopAPIServer()
	}
	info := s.GetAPIInfo()
	if enabled {
		info.Token = token
	}
	return info, nil
}

// RotateAPIToken replaces the bearer token and returns the new value once.
func (s *Service) RotateAPIToken() (model.APIInfo, error) {
	s.mu.Lock()
	token := randomToken()
	s.st.Secrets[apiTokenSecret] = token
	if err := s.st.SaveSecrets(); err != nil {
		s.mu.Unlock()
		return model.APIInfo{}, err
	}
	s.mu.Unlock()
	info := s.GetAPIInfo()
	info.Token = token
	return info, nil
}

func (s *Service) handleAPI(w http.ResponseWriter, r *http.Request) {
	s.apiMu.Lock()
	base := ""
	if s.apiListener != nil {
		base = "http://" + s.apiListener.Addr().String()
	}
	s.apiMu.Unlock()
	_ = base
	s.mu.Lock()
	token := strings.TrimSpace(s.st.Secrets[apiTokenSecret])
	s.mu.Unlock()
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	provided := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if token == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("{\"error\":\"unauthorized\"}\n"))
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/")
	parts := strings.Split(path, "/")
	if r.Method == http.MethodGet && path == "events" {
		s.handleAPIEvents(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet && path == "state" {
		s.mu.Lock()
		state := s.snapshotLocked()
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(state)
		return
	}
	if r.Method == http.MethodGet && path == "bots" {
		s.mu.Lock()
		bots := append([]model.Bot(nil), s.st.State.Bots...)
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"bots": bots})
		return
	}
	if r.Method == http.MethodGet && path == "groups" {
		s.mu.Lock()
		groups := append([]model.Group(nil), s.st.State.Groups...)
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"groups": groups})
		return
	}
	if r.Method == http.MethodGet && path == "routines" {
		s.mu.Lock()
		routines := append([]model.Routine(nil), s.st.State.Routines...)
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"routines": routines})
		return
	}
	if r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "routines" && parts[2] == "run" {
		result, err := s.RunRoutine(parts[1])
		if err != nil {
			writeAPIError(w, http.StatusConflict, err.Error())
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(result)
		return
	}
	if len(parts) >= 5 && parts[0] == "groups" && parts[2] == "threads" && r.Method == http.MethodPost {
		groupID, threadID, action, messageID := parts[1], parts[3], parts[4], ""
		if len(parts) >= 6 {
			messageID = parts[5]
		}
		var payload map[string]string
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&payload); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		switch action {
		case "messages":
			if len(parts) != 5 {
				writeAPIError(w, http.StatusNotFound, "not found")
				return
			}
			result, err := s.SendGroup(groupID, threadID, payload["text"])
			if err != nil {
				writeAPIError(w, http.StatusConflict, err.Error())
				return
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(result)
			return
		case "approvals":
			if messageID == "" {
				writeAPIError(w, http.StatusBadRequest, "message id is required")
				return
			}
			if err := s.DecideGroup(groupID, threadID, messageID, payload["decision"]); err != nil {
				writeAPIError(w, http.StatusConflict, err.Error())
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		case "answers":
			if messageID == "" {
				writeAPIError(w, http.StatusBadRequest, "message id is required")
				return
			}
			if err := s.AnswerGroup(groupID, threadID, messageID, payload["answer"]); err != nil {
				writeAPIError(w, http.StatusConflict, err.Error())
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		}
	}
	if len(parts) >= 5 && parts[0] == "bots" && parts[2] == "threads" && r.Method == http.MethodPost {
		botID, threadID, action, messageID := parts[1], parts[3], parts[4], ""
		if len(parts) >= 6 {
			messageID = parts[5]
		}
		var payload map[string]string
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&payload); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		switch action {
		case "messages":
			if len(parts) != 5 {
				writeAPIError(w, http.StatusNotFound, "not found")
				return
			}
			result, err := s.Send(botID, threadID, payload["text"])
			if err != nil {
				writeAPIError(w, http.StatusConflict, err.Error())
				return
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(result)
			return
		case "approvals":
			if messageID == "" {
				writeAPIError(w, http.StatusBadRequest, "message id is required")
				return
			}
			if err := s.Decide(botID, threadID, messageID, payload["decision"]); err != nil {
				writeAPIError(w, http.StatusConflict, err.Error())
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		case "answers":
			if messageID == "" {
				writeAPIError(w, http.StatusBadRequest, "message id is required")
				return
			}
			if err := s.Answer(botID, threadID, messageID, payload["answer"]); err != nil {
				writeAPIError(w, http.StatusConflict, err.Error())
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		}
	}
	writeAPIError(w, http.StatusNotFound, "not found")
}

func (s *Service) handleAPIEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, "streaming unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan model.Event, 64)
	s.apiSubMu.Lock()
	s.apiSubs[ch] = struct{}{}
	s.apiSubMu.Unlock()
	defer func() {
		s.apiSubMu.Lock()
		delete(s.apiSubs, ch)
		s.apiSubMu.Unlock()
	}()
	_, _ = fmt.Fprint(w, "event: ready\ndata: {\"ok\":true}\n\n")
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case event := <-ch:
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
			flusher.Flush()
		}
	}
}

func writeAPIError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
