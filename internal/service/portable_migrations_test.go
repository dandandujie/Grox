package service

import (
	"os"
	"strings"
	"testing"

	"github.com/dandandujie/grox/internal/model"
)

func TestImportBotMRRBlueprint(t *testing.T) {
	svc, _, _ := newTestService(t)
	data, err := os.ReadFile("testdata/openmaus-legacy-botmrr.v1.md")
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.ImportTeam(string(data))
	if err != nil {
		t.Fatal(err)
	}
	if result.Name != "Signal Desk" || result.Bots != 2 || result.Groups != 1 || result.Skills != 1 || result.Playbooks != 1 || result.Routines != 1 {
		t.Fatalf("unexpected BotMRR receipt: %+v", result)
	}
	group := svc.findGroupLocked(svc.st.State.ActiveGroupID)
	if group.Name != "Signal Room" || svc.findBotLocked(group.LeadID).Name != "Package Scout" ||
		group.Instructions != "Separate direct evidence from inference." {
		t.Fatalf("unexpected BotMRR room: %+v", group)
	}
}

func TestImportSplitGrokBotReply(t *testing.T) {
	svc, _, _ := newTestService(t)
	// Stand-in values use the same format as the export prompt. No real keys.
	fence := strings.Repeat("`", 3)
	input := "Here is part one:\n" + fence + `json
{"format":"grok-bot-export","version":1,"bots":[{"name":"Parcels","title":"Household logistics","instructions":"Summarize parcels and keep Bearer xai-123456789012345678901234 out of notes.","memories":["The building has a mail room."],"skills":[{"name":"shipping","description":"Find shipment delays","instructions":"Compare the carrier ETA against actual scans."}],}]}
` + fence + `
Part two:
{"format":"grok-bot-export","version":1,"bots":[{"name":"parcels","user_facts":[{"text":"Prefers compact updates."}],"memories":["The building has a mail room."],"routines":[{"name":"Morning check","instruction":"Find late shipments.","trigger":"schedule","schedule_cron":"0 9 * * 1-5"},{"name":"On a GitHub update","instruction":"Summarize the update.","trigger":"github","trigger_details":"repository parcel-tracker"}],"apps":["GitHub"]}]}`
	receipt, err := svc.ImportTeam(input)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Bots != 1 || receipt.Skills != 1 || receipt.Routines != 1 || receipt.Memories != 3 || receipt.Groups != 0 {
		t.Fatalf("unexpected Grok receipt: %+v", receipt)
	}
	state := svc.st.State
	bot := svc.findBotLocked(state.ActiveBotID)
	if bot.Name != "Parcels" || bot.Approval != model.ApprovalAsk ||
		strings.Contains(bot.Soul, "xai-123456789") || !strings.Contains(bot.Soul, "[redacted]") {
		t.Fatalf("unexpected Grok bot: %+v", bot)
	}
	memory, err := svc.GetMemory(bot.ID)
	if err != nil || strings.Count(memory.Content, "The building has a mail room.") != 1 ||
		!strings.Contains(memory.Content, "Prefers compact updates.") {
		t.Fatalf("memory not merged: %+v, %v", memory, err)
	}
	note, err := svc.ReadMemoryTopic(bot.ID, "grok-bot-event-routines")
	if err != nil || !strings.Contains(note.Content, "repository parcel-tracker") {
		t.Fatalf("event routine not saved as a note: %+v, %v", note, err)
	}
	routine := state.Routines[len(state.Routines)-1]
	if routine.Name != "Morning check" || routine.Enabled || routine.Cadence != "weekdays" || routine.TimeOfDay != "09:00" {
		t.Fatalf("wrong imported routine: %+v", routine)
	}

	badInput := `{"format":"grok-bot-export","version":1,"bots":[{"name":"New bot","apiKey":"example"}]}`
	if _, err := svc.ImportTeam(badInput); err == nil || !strings.Contains(err.Error(), "credential fields") {
		t.Fatalf("credential field accepted: %v", err)
	}
	if svc.st.State.Revision != state.Revision {
		t.Fatal("refused Grok export changed the workspace")
	}
	if _, err := svc.ImportTeam(input + ` {"format":"grok-bot-export","version":1,"bots":[`); err == nil || !strings.Contains(err.Error(), "missing part") {
		t.Fatalf("partially copied split reply accepted: %v", err)
	}
	again, err := svc.ImportTeam(input)
	if err != nil || again.Bots != 0 || svc.st.State.Revision != state.Revision {
		t.Fatalf("previously migrated bot should not be duplicated: %+v, %v", again, err)
	}
}
