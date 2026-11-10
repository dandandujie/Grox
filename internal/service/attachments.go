package service

import (
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"

	"github.com/dandandujie/grox/internal/model"
)

const maxAttachmentBytes = 32 << 20

func (s *Service) attachmentsDir() string {
	return filepath.Join(s.st.Dir, "attachments")
}

func safeAttachmentName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == 0 || unicode.IsControl(r) {
			return '_'
		}
		return r
	}, name)
	if name == "" || name == "." {
		name = "attachment"
	}
	if len([]rune(name)) > 120 {
		runes := []rune(name)
		name = string(runes[:100])
	}
	return name
}

func (s *Service) attachmentPath(a model.Attachment) string {
	return filepath.Join(s.attachmentsDir(), a.ID+"-"+safeAttachmentName(a.Name))
}

// SaveAttachment copies a file into the workspace and returns its metadata.
// The page sends base64 because the MyGo binding is JSON; bytes never go into
// state.json.
func (s *Service) SaveAttachment(name, mimeType, dataBase64 string) (model.Attachment, error) {
	if idx := strings.Index(dataBase64, ","); idx >= 0 && strings.HasPrefix(dataBase64, "data:") {
		dataBase64 = dataBase64[idx+1:]
	}
	if len(dataBase64) == 0 || len(dataBase64) > maxAttachmentBytes*4/3+8 {
		return model.Attachment{}, fmt.Errorf("the file is empty or larger than %d MB", maxAttachmentBytes>>20)
	}
	data, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return model.Attachment{}, fmt.Errorf("the file could not be decoded")
	}
	if len(data) == 0 {
		return model.Attachment{}, fmt.Errorf("the file is empty")
	}
	if len(data) > maxAttachmentBytes {
		return model.Attachment{}, fmt.Errorf("the file is larger than %d MB", maxAttachmentBytes>>20)
	}
	name = safeAttachmentName(name)
	if mt, _, err := mime.ParseMediaType(mimeType); err == nil && mt != "" {
		mimeType = mt
	} else {
		mimeType = http.DetectContentType(data)
	}
	kind := "file"
	if strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		kind = "image"
	}
	now := time.Now()
	attachment := model.Attachment{
		ID: newID("att"), Name: name, Mime: mimeType, Kind: kind, Size: int64(len(data)), CreatedAt: now,
	}
	if err := os.MkdirAll(s.attachmentsDir(), 0o700); err != nil {
		return model.Attachment{}, err
	}
	path := s.attachmentPath(attachment)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return model.Attachment{}, err
	}
	return attachment, nil
}

func (s *Service) attachmentByID(id string) (string, model.Attachment, error) {
	if !strings.HasPrefix(id, "att-") || strings.ContainsAny(id, "/\\") {
		return "", model.Attachment{}, fmt.Errorf("attachment not found")
	}
	matches, err := filepath.Glob(filepath.Join(s.attachmentsDir(), id+"-*"))
	if err != nil || len(matches) != 1 {
		return "", model.Attachment{}, fmt.Errorf("attachment not found")
	}
	path := matches[0]
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", model.Attachment{}, fmt.Errorf("attachment not found")
	}
	name := strings.TrimPrefix(filepath.Base(path), id+"-")
	mimeType := mime.TypeByExtension(filepath.Ext(name))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	kind := "file"
	if strings.HasPrefix(mimeType, "image/") {
		kind = "image"
	}
	return path, model.Attachment{ID: id, Name: name, Mime: mimeType, Kind: kind, Size: info.Size()}, nil
}

// ReadAttachment returns a base64 payload for the page to render a preview.
func (s *Service) ReadAttachment(id string) (string, error) {
	path, _, err := s.attachmentByID(id)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > 12<<20 {
		return "", fmt.Errorf("the attachment is too large to preview")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// OpenAttachment opens the attachment with the system's default application.
func (s *Service) OpenAttachment(id string) error {
	path, _, err := s.attachmentByID(id)
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("explorer", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	return cmd.Start()
}

func (s *Service) validateAttachments(list []model.Attachment) error {
	for _, a := range list {
		if _, _, err := s.attachmentByID(a.ID); err != nil {
			return fmt.Errorf("an attached file is missing")
		}
	}
	return nil
}

func (s *Service) attachmentContext(list []model.Attachment) string {
	if len(list) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("Files attached by the person (on this machine):\n")
	for _, a := range list {
		b.WriteString("- ")
		b.WriteString(s.attachmentPath(a))
		b.WriteString(" (")
		b.WriteString(a.Mime)
		b.WriteString(", ")
		b.WriteString(fmt.Sprintf("%d bytes", a.Size))
		b.WriteString(")\n")
	}
	return b.String()
}
