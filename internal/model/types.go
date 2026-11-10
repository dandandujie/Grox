// Package model holds the data Grox persists and sends to its frontend.
package model

import "time"

const (
	AppVersion = "0.1.0"

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
	Routines       []Routine             `json:"routines"`
	Runs           []Run                 `json:"runs"`
	Connections    map[string]Connection `json:"connections"`
	Settings       Settings              `json:"settings"`
	ActiveBotID    string                `json:"activeBotId"`
	ActiveThreadID string                `json:"activeThreadId"`
	CreatedAt      time.Time             `json:"createdAt"`
	UpdatedAt      time.Time             `json:"updatedAt"`
}

// Bot is one contact in the roster: a persona, a model, and its own threads.
type Bot struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Title         string    `json:"title"`
	Description   string    `json:"description"`
	Soul          string    `json:"soul"`
	Color         string    `json:"color"`
	MascotShape   string    `json:"mascotShape"`
	Expression    string    `json:"expression"`
	AvatarURL     string    `json:"avatarUrl,omitempty"`
	ModelID       string    `json:"modelId"`
	Approval      string    `json:"approval"`
	WorkingDir    string    `json:"workingDir,omitempty"`
	Notifications bool      `json:"notifications"`
	SpeakReplies  bool      `json:"speakReplies"`
	Pinned        bool      `json:"pinned"`
	Hidden        bool      `json:"hidden"`
	Archived      bool      `json:"archived"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	LastActiveAt  time.Time `json:"lastActiveAt"`
	Threads       []Thread  `json:"threads"`
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
	ID         string     `json:"id"`
	Role       string     `json:"role"`
	Kind       string     `json:"kind"`
	Text       string     `json:"text"`
	Status     string     `json:"status,omitempty"`
	Pending    bool       `json:"pending"`
	Error      bool       `json:"error"`
	Engine     string     `json:"engine,omitempty"`
	Model      string     `json:"model,omitempty"`
	Options    []Option   `json:"options,omitempty"`
	Approval   *Approval  `json:"approval,omitempty"`
	Activities []Activity `json:"activities,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
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
	Account     string    `json:"account,omitempty"`
	ConnectedAt time.Time `json:"connectedAt,omitempty"`
}

// Settings are app-wide preferences.
type Settings struct {
	Theme         string `json:"theme"`
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

// Bootstrap is everything the frontend needs for its first paint.
type Bootstrap struct {
	State     AppState     `json:"state"`
	Providers []Provider   `json:"providers"`
	Apps      []AppEntry   `json:"apps"`
	Engines   []EngineInfo `json:"engines"`
	Secrets   SecretStatus `json:"secrets"`
	Version   string       `json:"version"`
	Platform  string       `json:"platform"`
	DataDir   string       `json:"dataDir"`
	DemoMode  bool         `json:"demoMode"`
}

// Turn describes the transient state of a bot working in a thread.
type Turn struct {
	BotID    string `json:"botId"`
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
	Name          *string `json:"name,omitempty"`
	Title         *string `json:"title,omitempty"`
	Description   *string `json:"description,omitempty"`
	Soul          *string `json:"soul,omitempty"`
	Color         *string `json:"color,omitempty"`
	ModelID       *string `json:"modelId,omitempty"`
	Approval      *string `json:"approval,omitempty"`
	MascotShape   *string `json:"mascotShape,omitempty"`
	Expression    *string `json:"expression,omitempty"`
	AvatarURL     *string `json:"avatarUrl,omitempty"`
	WorkingDir    *string `json:"workingDir,omitempty"`
	Notifications *bool   `json:"notifications,omitempty"`
	SpeakReplies  *bool   `json:"speakReplies,omitempty"`
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
	ThreadID  string `json:"threadId"`
	MessageID string `json:"messageId"`
}
