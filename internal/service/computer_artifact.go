package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

func (s *Service) attachComputerFile(ctx context.Context, target claudeHookTarget, computer computerTarget, file string) (computerToolResult, error) {
	name, data, err := s.readComputerArtifact(ctx, computer, file)
	if err != nil {
		return computerToolResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return computerToolResult{}, err
	}
	attachment, err := s.saveAttachmentBytes(name, "", data)
	if err != nil {
		return computerToolResult{}, err
	}
	text, err := s.publishComputerAttachment(ctx, target, attachment)
	return computerToolResult{text: text}, err
}

func (s *Service) readComputerArtifact(ctx context.Context, computer computerTarget, file string) (string, []byte, error) {
	if computer.remote != nil {
		target, err := remoteJoin(computer.remote.Root, file)
		if err != nil {
			return "", nil, err
		}
		shell := fmt.Sprintf("test -f \"$target\" && head -c %d < \"$target\" | base64 | tr -d '\\n'", maxAttachmentBytes+1)
		command := remotePathCommand(computer.remote.Root, target, shell)
		out, _, code, err := s.remoteRun(ctx, *computer.remote, command, 60*time.Second, base64.StdEncoding.EncodedLen(maxAttachmentBytes+1))
		if err != nil {
			return "", nil, err
		}
		if code != 0 {
			return "", nil, fmt.Errorf("could not read the file on the selected computer")
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
		return path.Base(target), data, err
	}
	root, absolute, err := resolveComputerPath(computer.root, file)
	if err != nil {
		return "", nil, err
	}
	relative, err := filepath.Rel(root, absolute)
	if err != nil {
		return "", nil, err
	}
	folder, err := os.OpenRoot(root)
	if err != nil {
		return "", nil, err
	}
	defer folder.Close()
	info, err := folder.Stat(relative)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, fmt.Errorf("select a regular file inside the working folder")
	}
	source, err := folder.Open(relative)
	if err != nil {
		return "", nil, err
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, maxAttachmentBytes+1))
	return filepath.Base(absolute), data, err
}
