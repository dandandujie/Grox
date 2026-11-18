package catalog

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCLICommandFindsUserInstallFromDesktopPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("tests Unix user install directories")
	}
	t.Setenv("PATH", "/usr/bin:/bin")
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	userBin := filepath.Join(dir, ".local", "bin")
	if err := os.MkdirAll(userBin, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, script := range []string{"grox-cli-layout-test", "grox-cli-runtime-test"} {
		body := "#!/bin/sh\nprintf 'found'\n"
		if script == "grox-cli-layout-test" {
			body = "#!/usr/bin/env grox-cli-runtime-test\n"
		}
		if err := os.WriteFile(filepath.Join(userBin, script), []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cmd := CLICommand(context.Background(), "grox-cli-layout-test")
	output, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "found" {
		t.Fatalf("desktop PATH launch: %q, %v", output, err)
	}
}
