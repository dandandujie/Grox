package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

const (
	maxPreviewText  = 256 << 10
	maxPreviewImage = 12 << 20
	maxCommandBytes = 256 << 10
)

type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	original := len(p)
	remaining := b.max - b.buf.Len()
	if remaining > 0 {
		if len(p) > remaining {
			b.buf.Write(p[:remaining])
		} else {
			b.buf.Write(p)
		}
	}
	return original, nil
}

func (s *Service) computerRootLocked(bot *model.Bot) string {
	dir := strings.TrimSpace(bot.WorkingDir)
	if dir != "" {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	home, _ := os.UserHomeDir()
	return home
}

func (s *Service) resolveComputerPathLocked(bot *model.Bot, path string) (string, string, error) {
	root := s.computerRootLocked(bot)
	if root == "" {
		return "", "", fmt.Errorf("no working folder is available")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", "", err
	}
	clean := strings.TrimSpace(path)
	if clean == "" {
		clean = rootAbs
	} else if !filepath.IsAbs(clean) {
		clean = filepath.Join(rootAbs, clean)
	}
	abs, err := filepath.Abs(clean)
	if err != nil {
		return "", "", err
	}
	rel, err := filepath.Rel(rootAbs, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("that path is outside this bot's folder")
	}
	// Resolve symlinks so a link inside the folder cannot read outside it.
	if resolvedRoot, err := filepath.EvalSymlinks(rootAbs); err == nil {
		rootAbs = resolvedRoot
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	rel, err = filepath.Rel(rootAbs, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("that path is outside this bot's folder")
	}
	return rootAbs, abs, nil
}

// ListComputerFiles returns one folder inside the bot's local computer.
func (s *Service) ListComputerFiles(botID, path string) (model.FolderListing, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.FolderListing{}, fmt.Errorf("bot not found")
	}
	if bot.ComputerMode == "ssh" {
		cfg, err := s.remoteConfigLocked(bot)
		s.mu.Unlock()
		if err != nil {
			return model.FolderListing{}, err
		}
		return s.remoteList(cfg, path)
	}
	root, abs, err := s.resolveComputerPathLocked(bot, path)
	s.mu.Unlock()
	if err != nil {
		return model.FolderListing{}, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return model.FolderListing{}, fmt.Errorf("that folder does not exist")
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		return model.FolderListing{}, err
	}
	entries := make([]model.FileEntry, 0, len(items))
	for _, item := range items {
		if strings.HasPrefix(item.Name(), ".") && item.Name() != ".env.example" {
			continue
		}
		info, err := item.Info()
		if err != nil {
			continue
		}
		mimeType := ""
		if !item.IsDir() {
			mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(item.Name())))
		}
		entries = append(entries, model.FileEntry{
			Name: item.Name(), Path: filepath.Join(abs, item.Name()), Dir: item.IsDir(),
			Size: info.Size(), Modified: info.ModTime(), Mime: mimeType,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	if len(entries) > 500 {
		entries = entries[:500]
	}
	return model.FolderListing{Root: root, Path: abs, Entries: entries}, nil
}

// ReadComputerFile returns a bounded text or image preview.
func (s *Service) ReadComputerFile(botID, path string) (model.FilePreview, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.FilePreview{}, fmt.Errorf("bot not found")
	}
	if bot.ComputerMode == "ssh" {
		cfg, err := s.remoteConfigLocked(bot)
		s.mu.Unlock()
		if err != nil {
			return model.FilePreview{}, err
		}
		return s.remoteRead(cfg, path)
	}
	_, abs, err := s.resolveComputerPathLocked(bot, path)
	s.mu.Unlock()
	if err != nil {
		return model.FilePreview{}, err
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		return model.FilePreview{}, fmt.Errorf("that file does not exist")
	}
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(abs)))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	preview := model.FilePreview{Path: abs, Name: filepath.Base(abs), Mime: mimeType, Size: info.Size(), Kind: "text"}
	if strings.HasPrefix(mimeType, "image/") {
		if info.Size() > maxPreviewImage {
			return model.FilePreview{}, fmt.Errorf("this image is too large to preview")
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			return model.FilePreview{}, err
		}
		preview.Kind = "image"
		preview.Data = base64.StdEncoding.EncodeToString(data)
		return preview, nil
	}
	file, err := os.Open(abs)
	if err != nil {
		return model.FilePreview{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxPreviewText+1))
	if err != nil {
		return model.FilePreview{}, err
	}
	if len(data) > maxPreviewText {
		data = data[:maxPreviewText]
		preview.Truncated = true
	}
	if bytes.IndexByte(data, 0) >= 0 {
		preview.Kind = "binary"
		return preview, nil
	}
	preview.Text = string(data)
	return preview, nil
}

