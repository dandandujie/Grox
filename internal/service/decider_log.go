package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// logDecision appends one metadata-only decision row. Message text and bot
// descriptions never enter the log; a short state hash is enough to spot
// repeats.
func (s *Service) logDecision(provider, choice string, probability float64, latency time.Duration, modelID string, prompt string, ok bool, reason string) {
	sum := sha256.Sum256([]byte(prompt))
	row := map[string]any{
		"at": time.Now().UTC().Format(time.RFC3339), "seam": "roomRouting", "provider": provider,
		"ok": ok, "choice": choice, "pTop": probability, "latencyMs": latency.Milliseconds(),
		"stateHash": hex.EncodeToString(sum[:8]), "model": modelID,
	}
	if reason != "" {
		row["reason"] = reason
	}
	data, err := json.Marshal(row)
	if err != nil {
		return
	}
	dir := filepath.Join(s.dir, "decider-log")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(filepath.Join(dir, time.Now().Format("2006-01")+".ndjson"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(data, '\n'))
}
