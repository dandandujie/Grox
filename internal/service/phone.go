package service

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/dandandujie/grox/internal/model"
)

//go:embed phone.html
var phonePage embed.FS

func randomToken() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// PhoneInfo reports the local web companion's address. It never starts the
// server as a side effect.
func (s *Service) PhoneInfo() model.PhoneInfo {
	info := model.PhoneInfo{}
	s.mu.Lock()
	if s.st != nil {
		info.Enabled = s.st.State.Settings.PhoneEnabled
		info.Token = s.st.State.Settings.PhoneToken
	}
	s.mu.Unlock()
	s.phoneMu.Lock()
	info.Error = s.phoneErr
	if s.phoneListener != nil {
		if addr, ok := s.phoneListener.Addr().(*net.TCPAddr); ok {
			info.Port = addr.Port
		}
	}
	s.phoneMu.Unlock()
	s.phoneSubMu.Lock()
	info.Connected = len(s.phoneSubs)
	s.phoneSubMu.Unlock()
	if info.Port != 0 && info.Token != "" {
		info.URL = "http://" + lanAddress() + ":" + fmt.Sprintf("%d", info.Port) + "/p/" + info.Token
		if png, err := qrcode.Encode(info.URL, qrcode.Medium, 320); err == nil {
			info.QR = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
		}
	}
	return info
}

// SetPhoneEnabled starts or stops the LAN companion server.
func (s *Service) SetPhoneEnabled(enabled bool) (model.PhoneInfo, error) {
	s.mu.Lock()
	if s.st == nil {
		s.mu.Unlock()
		return model.PhoneInfo{}, fmt.Errorf("the workspace is not open")
	}
	s.st.State.Settings.PhoneEnabled = enabled
	if enabled && s.st.State.Settings.PhoneToken == "" {
		s.st.State.Settings.PhoneToken = randomToken()
	}
	s.touchLocked()
	s.saveLocked()
	s.mu.Unlock()
	if enabled {
		if err := s.startPhone(); err != nil {
			return s.PhoneInfo(), err
		}
	} else {
		s.stopPhone()
	}
	return s.PhoneInfo(), nil
}

func (s *Service) startPhoneIfEnabled() {
	s.mu.Lock()
	enabled := s.st != nil && s.st.State.Settings.PhoneEnabled
	if enabled && s.st.State.Settings.PhoneToken == "" {
		s.st.State.Settings.PhoneToken = randomToken()
		_ = s.st.SaveState()
	}
	s.mu.Unlock()
	if enabled {
		_ = s.startPhone()
	}
}

func (s *Service) startPhone() error {
	s.phoneMu.Lock()
	defer s.phoneMu.Unlock()
	if s.phoneServer != nil {
		return nil
	}
	var listener net.Listener
	var err error
	for port := 4870; port <= 4880; port++ {
		listener, err = net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			break
		}
	}
	if listener == nil {
		s.phoneErr = "could not open a LAN port (4870-4880)"
		return fmt.Errorf("%s", s.phoneErr)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/p/", s.handlePhonePage)
	mux.HandleFunc("/api/state", s.handlePhoneState)
	mux.HandleFunc("/api/send", s.handlePhoneSend)
	mux.HandleFunc("/api/read", s.handlePhoneRead)
	mux.HandleFunc("/api/events", s.handlePhoneEvents)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/p/", http.StatusFound)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 8 * time.Second}
	s.phoneServer = server
	s.phoneListener = listener
	s.phoneErr = ""
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			s.phoneMu.Lock()
			s.phoneErr = err.Error()
			s.phoneMu.Unlock()
		}
	}()
	return nil
}

func (s *Service) stopPhone() {
	s.phoneMu.Lock()
	server := s.phoneServer
	listener := s.phoneListener
	s.phoneServer = nil
	s.phoneListener = nil
	s.phoneMu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func (s *Service) phoneToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st == nil {
		return ""
	}
	return s.st.State.Settings.PhoneToken
}

func (s *Service) phoneAuthorized(r *http.Request) bool {
	token := s.phoneToken()
	if token == "" {
		return false
	}
	provided := r.URL.Query().Get("token")
	if provided == "" && strings.HasPrefix(r.URL.Path, "/p/") {
		provided = strings.TrimPrefix(r.URL.Path, "/p/")
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1
}

func (s *Service) handlePhonePage(w http.ResponseWriter, r *http.Request) {
	if !s.phoneAuthorized(r) {
		http.NotFound(w, r)
		return
	}
	page, err := phonePage.ReadFile("phone.html")
	if err != nil {
		http.Error(w, "phone page unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(page)
}

func (s *Service) handlePhoneState(w http.ResponseWriter, r *http.Request) {
	if !s.phoneAuthorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	state := s.snapshotLocked()
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"state": state})
}

type phoneSendInput struct {
	BotID    string
	GroupID  string
	ThreadID string
	Text     string
}

type phoneReadInput struct {
	BotID    string
	GroupID  string
	ThreadID string
}

func (s *Service) handlePhoneSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.phoneAuthorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var input phoneSendInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input); err != nil {
		http.Error(w, "invalid message", http.StatusBadRequest)
		return
	}
	var result model.SendResult
	var err error
	if input.GroupID != "" {
		result, err = s.SendGroup(input.GroupID, input.ThreadID, input.Text)
	} else {
		result, err = s.Send(input.BotID, input.ThreadID, input.Text)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (s *Service) handlePhoneRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.phoneAuthorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var input phoneReadInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	var err error
	if input.GroupID != "" {
		err = s.SelectGroup(input.GroupID, input.ThreadID)
	} else {
		err = s.Select(input.BotID, input.ThreadID)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) handlePhoneEvents(w http.ResponseWriter, r *http.Request) {
	if !s.phoneAuthorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan model.Event, 64)
	s.phoneSubMu.Lock()
	s.phoneSubs[ch] = struct{}{}
	s.phoneSubMu.Unlock()
	defer func() {
		s.phoneSubMu.Lock()
		delete(s.phoneSubs, ch)
		s.phoneSubMu.Unlock()
	}()
	s.mu.Lock()
	state := s.snapshotLocked()
	s.mu.Unlock()
	write := func(ev model.Event) bool {
		data, err := json.Marshal(ev)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write(model.Event{Type: "state", State: &state, Revision: state.Revision}) {
		return
	}
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case ev := <-ch:
			if !write(ev) {
				return
			}
		}
	}
}

func lanAddress() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP != nil && !addr.IP.IsLoopback() {
			return addr.IP.String()
		}
	}
	interfaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range interfaces {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			addrs, _ := iface.Addrs()
			for _, addr := range addrs {
				if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil && !ipnet.IP.IsLoopback() {
					return ipnet.IP.String()
				}
			}
		}
	}
	return "127.0.0.1"
}
