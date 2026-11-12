package service

import (
	"encoding/json"
	"fmt"
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
