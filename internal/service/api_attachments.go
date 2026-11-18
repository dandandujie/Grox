package service

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/model"
)

const (
	apiAttachmentCount = 8
	apiImageBytes      = 12 << 20
	apiTextBytes       = 64 << 10
)

// apiAttachmentLoader snapshots references during admission and reads the
// selected files when the API engine is running outside the service lock.
func (s *Service) apiAttachmentLoader(attachments []model.Attachment) func(context.Context) ([]agent.APIAttachment, error) {
	ids := make([]string, len(attachments))
	for index, attachment := range attachments {
		ids[index] = attachment.ID
	}
	return func(ctx context.Context) ([]agent.APIAttachment, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(ids) > apiAttachmentCount {
			return nil, fmt.Errorf("attach at most %d files per API message", apiAttachmentCount)
		}
		root, err := os.OpenRoot(s.attachmentsDir())
		if err != nil {
			return nil, fmt.Errorf("the attachment folder is unavailable: %w", err)
		}
		defer root.Close()

		imageRemaining, textRemaining := apiImageBytes, apiTextBytes
		files := make([]agent.APIAttachment, 0, len(ids))
		for _, id := range ids {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			// attachmentByID uses a glob to reconstruct the stored file name.
			// Accept only IDs of the form produced by SaveAttachment.
			suffix, prefixed := strings.CutPrefix(id, "att-")
			if _, err := strconv.ParseUint(suffix, 16, 64); !prefixed || err != nil {
				return nil, fmt.Errorf("an attached file is missing")
			}
			path, metadata, err := s.attachmentByID(id)
			if err != nil {
				return nil, err
			}
			file, err := readAPIAttachment(root, filepath.Base(path), metadata.Name, imageRemaining, textRemaining)
			if err != nil {
				return nil, fmt.Errorf("attachment %q: %w", metadata.Name, err)
			}
			if file.ImageMIME != "" {
				imageRemaining -= len(file.Data)
			} else {
				textRemaining -= len(file.Data)
			}
			files = append(files, file)
		}
		return files, nil
	}
}

func readAPIAttachment(root *os.Root, base, name string, imageRemaining, textRemaining int) (agent.APIAttachment, error) {
	entry, err := root.Lstat(base)
	if err != nil || !entry.Mode().IsRegular() {
		return agent.APIAttachment{}, fmt.Errorf("the stored file is unavailable")
	}
	file, err := root.Open(base)
	if err != nil {
		return agent.APIAttachment{}, err
	}
	defer file.Close()

	reader := bufio.NewReader(file)
	prefix, err := reader.Peek(512)
	if err != nil && err != io.EOF {
		return agent.APIAttachment{}, err
	}
	mimeType := http.DetectContentType(prefix)
	attachment := agent.APIAttachment{Name: name}
	remaining := textRemaining
	limit := "64 KiB of text per message"
	switch mimeType {
	case "image/png", "image/jpeg", "image/webp":
		attachment.ImageMIME = mimeType
		remaining = imageRemaining
		limit = "12 MiB of images per message"
	default:
		if !strings.HasPrefix(mimeType, "text/") {
			return agent.APIAttachment{}, fmt.Errorf("API messages support PNG, JPEG, WebP and UTF-8 text")
		}
	}
	if entry.Size() > int64(remaining) {
		return agent.APIAttachment{}, fmt.Errorf("the attachment limit is %s", limit)
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(remaining)+1))
	if err != nil {
		return agent.APIAttachment{}, err
	}
	if len(data) > remaining {
		return agent.APIAttachment{}, fmt.Errorf("the attachment limit is %s", limit)
	}
	if len(data) == 0 {
		return agent.APIAttachment{}, fmt.Errorf("the file is empty")
	}
	if attachment.ImageMIME == "" {
		if !utf8.Valid(data) || bytes.ContainsFunc(data, func(r rune) bool {
			return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t'
		}) {
			return agent.APIAttachment{}, fmt.Errorf("the file does not contain UTF-8 text")
		}
	}
	attachment.Data = data
	return attachment, nil
}
