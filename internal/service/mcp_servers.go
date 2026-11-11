package service

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func mcpSecretName(id string) string { return "mcp:" + id }

func validateMCPURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("enter a full http(s) MCP URL")
	}
	return raw, nil
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

// ListMCPServers returns user-managed remote MCP servers without token values.
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
	target, err := validateMCPURL(input.URL)
	if err != nil {
		return model.MCPServer{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	server := model.MCPServer{
		ID: newID("mcp"), Name: s.uniqueMCPNameLocked(input.Name), URL: target,
		Enabled: input.Enabled, CreatedAt: now, UpdatedAt: now,
	}
	if token := strings.TrimSpace(input.Token); token != "" {
		s.st.Secrets[mcpSecretName(server.ID)] = token
		if err := s.st.SaveSecrets(); err != nil {
			return model.MCPServer{}, err
		}
		server.AuthConfigured = true
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
	if patch.URL != nil {
		target, err := validateMCPURL(*patch.URL)
		if err != nil {
			return model.MCPServer{}, err
		}
		server.URL = target
	}
	if patch.Enabled != nil {
		server.Enabled = *patch.Enabled
	}
	if patch.Token != nil {
		if token := strings.TrimSpace(*patch.Token); token != "" {
			s.st.Secrets[mcpSecretName(id)] = token
			server.AuthConfigured = true
			if err := s.st.SaveSecrets(); err != nil {
				return model.MCPServer{}, err
			}
		}
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
		out = append(out, model.MCPServerConfig{
			ID: server.ID, Name: server.Name, URL: server.URL,
			Token: s.st.Secrets[mcpSecretName(server.ID)],
		})
	}
	return out
}
