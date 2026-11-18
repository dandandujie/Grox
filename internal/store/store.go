// Package store persists the workspace to disk and initializes new workspaces.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/catalog"
	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

// Store owns the state document and the write-only secrets file.
type Store struct {
	Dir     string
	State   model.AppState
	Secrets map[string]string
}

// Open loads a workspace, seeding a new one when state.json is absent.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{Dir: dir, Secrets: map[string]string{}}
	if err := s.loadSecrets(); err != nil {
		return nil, err
	}
	path := s.statePath()
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		s.State = Seed(time.Now())
		s.Normalize()
		if err := s.SaveState(); err != nil {
			return nil, err
		}
		return s, nil
	}
	var state model.AppState
	if err := json.Unmarshal(data, &state); err != nil {
		// Keep the unreadable file for the person to inspect, then start over.
		_ = os.WriteFile(path+".broken-"+time.Now().Format("20060102-150405"), data, 0o600)
		s.State = Seed(time.Now())
		return s, s.SaveState()
	}
	s.State = state
	s.Normalize()
	return s, nil
}

func (s *Store) statePath() string   { return filepath.Join(s.Dir, "state.json") }
func (s *Store) secretsPath() string { return filepath.Join(s.Dir, "secrets.json") }

func (s *Store) loadSecrets() error {
	data, err := os.ReadFile(s.secretsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return json.Unmarshal(data, &s.Secrets)
}

// SaveState writes state.json atomically with private permissions.
func (s *Store) SaveState() error {
	data, err := json.MarshalIndent(s.State, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.statePath(), data)
}

// SaveSecrets writes secrets.json atomically with private permissions.
func (s *Store) SaveSecrets() error {
	data, err := json.MarshalIndent(s.Secrets, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.secretsPath(), data)
}

func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// Key returns a stored secret, or the matching environment variable. A
// stored key always wins; the environment is a convenience for CLI users.
func (s *Store) Key(name string) string {
	if v := s.Secrets[name]; v != "" {
		return v
	}
	env := map[string]string{
		"xai": "XAI_API_KEY", "openai": "OPENAI_API_KEY",
		"anthropic": "ANTHROPIC_API_KEY", "google": "GEMINI_API_KEY",
		"composio": "COMPOSIO_API_KEY", "api": "GROX_API_KEY",
	}
	if e, ok := env[name]; ok {
		return os.Getenv(e)
	}
	return ""
}

// SetSecret stores a key and returns an error when the value is blank.
func (s *Store) SetSecret(name, value string) error {
	if value == "" {
		return fmt.Errorf("the key is empty")
	}
	if s.Secrets == nil {
		s.Secrets = map[string]string{}
	}
	s.Secrets[name] = value
	return s.SaveSecrets()
}

// ClearSecret forgets a stored key. Environment keys are untouched.
func (s *Store) ClearSecret(name string) error {
	delete(s.Secrets, name)
	return s.SaveSecrets()
}

// SecretStatus never exposes a value, only whether one exists and its tail.
func (s *Store) SecretStatus() model.SecretStatus {
	status := model.SecretStatus{Configured: map[string]bool{}, Hints: map[string]string{}}
	for _, name := range []string{"xai", "openai", "anthropic", "google", "composio", "api"} {
		value := s.Key(name)
		if value == "" {
			continue
		}
		status.Configured[name] = true
		if len(value) > 4 {
			status.Hints[name] = "••••" + value[len(value)-4:]
		} else {
			status.Hints[name] = "••••"
		}
	}
	return status
}

// Normalize repairs a freshly loaded document and fills defaults.
func (s *Store) Normalize() {
	st := &s.State
	if st.Version < 2 {
		// Version 1 wrote English by default and had no language selector.
		st.Version = 2
		if st.Settings.Language == "en" {
			st.Settings.Language = "zh"
		}
	}
	if st.Connections == nil {
		st.Connections = map[string]model.Connection{}
	}
	if st.Bots == nil {
		st.Bots = []model.Bot{}
	}
	for index := range st.Bots {
		if strings.TrimSpace(st.Bots[index].Department) == "" {
			st.Bots[index].Department = "General"
		}
	}
	if st.Departments == nil {
		st.Departments = []model.Department{}
	}
	seenDepartments := map[string]bool{}
	for _, department := range st.Departments {
		seenDepartments[strings.ToLower(strings.TrimSpace(department.Name))] = true
	}
	ensureDepartment := func(name string, now time.Time) {
		name = strings.TrimSpace(name)
		if name == "" || seenDepartments[strings.ToLower(name)] {
			return
		}
		seenDepartments[strings.ToLower(name)] = true
		id := "dept-" + strings.ToLower(strings.ReplaceAll(name, " ", "-"))
		for _, department := range st.Departments {
			if department.ID == id {
				id += "-2"
			}
		}
		st.Departments = append(st.Departments, model.Department{ID: id, Name: name, CreatedAt: now, UpdatedAt: now})
	}
	ensureDepartment("General", st.CreatedAt)
	for _, bot := range st.Bots {
		ensureDepartment(bot.Department, st.CreatedAt)
	}
	if st.Webhooks == nil {
		st.Webhooks = []model.Webhook{}
	}
	if st.WebhookDeliveries == nil {
		st.WebhookDeliveries = []model.WebhookDelivery{}
	}
	if st.MCPServers == nil {
		st.MCPServers = []model.MCPServer{}
	}
	if st.Presets == nil {
		st.Presets = DefaultPresets(time.Now())
	}
	for appID, app := range appCatalogMap() {
		c, ok := st.Connections[appID]
		if !ok {
			st.Connections[appID] = model.Connection{ID: app.ID}
			continue
		}
		c.ID = app.ID
		st.Connections[appID] = c
	}
	if st.Settings.Theme == "" {
		st.Settings.Theme = "midnight"
	}
	if st.Settings.Language != "en" && st.Settings.Language != "zh" {
		st.Settings.Language = "zh"
	}
	if st.Settings.SidebarWidth < 240 || st.Settings.SidebarWidth > 480 {
		st.Settings.SidebarWidth = 312
	}
	if st.Settings.EngineMode == "" {
		st.Settings.EngineMode = "auto"
	}
	now := time.Now()
	for bi := range st.Bots {
		b := &st.Bots[bi]
		if b.Color == "" {
			b.Color = "green"
		}
		if b.MascotShape == "" {
			b.MascotShape = "cursor"
		}
		if b.Expression == "" {
			b.Expression = "idle"
		}
		if b.Approval == "" {
			b.Approval = model.ApprovalAsk
		}
		if b.ModelID == "" {
			b.ModelID = "grox-demo"
		}
		if b.CreatedAt.IsZero() {
			b.CreatedAt = now
		}
		if b.UpdatedAt.IsZero() {
			b.UpdatedAt = now
		}
		if len(b.Threads) == 0 {
			b.Threads = []model.Thread{{ID: "thread-" + b.ID, BotID: b.ID, Title: "New conversation", Kind: "chat", CreatedAt: now, UpdatedAt: now}}
		}
		for ti := range b.Threads {
			normalizeThread(&b.Threads[ti], "chat", now)
		}
	}
	if st.Groups == nil {
		st.Groups = []model.Group{}
	}
	for gi := range st.Groups {
		g := &st.Groups[gi]
		if g.Name == "" {
			g.Name = "Channel"
		}
		if g.Color == "" {
			g.Color = "purple"
		}
		if g.CreatedAt.IsZero() {
			g.CreatedAt = now
		}
		if g.UpdatedAt.IsZero() {
			g.UpdatedAt = now
		}
		members := []string{}
		for _, id := range g.MemberIDs {
			if findBot(st, id) != nil {
				members = append(members, id)
			}
		}
		g.MemberIDs = members
		leadOK := false
		for _, id := range members {
			if id == g.LeadID {
				leadOK = true
			}
		}
		if !leadOK && len(members) > 0 {
			g.LeadID = members[0]
		}
		if len(members) == 0 {
			g.LeadID = ""
		}
		if len(g.Threads) == 0 {
			g.Threads = []model.Thread{{ID: "thread-" + g.ID, Title: "New conversation", Kind: "group", CreatedAt: now, UpdatedAt: now}}
		}
		for ti := range g.Threads {
			normalizeThread(&g.Threads[ti], "group", now)
		}
	}
	for i := range st.Runs {
		run := &st.Runs[i]
		if run.Status != "running" {
			continue
		}
		run.Status = "stopped"
		run.FinishedAt = now
		run.Summary = "Grox restarted before the run finished."
		for j := range st.Routines {
			routine := &st.Routines[j]
			if routine.ID == run.RoutineID && routine.LastRun.Equal(run.StartedAt) {
				routine.LastStatus = run.Status
				break
			}
		}
	}
	if len(st.Runs) > 60 {
		st.Runs = st.Runs[len(st.Runs)-60:]
	}
	if st.ActiveGroupID != "" {
		if g := findGroup(st, st.ActiveGroupID); g != nil {
			st.ActiveBotID = ""
			if !hasGroupThread(g, st.ActiveThreadID) {
				st.ActiveThreadID = ""
				if len(g.Threads) > 0 {
					st.ActiveThreadID = g.Threads[0].ID
				}
			}
		} else {
			st.ActiveGroupID = ""
		}
	}
	if st.ActiveGroupID == "" {
		if !hasBot(st, st.ActiveBotID) {
			st.ActiveBotID = ""
			for _, b := range st.Bots {
				if !b.Hidden && !b.Archived {
					st.ActiveBotID = b.ID
					break
				}
			}
		}
		if b := findBot(st, st.ActiveBotID); b != nil {
			if !hasThread(b, st.ActiveThreadID) {
				st.ActiveThreadID = ""
				if len(b.Threads) > 0 {
					st.ActiveThreadID = b.Threads[0].ID
				}
			}
		}
	}
	for ri := range st.Routines {
		r := &st.Routines[ri]
		if r.Cadence == "" {
			r.Cadence = "daily"
		}
		if r.TimeOfDay == "" {
			r.TimeOfDay = "09:00"
		}
		r.TimeOfDay = schedule.Clock(r.TimeOfDay)
		if r.NextRun.IsZero() {
			r.NextRun = schedule.Next(*r, now)
		}
	}
	sort.SliceStable(st.Routines, func(i, j int) bool { return st.Routines[i].NextRun.Before(st.Routines[j].NextRun) })
}

// Reset replaces the workspace with a fresh seed. The caller keeps the
// returned state; secrets are left alone.
func (s *Store) Reset(now time.Time) error {
	language := s.State.Settings.Language
	s.State = Seed(now)
	if language == "en" {
		s.State.Settings.Language = language
	}
	if err := s.SaveState(); err != nil {
		return err
	}
	return nil
}

func normalizeThread(thread *model.Thread, kind string, now time.Time) {
	if thread.Title == "" {
		thread.Title = "New conversation"
	}
	if thread.Kind == "" {
		thread.Kind = kind
	}
	for index := range thread.Messages {
		message := &thread.Messages[index]
		message.Pending = false
		if thread.Busy && message.Status == model.StatusPending && (message.Kind == model.KindApproval || message.Kind == model.KindOptions) {
			message.Status = "expired"
		}
		if message.Kind == "" {
			message.Kind = model.KindText
		}
		if message.CreatedAt.IsZero() {
			message.CreatedAt = thread.CreatedAt
		}
	}
	if thread.Busy {
		thread.Messages = append(thread.Messages, model.Message{
			ID: fmt.Sprintf("%s-interrupted-%d", thread.ID, len(thread.Messages)), Role: model.RoleBot, Kind: model.KindNotice,
			Status: "stopped", Text: "Grox closed before this turn finished.", CreatedAt: now, UpdatedAt: now,
		})
		thread.UpdatedAt = now
	}
	thread.Busy = false
	thread.Status = ""
	if thread.Messages == nil {
		thread.Messages = []model.Message{}
	}
}

func hasBot(st *model.AppState, id string) bool { return findBot(st, id) != nil }

func findBot(st *model.AppState, id string) *model.Bot {
	for i := range st.Bots {
		if st.Bots[i].ID == id {
			return &st.Bots[i]
		}
	}
	return nil
}

func findGroup(st *model.AppState, id string) *model.Group {
	for i := range st.Groups {
		if st.Groups[i].ID == id {
			return &st.Groups[i]
		}
	}
	return nil
}

func hasGroupThread(g *model.Group, id string) bool {
	for _, t := range g.Threads {
		if t.ID == id {
			return true
		}
	}
	return false
}

func hasThread(b *model.Bot, id string) bool {
	for _, t := range b.Threads {
		if t.ID == id {
			return true
		}
	}
	return false
}

func appCatalogMap() map[string]model.AppEntry {
	out := map[string]model.AppEntry{}
	for _, a := range catalog.Apps() {
		out[a.ID] = a
	}
	return out
}
