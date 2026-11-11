// Package model holds the data Grox persists and sends to its frontend.
package model

import "time"

const (
	AppVersion = "0.19.0"

	RoleUser   = "user"
	RoleBot    = "bot"
	RoleSystem = "system"

	KindText     = "text"
	KindOptions  = "options"
	KindApproval = "approval"
	KindNotice   = "notice"

	StatusPending  = "pending"
	StatusAllowed  = "allowed"
	StatusAlways   = "always"
	StatusDenied   = "denied"
	StatusAnswered = "answered"
	StatusRunning  = "running"
	StatusOK       = "ok"
	StatusError    = "error"

	ApprovalAsk  = "ask"
	ApprovalAuto = "auto"
	ApprovalFull = "full"
)

// AppState is the single document the app owns. Everything the sidebar, a
// conversation and the settings surfaces show comes from it.
type AppState struct {
	Version        int                   `json:"version"`
	Revision       int64                 `json:"revision"`
	Bots           []Bot                 `json:"bots"`
	Groups         []Group               `json:"groups"`
	Routines       []Routine             `json:"routines"`
	Presets        []Preset              `json:"presets"`
	Webhooks       []Webhook             `json:"webhooks"`
	Runs           []Run                 `json:"runs"`
	Connections    map[string]Connection `json:"connections"`
	MCPServers     []MCPServer           `json:"mcpServers,omitempty"`
	Settings       Settings              `json:"settings"`
	ActiveBotID    string                `json:"activeBotId"`
	ActiveGroupID  string                `json:"activeGroupId"`
	ActiveThreadID string                `json:"activeThreadId"`
	CreatedAt      time.Time             `json:"createdAt"`
	UpdatedAt      time.Time             `json:"updatedAt"`
}

// Bot is one contact in the roster: a persona, a model, and its own threads.
type Bot struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Title         string     `json:"title"`
	Description   string     `json:"description"`
	Soul          string     `json:"soul"`
	Color         string     `json:"color"`
	MascotShape   string     `json:"mascotShape"`
	Expression    string     `json:"expression"`
	AvatarURL     string     `json:"avatarUrl,omitempty"`
	ModelID       string     `json:"modelId"`
	Approval      string     `json:"approval"`
	WorkingDir    string     `json:"workingDir,omitempty"`
	ComputerMode  string     `json:"computerMode,omitempty"`
	SSHHost       string     `json:"sshHost,omitempty"`
	SSHUser       string     `json:"sshUser,omitempty"`
	SSHRoot       string     `json:"sshRoot,omitempty"`
	SSHKeyPath    string     `json:"sshKeyPath,omitempty"`
	SSHPort       int        `json:"sshPort,omitempty"`
	Notifications bool       `json:"notifications"`
	SpeakReplies  bool       `json:"speakReplies"`
	Voice         string     `json:"voice,omitempty"`
	Skills        []BotSkill `json:"skills,omitempty"`
	MemoryOff     bool       `json:"memoryOff,omitempty"`
	Pinned        bool       `json:"pinned"`
	Hidden        bool       `json:"hidden"`
	Archived      bool       `json:"archived"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	LastActiveAt  time.Time  `json:"lastActiveAt"`
	Threads       []Thread   `json:"threads"`
}

// BotSkill is the persisted on/off state for one discovered SKILL.md file.
// The skill text itself stays on disk; only the id and enabled flag live in state.
type BotSkill struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

// Skill is a discovered SKILL.md file and its per-bot state. Body is filled by
// ReadSkill and omitted from ListSkills to keep the state/event payloads small.
type Skill struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Source      string    `json:"source"`
	Path        string    `json:"path"`
	Bytes       int       `json:"bytes"`
	Enabled     bool      `json:"enabled"`
	Body        string    `json:"body,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// MemoryState is the bot's editable MEMORY.md and the read-only topic index.
// The bytes live under <dataDir>/memory/<botID>; only MemoryOff is in state.
type MemoryState struct {
	BotID       string        `json:"botId"`
	Enabled     bool          `json:"enabled"`
	Content     string        `json:"content"`
	Path        string        `json:"path"`
	Revision    string        `json:"revision"`
	Bytes       int           `json:"bytes"`
	Lines       int           `json:"lines"`
	LoadedBytes int           `json:"loadedBytes"`
	LoadedLines int           `json:"loadedLines"`
	LimitBytes  int           `json:"limitBytes"`
	LimitLines  int           `json:"limitLines"`
	Topics      []MemoryTopic `json:"topics"`
}

