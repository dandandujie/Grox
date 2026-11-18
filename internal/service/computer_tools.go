package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/model"
)

const (
	computerInfoTool       = "computer_info"
	computerListTool       = "computer_list"
	computerReadTool       = "computer_read"
	computerRunTool        = "computer_run"
	computerScreenshotTool = "computer_screenshot"
	computerAttachTool     = "attach_file"
)

var computerTools = []agent.Tool{
	{Name: computerAttachTool, Description: "Copy a file from the selected computer into this conversation so the person can open it.", Parameters: computerToolParameters("path", "File relative to the selected working folder.", true)},
	{Name: computerInfoTool, Description: "Get the selected computer and its working folder. Agent CLI built-in tools may still run locally.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}},
	{Name: computerListTool, Description: "List files in a folder on the selected computer.", Parameters: computerToolParameters("path", "Folder relative to the selected working folder. Empty lists the working folder.", false)},
	{Name: computerReadTool, Description: "Read text or an image inside the selected working folder.", Parameters: computerToolParameters("path", "File relative to the selected working folder.", true)},
	{Name: computerRunTool, Description: "Run a shell command on the selected computer. The working folder is the starting directory, not a shell sandbox.", Parameters: computerToolParameters("command", "Exact non-interactive shell command.", true)},
	{Name: computerScreenshotTool, Description: "Capture the selected computer's desktop as a PNG and attach it to the current conversation.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}},
}

func computerToolParameters(key, description string, required bool) map[string]any {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			key: map[string]any{"type": "string", "description": description},
		},
	}
	if required {
		schema["required"] = []string{key}
	}
	return schema
}

