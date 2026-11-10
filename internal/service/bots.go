package service

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

var allowedColors = map[string]bool{
	"green": true, "blue": true, "red": true, "orange": true, "purple": true,
	"cyan": true, "pink": true, "yellow": true, "teal": true, "coral": true,
	"silver": true, "chrome": true,
}

var allowedShapes = map[string]bool{"cursor": true, "blob": true, "circle": true, "rounded": true, "square": true}

// CreateBot adds a contact and opens its first conversation.
func (s *Service) CreateBot(input model.CreateBotInput) (model.Bot, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return model.Bot{}, fmt.Errorf("give the bot a name")
	}
	s.mu.Lock()
	engines := s.engines
	availability := s.availabilityLocked(engines)
	modelID := strings.TrimSpace(input.ModelID)
	if modelID == "" {
		modelID = catalogDefault(availability)
	}
	color := input.Color
	if !allowedColors[color] {
		color = "green"
	}
	now := time.Now()
	botID := newID("bot")
	threadID := newID("thread")
	thread := model.Thread{
		ID: threadID, BotID: botID, Title: "New conversation", Kind: "chat",
		CreatedAt: now, UpdatedAt: now,
	}
	greeting := "Hey — I'm " + name + "."
	if strings.TrimSpace(input.Title) != "" {
		greeting += " I look after " + strings.ToLower(strings.TrimSpace(input.Title)) + "."
	}
	greeting += "\n\nAsk me anything, or open **Agent profile** to shape how I work. I am ready when you are."
	thread.Messages = append(thread.Messages, model.Message{
		ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText, Text: greeting,
		CreatedAt: now, UpdatedAt: now,
	})
	bot := model.Bot{
		ID: botID, Name: name, Title: strings.TrimSpace(input.Title),
		Description: strings.TrimSpace(input.Description), Soul: strings.TrimSpace(input.Soul),
		Color: color, MascotShape: "cursor", Expression: "idle", ModelID: modelID,
		Approval: model.ApprovalAsk, Notifications: true,
		CreatedAt: now, UpdatedAt: now, LastActiveAt: now,
		Threads: []model.Thread{thread},
	}
	s.st.State.Bots = append(s.st.State.Bots, bot)
	s.st.State.ActiveBotID = botID
	s.st.State.ActiveThreadID = threadID
	s.touchLocked()
	s.saveLocked()
	out := cloneBot(bot)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// UpdateBot edits the fields in the patch.
func (s *Service) UpdateBot(botID string, patch model.BotPatch) (model.Bot, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.Bot{}, fmt.Errorf("bot not found")
	}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" {
			s.mu.Unlock()
			return model.Bot{}, fmt.Errorf("the name cannot be empty")
		}
		bot.Name = name
	}
	if patch.Title != nil {
		bot.Title = strings.TrimSpace(*patch.Title)
	}
	if patch.Description != nil {
		bot.Description = strings.TrimSpace(*patch.Description)
	}
	if patch.Soul != nil {
		bot.Soul = strings.TrimSpace(*patch.Soul)
	}
	if patch.Color != nil && allowedColors[*patch.Color] {
		bot.Color = *patch.Color
	}
	if patch.ModelID != nil && strings.TrimSpace(*patch.ModelID) != "" {
		bot.ModelID = strings.TrimSpace(*patch.ModelID)
	}
	if patch.Approval != nil {
		switch *patch.Approval {
		case model.ApprovalAsk, model.ApprovalAuto, model.ApprovalFull:
			bot.Approval = *patch.Approval
		}
	}
	if patch.MascotShape != nil && allowedShapes[*patch.MascotShape] {
		bot.MascotShape = *patch.MascotShape
	}
	if patch.Expression != nil {
		bot.Expression = strings.TrimSpace(*patch.Expression)
	}
	if patch.AvatarURL != nil {
		value := strings.TrimSpace(*patch.AvatarURL)
		if len(value) > 4*1024*1024 {
			s.mu.Unlock()
			return model.Bot{}, fmt.Errorf("that image is too large (4 MB max)")
		}
		bot.AvatarURL = value
	}
	if patch.WorkingDir != nil {
		bot.WorkingDir = strings.TrimSpace(*patch.WorkingDir)
	}
	if patch.Notifications != nil {
		bot.Notifications = *patch.Notifications
	}
	if patch.SpeakReplies != nil {
		bot.SpeakReplies = *patch.SpeakReplies
	}
	if patch.Pinned != nil {
		bot.Pinned = *patch.Pinned
	}
	if patch.Hidden != nil {
		bot.Hidden = *patch.Hidden
	}
	if patch.Archived != nil {
		bot.Archived = *patch.Archived
	}
	bot.UpdatedAt = time.Now()
	if bot.Hidden || bot.Archived {
		if s.st.State.ActiveBotID == bot.ID {
			s.chooseAnotherBotLocked()
		}
	}
	s.touchLocked()
	s.saveLocked()
	out := cloneBot(*bot)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// DuplicateBot makes a copy with fresh conversations and no unread work.