// MemoryForgetResult reports a forget pass over MEMORY.md.
type MemoryForgetResult struct {
	Removed  int `json:"removed"`
	Archived int `json:"archived"`
}

// MemoryTidyResult reports an archive pass over MEMORY.md.
type MemoryTidyResult struct {
	Archived int  `json:"archived"`
	Lines    int  `json:"lines"`
	Bytes    int  `json:"bytes"`
	Within   bool `json:"within"`
}

// MemoryTopic is one file under memory/<botID>/topics; it is never loaded
// automatically into a prompt.
type MemoryTopic struct {
	Name        string    `json:"name"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Bytes       int       `json:"bytes"`
	Content     string    `json:"content,omitempty"`
	Revision    string    `json:"revision,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Webhook is one local inbound trigger. Its token is the capability secret in
// the URL; the receiver only binds loopback.
type Webhook struct {
	ID               string    `json:"id"`
	BotID            string    `json:"botId"`
	Name             string    `json:"name"`
	Prompt           string    `json:"prompt"`
	Token            string    `json:"token"`
	Enabled          bool      `json:"enabled"`
	RequireSignature bool      `json:"requireSignature,omitempty"`
	EventCount       int       `json:"eventCount"`
	LastEventAt      time.Time `json:"lastEventAt,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// WebhookInfo reports the loopback receiver and any bind error.
type WebhookInfo struct {
	BaseURL string    `json:"baseUrl"`
	Error   string    `json:"error,omitempty"`
	Items   []Webhook `json:"items"`
}

// WebhookInput is the New webhook form.
type WebhookInput struct {
	BotID            string `json:"botId"`
	Name             string `json:"name"`
	Prompt           string `json:"prompt"`
	Enabled          bool   `json:"enabled"`
	RequireSignature bool   `json:"requireSignature"`
}

// WebhookPatch edits only the fields it sets.
type WebhookPatch struct {
	Name             *string `json:"name,omitempty"`
	Prompt           *string `json:"prompt,omitempty"`
	Enabled          *bool   `json:"enabled,omitempty"`
	RequireSignature *bool   `json:"requireSignature,omitempty"`
}

// Preset is a reusable New bot starting point. It carries persona text, never
// a model, approval level, folder or credential.
type Preset struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Soul        string    `json:"soul"`
	Color       string    `json:"color"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// PresetInput is the Save as preset form.
type PresetInput struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Soul        string `json:"soul"`
	Color       string `json:"color"`
}

// PresetPatch edits only the fields it sets.
type PresetPatch struct {
	Name        *string `json:"name,omitempty"`
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Soul        *string `json:"soul,omitempty"`
	Color       *string `json:"color,omitempty"`
}

// TeamPackage is a portable channel/team export. It carries persona text,
// skills, memory and paused routines, never API keys or app connections.
type TeamPackage struct {
	Format     string           `json:"format"`
	Version    int              `json:"version"`
	ExportedAt time.Time        `json:"exportedAt"`
	Name       string           `json:"name"`
	Group      PackageGroup     `json:"group"`
	Bots       []PackageBot     `json:"bots"`
	Routines   []PackageRoutine `json:"routines,omitempty"`
}

type PackageGroup struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Color       string   `json:"color"`
	LeadKey     string   `json:"leadKey"`
	MemberKeys  []string `json:"memberKeys"`
}

type PackageBot struct {
	Key         string         `json:"key"`
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Soul        string         `json:"soul"`
	Color       string         `json:"color"`
	ModelID     string         `json:"modelId"`
	Skills      []PackageSkill `json:"skills,omitempty"`
	Memory      string         `json:"memory,omitempty"`
	MemoryOff   bool           `json:"memoryOff,omitempty"`
}

type PackageSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Body        string `json:"body"`
}

type PackageRoutine struct {
	BotKey    string `json:"botKey,omitempty"`
	Name      string `json:"name"`
	Prompt    string `json:"prompt"`
	Cadence   string `json:"cadence"`
	TimeOfDay string `json:"timeOfDay"`
	Weekday   int    `json:"weekday"`
	Enabled   bool   `json:"enabled"`
}

// TeamImportResult is the additive import receipt.
type TeamImportResult struct {
	Bots     int    `json:"bots"`
	Groups   int    `json:"groups"`
	Routines int    `json:"routines"`
	Skills   int    `json:"skills"`
	Memories int    `json:"memories"`
	Name     string `json:"name"`
}

