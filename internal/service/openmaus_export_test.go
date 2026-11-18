package service

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

func TestExportOpenMausTeamPortability(t *testing.T) {
	svc, _, _ := newTestService(t)
	if _, err := svc.ImportTeam(openMausTeamFixture(t)); err != nil {
		t.Fatal(err)
	}
	group := svc.findGroupLocked(svc.st.State.ActiveGroupID)
	groupID, botID := group.ID, group.LeadID
	const held = "local-test-value-24"
	if _, err := svc.SetSecret("api", held); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateBot(botID, model.BotPatch{Soul: ptr("Ask first. Do not repeat " + held)}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetSkillEnabled(botID, "pricing-policy", true); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateMCPServer(model.MCPServerInput{
		Name: "another CRM", URL: "https://server.example/mcp?token=opaque-test-value&mode=team",
		Enabled: true, BotIDs: []string{botID}, Token: "configured-token",
	}); err != nil {
		t.Fatal(err)
	}

	for _, includeNotes := range []bool{false, true} {
		exported, err := svc.ExportOpenMausTeam(groupID, includeNotes)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(exported.Filename, ".openmaus.json") || len(exported.Warnings) == 0 ||
			strings.Contains(exported.Document, held) || strings.Contains(exported.Document, "opaque-test-value") ||
			strings.Contains(exported.Document, "configured-token") {
			t.Fatalf("wrong output name or credential filtering")
		}
		var decoded openMausTeamDocument
		if err := json.Unmarshal([]byte(exported.Document), &decoded); err != nil {
			t.Fatal(err)
		}
		pkg := decoded.Package
		if decoded.Version != 2 || len(pkg.Agents) != 3 || len(pkg.Rooms) != 1 || len(pkg.Skills.Entries) != 1 ||
			len(pkg.Playbooks) != 1 || len(pkg.Routines) != 2 || len(pkg.Connections) != 1 {
			t.Fatalf("incomplete portable manifest")
		}
		lead := pkg.Agents[0]
		connection := pkg.Connections[0]
		channelRoutine := pkg.Routines[1]
		if pkg.Team.Leader != lead.Key || pkg.Rooms[0].DefaultResponder.Agent != lead.Key ||
			pkg.Rooms[0].Bulletin != group.Instructions || !strings.Contains(lead.Soul, "[redacted]") ||
			(len(lead.Seed.Memory) > 0) != includeNotes ||
			!slices.Equal(lead.Connections, []string{connection.Key}) ||
			connection.MCP.URL != "https://server.example/mcp?mode=team" ||
			channelRoutine.Room != pkg.Rooms[0].Key || channelRoutine.Schedule.Expression != "0 10 * * 1" ||
			channelRoutine.Schedule.TimeZone != "UTC" ||
			!slices.Equal(connection.MCP.ValueNames, []string{"Authorization"}) {
			t.Fatalf("portable references or note selection did not round-trip")
		}
		receiver, _, _ := newTestService(t)
		receipt, err := receiver.ImportTeam(exported.Document)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.Routines != 2 || receipt.Connections != 1 || (receipt.Memories > 0) != includeNotes {
			t.Fatalf("imported contents differ from export: %+v", receipt)
		}
	}
}