func isComputerTool(name string) bool {
	if isBrowserTool(name) {
		return true
	}
	for _, tool := range computerTools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func isGroxComputerHook(name string) bool {
	bare, ok := strings.CutPrefix(name, "mcp__grox__")
	return ok && isComputerTool(bare)
}

type computerToolResult struct {
	text  string
	image *agent.APIAttachment
}

func (s *Service) executeComputerTool(ctx context.Context, target claudeHookTarget, name string, args map[string]any) (computerToolResult, error) {
	control := target.control
	if control == nil {
		return computerToolResult{}, fmt.Errorf("computer tools require a live agent turn")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(control.ctx, cancel)
	defer stop()
	if err := control.ctx.Err(); err != nil {
		return computerToolResult{}, err
	}

	var browserOp browserAction
	if isBrowserTool(name) {
		var err error
		browserOp, err = prepareBrowserAction(control.browser, name, args)
		if err != nil {
			return computerToolResult{}, err
		}
	}

	s.mu.Lock()
	owner := s.hookOwnerLocked(target)
	bot := s.findBotLocked(target.BotID)
	if owner.thread == nil || bot == nil || !toolAllowed(bot.ToolPolicy, name) {
		s.mu.Unlock()
		return computerToolResult{}, fmt.Errorf("this computer tool is unavailable in the current turn")
	}
	computer := control.computer
	if control.computerErr != nil {
		s.mu.Unlock()
		return computerToolResult{}, control.computerErr
	}
	current, configErr := s.computerTargetLocked(bot)
	if configErr != nil || !computer.sameComputer(current) {
		s.mu.Unlock()
		return computerToolResult{}, fmt.Errorf("the selected computer changed. Start a new turn to use it")
	}
	host, mode := "This computer", "local"
	if computer.remote != nil {
		host, mode = fmt.Sprintf("%s@%s:%d", computer.remote.User, computer.remote.Host, computer.remote.Port), "ssh"
	}
	switch name {
	case computerInfoTool:
		s.mu.Unlock()
		return computerToolJSON(map[string]string{"computer": host, "mode": mode, "workingFolder": computer.root})
	}
	arg := ""
	operation := ""
	switch name {
	case computerListTool, computerReadTool, computerAttachTool:
		arg = strings.TrimSpace(toolString(args["path"]))
		operation = "List folder " + arg
		if name != computerListTool {
			if arg == "" {
				s.mu.Unlock()
				return computerToolResult{}, fmt.Errorf("a file path is required")
			}
			operation = "Read file " + arg
			if name == computerAttachTool {
				operation = "Attach file " + arg
			}
		}
	case computerRunTool:
		arg = strings.TrimSpace(toolString(args["command"]))
		if arg == "" || len(arg) > 8192 {
			s.mu.Unlock()
			return computerToolResult{}, fmt.Errorf("a shell command of at most 8192 bytes is required")
		}
		operation = arg
	case computerScreenshotTool:
		operation = "Capture the desktop and attach the screenshot to this conversation"
	case browserOpenTool, browserReadTool, browserClickTool, browserTypeTool, browserBackTool, browserScreenshotTool:
		operation = browserOp.operation
	default:
		s.mu.Unlock()
		return computerToolResult{}, fmt.Errorf("unknown computer tool %q", name)
	}
	approvalKey := name + "\x00" + arg
	if browserOp.name != "" {
		approvalKey = browserOp.key()
	}
	ask := requiresComputerApproval(bot, name) && !control.computerAllowed[approvalKey]
	s.mu.Unlock()

	if ask {
		risk := "File contents or screen pixels can be shared with the selected model."
		if browserOp.name != "" {
			risk = "The managed browser may send this operation to the website. Page content may be returned to the selected model."
		} else if name == computerRunTool {
			risk = "This command runs with the computer account's permissions and can access files outside its starting folder."
		}
		decision, err := s.awaitComputerApproval(ctx, target, model.Approval{
			Title: "Allow computer access on " + host + "?", Command: operation,
			Reason: "Working folder · " + computer.root + ". Always allows the same action for this turn.", Risk: risk,
		})
		if err != nil {
			return computerToolResult{}, err
		}
		if decision == "always" {
			s.mu.Lock()
			control.computerAllowed[approvalKey] = true
			s.mu.Unlock()
		}
	}

	// Recheck permission and destination after approval and before running.
	s.mu.Lock()
	owner = s.hookOwnerLocked(target)
	bot = s.findBotLocked(target.BotID)
	enabled := owner.thread != nil && bot != nil && toolAllowed(bot.ToolPolicy, name)
	if enabled {
		current, configErr = s.computerTargetLocked(bot)
		enabled = configErr == nil && computer.sameComputer(current) && (ask || control.computerAllowed[approvalKey] || !requiresComputerApproval(bot, name))
	}
	s.mu.Unlock()
	if !enabled || ctx.Err() != nil {
		return computerToolResult{}, fmt.Errorf("the computer, permission, or active turn changed before execution")
	}

	if browserOp.name != "" {
		return s.executeBrowserAction(ctx, target, browserOp)
	}
	switch name {
	case computerListTool:
		listing, err := s.listComputerFiles(ctx, computer, arg)
		if err != nil {
			return computerToolResult{}, err
		}
		return computerToolJSON(listing)
	case computerReadTool:
		preview, err := s.readComputerFile(ctx, computer, arg)
		if err != nil {
			return computerToolResult{}, err
		}
		if preview.Kind == "image" {
			return s.attachComputerImage(ctx, target, preview.Name, preview.Data)
		}
		return computerToolJSON(preview)
	case computerAttachTool:
		return s.attachComputerFile(ctx, target, computer, arg)
	case computerRunTool:
		result, err := s.runComputerCommand(ctx, computer, arg)
		if err != nil {
			return computerToolResult{}, err
		}
		return computerToolJSON(result)
	case computerScreenshotTool:
		data, err := s.captureComputerScreen(ctx, computer)
		if err != nil {
			return computerToolResult{}, err
		}
		return s.attachComputerImage(ctx, target, "Computer screenshot.png", data)
	}
	panic("unhandled validated computer tool")
}

func (target computerTarget) sameComputer(current computerTarget) bool {
	if target.remote != nil && current.remote != nil {
		return *target.remote == *current.remote
	}
	return target.remote == nil && current.remote == nil && target.root == current.root
}

func requiresComputerApproval(bot *model.Bot, name string) bool {
	if bot.Approval == model.ApprovalFull {
		return false
	}
	if isBrowserTool(name) {
		return bot.Approval != model.ApprovalAuto || name != browserReadTool
	}
	return bot.Approval != model.ApprovalAuto || name == computerRunTool || name == computerScreenshotTool || name == computerAttachTool ||
		(bot.ComputerMode != "ssh" && strings.TrimSpace(bot.WorkingDir) == "")
}

func computerToolJSON(value any) (computerToolResult, error) {
	raw, err := json.Marshal(value)
	return computerToolResult{text: string(raw)}, err
}

func (s *Service) attachComputerImage(ctx context.Context, target claudeHookTarget, name, encoded string) (computerToolResult, error) {
	if err := ctx.Err(); err != nil {
		return computerToolResult{}, err
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return computerToolResult{}, fmt.Errorf("the computer returned invalid image data")
	}
	mimeType := http.DetectContentType(data)
	switch mimeType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		return computerToolResult{}, fmt.Errorf("the computer did not return a supported image")
	}
	attachment, err := s.saveAttachmentBytes(name, mimeType, data)
	if err != nil {
		return computerToolResult{}, err
	}
	text, err := s.publishComputerAttachment(ctx, target, attachment)
	if err != nil {
		return computerToolResult{}, err
	}
	return computerToolResult{
		text:  text,
		image: &agent.APIAttachment{Name: attachment.Name, Data: data, ImageMIME: mimeType},
	}, nil
}

func (s *Service) publishComputerAttachment(ctx context.Context, target claudeHookTarget, attachment model.Attachment) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner := s.hookOwnerLocked(target)
	if owner.thread == nil || ctx.Err() != nil {
		_ = os.Remove(s.attachmentPath(attachment))
		return "", fmt.Errorf("the turn ended before the file could be attached")
	}
	now := time.Now()
	msg := model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText, Attachments: []model.Attachment{attachment},
		SenderID: target.BotID, CreatedAt: now, UpdatedAt: now,
	}
	if bot := s.findBotLocked(target.BotID); bot != nil {
		msg.SenderName = bot.Name
	}
	owner.thread.Messages = append(owner.thread.Messages, msg)
	s.touchLocked()
	if err := s.st.SaveState(); err != nil {
		owner.thread.Messages = owner.thread.Messages[:len(owner.thread.Messages)-1]
		_ = os.Remove(s.attachmentPath(attachment))
		return "", fmt.Errorf("save computer attachment: %w", err)
	}
	s.emitStateLocked()
	return fmt.Sprintf("Attached %s to the current conversation.", attachment.Name), nil
}