// MCPServer is a user-managed remote streamable-HTTP MCP server. The bearer
// token is stored in secrets.json, never in AppState or API responses.
type MCPServer struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Transport      string    `json:"transport,omitempty"`
	URL            string    `json:"url,omitempty"`
	Command        string    `json:"command,omitempty"`
	Args           []string  `json:"args,omitempty"`
	Enabled        bool      `json:"enabled"`
	AuthConfigured bool      `json:"authConfigured"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// MCPServerInput is the add form. Token is write-only.
type MCPServerInput struct {
	Name      string   `json:"name"`
	Transport string   `json:"transport,omitempty"`
	URL       string   `json:"url,omitempty"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	Token     string   `json:"token,omitempty"`
	Enabled   bool     `json:"enabled"`
}

// MCPServerPatch edits only fields that are set; an empty Token keeps the old one.
type MCPServerPatch struct {
	Name      *string   `json:"name,omitempty"`
	Transport *string   `json:"transport,omitempty"`
	URL       *string   `json:"url,omitempty"`
	Command   *string   `json:"command,omitempty"`
	Args      *[]string `json:"args,omitempty"`
	Token     *string   `json:"token,omitempty"`
	Enabled   *bool     `json:"enabled,omitempty"`
}

// MCPServerConfig is the runtime-only view; Token never leaves the Go process.
type MCPServerConfig struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Transport string   `json:"transport,omitempty"`
	URL       string   `json:"url,omitempty"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	Token     string   `json:"token,omitempty"`
}

// Thread is one conversation with a bot: a chat, a task, or a routine run.
type Thread struct {
	ID        string    `json:"id"`
	BotID     string    `json:"botId"`
	Title     string    `json:"title"`
	Kind      string    `json:"kind"`
	Pinned    bool      `json:"pinned"`
	Unread    int       `json:"unread"`
	Busy      bool      `json:"busy"`
	Status    string    `json:"status,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Messages  []Message `json:"messages"`
}