func (s *Service) DuplicateBot(id string) (model.Bot, error) {
	s.mu.Lock()
	bot := s.findBotLocked(id)
	if bot == nil {
		s.mu.Unlock()
		return model.Bot{}, fmt.Errorf("bot not found")
	}
	now := time.Now()
	dup := cloneBot(*bot)
	dup.ID = newID("bot")
	dup.Name = strings.TrimSpace(dup.Name) + " copy"
	dup.Pinned = false
	dup.Hidden = false
	dup.Archived = false
	dup.CreatedAt = now
	dup.UpdatedAt = now
	dup.LastActiveAt = now
	dup.Threads = nil
	for _, thread := range bot.Threads {
		nt := thread
		nt.ID = newID("thread")
		nt.BotID = dup.ID
		nt.Unread = 0
		nt.Busy = false
		nt.Status = ""
		nt.CreatedAt = now
		nt.UpdatedAt = now
		nt.Messages = nil
		for _, msg := range thread.Messages {
			nm := msg
			nm.ID = newID("msg")
			nm.CreatedAt = now
			nm.UpdatedAt = now
			nm.Pending = false
			nt.Messages = append(nt.Messages, nm)
		}
		dup.Threads = append(dup.Threads, nt)
	}
	if len(dup.Threads) == 0 {
		dup.Threads = []model.Thread{{ID: newID("thread"), BotID: dup.ID, Title: "New conversation", Kind: "chat", CreatedAt: now, UpdatedAt: now}}
	}
	s.st.State.Bots = append(s.st.State.Bots, dup)
	s.st.State.ActiveBotID = dup.ID
	s.st.State.ActiveThreadID = dup.Threads[0].ID
	s.touchLocked()
	s.saveLocked()
	out := cloneBot(dup)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// DeleteBot removes a contact and every conversation it owns.
func (s *Service) DeleteBot(id string) error {
	s.mu.Lock()
	idx := -1
	for i := range s.st.State.Bots {
		if s.st.State.Bots[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	for _, thread := range s.st.State.Bots[idx].Threads {
		s.cancelTurnLocked(id, thread.ID)
	}
	s.st.State.Bots = append(s.st.State.Bots[:idx], s.st.State.Bots[idx+1:]...)
	if s.st.State.ActiveBotID == id {
		s.chooseAnotherBotLocked()
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

func (s *Service) chooseAnotherBotLocked() {
	s.st.State.ActiveBotID = ""
	s.st.State.ActiveThreadID = ""
	for i := range s.st.State.Bots {
		b := &s.st.State.Bots[i]
		if b.Hidden || b.Archived {
			continue
		}
		s.st.State.ActiveBotID = b.ID
		if len(b.Threads) > 0 {
			s.st.State.ActiveThreadID = b.Threads[0].ID
		}
		return
	}
}

// CreateThread starts a fresh conversation, task or routine run.
func (s *Service) CreateThread(botID, title string) (model.Thread, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("bot not found")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = "New conversation"
	}
	now := time.Now()
	thread := model.Thread{
		ID: newID("thread"), BotID: botID, Title: title, Kind: "chat",
		CreatedAt: now, UpdatedAt: now,
	}
	bot.Threads = append([]model.Thread{thread}, bot.Threads...)
	bot.UpdatedAt = now
	s.st.State.ActiveBotID = botID
	s.st.State.ActiveThreadID = thread.ID
	s.touchLocked()
	s.saveLocked()
	out := cloneThread(thread)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// UpdateThread renames a conversation.
func (s *Service) UpdateThread(botID, threadID, title string) (model.Thread, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("bot not found")
	}
	thread := s.findThreadLocked(bot, threadID)
	if thread == nil {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("conversation not found")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		s.mu.Unlock()
		return model.Thread{}, fmt.Errorf("the title cannot be empty")
	}
	thread.Title = title
	thread.UpdatedAt = time.Now()
	s.touchLocked()
	s.saveLocked()
	out := cloneThread(*thread)
	s.emitStateLocked()
	s.mu.Unlock()
	return out, nil
}

// DeleteThread removes one conversation.
func (s *Service) DeleteThread(botID, threadID string) error {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	idx := -1
	for i := range bot.Threads {
		if bot.Threads[i].ID == threadID {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	s.cancelTurnLocked(botID, threadID)
	bot.Threads = append(bot.Threads[:idx], bot.Threads[idx+1:]...)
	if len(bot.Threads) == 0 {
		now := time.Now()
		bot.Threads = append(bot.Threads, model.Thread{ID: newID("thread"), BotID: botID, Title: "New conversation", Kind: "chat", CreatedAt: now, UpdatedAt: now})
	}
	if s.st.State.ActiveBotID == botID && s.st.State.ActiveThreadID == threadID {
		s.st.State.ActiveThreadID = ""
		if len(bot.Threads) > 0 {
			s.st.State.ActiveThreadID = bot.Threads[0].ID
		}
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// Select opens a conversation and marks it read.
func (s *Service) Select(botID, threadID string) error {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	if threadID != "" {
		thread := s.findThreadLocked(bot, threadID)
		if thread == nil {
			s.mu.Unlock()
			return fmt.Errorf("conversation not found")
		}
		s.st.State.ActiveThreadID = threadID
	}
	s.st.State.ActiveBotID = botID
	if thread := s.findThreadLocked(bot, s.st.State.ActiveThreadID); thread != nil {
		thread.Unread = 0
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// MarkUnread puts a conversation back in the unread list.
func (s *Service) MarkUnread(botID, threadID string) error {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	thread := s.findThreadLocked(bot, threadID)
	if thread == nil {
		s.mu.Unlock()
		return fmt.Errorf("conversation not found")
	}
	if thread.Unread < 1 {
		thread.Unread = 1
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

// RevealWorkingFolder opens the bot's folder in the system file manager.
func (s *Service) RevealWorkingFolder(botID string) (string, error) {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return "", fmt.Errorf("bot not found")
	}
	dir := strings.TrimSpace(bot.WorkingDir)
	s.mu.Unlock()
	if dir == "" {
		dir, _ = os.UserHomeDir()
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return dir, fmt.Errorf("that folder does not exist")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dir)
	case "windows":
		cmd = exec.Command("explorer", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		return dir, err
	}
	return dir, nil
}

// MarkRead clears a conversation's unread count without opening it.
func (s *Service) MarkRead(botID, threadID string) error {
	s.mu.Lock()
	bot := s.findBotLocked(botID)
	if bot == nil {
		s.mu.Unlock()
		return fmt.Errorf("bot not found")
	}
	if thread := s.findThreadLocked(bot, threadID); thread != nil {
		thread.Unread = 0
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	s.mu.Unlock()
	return nil
}

func catalogDefault(availability map[string]bool) string {
	order := map[string]string{"grok": "grok-4.6", "claude": "claude-sonnet-5", "openai": "gpt-5.2", "google": "gemini-3-pro"}
	for _, key := range []string{"grok", "claude", "openai", "google"} {
		if availability[key] {
			return order[key]
		}
	}
	return "grox-demo"
}
