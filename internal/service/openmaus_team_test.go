package service

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/store"
)

func openMausTeamFixture(t *testing.T) string {
	t.Helper()
	// Upstream shared/package-fixtures/full-team.v2.json at
	// OpenMausBot 0f7abc72bef5d6a586621092593913cecb690fbe (Apache-2.0).
	data, err := os.ReadFile("testdata/openmaus-full-team.v2.json")
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestImportOpenMausTeam(t *testing.T) {
	svc, dir, _ := newTestService(t)
	before := svc.st.State
	result, err := svc.ImportTeam(openMausTeamFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if result.Bots != 3 || result.Groups != 1 || result.Routines != 2 || result.Skills != 3 ||
		result.Playbooks != 1 || result.Memories != 2 || result.Connections != 1 {
		t.Fatalf("unexpected import receipt: %+v", result)
	}
	warnings := strings.Join(result.Warnings, "\n")
	if !strings.Contains(warnings, "Imported MCP connections are disabled") || !strings.Contains(warnings, "default time limit") {
		t.Fatalf("missing unsupported items: %s", warnings)
	}
	reopened, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := reopened.State
	if len(state.Bots) != len(before.Bots)+3 || len(state.MCPServers) != len(before.MCPServers)+1 || len(state.Presets) != len(before.Presets) {
		t.Fatalf("expected three additive bots, one disabled connection and no presets")
	}
	group := state.Groups[len(state.Groups)-1]
	if group.ID != state.ActiveGroupID || group.Name != "Deal desk" || len(group.MemberIDs) != 3 ||
		!strings.Contains(group.Instructions, "Cite sources") {
		t.Fatalf("unexpected imported group: %+v", group)
	}
	morgan := state.Bots[len(before.Bots)]
	if morgan.ID != group.LeadID || morgan.Name != "Morgan" || morgan.Department != "Sales desk" ||
		!strings.Contains(morgan.Soul, "49 per seat") {
		t.Fatalf("unexpected lead: %+v", morgan)
	}
	for _, bot := range state.Bots[len(before.Bots):] {
		if bot.Approval != model.ApprovalAsk {
			t.Fatalf("%q approval = %q, expected Ask", bot.Name, bot.Approval)
		}
	}
	connection := state.MCPServers[len(before.MCPServers)]
	if connection.Enabled || connection.AuthConfigured || connection.URL != "https://mcp.example.com/crm" ||
		!slices.Equal(connection.BotIDs, []string{morgan.ID, state.Bots[len(before.Bots)+1].ID}) ||
		!slices.Equal(connection.RequiredHeaders, []string{"Authorization"}) {
		t.Fatalf("unexpected imported connection: %+v", connection)
	}
	routineIndex := slices.IndexFunc(state.Routines, func(routine model.Routine) bool { return routine.Name == "Daily digest" })
	if routineIndex < 0 {
		t.Fatal("daily digest was not persisted")
	}
	routine := state.Routines[routineIndex]
	if routine.BotID != state.Bots[len(before.Bots)+1].ID || routine.Enabled || !routine.Continuity ||
		routine.Cadence != "weekdays" || routine.TimeOfDay != "09:00" {
		t.Fatalf("unexpected imported routine: %+v", routine)
	}
	roomRoutineIndex := slices.IndexFunc(state.Routines, func(routine model.Routine) bool { return routine.Name == "Weekly pipeline review" })
	if roomRoutineIndex < 0 {
		t.Fatal("channel cron routine was not persisted")
	}
	roomRoutine := state.Routines[roomRoutineIndex]
	if roomRoutine.GroupID != group.ID || roomRoutine.BotID != morgan.ID || roomRoutine.Enabled ||
		roomRoutine.CronExpression != "0 10 * * 1" || roomRoutine.TimeZone != "UTC" || roomRoutine.NextRun.IsZero() {
		t.Fatalf("unexpected channel cron routine: %+v", roomRoutine)
	}
	skills, err := svc.ListSkills(morgan.ID)
	if err != nil {
		t.Fatal(err)
	}
	index := slices.IndexFunc(skills, func(skill model.Skill) bool { return skill.ID == "pricing-policy" })
	if index < 0 || skills[index].Enabled || skills[index].Source != "Workspace" {
		t.Fatalf("expected a disabled bot-local pricing skill: %+v", skills)
	}
	playbooks, err := svc.ListPlaybooks(morgan.ID)
	if err != nil || len(playbooks) != 1 || playbooks[0].Name != "Qualify a lead" || !slices.Contains(playbooks[0].Triggers, "qualify") {
		t.Fatalf("missing imported playbook: %+v, %v", playbooks, err)
	}
	topic, err := svc.ReadMemoryTopic(morgan.ID, "pricing")
	if err != nil || !strings.Contains(topic.Content, "49 per seat") {
		t.Fatalf("missing imported memory topic: %+v, %v", topic, err)
	}
	pkg, err := svc.ExportTeam(group.ID)
	if err != nil || !strings.Contains(pkg, "Cite sources") {
		t.Fatalf("Grox export lost channel instructions: %v", err)
	}

	// OpenMaus v3 reads the same team structure with a larger skill allowance.
	version3 := strings.Replace(openMausTeamFixture(t), `"version": 2`, `"version": 3`, 1)
	if _, err := svc.ImportTeam(version3); err != nil {
		t.Fatal(err)
	}
	if newer := svc.st.State.Bots[len(before.Bots)+3]; newer.ID == morgan.ID || newer.Name != "Morgan 2" {
		t.Fatalf("additive import overwrote earlier bot: %+v", newer)
	}
}

func TestOpenMausImportRollsBack(t *testing.T) {
	svc, dir, _ := newTestService(t)
	before := svc.st.State
	fixture := openMausTeamFixture(t)
	badRef := strings.Replace(fixture, `"agent": "scout"`, `"agent": "missing-bot"`, 1)
	if _, err := svc.ImportTeam(badRef); err == nil || !strings.Contains(err.Error(), "unknown bot") {
		t.Fatalf("invalid cross-reference accepted: %v", err)
	}
	invalidPath := strings.Replace(fixture, `"memory/pricing.md":`, `"memory/../../secret.md":`, 1)
	if _, err := svc.ImportTeam(invalidPath); err == nil || !strings.Contains(err.Error(), "starter note path") {
		t.Fatalf("unsafe path accepted: %v", err)
	}
	// Occupy the state destination with a directory to fail the atomic
	// rename after all imported files have been installed.
	statePath := filepath.Join(dir, "state.json")
	backup := filepath.Join(dir, "state-original.json")
	if err := os.Rename(statePath, backup); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Remove(statePath)
		_ = os.Rename(backup, statePath)
	})
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportTeam(fixture); err == nil || !strings.Contains(err.Error(), "save imported team") {
		t.Fatalf("failed disk write accepted: %v", err)
	}
	after := svc.st.State
	if after.Revision != before.Revision || len(after.Bots) != len(before.Bots) || len(after.Groups) != len(before.Groups) ||
		len(after.Departments) != len(before.Departments) || len(after.Routines) != len(before.Routines) {
		t.Fatal("rejected import mutated the workspace")
	}
	for _, name := range []string{"workspaces", "memory", "playbooks"} {
		if entries, err := os.ReadDir(filepath.Join(dir, name)); !os.IsNotExist(err) && (err != nil || len(entries) != 0) {
			t.Fatalf("rejected import left files under %s: %v %v", name, entries, err)
		}
	}
}

func TestOpenMausChannelBulletinReachesEngine(t *testing.T) {
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || !strings.Contains(string(body), "Cite sources. Morgan answers unless someone is mentioned.") {
			t.Error("configured engine did not receive the channel bulletin")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Ready to research\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer engine.Close()

	svc, _, events := newTestService(t)
	settings := svc.st.State.Settings
	settings.EngineMode, settings.APIBaseURL, settings.APIModel = "api", engine.URL, "test-model"
	if _, err := svc.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportTeam(openMausTeamFixture(t)); err != nil {
		t.Fatal(err)
	}
	state := svc.st.State
	if _, err := svc.SendGroup(state.ActiveGroupID, state.ActiveThreadID, "Find recent leads"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, events, 5*time.Second, "reply from the configured API endpoint", func(ev model.Event) bool {
		return ev.GroupID == state.ActiveGroupID && ev.Type == "message" && ev.Message != nil &&
			!ev.Message.Pending && ev.Message.Text == "Ready to research"
	})
}
