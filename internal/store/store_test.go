package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenSeedsAndPersists(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.State.Bots) < 4 {
		t.Fatalf("expected the first-run team, got %d bots", len(s.State.Bots))
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
