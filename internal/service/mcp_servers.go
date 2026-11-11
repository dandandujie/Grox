package service

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func mcpSecretName(id string) string { return "mcp:" + id }

func mcpHeadersSecretName(id string) string { return "mcp:" + id + ":headers" }

func normalizeMCPHeaders(values map[string]string) (map[string]string, []string, error) {
	out := map[string]string{}
	seen := map[string]bool{}
	for name, value := range values {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if strings.ContainsAny(name, ":\r\n") || strings.ContainsAny(value, "\r\n") || strings.ContainsRune(value, 0) {
			return nil, nil, fmt.Errorf("invalid MCP header")
		}
		if len(name) > 128 || len(value) > 4096 {
			return nil, nil, fmt.Errorf("an MCP header is too long")
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out[name] = value
	}
	if len(out) > 16 {
		return nil, nil, fmt.Errorf("too many MCP headers (16 max)")
	}
	names := make([]string, 0, len(out))
	for name := range out {
		names = append(names, name)
	}
	sort.Strings(names)
	return out, names, nil
}

func (s *Service) saveMCPHeadersLocked(id string, headers map[string]string) error {
	if len(headers) == 0 {
		delete(s.st.Secrets, mcpHeadersSecretName(id))
		return s.st.SaveSecrets()
	}
	data, err := json.Marshal(headers)
	if err != nil {
		return err
	}
	s.st.Secrets[mcpHeadersSecretName(id)] = string(data)
	return s.st.SaveSecrets()
}

func (s *Service) mcpHeadersLocked(id string) map[string]string {
	raw := s.st.Secrets[mcpHeadersSecretName(id)]
	if raw == "" {
		return nil
	}
	out := map[string]string{}
	if json.Unmarshal([]byte(raw), &out) != nil {
		return nil
	}
	return out
}

func normalizeMCPTransport(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "stdio") {
		return "stdio"
	}
	return "http"
}

func validateMCPURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("enter a full http(s) MCP URL")
	}
	return raw, nil
}

func cleanMCPArgs(args []string) ([]string, error) {
	if len(args) > 32 {
		return nil, fmt.Errorf("too many MCP arguments (32 max)")
	}
	out := make([]string, 0, len(args))
	for _, arg := range args {
		if strings.ContainsRune(arg, 0) {
			return nil, fmt.Errorf("MCP arguments cannot contain NUL")
		}
		if len(arg) > 4096 {
			return nil, fmt.Errorf("one MCP argument is too long")
		}
		out = append(out, arg)
	}
	return out, nil
}

func (s *Service) uniqueMCPNameLocked(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "mcp"
	}
	taken := map[string]bool{}
	for _, server := range s.st.State.MCPServers {
		taken[strings.ToLower(skillSlug(server.Name))] = true
	}
	candidate := skillSlug(name)
	if candidate == "" {
		candidate = "mcp"
	}
	base := candidate
	for suffix := 2; taken[candidate]; suffix++ {
		candidate = fmt.Sprintf("%s-%d", base, suffix)
	}
	return candidate
}

// ListMCPServers returns user-managed MCP servers without token values.
func (s *Service) ListMCPServers() []model.MCPServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]model.MCPServer, len(s.st.State.MCPServers))
	copy(out, s.st.State.MCPServers)
	if out == nil {
		return []model.MCPServer{}
	}
	return out
}

