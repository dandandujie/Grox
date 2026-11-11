package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

type mcpOAuthPending struct {
	serverID string
	verifier string
	redirect string
	expires  time.Time
	server   *http.Server
	listener net.Listener
}

func randomURLToken(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// BeginMCPOAuth starts a loopback callback and returns the authorization URL.
func (s *Service) BeginMCPOAuth(id string) (model.MCPOAuthStart, error) {
	s.mu.Lock()
	server := s.findMCPServerLocked(id)
	if server == nil {
		s.mu.Unlock()
		return model.MCPOAuthStart{}, fmt.Errorf("MCP server not found")
	}
	config, ok := s.mcpOAuthConfigLocked(id)
	s.mu.Unlock()
	if !ok || config.AuthorizationURL == "" {
		return model.MCPOAuthStart{}, fmt.Errorf("configure an OAuth authorization URL first")
	}
	authURL, err := validateMCPURL(config.AuthorizationURL)
	if err != nil {
		return model.MCPOAuthStart{}, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return model.MCPOAuthStart{}, err
	}
	redirect := "http://" + listener.Addr().String() + "/oauth/callback"
	state := randomURLToken(24)
	verifier := randomURLToken(48)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	pending := &mcpOAuthPending{serverID: id, verifier: verifier, redirect: redirect, expires: time.Now().Add(5 * time.Minute)}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/callback", func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			s.oauthMu.Lock()
			delete(s.oauthPending, state)
			s.oauthMu.Unlock()
			go s.closeMCPOAuthPending(pending)
		}()
		code := strings.TrimSpace(r.URL.Query().Get("code"))
		returnedState := strings.TrimSpace(r.URL.Query().Get("state"))
		if code == "" || returnedState != state {
			http.Error(w, "missing or invalid OAuth code", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := s.finishMCPOAuth(id, config, code, verifier, redirect); err != nil {
			_, _ = fmt.Fprintf(w, "<html><body><h1>Grox OAuth failed</h1><p>%s</p></body></html>", html.EscapeString(err.Error()))
			return
		}
		_, _ = w.Write([]byte("<html><body><h1>Grox is connected</h1><p>You can close this tab.</p></body></html>"))
	})
	s.oauthMu.Lock()
	s.oauthPending[state] = pending
	s.oauthMu.Unlock()
	pending.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	pending.listener = listener
	go func() { _ = pending.server.Serve(listener) }()
	go func() {
		time.Sleep(5 * time.Minute)
		s.closeMCPOAuthPending(pending)
	}()
	values, _ := url.Parse(authURL)
	query := values.Query()
	query.Set("response_type", "code")
	query.Set("client_id", config.ClientID)
	query.Set("redirect_uri", redirect)
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	if config.Scopes != "" {
		query.Set("scope", config.Scopes)
	}
	values.RawQuery = query.Encode()
	return model.MCPOAuthStart{URL: values.String()}, nil
}

func (s *Service) closeMCPOAuthPending(pending *mcpOAuthPending) {
	if pending == nil {
		return
	}
	if pending.server != nil {
		_ = pending.server.Close()
	}
	if pending.listener != nil {
		_ = pending.listener.Close()
	}
}

func (s *Service) finishMCPOAuth(id string, config mcpOAuthConfig, code, verifier, redirect string) error {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("client_id", config.ClientID)
	form.Set("redirect_uri", redirect)
	form.Set("code_verifier", verifier)
	request, err := http.NewRequest(http.MethodPost, config.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	if config.ClientSecret != "" {
		request.SetBasicAuth(config.ClientID, config.ClientSecret)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("token endpoint returned %s", response.Status)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return err
	}
	token, _ := payload["access_token"].(string)
	if token == "" {
		return fmt.Errorf("token endpoint returned no access token")
	}
	expires, _ := payload["expires_in"].(float64)
	if refreshed, _ := payload["refresh_token"].(string); refreshed != "" {
		config.RefreshToken = refreshed
	}
	config.AccessToken = token
	if expires > 0 {
		config.ExpiresAt = time.Now().Add(time.Duration(expires)*time.Second - 30*time.Second).Unix()
	} else {
		config.ExpiresAt = time.Now().Add(5 * time.Minute).Unix()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	server := s.findMCPServerLocked(id)
	if server == nil {
		return fmt.Errorf("MCP server not found")
	}
	if err := s.saveMCPOAuthLocked(id, config); err != nil {
		return err
	}
	server.OAuthConfigured = true
	server.OAuthTokenURL = config.TokenURL
	server.OAuthAuthorizationURL = config.AuthorizationURL
	server.AuthConfigured = true
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return nil
}

func (s *Service) findMCPServerLocked(id string) *model.MCPServer {
	for index := range s.st.State.MCPServers {
		if s.st.State.MCPServers[index].ID == id {
			return &s.st.State.MCPServers[index]
		}
	}
	return nil
}