// OpenComputerPath opens a local file or folder with the system handler.
func (s *Service) OpenComputerPath(botID, path string) error {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	if bot.ComputerMode == "ssh" {
		cfg, err := s.remoteConfigLocked(bot)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		return s.remoteOpen(cfg, path)
	}
	_, abs, err := s.resolveComputerPathLocked(bot, path)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", abs)
	case "windows":
		cmd = exec.Command("explorer", abs)
	default:
		cmd = exec.Command("xdg-open", abs)
	}
	return cmd.Start()
}

// RunComputerCommand runs a command the person typed in the Computer panel.
// It is intentionally not exposed to the agent as an unattended tool.
func (s *Service) RunComputerCommand(botID, command string) (model.CommandResult, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return model.CommandResult{}, fmt.Errorf("type a command first")
	}
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.CommandResult{}, fmt.Errorf("bot not found")
	}
	if bot.ComputerMode == "ssh" {
		cfg, err := s.remoteConfigLocked(bot)
		s.mu.Unlock()
		if err != nil {
			return model.CommandResult{}, err
		}
		start := time.Now()
		stdout, stderr, code, err := s.remoteRun(cfg, command, 60*time.Second)
		if err != nil {
			return model.CommandResult{Command: command, Stdout: stdout, Stderr: stderr, ExitCode: code, DurationMS: time.Since(start).Milliseconds()}, err
		}
		return model.CommandResult{Command: command, Stdout: stdout, Stderr: stderr, ExitCode: code, DurationMS: time.Since(start).Milliseconds()}, nil
	}
	_, root, err := s.resolveComputerPathLocked(bot, "")
	s.mu.Unlock()
	if err != nil {
		return model.CommandResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-lc", command)
	}
	cmd.Dir = root
	stdout := &cappedBuffer{max: maxCommandBytes}
	stderr := &cappedBuffer{max: maxCommandBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	start := time.Now()
	runErr := cmd.Run()
	result := model.CommandResult{
		Command: command, Stdout: stdout.buf.String(), Stderr: stderr.buf.String(),
		DurationMS: time.Since(start).Milliseconds(),
	}
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}
	if ctx.Err() == context.DeadlineExceeded {
		return result, fmt.Errorf("the command ran for more than a minute")
	}
	if runErr != nil && result.Stderr == "" {
		result.Stderr = runErr.Error()
	}
	return result, nil
}

// CaptureComputerScreen takes a PNG screenshot of the local desktop. The OS
// may ask for screen-recording permission the first time.
func (s *Service) CaptureComputerScreen(botID string) (string, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("bot not found")
	}
	if bot.ComputerMode == "ssh" {
		cfg, err := s.remoteConfigLocked(bot)
		s.mu.Unlock()
		if err != nil {
			return "", err
		}
		return s.remoteScreen(cfg)
	}
	s.mu.Unlock()
	file, err := os.CreateTemp("", "grox-screen-*.png")
	if err != nil {
		return "", err
	}
	path := file.Name()
	_ = file.Close()
	defer os.Remove(path)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("screencapture", "-x", "-t", "png", path)
	case "linux":
		if _, err := exec.LookPath("grim"); err == nil {
			cmd = exec.Command("grim", path)
		} else if _, err := exec.LookPath("scrot"); err == nil {
			cmd = exec.Command("scrot", "-o", path)
		} else {
			return "", fmt.Errorf("install grim or scrot to capture the desktop")
		}
	default:
		return "", fmt.Errorf("screen capture is not available on this platform")
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("screen capture failed: %s", message)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > 20<<20 {
		return "", fmt.Errorf("the screenshot is too large")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
