package service

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// prefetchMCPOAuth refreshes expired OAuth tokens before a turn takes s.mu, so a
// slow token endpoint cannot block the rest of the service.
func (s *Service) prefetchMCPOAuth() {
	type job struct {
		id     string
		config mcpOAuthConfig
	}
	jobs := []job{}
	s.mu.Lock()
	for _, server := range s.st.State.MCPServers {
		if !server.Enabled || !server.OAuthConfigured {
			continue
		}
		config, ok := s.mcpOAuthConfigLocked(server.ID)
		if !ok || cachedMCPOAuthValid(config) || time.Now().Before(s.oauthRetry[server.ID]) {
			continue
		}
		jobs = append(jobs, job{id: server.ID, config: config})
	}
	s.mu.Unlock()
	for _, item := range jobs {
		token, refresh, expiry := fetchMCPOAuthToken(item.config)
		if token == "" {
			s.mu.Lock()
			s.oauthRetry[item.id] = time.Now().Add(30 * time.Second)
			s.mu.Unlock()
			continue
		}
		s.mu.Lock()
		s.oauthTokens[item.id] = mcpOAuthToken{AccessToken: token, ExpiresAt: expiry}
		delete(s.oauthRetry, item.id)
		if refresh != "" && refresh != item.config.RefreshToken {
			item.config.RefreshToken = refresh
			item.config.AccessToken = token
			item.config.ExpiresAt = expiry.Unix()
			_ = s.saveMCPOAuthLocked(item.id, item.config)
		}
		s.mu.Unlock()
	}
}

func cachedMCPOAuthValid(config mcpOAuthConfig) bool {
	return config.AccessToken != "" && time.Now().Unix() < config.ExpiresAt-30
}

func (s *Service) cachedMCPOAuthTokenLocked(id string) string {
	if config, ok := s.mcpOAuthConfigLocked(id); ok && config.AccessToken != "" && time.Now().Unix() < config.ExpiresAt-30 {
		return config.AccessToken
	}
	s.oauthMu.Lock()
	defer s.oauthMu.Unlock()
	if cached := s.oauthTokens[id]; cached.AccessToken != "" && time.Now().Before(cached.ExpiresAt) {
		return cached.AccessToken
	}
	return ""
}

func fetchMCPOAuthToken(config mcpOAuthConfig) (string, string, time.Time) {
	form := url.Values{}
	if config.RefreshToken != "" {
		form.Set("grant_type", "refresh_token")
		form.Set("refresh_token", config.RefreshToken)
	} else {
		form.Set("grant_type", "client_credentials")
	}
	form.Set("client_id", config.ClientID)
	if config.Scopes != "" {
		form.Set("scope", config.Scopes)
	}
	request, err := http.NewRequest(http.MethodPost, config.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", time.Time{}
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	if config.ClientSecret != "" {
		request.SetBasicAuth(config.ClientID, config.ClientSecret)
	}
	response, err := (&http.Client{Timeout: 8 * time.Second}).Do(request)
	if err != nil {
		return "", "", time.Time{}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", "", time.Time{}
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return "", "", time.Time{}
	}
	token, _ := payload["access_token"].(string)
	if token == "" {
		return "", "", time.Time{}
	}
	refreshed, _ := payload["refresh_token"].(string)
	expires, _ := payload["expires_in"].(float64)
	expiry := time.Now().Add(5 * time.Minute)
	if expires > 0 {
		expiry = time.Now().Add(time.Duration(expires)*time.Second - 30*time.Second)
	}
	return token, refreshed, expiry
}
