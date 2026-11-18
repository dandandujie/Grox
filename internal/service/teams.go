package service

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/schedule"
)

const (
	teamPackageFormat = "grox.team"
	teamSigningSecret = "team:signing-key"
)

func (s *Service) uniqueBotNameLocked(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Imported bot"
	}
	taken := map[string]bool{}
	for _, bot := range s.st.State.Bots {
		taken[strings.ToLower(bot.Name)] = true
	}
	candidate := name
	for suffix := 2; taken[strings.ToLower(candidate)]; suffix++ {
		candidate = fmt.Sprintf("%s %d", name, suffix)
	}
	return candidate
}

func (s *Service) uniqueGroupNameLocked(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Imported team"
	}
	taken := map[string]bool{}
	for _, group := range s.st.State.Groups {
		taken[strings.ToLower(group.Name)] = true
	}
	candidate := name
	for suffix := 2; taken[strings.ToLower(candidate)]; suffix++ {
		candidate = fmt.Sprintf("%s %d", name, suffix)
	}
	return candidate
}

func (s *Service) teamSigningKeyLocked() (ed25519.PrivateKey, error) {
	if encoded := strings.TrimSpace(s.st.Secrets[teamSigningSecret]); encoded != "" {
		seed, err := base64.StdEncoding.DecodeString(encoded)
		if err == nil && len(seed) == ed25519.SeedSize {
			return ed25519.NewKeyFromSeed(seed), nil
		}
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	s.st.Secrets[teamSigningSecret] = base64.StdEncoding.EncodeToString(private.Seed())
	if err := s.st.SaveSecrets(); err != nil {
		return nil, err
	}
	_ = public
	return private, nil
}

func canonicalTeamPackage(pkg model.TeamPackage) []byte {
	copy := pkg
	copy.Signature = ""
	copy.PublicKey = ""
	copy.SignedAt = time.Time{}
	data, _ := json.Marshal(copy)
	return data
}

func (s *Service) signTeamPackageLocked(pkg *model.TeamPackage) error {
	private, err := s.teamSigningKeyLocked()
	if err != nil {
		return err
	}
	signature := ed25519.Sign(private, canonicalTeamPackage(*pkg))
	pkg.Signature = base64.StdEncoding.EncodeToString(signature)
	pkg.PublicKey = base64.StdEncoding.EncodeToString(private.Public().(ed25519.PublicKey))
	pkg.SignedAt = time.Now().UTC()
	return nil
}

func verifyTeamPackage(pkg model.TeamPackage) error {
	if pkg.Signature == "" && pkg.PublicKey == "" && pkg.SignedAt.IsZero() {
		return nil
	}
	if pkg.Signature == "" || pkg.PublicKey == "" {
		return fmt.Errorf("team package signature is incomplete")
	}
	public, err := base64.StdEncoding.DecodeString(pkg.PublicKey)
	if err != nil || len(public) != ed25519.PublicKeySize {
		return fmt.Errorf("team package public key is invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(pkg.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("team package signature is invalid")
	}
	if !ed25519.Verify(ed25519.PublicKey(public), canonicalTeamPackage(pkg), signature) {
		return fmt.Errorf("team package signature does not match")
	}
	return nil
}

// ExportTeam writes one channel and its member bots as a portable JSON package.
// It includes only enabled SKILL.md bodies, persona text, MEMORY.md and routines;
// no keys, connections, threads or app credentials travel.
func (s *Service) ExportTeam(groupID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var group *model.Group
	for index := range s.st.State.Groups {
		if s.st.State.Groups[index].ID == groupID {
			group = &s.st.State.Groups[index]
			break
		}
	}
	if group == nil {
		return "", fmt.Errorf("channel not found")
	}
	pkg := model.TeamPackage{
		Format: teamPackageFormat, Version: 1, ExportedAt: time.Now(), Name: group.Name,
		Group: model.PackageGroup{
			Name: group.Name, Description: group.Description, Color: group.Color,
			Instructions: group.Instructions,
			LeadKey:      group.LeadID, MemberKeys: append([]string(nil), group.MemberIDs...),
		},
	}
	seenSkills := map[string]bool{}
	for _, botID := range group.MemberIDs {
		bot := s.findBotLocked(botID)
		if bot == nil {
			continue
		}
		item := model.PackageBot{
			Key: bot.ID, Name: bot.Name, Title: bot.Title, Description: bot.Description,
			Soul: bot.Soul, Color: bot.Color, Department: bot.Department, ModelID: bot.ModelID, MemoryOff: bot.MemoryOff,
		}
		if path, err := s.memoryPathLocked(bot.ID); err == nil {
			if content, _, _, err := readMemoryFile(path); err == nil {
				item.Memory = content
			}
		}
		for _, skill := range s.scanSkillsLocked(bot) {
			if !skill.Enabled || seenSkills[skill.ID] {
				continue
			}
			data, err := os.ReadFile(skill.Path)
			if err != nil {
				continue
			}
			seenSkills[skill.ID] = true
			item.Skills = append(item.Skills, model.PackageSkill{
				ID: skill.ID, Name: skill.Name, Description: skill.Description, Body: string(data),
			})
		}
		pkg.Bots = append(pkg.Bots, item)
		for _, routine := range s.st.State.Routines {
			if routine.BotID != bot.ID || (routine.GroupID != "" && routine.GroupID != group.ID) {
				continue
			}
			pkg.Routines = append(pkg.Routines, model.PackageRoutine{
				BotKey: bot.ID, Name: routine.Name, Prompt: routine.Prompt, Cadence: routine.Cadence,
				TimeOfDay: routine.TimeOfDay, Weekday: routine.Weekday, Enabled: routine.Enabled,
				Channel: routine.GroupID != "", CronExpression: routine.CronExpression, TimeZone: routine.TimeZone,
				Continuity: routine.Continuity, Overlap: routine.Overlap, Checks: routine.Checks,
			})
		}
	}
	if err := s.signTeamPackageLocked(&pkg); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(pkg, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func safePackageSkillDir(id string) string {
	value := skillSlug(id)
	if value == "" {
		value = "skill"
	}
	return value
}

// ImportTeam adds a Grox or OpenMaus team. Bots start at Ask, skills start
// disabled and routines start paused.
func (s *Service) ImportTeam(raw string) (model.TeamImportResult, error) {
	if len(raw) > 4*1024*1024 {
		return model.TeamImportResult{}, fmt.Errorf("team package is too large (4 MB max)")
	}
	raw = strings.TrimPrefix(strings.TrimSpace(raw), "\ufeff")
	if strings.HasPrefix(raw, "---\n") || strings.HasPrefix(raw, "---\r\n") {
		return s.importBotMRR(raw)
	}
	var header struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal([]byte(raw), &header); err != nil {
		return s.importGrokBots(raw)
	}
	if header.Format == "openmaus.package" {
		return s.importOpenMausTeam(raw)
	}
	if header.Format != teamPackageFormat {
		return s.importGrokBots(raw)
	}
	var pkg model.TeamPackage
	if err := json.Unmarshal([]byte(raw), &pkg); err != nil {
		return model.TeamImportResult{}, fmt.Errorf("invalid team package: %w", err)
	}
	if err := verifyTeamPackage(pkg); err != nil {
		return model.TeamImportResult{}, err
	}
	if pkg.Format != teamPackageFormat || pkg.Version != 1 {
		return model.TeamImportResult{}, fmt.Errorf("unsupported team package format")
	}
	if len(pkg.Bots) == 0 {
		return model.TeamImportResult{}, fmt.Errorf("the package has no bots")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	idMap := map[string]string{}
	result := model.TeamImportResult{Name: s.uniqueGroupNameLocked(pkg.Group.Name)}
	for _, item := range pkg.Bots {
		name := s.uniqueBotNameLocked(item.Name)
		botID := newID("bot")
		threadID := newID("thread")
		thread := model.Thread{
			ID: threadID, BotID: botID, Title: "New conversation", Kind: "chat",
			CreatedAt: now, UpdatedAt: now,
			Messages: []model.Message{{
				ID: newID("msg"), Role: model.RoleBot, Kind: model.KindText,
				Text:      "Imported from " + pkg.Name + ". Review my profile and memory before giving me work.",
				CreatedAt: now, UpdatedAt: now,
			}},
		}
		modelID := strings.TrimSpace(item.ModelID)
		if modelID == "" {
			modelID = "grox-demo"
		}
		bot := model.Bot{
			ID: botID, Name: name, Title: item.Title, Description: item.Description, Soul: item.Soul,
			Color: item.Color, Department: item.Department, MascotShape: "cursor", Expression: "idle", ModelID: modelID,
			Approval: model.ApprovalAsk, Notifications: true, MemoryOff: item.MemoryOff,
			CreatedAt: now, UpdatedAt: now, LastActiveAt: now, Threads: []model.Thread{thread},
		}
		if path, err := s.memoryPathLocked(botID); err == nil && strings.TrimSpace(item.Memory) != "" {
			if err := writeMemoryAtomic(path, []byte(item.Memory)); err == nil {
				result.Memories++
			}
		}
		for _, skill := range item.Skills {
			dir := filepath.Join(s.dir, "skills", "imported-"+safePackageSkillDir(skill.ID))
			if err := os.MkdirAll(dir, 0o700); err != nil {
				continue
			}
			path := filepath.Join(dir, "SKILL.md")
			if _, err := os.Stat(path); err == nil {
				dir = filepath.Join(s.dir, "skills", "imported-"+safePackageSkillDir(skill.ID)+"-"+botID)
				_ = os.MkdirAll(dir, 0o700)
				path = filepath.Join(dir, "SKILL.md")
			}
			if err := os.WriteFile(path, []byte(skill.Body), 0o600); err == nil {
				result.Skills++
			}
		}
		s.st.State.Bots = append(s.st.State.Bots, bot)
		idMap[item.Key] = botID
		result.Bots++
	}
	groupID := newID("group")
	leadID := idMap[pkg.Group.LeadKey]
	members := make([]string, 0, len(pkg.Group.MemberKeys))
	for _, key := range pkg.Group.MemberKeys {
		if mapped := idMap[key]; mapped != "" {
			members = append(members, mapped)
		}
	}
	if len(members) == 0 {
		for _, bot := range s.st.State.Bots[len(s.st.State.Bots)-len(pkg.Bots):] {
			members = append(members, bot.ID)
		}
	}
	if leadID == "" && len(members) > 0 {
		leadID = members[0]
	}
	color := pkg.Group.Color
	if !allowedColors[color] {
		color = "purple"
	}
	group := model.Group{
		ID: groupID, Name: result.Name, Description: pkg.Group.Description, Color: color,
		Instructions: pkg.Group.Instructions,
		MemberIDs:    members, LeadID: leadID, CreatedAt: now, UpdatedAt: now,
		Threads: []model.Thread{{
			ID: newID("thread"), BotID: "", Title: "New conversation", Kind: "group",
			CreatedAt: now, UpdatedAt: now,
		}},
	}
	s.st.State.Groups = append(s.st.State.Groups, group)
	result.Groups = 1
	for _, routine := range pkg.Routines {
		botID := idMap[routine.BotKey]
		if botID == "" && len(members) > 0 {
			botID = members[0]
		}
		if botID == "" {
			continue
		}
		r := model.Routine{
			ID: newID("routine"), BotID: botID, Name: routine.Name, Prompt: routine.Prompt,
			Cadence: normalCadence(routine.Cadence), TimeOfDay: schedule.Clock(routine.TimeOfDay),
			Weekday: routine.Weekday, Enabled: false, CreatedAt: now, UpdatedAt: now,
			CronExpression: routine.CronExpression, TimeZone: routine.TimeZone,
			Continuity: routine.Continuity, Overlap: normalizeRoutineOverlap(routine.Overlap), Checks: normalizeRoutineChecks(routine.Checks),
		}
		if routine.Channel {
			r.GroupID, r.Continuity = groupID, false
		}
		r.NextRun = schedule.Next(r, now)
		s.st.State.Routines = append(s.st.State.Routines, r)
		result.Routines++
	}
	s.st.State.ActiveGroupID = groupID
	s.st.State.ActiveThreadID = group.Threads[0].ID
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return result, nil
}
