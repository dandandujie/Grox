package service

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

var (
	portableHeaderName   = regexp.MustCompile(`^[!#$%&'*+.^_|~0-9A-Za-z-]{1,128}$`)
	portableQuerySecrets = regexp.MustCompile(`(?i)key|token|secret|pass|auth|sig|session|credential`)
	portableOpaquePath   = regexp.MustCompile(`^[A-Za-z0-9_-]{24,}$`)
	portablePathDigit    = regexp.MustCompile(`[0-9]`)
	portablePathLetter   = regexp.MustCompile(`[A-Za-z]`)
)

func portableHeaderNames(values []string) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		name := strings.TrimSpace(value)
		key := strings.ToLower(name)
		if !portableHeaderName.MatchString(name) || seen[key] {
			continue
		}
		seen[key] = true
		names = append(names, name)
		if len(names) == 16 {
			break
		}
	}
	return names
}

func portableMCPAddress(value string, allowLoopback bool, scrub *openMausText) (string, bool) {
	address, err := url.Parse(strings.TrimSpace(value))
	if err != nil || address.Hostname() == "" || address.Opaque != "" {
		return "", false
	}
	if address.Scheme != "https" {
		ip := net.ParseIP(address.Hostname())
		if !allowLoopback || address.Scheme != "http" ||
			(!strings.EqualFold(address.Hostname(), "localhost") && (ip == nil || !ip.IsLoopback())) {
			return "", false
		}
	}
	original := address.String()
	address.User = nil
	address.Fragment = ""
	address.RawFragment = ""
	query := address.Query()
	for name, values := range query {
		if portableQuerySecrets.MatchString(name) || slices.ContainsFunc(values, func(value string) bool {
			return scrubPortableCredentials(value, scrub.secrets) != value
		}) {
			query.Del(name)
		}
	}
	address.RawQuery = query.Encode()
	clean := address.String()
	if clean != original {
		scrub.redacted = true
	}
	for part := range strings.SplitSeq(address.Path, "/") {
		if (portableOpaquePath.MatchString(part) && portablePathDigit.MatchString(part) && portablePathLetter.MatchString(part)) ||
			scrubPortableCredentials(part, scrub.secrets) != part {
			return "", false
		}
	}
	if scrub.clean(clean) != clean || len(clean) > 2_000 {
		return "", false
	}
	return clean, true
}

func (s *Service) installOpenMausConnections(pkg openMausTeam, botIDs map[string]string, now time.Time, result *model.TeamImportResult) {
	botsByConnection := map[string][]string{}
	for _, bot := range pkg.Agents {
		botID := botIDs[bot.Key]
		if botID == "" {
			continue
		}
		for _, key := range bot.Connections {
			botsByConnection[key] = append(botsByConnection[key], botID)
		}
	}
	scrub := openMausText{}
	for _, item := range pkg.Connections {
		bots := botsByConnection[item.Key]
		if len(bots) == 0 {
			continue
		}
		label := scrub.oneLine(item.Label, 100)
		if label == "" {
			label = item.Key
		}
		address, ok := portableMCPAddress(item.MCP.URL, true, &scrub)
		if !ok || item.MCP.Transport != "http" {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Connection %q needs manual setup.", label))
			continue
		}
		s.st.State.MCPServers = append(s.st.State.MCPServers, model.MCPServer{
			ID: newID("mcp"), Name: s.uniqueMCPNameLocked(label), Transport: "http", URL: address,
			BotIDs: bots, RequiredHeaders: portableHeaderNames(item.MCP.ValueNames),
			CreatedAt: now, UpdatedAt: now,
		})
		result.Connections++
	}
	if result.Connections != 0 {
		result.Warnings = append(result.Warnings, "Imported MCP connections are disabled until you configure and enable them in Settings.")
	}
	if scrub.redacted {
		result.Warnings = append(result.Warnings, "Credential-shaped text and URL details were removed from connections.")
	}
}

func (s *Service) exportOpenMausConnections(pkg *openMausTeam, agentKeys map[string]string, scrub *openMausText, result *model.OpenMausExport) error {
	for _, server := range s.st.State.MCPServers {
		if !server.Enabled {
			continue
		}
		agents := []int{}
		for botID, key := range agentKeys {
			if len(server.BotIDs) == 0 || slices.Contains(server.BotIDs, botID) {
				if index := slices.IndexFunc(pkg.Agents, func(agent openMausAgent) bool { return agent.Key == key }); index >= 0 {
					agents = append(agents, index)
				}
			}
		}
		if len(agents) == 0 {
			continue
		}
		name := scrub.oneLine(server.Name, 100)
		address, ok := portableMCPAddress(server.URL, true, scrub)
		if !ok || server.Transport == "stdio" {
			result.Warnings = append(result.Warnings, fmt.Sprintf("Connection %q needs manual setup in OpenMausBot.", name))
			continue
		}
		if len(pkg.Connections) == 20 {
			return fmt.Errorf("OpenMaus accepts at most 20 connections per team")
		}
		item := openMausConnection{
			Key: fmt.Sprintf("connection-%d", len(pkg.Connections)+1), Label: name, Reason: "MCP connection from Grox",
		}
		if item.Label == "" {
			item.Label = item.Key
		}
		item.MCP.Transport = "http"
		item.MCP.URL = address
		names := slices.Concat(server.HeaderNames, server.RequiredHeaders)
		if server.AuthConfigured && (server.OAuthConfigured || s.st.Secrets[mcpSecretName(server.ID)] != "") {
			names = append(names, "Authorization")
		}
		item.MCP.ValueNames = portableHeaderNames(names)
		pkg.Connections = append(pkg.Connections, item)
		for _, index := range agents {
			pkg.Agents[index].Connections = append(pkg.Agents[index].Connections, item.Key)
		}
	}
	return nil
}