func (s *Service) CreateMCPServer(input model.MCPServerInput) (model.MCPServer, error) {
	transport := normalizeMCPTransport(input.Transport)
	server := model.MCPServer{
		ID: newID("mcp"), Name: "", Transport: transport, Enabled: input.Enabled,
	}
	if transport == "stdio" {
		command := strings.TrimSpace(input.Command)
		if command == "" {
			return model.MCPServer{}, fmt.Errorf("enter the local MCP command")
		}
		args, err := cleanMCPArgs(input.Args)
		if err != nil {
			return model.MCPServer{}, err
		}
		server.Command = command
		server.Args = args
	} else {
		target, err := validateMCPURL(input.URL)
		if err != nil {
			return model.MCPServer{}, err
		}
		server.URL = target
	}
	headers, headerNames, err := normalizeMCPHeaders(input.Headers)
	if err != nil {
		return model.MCPServer{}, err
	}
	if transport == "stdio" {
		headers = nil
		headerNames = nil
	}
	oauthConfig := mcpOAuthConfig{
		TokenURL: strings.TrimSpace(input.OAuthTokenURL), ClientID: strings.TrimSpace(input.OAuthClientID),
		ClientSecret: input.OAuthClientSecret, Scopes: strings.TrimSpace(input.OAuthScopes),
	}
	if oauthConfig.TokenURL != "" {
		if err := validateMCPOAuth(oauthConfig.TokenURL, oauthConfig.ClientID); err != nil {
			return model.MCPServer{}, err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	server.Name = s.uniqueMCPNameLocked(input.Name)
	now := time.Now()
	server.CreatedAt = now
	server.UpdatedAt = now
	if transport == "http" {
		if token := strings.TrimSpace(input.Token); token != "" {
			s.st.Secrets[mcpSecretName(server.ID)] = token
			server.AuthConfigured = true
		}
		if len(headers) > 0 {
			if err := s.saveMCPHeadersLocked(server.ID, headers); err != nil {
				return model.MCPServer{}, err
			}
			server.HeaderNames = headerNames
			server.AuthConfigured = true
		}
		if oauthConfig.TokenURL != "" {
			if err := s.saveMCPOAuthLocked(server.ID, oauthConfig); err != nil {
				return model.MCPServer{}, err
			}
			server.OAuthTokenURL = oauthConfig.TokenURL
			server.OAuthConfigured = true
			server.AuthConfigured = true
		}
		if err := s.st.SaveSecrets(); err != nil {
			return model.MCPServer{}, err
		}
	}
	s.st.State.MCPServers = append(s.st.State.MCPServers, server)
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return server, nil
}

func (s *Service) UpdateMCPServer(id string, patch model.MCPServerPatch) (model.MCPServer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var server *model.MCPServer
	for index := range s.st.State.MCPServers {
		if s.st.State.MCPServers[index].ID == id {
			server = &s.st.State.MCPServers[index]
			break
		}
	}
	if server == nil {
		return model.MCPServer{}, fmt.Errorf("MCP server not found")
	}
	if patch.Name != nil {
		server.Name = s.uniqueMCPNameLocked(*patch.Name)
	}
	if patch.Transport != nil {
		server.Transport = normalizeMCPTransport(*patch.Transport)
	}
	if server.Transport == "" {
		server.Transport = "http"
	}
	if server.Transport == "stdio" {
		if patch.Command != nil {
			server.Command = strings.TrimSpace(*patch.Command)
		}
		if patch.Args != nil {
			args, err := cleanMCPArgs(*patch.Args)
			if err != nil {
				return model.MCPServer{}, err
			}
			server.Args = args
		}
		if strings.TrimSpace(server.Command) == "" {
			return model.MCPServer{}, fmt.Errorf("enter the local MCP command")
		}
		server.URL = ""
		delete(s.st.Secrets, mcpSecretName(id))
		delete(s.st.Secrets, mcpHeadersSecretName(id))
		server.AuthConfigured = false
		server.HeaderNames = nil
		server.OAuthConfigured = false
		server.OAuthTokenURL = ""
		delete(s.st.Secrets, mcpOAuthSecretName(id))
		_ = s.st.SaveSecrets()
	} else {
		if patch.URL != nil {
			target, err := validateMCPURL(*patch.URL)
			if err != nil {
				return model.MCPServer{}, err
			}
			server.URL = target
		}
		if server.URL == "" {
			return model.MCPServer{}, fmt.Errorf("enter a full http(s) MCP URL")
		}
		server.Command = ""
		server.Args = nil
		if patch.Token != nil {
			if token := strings.TrimSpace(*patch.Token); token != "" {
				s.st.Secrets[mcpSecretName(id)] = token
				server.AuthConfigured = true
			}
		}
		if patch.Headers != nil {
			if headers, names, err := normalizeMCPHeaders(*patch.Headers); err != nil {
				return model.MCPServer{}, err
			} else {
				if err := s.saveMCPHeadersLocked(id, headers); err != nil {
					return model.MCPServer{}, err
				}
				server.HeaderNames = names
				server.AuthConfigured = len(headers) > 0 || s.st.Secrets[mcpSecretName(id)] != "" || server.OAuthConfigured
			}
		}
		if err := s.st.SaveSecrets(); err != nil {
			return model.MCPServer{}, err
		}
	}
	if patch.OAuthTokenURL != nil || patch.OAuthClientID != nil || patch.OAuthClientSecret != nil || patch.OAuthScopes != nil {
		config, _ := s.mcpOAuthConfigLocked(id)
		if patch.OAuthTokenURL != nil {
			config.TokenURL = strings.TrimSpace(*patch.OAuthTokenURL)
		}
		if patch.OAuthClientID != nil && strings.TrimSpace(*patch.OAuthClientID) != "" {
			config.ClientID = strings.TrimSpace(*patch.OAuthClientID)
		}
		if patch.OAuthClientSecret != nil && *patch.OAuthClientSecret != "" {
			config.ClientSecret = *patch.OAuthClientSecret
		}
		if patch.OAuthScopes != nil {
			config.Scopes = strings.TrimSpace(*patch.OAuthScopes)
		}
		if config.TokenURL == "" {
			delete(s.st.Secrets, mcpOAuthSecretName(id))
			server.OAuthConfigured = false
			server.OAuthTokenURL = ""
			server.AuthConfigured = s.st.Secrets[mcpSecretName(id)] != "" || len(server.HeaderNames) > 0
		} else {
			if err := validateMCPOAuth(config.TokenURL, config.ClientID); err != nil {
				return model.MCPServer{}, err
			}
			if err := s.saveMCPOAuthLocked(id, config); err != nil {
				return model.MCPServer{}, err
			}
			server.OAuthConfigured = true
			server.OAuthTokenURL = config.TokenURL
			server.AuthConfigured = true
		}
	}
	if patch.Enabled != nil {
		server.Enabled = *patch.Enabled
	}
	server.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return *server, nil
}

func (s *Service) DeleteMCPServer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.st.State.MCPServers {
		if s.st.State.MCPServers[index].ID != id {
			continue
		}
		s.st.State.MCPServers = append(s.st.State.MCPServers[:index], s.st.State.MCPServers[index+1:]...)
		delete(s.st.Secrets, mcpSecretName(id))
		delete(s.st.Secrets, mcpHeadersSecretName(id))
		delete(s.st.Secrets, mcpOAuthSecretName(id))
		_ = s.st.SaveSecrets()
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
		return nil
	}
	return fmt.Errorf("MCP server not found")
}

func (s *Service) mcpConfigsLocked() []model.MCPServerConfig {
	out := make([]model.MCPServerConfig, 0, len(s.st.State.MCPServers))
	for _, server := range s.st.State.MCPServers {
		if !server.Enabled {
			continue
		}
		item := model.MCPServerConfig{
			ID: server.ID, Name: server.Name, Transport: normalizeMCPTransport(server.Transport),
			URL: server.URL, Command: server.Command, Args: append([]string(nil), server.Args...),
		}
		if item.Transport == "http" {
			if server.OAuthConfigured {
				item.Token = s.mcpOAuthAccessTokenLocked(server.ID)
			} else {
				item.Token = s.st.Secrets[mcpSecretName(server.ID)]
			}
			item.Headers = s.mcpHeadersLocked(server.ID)
		}
		out = append(out, item)
	}
	return out
}