// Message is one line in a transcript. Tool runs live in Activities, so a
// single bot message can show the work above its answer.
type Message struct {
	ID          string       `json:"id"`
	Role        string       `json:"role"`
	Kind        string       `json:"kind"`
	Text        string       `json:"text"`
	Status      string       `json:"status,omitempty"`
	Pending     bool         `json:"pending"`
	Error       bool         `json:"error"`
	SenderID    string       `json:"senderId,omitempty"`
	SenderName  string       `json:"senderName,omitempty"`
	Engine      string       `json:"engine,omitempty"`
	Model       string       `json:"model,omitempty"`
	Options     []Option     `json:"options,omitempty"`
	Approval    *Approval    `json:"approval,omitempty"`
	Activities  []Activity   `json:"activities,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
}

// Attachment is a file copied into the Grox workspace and referenced by a message.
// The bytes live in <workspace>/attachments; only the metadata is in state.json.
type Attachment struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Mime      string    `json:"mime"`
	Kind      string    `json:"kind"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

// Option is one answer in a question card.
type Option struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// Approval describes a decision the bot needs before it acts.
type Approval struct {
	Title     string    `json:"title"`
	Command   string    `json:"command,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	Risk      string    `json:"risk,omitempty"`
	Decision  string    `json:"decision,omitempty"`
	DecidedAt time.Time `json:"decidedAt,omitempty"`
}

// Activity is a tool run reported above a bot's answer.
type Activity struct {
	Label     string    `json:"label"`
	Detail    string    `json:"detail,omitempty"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"startedAt"`
}

// Group is a channel: a shared conversation with a roster of bots. The lead
// answers by default; @mentions route a message to another member.
type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Color       string    `json:"color"`
	MemberIDs   []string  `json:"memberIds"`
	LeadID      string    `json:"leadId"`
	Pinned      bool      `json:"pinned"`
	Unread      int       `json:"unread"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	Threads     []Thread  `json:"threads"`
}

// FileEntry is one item in a bot's local working folder.
type FileEntry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Dir      bool      `json:"dir"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	Mime     string    `json:"mime,omitempty"`
}

// FolderListing is one directory inside a bot's local computer.
type FolderListing struct {
	Root    string      `json:"root"`
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
}

// FilePreview is a bounded read of one local file.
type FilePreview struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Mime      string `json:"mime,omitempty"`
	Text      string `json:"text,omitempty"`
	Data      string `json:"data,omitempty"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

// CommandResult is the output of a command the person ran in the Computer
// panel. It is not an agent tool call; the person explicitly typed it.
type CommandResult struct {
	Command    string `json:"command"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMS int64  `json:"durationMs"`
}

// ComposioLink is an OAuth link session returned by Composio.
type ComposioLink struct {
	AppID     string `json:"appId"`
	URL       string `json:"url"`
	AccountID string `json:"accountId"`
}

// ComposioTool is one live tool exposed by a Composio tool-router session.
type ComposioTool struct {
	Slug        string         `json:"slug"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Toolkit     string         `json:"toolkit"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
}

// Routine is a recurring task: a prompt sent to a bot on a schedule.
type Routine struct {
	ID         string    `json:"id"`
	BotID      string    `json:"botId"`
	Name       string    `json:"name"`
	Prompt     string    `json:"prompt"`
	Cadence    string    `json:"cadence"`
	TimeOfDay  string    `json:"timeOfDay"`
	Weekday    int       `json:"weekday"`
	Enabled    bool      `json:"enabled"`
	NextRun    time.Time `json:"nextRun"`
	LastRun    time.Time `json:"lastRun,omitempty"`
	LastStatus string    `json:"lastStatus,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Run records one execution of a routine.
type Run struct {
	ID         string    `json:"id"`
	RoutineID  string    `json:"routineId"`
	BotID      string    `json:"botId"`
	ThreadID   string    `json:"threadId"`
	Title      string    `json:"title"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt,omitempty"`
	Summary    string    `json:"summary,omitempty"`
}

// Connection is one app from the marketplace.
type Connection struct {
	ID          string    `json:"id"`
	Connected   bool      `json:"connected"`
	ExternalID  string    `json:"externalId,omitempty"`
	Account     string    `json:"account,omitempty"`
	ConnectedAt time.Time `json:"connectedAt,omitempty"`
}

// Settings are app-wide preferences.
type Settings struct {
	Theme         string `json:"theme"`
	VoiceName     string `json:"voiceName,omitempty"`
	PhoneEnabled  bool   `json:"phoneEnabled,omitempty"`
	PhoneToken    string `json:"phoneToken,omitempty"`
	Language      string `json:"language"`
	SidebarWidth  int    `json:"sidebarWidth"`
	Advanced      bool   `json:"advanced"`
	ReduceMotion  bool   `json:"reduceMotion"`
	Notifications bool   `json:"notifications"`
	Sounds        bool   `json:"sounds"`
	EngineMode    string `json:"engineMode"`
	APIBaseURL    string `json:"apiBaseUrl"`
	APIModel      string `json:"apiModel"`
}

// Provider groups models by the engine that serves them.
type Provider struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Accent   string  `json:"accent"`
	Status   string  `json:"status"`
	Detail   string  `json:"detail"`
	SignedIn bool    `json:"signedIn"`
	Models   []Model `json:"models"`
}

// Model is one choice in the model picker.
type Model struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Provider     string `json:"provider"`
	ProviderName string `json:"providerName"`
	Accent       string `json:"accent"`
	Description  string `json:"description"`
	Default      bool   `json:"default"`
	Available    bool   `json:"available"`
}

// AppEntry is one connected-app marketplace row.
type AppEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Color       string `json:"color"`
	Icon        string `json:"icon"`
	Connected   bool   `json:"connected"`
	Account     string `json:"account,omitempty"`
}

// SecretStatus tells the UI which keys exist without ever sending one back.
type SecretStatus struct {
	Configured map[string]bool   `json:"configured"`
	Hints      map[string]string `json:"hints"`
}

// EngineInfo reports one detected CLI.
type EngineInfo struct {
	ProviderID string `json:"providerId"`
	Command    string `json:"command"`
	Version    string `json:"version"`
	Status     string `json:"status"`
	Detail     string `json:"detail"`
}

