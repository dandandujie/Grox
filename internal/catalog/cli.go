package catalog

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// CLICommand resolves the same executable for discovery and for turns. Finder
// launches can omit package-manager and user install directories from PATH.
func CLICommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	var extra []string
	if runtime.GOOS != "windows" {
		if home, err := os.UserHomeDir(); err == nil {
			extra = append(extra, filepath.Join(home, ".local", "bin"), filepath.Join(home, ".grok", "bin"))
		}
	}
	if runtime.GOOS == "darwin" {
		extra = append(extra, "/opt/homebrew/bin", "/usr/local/bin")
	}
	cmd := exec.CommandContext(ctx, name, args...)
	if cmd.Err != nil {
		for _, dir := range extra {
			path, err := exec.LookPath(filepath.Join(dir, name))
			if err == nil {
				cmd = exec.CommandContext(ctx, path, args...)
				break
			}
		}
	}
	if len(extra) > 0 {
		paths := extra
		if inherited := os.Getenv("PATH"); inherited != "" {
			paths = append([]string{inherited}, paths...)
		}
		cmd.Env = append(cmd.Environ(), "PATH="+strings.Join(paths, string(os.PathListSeparator)))
	}
	return cmd
}
