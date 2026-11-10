package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

var composioBaseURL = "https://backend.composio.dev/api/v3.1"

const composioUserID = "grox-local"

var composioToolkits = map[string]string{
	"slack":           "slack",
	"github":          "github",
	"gmail":           "gmail",
	"google-calendar": "googlecalendar",
	"google-sheets":   "googlesheets",
	"google-docs":     "googledocs",
	"google-drive":    "googledrive",
	"notion":          "notion",
	"linear":          "linear",
	"sentry":          "sentry",
	"figma":           "figma",
	"stripe":          "stripe",
	"spotify":         "spotify",
	"x":               "twitter",
	"discord":         "discord",
	"telegram":        "telegram",
	"postgres":        "postgres",
	"vercel":          "vercel",
	"cloudflare":      "cloudflare",
	"zapier":          "zapier",
}

func init() {
	if value := strings.TrimSpace(os.Getenv("COMPOSIO_API_URL")); value != "" {
		composioBaseURL = strings.TrimSuffix(value, "/")
	}
}

func (s *Service) composioKey() string {
	if s.st == nil {
		return ""
	}
	return s.st.Key("composio")
}

type composioError struct {
	Error struct {
		Message string "json:\"message\""
	} "json:\"error\""
	Message string "json:\"message\""
}

func (s *Service) composioRequest(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	key := s.composioKey()
	if key == "" {
		return fmt.Errorf("add a Composio project key in Settings → Connections first")
	}
	endpoint := composioBaseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach Composio: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var parsed composioError
		_ = json.Unmarshal(data, &parsed)
		message := parsed.Error.Message
		if message == "" {
			message = parsed.Message
		}
		if message == "" {
			message = strings.TrimSpace(string(data))
		}
		if len(message) > 300 {
			message = message[:300] + "…"
		}
		return fmt.Errorf("Composio returned %s: %s", resp.Status, message)
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("could not read Composio's response: %w", err)
		}
	}
	return nil
}

func composioToolkitForApp(appID string) string {
	return composioToolkits[appID]
}

// ConnectComposioApp creates a hosted OAuth link for one catalog app.
func (s *Service) ConnectComposioApp(appID string) (model.ComposioLink, error) {
	slug := composioToolkitForApp(appID)
	if slug == "" {
		return model.ComposioLink{}, fmt.Errorf("this app has no Composio toolkit mapping yet")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	var configs struct {
		Items []struct {
			ID     string "json:\"id\""
			Status string "json:\"status\""
		} "json:\"items\""
	}
	query := url.Values{}
	query.Set("toolkit_slug", slug)
	if err := s.composioRequest(ctx, http.MethodGet, "/auth_configs", query, nil, &configs); err != nil {
		return model.ComposioLink{}, err
	}
	configID := ""
	for _, config := range configs.Items {
		if strings.EqualFold(config.Status, "ENABLED") || config.Status == "" {
			configID = config.ID
			break
		}
	}
	if configID == "" && len(configs.Items) > 0 {
		configID = configs.Items[0].ID
	}
	if configID == "" {
		return model.ComposioLink{}, fmt.Errorf("no Composio auth config exists for %s yet. Create one for this toolkit in Composio, then try again", slug)
	}
	var link struct {
		URL       string "json:\"redirect_url\""
		AccountID string "json:\"connected_account_id\""
	}
	payload := map[string]any{"auth_config_id": configID, "user_id": composioUserID}
	if err := s.composioRequest(ctx, http.MethodPost, "/connected_accounts/link", nil, payload, &link); err != nil {
		return model.ComposioLink{}, err
	}
	s.mu.Lock()
	if s.st != nil {
		connection := s.st.State.Connections[appID]
		connection.ID = appID
		connection.ExternalID = link.AccountID
		connection.Connected = false
		connection.Account = "Waiting for OAuth"
		s.st.State.Connections[appID] = connection
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
	}
	s.mu.Unlock()
	if link.URL != "" && os.Getenv("GROX_NO_BROWSER") != "1" {
		openExternalURL(link.URL)
	}
	return model.ComposioLink{AppID: appID, URL: link.URL, AccountID: link.AccountID}, nil
}

// RefreshComposioConnections reconciles the local connection map with the
// connected accounts on Composio.
func (s *Service) RefreshComposioConnections() (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	var result struct {
		Items []struct {
			ID      string "json:\"id\""
			Status  string "json:\"status\""
			Alias   string "json:\"alias\""
			Toolkit struct {
				Slug string "json:\"slug\""
			} "json:\"toolkit\""
		} "json:\"items\""
	}
	query := url.Values{}
	query.Set("user_ids", composioUserID)
	query.Set("limit", "100")
	if err := s.composioRequest(ctx, http.MethodGet, "/connected_accounts", query, nil, &result); err != nil {
		return 0, err
	}
	byToolkit := map[string]string{}
	for _, item := range result.Items {
		if strings.EqualFold(item.Status, "ACTIVE") {
			label := item.Alias
			if label == "" {
				label = item.Toolkit.Slug
			}
			byToolkit[item.Toolkit.Slug] = label
		}
	}
	count := 0
	s.mu.Lock()
	if s.st != nil {
		for appID, slug := range composioToolkits {
			connection, ok := s.st.State.Connections[appID]
			if !ok {
				continue
			}
			if label, active := byToolkit[slug]; active {
				connection.Connected = true
				connection.Account = label
				if connection.ConnectedAt.IsZero() {
					connection.ConnectedAt = time.Now()
				}
				count++
			} else if strings.EqualFold(connection.Account, "Waiting for OAuth") {
				connection.Connected = false
				connection.Account = ""
			}
			s.st.State.Connections[appID] = connection
		}
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
	}
	s.mu.Unlock()
	go s.warmComposioTools()
	return count, nil
}

// DisconnectComposioApp revokes a connected account when it has an external id.
func (s *Service) DisconnectComposioApp(appID string) error {
	s.mu.Lock()
	connection := s.st.State.Connections[appID]
	s.mu.Unlock()
	if connection.ExternalID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err := s.composioRequest(ctx, http.MethodDelete, "/connected_accounts/"+url.PathEscape(connection.ExternalID), nil, nil, nil)
		cancel()
		if err != nil {
			return err
		}
	}
	s.mu.Lock()
	if s.st != nil {
		connection = s.st.State.Connections[appID]
		connection.Connected = false
		connection.Account = ""
		connection.ExternalID = ""
		connection.ConnectedAt = time.Time{}
		s.st.State.Connections[appID] = connection
		s.touchLocked()
		s.saveLocked()
		s.emitStateLocked()
	}
	s.mu.Unlock()
	return nil
}

