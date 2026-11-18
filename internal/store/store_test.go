package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func TestReopenRecoversInterruptedTurn(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	thread := &s.State.Bots[0].Threads[0]
	thread.Busy = true
	thread.Messages = []model.Message{
		{ID: "user-request", Role: model.RoleUser, Text: "Summarize these notes"},
		{ID: "pending-permission", Role: model.RoleBot, Kind: model.KindApproval, Status: model.StatusPending},
	}
	s.State.Runs = []model.Run{{ID: "run-interrupted", Status: "running", StartedAt: time.Now()}}
	if err := s.SaveState(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	recovered := reopened.State.Bots[0].Threads[0]
	if recovered.Busy || len(recovered.Messages) != 3 || recovered.Messages[0].Text != "Summarize these notes" || recovered.Messages[1].Status != "expired" || recovered.Messages[2].Status != "stopped" {
		t.Fatalf("reopened turn = %+v", recovered)
	}
	if reopened.State.Runs[0].Status != "stopped" {
		t.Fatalf("reopened run = %+v", reopened.State.Runs[0])
	}
}

func TestOpenSeedsAndPersists(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.State.Settings.Language != "zh" {
		t.Fatalf("fresh workspace language = %q", s.State.Settings.Language)
	}
	if len(s.State.Bots) != 1 {
		t.Fatalf("expected one starter agent, got %d", len(s.State.Bots))
	}
	if len(s.State.Bots[0].Threads) != 1 || len(s.State.Bots[0].Threads[0].Messages) != 0 || len(s.State.Groups)+len(s.State.Routines)+len(s.State.Runs) != 0 {
		t.Fatal("a fresh workspace must not contain sample work or scheduled actions")
	}
	if s.State.ActiveBotID == "" || s.State.ActiveThreadID == "" {
		t.Fatal("expected an active bot and thread")
	}
	if err := s.SetSecret("xai", "test-key-1234"); err != nil {
		t.Fatal(err)
	}
	if s.Key("xai") != "test-key-1234" {
		t.Fatal("stored key not readable")
	}
	status := s.SecretStatus()
	if !status.Configured["xai"] || status.Hints["xai"] == "" {
		t.Fatalf("unexpected secret status: %+v", status)
	}
	// The secrets file must be private.
	info, err := os.Stat(filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("secrets file permissions = %v", info.Mode().Perm())
	}
	if err := s.SaveState(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.State.Bots) != len(s.State.Bots) {
		t.Fatalf("reopened bots = %d, want %d", len(reopened.State.Bots), len(s.State.Bots))
	}
	if reopened.Key("xai") != "test-key-1234" {
		t.Fatal("secret did not persist")
	}
}

func TestCorruptStateIsBackedUp(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.State.Bots) == 0 {
		t.Fatal("expected a fresh seed after corrupt state")
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "state.json.broken-*"))
	if len(matches) != 1 {
		t.Fatalf("expected one backup, got %d", len(matches))
	}
}

func TestLanguageMigrationAndEnglishPreference(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.State.Version = 1
	s.State.Settings.Language = "en"
	s.State.Bots[0].Threads[0].Title = "Kept conversation"
	if err := s.SaveState(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.State.Settings.Language != "zh" || migrated.State.Bots[0].Threads[0].Title != "Kept conversation" {
		t.Fatalf("migration language = %q, conversation = %q", migrated.State.Settings.Language, migrated.State.Bots[0].Threads[0].Title)
	}
	migrated.State.Settings.Language = "en"
	if err := migrated.SaveState(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.State.Settings.Language != "en" {
		t.Fatalf("reopened language = %q", reopened.State.Settings.Language)
	}
	if err := reopened.Reset(time.Now()); err != nil {
		t.Fatal(err)
	}
	if reopened.State.Settings.Language != "en" {
		t.Fatalf("reset language = %q", reopened.State.Settings.Language)
	}
}
