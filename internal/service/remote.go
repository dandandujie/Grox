package service

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"mime"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"github.com/dandandujie/grox/internal/model"
)

type remoteConfig struct {
	Host    string
	User    string
	Port    int
	Root    string
	KeyPath string
}

func expandHome(value string) string {
	if strings.HasPrefix(value, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, value[2:])
		}
	}
	return value
}

func (s *Service) remoteConfigLocked(bot *model.Bot) (remoteConfig, error) {
	cfg := remoteConfig{
		Host: strings.TrimSpace(bot.SSHHost), User: strings.TrimSpace(bot.SSHUser),
		Root: strings.TrimSpace(bot.SSHRoot), KeyPath: strings.TrimSpace(bot.SSHKeyPath),
	}
	cfg.Port = bot.SSHPort
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	if cfg.Host == "" {
		return cfg, fmt.Errorf("set a remote host first")
	}
	if cfg.User == "" {
		return cfg, fmt.Errorf("set the SSH user first")
	}
	if cfg.Root == "" {
		if cfg.User == "root" {
			cfg.Root = "/root"
		} else {
			cfg.Root = "/home/" + cfg.User
		}
	}
	if !strings.HasPrefix(cfg.Root, "/") {
		return cfg, fmt.Errorf("the remote root must be an absolute path")
	}
	if cfg.KeyPath == "" {
		return cfg, fmt.Errorf("set an SSH private key path first")
	}
	return cfg, nil
}

func (s *Service) remoteClient(cfg remoteConfig) (*ssh.Client, error) {
	key, err := os.ReadFile(expandHome(cfg.KeyPath))
	if err != nil {
		return nil, fmt.Errorf("could not read the SSH key: %w", err)
	}
	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("could not parse the SSH key: %w", err)
	}
	hostKeyCallback := ssh.InsecureIgnoreHostKey()
	if home, homeErr := os.UserHomeDir(); homeErr == nil {
		knownHosts := filepath.Join(home, ".ssh", "known_hosts")
		if _, statErr := os.Stat(knownHosts); statErr == nil {
			if callback, callbackErr := knownhosts.New(knownHosts); callbackErr == nil {
				hostKeyCallback = callback
			}
		}
	}
	config := &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: hostKeyCallback,
		Timeout:         12 * time.Second,
	}
	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	conn, err := net.DialTimeout("tcp", address, 12*time.Second)
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", address, err)
	}
	sshConn, channels, requests, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("SSH handshake failed: %w", err)
	}
	return ssh.NewClient(sshConn, channels, requests), nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func (s *Service) remoteRun(cfg remoteConfig, command string, timeout time.Duration) (string, string, int, error) {
	client, err := s.remoteClient(cfg)
	if err != nil {
		return "", "", 1, err
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return "", "", 1, err
	}
	defer session.Close()
	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	full := "cd " + shellQuote(cfg.Root) + " 2>/dev/null && " + command
	done := make(chan error, 1)
	go func() { done <- session.Run(full) }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = client.Close()
		return stdout.String(), stderr.String(), 1, fmt.Errorf("the remote command timed out")
	}
	exitCode := 0
	if err != nil {
		if exit, ok := err.(*ssh.ExitError); ok {
			exitCode = exit.ExitStatus()
		} else {
			return stdout.String(), stderr.String(), 1, err
		}
	}
	return stdout.String(), stderr.String(), exitCode, nil
}

func remoteJoin(root, value string) (string, error) {
	value = strings.TrimSpace(value)
	cleanRoot := path.Clean(root)
	if value == "" {
		return cleanRoot, nil
	}
	result := path.Clean(value)
	if !strings.HasPrefix(value, "/") {
		result = path.Join(cleanRoot, value)
	}
	if result != cleanRoot && !strings.HasPrefix(result, cleanRoot+"/") {
		return "", fmt.Errorf("that path is outside the remote computer root")
	}
	return result, nil
}

