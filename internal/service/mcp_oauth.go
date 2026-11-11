package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type mcpOAuthConfig struct {
	TokenURL         string
	ClientID         string
	ClientSecret     string
	Scopes           string
	RefreshToken     string
	AuthorizationURL string
	AccessToken      string
	ExpiresAt        int64
}

type mcpOAuthToken struct {
	AccessToken string
	ExpiresAt   time.Time
}

func mcpOAuthSecretName(id string) string { return "mcp:" + id + ":oauth" }

func (s *Service) saveMCPOAuthLocked(id string, config mcpOAuthConfig) error {
	data, err := json.Marshal(map[string]string{
		"tokenUrl": config.TokenURL, "clientId": config.ClientID,
		"clientSecret": config.ClientSecret, "scopes": config.Scopes, "refreshToken": config.RefreshToken,
		"authorizationUrl": config.AuthorizationURL, "accessToken": config.AccessToken,
		"expiresAt": strconv.FormatInt(config.ExpiresAt, 10),
	})
	if err != nil {
		return err
	}
	s.st.Secrets[mcpOAuthSecretName(id)] = string(data)
	return s.st.SaveSecrets()
}

func (s *Service) mcpOAuthConfigLocked(id string) (mcpOAuthConfig, bool) {
	raw := s.st.Secrets[mcpOAuthSecretName(id)]
	if raw == "" {
		return mcpOAuthConfig{}, false
	}
	var values map[string]string
	if json.Unmarshal([]byte(raw), &values) != nil {
		return mcpOAuthConfig{}, false
	}
	config := mcpOAuthConfig{
		TokenURL: values["tokenUrl"], ClientID: values["clientId"],
		ClientSecret: values["clientSecret"], Scopes: values["scopes"], RefreshToken: values["refreshToken"],
		AuthorizationURL: values["authorizationUrl"], AccessToken: values["accessToken"],
	}
	config.ExpiresAt, _ = strconv.ParseInt(values["expiresAt"], 10, 64)
	if config.TokenURL == "" || config.ClientID == "" {
		return mcpOAuthConfig{}, false
	}
	return config, true
}

// mcpOAuthAccessTokenLocked fetches a client-credentials token. The token is
// cached in memory and never written to AppState.
func (s *Service) mcpOAuthAccessTokenLocked(id string) string {
	config, ok := s.mcpOAuthConfigLocked(id)
	if !ok {
		return ""
	}
	if config.AccessToken != "" && time.Now().Unix() < config.ExpiresAt-30 {
		return config.AccessToken
	}
	s.oauthMu.Lock()
	cached := s.oauthTokens[id]
	if cached.AccessToken != "" && time.Now().Before(cached.ExpiresAt) {
		s.oauthMu.Unlock()
		return cached.AccessToken
	}
	s.oauthMu.Unlock()
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
		return ""
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	if config.ClientSecret != "" {
		request.SetBasicAuth(config.ClientID, config.ClientSecret)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ""
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return ""
	}
	token, _ := payload["access_token"].(string)
	if token == "" {
		return ""
	}
	if refreshed, _ := payload["refresh_token"].(string); refreshed != "" && refreshed != config.RefreshToken {
		config.RefreshToken = refreshed
		_ = s.saveMCPOAuthLocked(id, config)
	}
	expires, _ := payload["expires_in"].(float64)
	expiry := time.Now().Add(5 * time.Minute)
	if expires > 0 {
		expiry = time.Now().Add(time.Duration(expires)*time.Second - 30*time.Second)
	}
	s.oauthMu.Lock()
	s.oauthTokens[id] = mcpOAuthToken{AccessToken: token, ExpiresAt: expiry}
	s.oauthMu.Unlock()
	config.AccessToken = token
	config.ExpiresAt = expiry.Unix()
	_ = s.saveMCPOAuthLocked(id, config)
	return token
}

func validateMCPOAuth(tokenURL, clientID string) error {
	if strings.TrimSpace(tokenURL) == "" {
		return fmt.Errorf("enter the OAuth token URL")
	}
	target, err := validateMCPURL(tokenURL)
	if err != nil {
		return fmt.Errorf("OAuth token URL: %w", err)
	}
	if target != tokenURL {
		return fmt.Errorf("OAuth token URL must be a full http(s) URL")
	}
	if strings.TrimSpace(clientID) == "" {
		return fmt.Errorf("enter the OAuth client ID")
	}
	return nil
}