func (s *Service) composioSession(ctx context.Context) (string, error) {
	var session struct {
		ID string "json:\"session_id\""
	}
	payload := map[string]any{
		"user_id":            composioUserID,
		"manage_connections": map[string]any{"enable": true},
	}
	if err := s.composioRequest(ctx, http.MethodPost, "/tool_router/session", nil, payload, &session); err != nil {
		return "", err
	}
	if session.ID == "" {
		return "", fmt.Errorf("Composio did not return a session id")
	}
	return session.ID, nil
}

// ListComposioTools returns tools from a fresh tool-router session.
func (s *Service) ListComposioTools() ([]model.ComposioTool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sessionID, err := s.composioSession(ctx)
	if err != nil {
		return nil, err
	}
	var result struct {
		Items []struct {
			Slug        string         "json:\"slug\""
			Name        string         "json:\"name\""
			Description string         "json:\"description\""
			InputSchema map[string]any "json:\"input_parameters\""
			Toolkit     struct {
				Slug string "json:\"slug\""
			} "json:\"toolkit\""
		} "json:\"items\""
	}
	query := url.Values{}
	query.Set("limit", "200")
	if err := s.composioRequest(ctx, http.MethodGet, "/tool_router/session/"+url.PathEscape(sessionID)+"/tools", query, nil, &result); err != nil {
		return nil, err
	}
	tools := make([]model.ComposioTool, 0, len(result.Items))
	for _, item := range result.Items {
		tools = append(tools, model.ComposioTool{
			Slug: item.Slug, Name: item.Name, Description: item.Description, Toolkit: item.Toolkit.Slug, InputSchema: item.InputSchema,
		})
	}
	s.composioToolsMu.Lock()
	s.composioTools = tools
	s.composioToolsAt = time.Now()
	s.composioToolsMu.Unlock()
	return tools, nil
}

func (s *Service) cachedComposioTools() []model.ComposioTool {
	s.composioToolsMu.Lock()
	defer s.composioToolsMu.Unlock()
	if len(s.composioTools) == 0 || time.Since(s.composioToolsAt) > 15*time.Minute {
		return nil
	}
	out := make([]model.ComposioTool, len(s.composioTools))
	copy(out, s.composioTools)
	return out
}

func (s *Service) warmComposioTools() {
	if s.composioKey() == "" {
		return
	}
	if len(s.cachedComposioTools()) > 0 {
		return
	}
	_, _ = s.ListComposioTools()
}

// ExecuteComposioTool runs one live Composio tool with JSON arguments.
func (s *Service) ExecuteComposioTool(slug string, arguments map[string]any) (any, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, fmt.Errorf("choose a tool first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	sessionID, err := s.composioSession(ctx)
	if err != nil {
		return nil, err
	}
	var result struct {
		Data  any    "json:\"data\""
		Error string "json:\"error\""
	}
	payload := map[string]any{"tool_slug": slug, "arguments": arguments}
	if err := s.composioRequest(ctx, http.MethodPost, "/tool_router/session/"+url.PathEscape(sessionID)+"/execute", nil, payload, &result); err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, fmt.Errorf("%s", result.Error)
	}
	return result.Data, nil
}

func openExternalURL(target string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	_ = cmd.Start()
}