func (s *Service) remoteList(cfg remoteConfig, target string) (model.FolderListing, error) {
	remotePath, err := remoteJoin(cfg.Root, target)
	if err != nil {
		return model.FolderListing{}, err
	}
	command := "find " + shellQuote(remotePath) + " -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n' 2>/dev/null"
	stdout, stderr, code, err := s.remoteRun(cfg, command, 20*time.Second)
	if err != nil {
		return model.FolderListing{}, err
	}
	if code != 0 && strings.TrimSpace(stdout) == "" {
		message := strings.TrimSpace(stderr)
		if message == "" {
			message = "the remote folder could not be read"
		}
		return model.FolderListing{}, fmt.Errorf("%s", message)
	}
	entries := []model.FileEntry{}
	for _, line := range strings.Split(strings.TrimSpace(stdout), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) < 4 || parts[0] == "" {
			continue
		}
		if strings.HasPrefix(parts[0], ".") {
			continue
		}
		size, _ := strconv.ParseInt(parts[2], 10, 64)
		seconds, _ := strconv.ParseFloat(parts[3], 64)
		mimeType := ""
		isDir := parts[1] == "d"
		if !isDir {
			mimeType = mime.TypeByExtension(strings.ToLower(path.Ext(parts[0])))
		}
		entries = append(entries, model.FileEntry{
			Name: parts[0], Path: path.Join(remotePath, parts[0]), Dir: isDir,
			Size: size, Modified: time.Unix(int64(seconds), 0), Mime: mimeType,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return model.FolderListing{Root: cfg.Root, Path: remotePath, Entries: entries}, nil
}

func (s *Service) remoteRead(cfg remoteConfig, target string) (model.FilePreview, error) {
	remotePath, err := remoteJoin(cfg.Root, target)
	if err != nil {
		return model.FilePreview{}, err
	}
	sizeOut, _, code, err := s.remoteRun(cfg, "wc -c < "+shellQuote(remotePath), 15*time.Second)
	if err != nil {
		return model.FilePreview{}, err
	}
	if code != 0 {
		return model.FilePreview{}, fmt.Errorf("the remote file could not be read")
	}
	size, _ := strconv.ParseInt(strings.TrimSpace(sizeOut), 10, 64)
	mimeType := mime.TypeByExtension(strings.ToLower(path.Ext(remotePath)))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	preview := model.FilePreview{Path: remotePath, Name: path.Base(remotePath), Mime: mimeType, Size: size, Kind: "text"}
	if strings.HasPrefix(mimeType, "image/") {
		if size > maxPreviewImage {
			return model.FilePreview{}, fmt.Errorf("this image is too large to preview")
		}
		out, stderr, code, err := s.remoteRun(cfg, "base64 < "+shellQuote(remotePath)+" | tr -d '\\n'", 30*time.Second)
		if err != nil || code != 0 {
			if err == nil {
				err = fmt.Errorf("%s", strings.TrimSpace(stderr))
			}
			return model.FilePreview{}, err
		}
		preview.Kind = "image"
		preview.Data = strings.TrimSpace(out)
		return preview, nil
	}
	out, stderr, code, err := s.remoteRun(cfg, "head -c 262145 < "+shellQuote(remotePath), 20*time.Second)
	if err != nil || code != 0 {
		if err == nil {
			err = fmt.Errorf("%s", strings.TrimSpace(stderr))
		}
		return model.FilePreview{}, err
	}
	if size > maxPreviewText {
		preview.Truncated = true
	}
	if strings.ContainsRune(out, 0) {
		preview.Kind = "binary"
		return preview, nil
	}
	preview.Text = out
	return preview, nil
}

func (s *Service) remoteOpen(cfg remoteConfig, target string) error {
	preview, err := s.remoteRead(cfg, target)
	if err != nil {
		return err
	}
	remotePath, err := remoteJoin(cfg.Root, target)
	if err != nil {
		return err
	}
	out, _, code, err := s.remoteRun(cfg, "base64 < "+shellQuote(remotePath)+" | tr -d '\\n'", 40*time.Second)
	if err != nil || code != 0 {
		return fmt.Errorf("could not download the remote file")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if err != nil {
		return err
	}
	file, err := os.CreateTemp("", "grox-remote-*"+path.Ext(preview.Name))
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	_ = file.Close()
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", file.Name())
	case "windows":
		cmd = exec.Command("explorer", file.Name())
	default:
		cmd = exec.Command("xdg-open", file.Name())
	}
	return cmd.Start()
}

func (s *Service) remoteScreen(cfg remoteConfig) (string, error) {
	command := "tmp=/tmp/grox-screen-$$.png; " +
		"if command -v grim >/dev/null 2>&1; then grim \"$tmp\" >/dev/null 2>&1; " +
		"elif command -v scrot >/dev/null 2>&1; then scrot -o \"$tmp\" >/dev/null 2>&1; " +
		"elif command -v import >/dev/null 2>&1; then import -window root \"$tmp\" >/dev/null 2>&1; " +
		"else echo 'no screen capture tool (grim, scrot, or import)' >&2; exit 127; fi; " +
		"base64 < \"$tmp\" | tr -d '\\n'; rm -f \"$tmp\""
	out, stderr, code, err := s.remoteRun(cfg, command, 30*time.Second)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("%s", strings.TrimSpace(stderr))
	}
	return strings.TrimSpace(out), nil
}

// TestRemoteComputer opens a real SSH connection and returns uname output.
func (s *Service) TestRemoteComputer(botID string) (string, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("bot not found")
	}
	cfg, err := s.remoteConfigLocked(bot)
	s.mu.Unlock()
	if err != nil {
		return "", err
	}
	stdout, stderr, code, err := s.remoteRun(cfg, "uname -a; pwd", 20*time.Second)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("%s", strings.TrimSpace(stderr))
	}
	return strings.TrimSpace(stdout), nil
}