// PhoneInfo describes the local web companion. The token is part of the URL;
// anyone on the same network with it can read and send this workspace's chats.
type PhoneInfo struct {
	Enabled   bool   `json:"enabled"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	QR        string `json:"qr,omitempty"`
	Error     string `json:"error,omitempty"`
	Port      int    `json:"port"`
	Connected int    `json:"connected"`
}

// Bootstrap is everything the frontend needs for its first paint.
type Bootstrap struct {
	State     AppState     `json:"state"`
	Providers []Provider   `json:"providers"`
	Apps      []AppEntry   `json:"apps"`
	Engines   []EngineInfo `json:"engines"`
	Secrets   SecretStatus `json:"secrets"`
	Phone     PhoneInfo    `json:"phone"`
	Version   string       `json:"version"`
	Platform  string       `json:"platform"`
	DataDir   string       `json:"dataDir"`
	DemoMode  bool         `json:"demoMode"`
}

// Turn describes the transient state of a bot working in a thread.
type Turn struct {
	BotID    string `json:"botId"`
	GroupID  string `json:"groupId,omitempty"`
	ThreadID string `json:"threadId"`
	Busy     bool   `json:"busy"`
	Status   string `json:"status,omitempty"`
	Engine   string `json:"engine,omitempty"`
}

// Toast is a short message the app shows over the transcript.
type Toast struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
}

// Event is pushed to the page. Exactly one of State, Message, Delta or Turn
// (or Toast) is set, according to Type.
type Event struct {
	Type      string    `json:"type"`
	Revision  int64     `json:"revision"`
	State     *AppState `json:"state,omitempty"`
	BotID     string    `json:"botId,omitempty"`
	GroupID   string    `json:"groupId,omitempty"`
	ThreadID  string    `json:"threadId,omitempty"`
	MessageID string    `json:"messageId,omitempty"`
	Message   *Message  `json:"message,omitempty"`
	Delta     string    `json:"delta,omitempty"`
	Turn      *Turn     `json:"turn,omitempty"`
	Toast     *Toast    `json:"toast,omitempty"`
}

// CreateBotInput is the New bot form.
type CreateBotInput struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Soul        string `json:"soul"`
	Color       string `json:"color"`
	ModelID     string `json:"modelId"`
}

// BotPatch edits only the fields it sets.
type BotPatch struct {
	Name         *string `json:"name,omitempty"`
	Title        *string `json:"title,omitempty"`
	Description  *string `json:"description,omitempty"`
	Soul         *string `json:"soul,omitempty"`
	Color        *string `json:"color,omitempty"`
	ModelID      *string `json:"modelId,omitempty"`
	Approval     *string `json:"approval,omitempty"`
	MascotShape  *string `json:"mascotShape,omitempty"`
	Expression   *string `json:"expression,omitempty"`
	AvatarURL    *string `json:"avatarUrl,omitempty"`
	WorkingDir   *string `json:"workingDir,omitempty"`
	ComputerMode *string `json:"computerMode,omitempty"`
	SSHHost      *string `json:"sshHost,omitempty"`
	SSHUser      *string `json:"sshUser,omitempty"`
	SSHRoot      *string `json:"sshRoot,omitempty"`
	SSHKeyPath   *string `json:"sshKeyPath,omitempty"`
	SSHPort      *int    `json:"sshPort,omitempty"`

	Notifications *bool   `json:"notifications,omitempty"`
	SpeakReplies  *bool   `json:"speakReplies,omitempty"`
	Voice         *string `json:"voice,omitempty"`
	MemoryOff     *bool   `json:"memoryOff,omitempty"`
	Pinned        *bool   `json:"pinned,omitempty"`
	Hidden        *bool   `json:"hidden,omitempty"`
	Archived      *bool   `json:"archived,omitempty"`
}

// RoutineInput is the New routine form.
type RoutineInput struct {
	BotID     string `json:"botId"`
	Name      string `json:"name"`
	Prompt    string `json:"prompt"`
	Cadence   string `json:"cadence"`
	TimeOfDay string `json:"timeOfDay"`
	Weekday   int    `json:"weekday"`
	Enabled   bool   `json:"enabled"`
}

// RoutinePatch edits only the fields it sets.
type RoutinePatch struct {
	Name      *string `json:"name,omitempty"`
	Prompt    *string `json:"prompt,omitempty"`
	Cadence   *string `json:"cadence,omitempty"`
	TimeOfDay *string `json:"timeOfDay,omitempty"`
	Weekday   *int    `json:"weekday,omitempty"`
	Enabled   *bool   `json:"enabled,omitempty"`
}

// SendResult points at the user message and the bot reply it started.
type SendResult struct {
	BotID     string `json:"botId"`
	GroupID   string `json:"groupId,omitempty"`
	ThreadID  string `json:"threadId"`
	MessageID string `json:"messageId"`
}

// CreateGroupInput is the New channel form.
type CreateGroupInput struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Color       string   `json:"color"`
	MemberIDs   []string `json:"memberIds"`
	LeadID      string   `json:"leadId"`
}

// GroupPatch edits only the fields it sets.
type GroupPatch struct {
	Name        *string   `json:"name,omitempty"`
	Description *string   `json:"description,omitempty"`
	Color       *string   `json:"color,omitempty"`
	MemberIDs   *[]string `json:"memberIds,omitempty"`
	LeadID      *string   `json:"leadId,omitempty"`
	Pinned      *bool     `json:"pinned,omitempty"`
}
