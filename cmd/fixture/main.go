package main

// Command fixture writes the browser preview's first paint from the same seed
// the Go app uses. Run it after changing the seed:
//
//	go run ./cmd/fixture > src/mock/bootstrap.json

import (
	"encoding/json"
	"os"
	"time"

	"github.com/dandandujie/grox/internal/catalog"
	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/store"
)

func main() {
	now := time.Now()
	state := store.Seed(now)
	availability := map[string]bool{"grok": true, "claude": true, "openai": true, "google": true, "local": true}
	apps := catalog.Apps()
	for i := range apps {
		if c, ok := state.Connections[apps[i].ID]; ok {
			apps[i].Connected = c.Connected
			apps[i].Account = c.Account
		}
	}
	providers := catalog.Providers(availability, catalog.DefaultModel(availability))
	engines := []model.EngineInfo{
		{ProviderID: "grok", Command: "grok", Version: "1.0.13", Status: "ready", Detail: "Installed"},
		{ProviderID: "claude", Command: "claude", Version: "2.1.311", Status: "ready", Detail: "Installed"},
		{ProviderID: "openai", Command: "codex", Version: "0.164.0", Status: "ready", Detail: "Installed"},
		{ProviderID: "google", Command: "gemini", Version: "0.34.0", Status: "ready", Detail: "Installed"},
	}
	secrets := model.SecretStatus{Configured: map[string]bool{"xai": true, "openai": true}, Hints: map[string]string{"xai": "••••9abc", "openai": "••••7def"}}
	boot := model.Bootstrap{
		State: state, Providers: providers, Apps: apps, Engines: engines, Secrets: secrets,
		Version: model.AppVersion, Platform: "darwin", DataDir: "~/Library/Application Support/Grox", DemoMode: false,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(boot); err != nil {
		panic(err)
	}
}
