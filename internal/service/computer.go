package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"io/fs"
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

type computerTarget struct {
	root   string
	remote *remoteConfig
}

func (s *Service) computerTargetLocked(bot *model.Bot) (computerTarget, error) {
	if bot.ComputerMode == "ssh" {
		cfg, err := s.remoteConfigLocked(bot)
		return computerTarget{root: cfg.Root, remote: &cfg}, err
	}
	dir := strings.TrimSpace(bot.WorkingDir)
	if dir != "" {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			return computerTarget{}, fmt.Errorf("the selected working folder is unavailable")
		}
	} else {
		dir, _ = os.UserHomeDir()
	}
	if dir == "" {
		return computerTarget{}, fmt.Errorf("no working folder is available")
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return computerTarget{}, err
	}
	root, err = filepath.EvalSymlinks(root)
	return computerTarget{root: root}, err
}

func (s *Service) computerTarget(botID string) (computerTarget, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		return computerTarget{}, fmt.Errorf("bot not found")
	}
	return s.computerTargetLocked(bot)
}

func resolveComputerPath(root, path string) (string, string, error) {
	if root == "" {
		return "", "", fmt.Errorf("no working folder is available")
	}
	rootAbs := root
	clean := strings.TrimSpace(path)
	if clean == "" {
		clean = rootAbs
	} else if !filepath.IsAbs(clean) {
		clean = filepath.Join(rootAbs, clean)
	}
	abs, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", "", err
	}
	rel, err := filepath.Rel(rootAbs, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("that path is outside this bot's folder")
	}
	return rootAbs, abs, nil
}

// ListComputerFiles returns one folder inside the bot's local computer.
func (s *Service) ListComputerFiles(botID, path string) (model.FolderListing, error) {
	target, err := s.computerTarget(botID)
	if err != nil {
		return model.FolderListing{}, err
	}
	return s.listComputerFiles(context.Background(), target, path)
}

func (s *Service) listComputerFiles(ctx context.Context, target computerTarget, path string) (model.FolderListing, error) {
	if target.remote != nil {
		return s.remoteList(ctx, *target.remote, path)
	}
	root, abs, err := resolveComputerPath(target.root, path)
	if err != nil {
		return model.FolderListing{}, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return model.FolderListing{}, fmt.Errorf("that folder does not exist")
	}
	folder, err := os.OpenRoot(root)
	if err != nil {
		return model.FolderListing{}, err
	}
	defer folder.Close()
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return model.FolderListing{}, err
	}
	items, err := fs.ReadDir(folder.FS(), filepath.ToSlash(rel))
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
	target, err := s.computerTarget(botID)
	if err != nil {
		return model.FilePreview{}, err
	}
	return s.readComputerFile(context.Background(), target, path)
}

func (s *Service) readComputerFile(ctx context.Context, target computerTarget, path string) (model.FilePreview, error) {
	if target.remote != nil {
		return s.remoteRead(ctx, *target.remote, path)
	}
	root, abs, err := resolveComputerPath(target.root, path)
	if err != nil {
		return model.FilePreview{}, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return model.FilePreview{}, fmt.Errorf("that file does not exist")
	}
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(abs)))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	preview := model.FilePreview{Path: abs, Name: filepath.Base(abs), Mime: mimeType, Size: info.Size(), Kind: "text"}
	folder, err := os.OpenRoot(root)
	if err != nil {
		return model.FilePreview{}, err
	}
	defer folder.Close()
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return model.FilePreview{}, err
	}
	file, err := folder.Open(rel)
	if err != nil {
		return model.FilePreview{}, err
	}
	defer file.Close()
	if strings.HasPrefix(mimeType, "image/") {
		if info.Size() > maxPreviewImage {
			return model.FilePreview{}, fmt.Errorf("this image is too large to preview")
		}
		data, err := io.ReadAll(io.LimitReader(file, maxPreviewImage+1))
		if err != nil {
			return model.FilePreview{}, err
		}
		if len(data) > maxPreviewImage {
			return model.FilePreview{}, fmt.Errorf("this image is too large to preview")
		}
		preview.Kind = "image"
		preview.Data = base64.StdEncoding.EncodeToString(data)
		return preview, nil
	}
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
	target, err := s.computerTarget(botID)
	if err != nil {
		return err
	}
	if target.remote != nil {
		return s.remoteOpen(*target.remote, path)
	}
	_, abs, err := resolveComputerPath(target.root, path)
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
func (s *Service) RunComputerCommand(botID, command string) (model.CommandResult, error) {
	target, err := s.computerTarget(botID)
	if err != nil {
		return model.CommandResult{}, err
	}
	return s.runComputerCommand(context.Background(), target, command)
}

func (s *Service) runComputerCommand(ctx context.Context, target computerTarget, command string) (model.CommandResult, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return model.CommandResult{}, fmt.Errorf("type a command first")
	}
	if target.remote != nil {
		start := time.Now()
		stdout, stderr, code, err := s.remoteRun(ctx, *target.remote, command, 60*time.Second, maxCommandBytes)
		return model.CommandResult{Command: command, Stdout: stdout, Stderr: stderr, ExitCode: code, DurationMS: time.Since(start).Milliseconds()}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-lc", command)
	}
	cmd.Dir = target.root
	configureCommandCancellation(cmd)
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
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if runErr != nil {
		if cmd.ProcessState == nil {
			return result, runErr
		}
		if result.Stderr == "" {
			result.Stderr = runErr.Error()
		}
	}
	return result, nil
}

// CaptureComputerScreen takes a PNG screenshot of the local desktop. The OS
// may ask for screen-recording permission the first time.
func (s *Service) CaptureComputerScreen(botID string) (string, error) {
	target, err := s.computerTarget(botID)
	if err != nil {
		return "", err
	}
	return s.captureComputerScreen(context.Background(), target)
}

func (s *Service) captureComputerScreen(ctx context.Context, target computerTarget) (string, error) {
	if target.remote != nil {
		return s.remoteScreen(ctx, *target.remote)
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
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
		cmd = exec.CommandContext(ctx, "screencapture", "-x", "-t", "png", path)
	case "linux":
		if _, err := exec.LookPath("grim"); err == nil {
			cmd = exec.CommandContext(ctx, "grim", path)
		} else if _, err := exec.LookPath("scrot"); err == nil {
			cmd = exec.CommandContext(ctx, "scrot", "-o", path)
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
