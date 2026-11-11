import { useState } from "react";
import {
  Check, CheckCircle2, Copy, Loader2, ShieldCheck, Sparkles, Volume2, X, XCircle,
} from "lucide-react";
import type { Bot, Message } from "@/lib/bridge";
import { Markdown } from "@/components/Markdown";
import { Mascot } from "@/components/Mascot";
import { AttachmentGallery } from "@/components/Attachments";
import { cn } from "@/lib/cn";
import { clock } from "@/lib/format";

function ActivityChips({ message }: { message: Message }) {
  if (!message.activities?.length) return null;
  return (
    <div className="activity-chips">
      {message.activities.map((activity, index) => (
        <span
          key={activity.label + index}
          className={cn("activity-chip", activity.status === "error" && "is-error", activity.status === "running" && "is-running")}
          title={activity.detail}
        >
          {activity.status === "running" ? <Loader2 size={12} className="spin" /> : activity.status === "error" ? <XCircle size={12} /> : <Check size={12} />}
          <span>{activity.label}</span>
          {activity.detail && <span className="activity-detail">{activity.detail}</span>}
        </span>
      ))}
    </div>
  );
}

function MessageActions({ message, bot }: { message: Message; bot: Bot }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(message.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const speak = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message.text.replace(/[*_#>\`]/g, ""));
    utterance.rate = 1.02;
    window.speechSynthesis.speak(utterance);
  };
  return (
    <div className={cn("message-actions", message.role === "user" && "is-user")}>
      {message.text && (
        <button type="button" onClick={copy} aria-label="Copy message" title="Copy">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
      {message.role === "bot" && message.text && (
        <button type="button" onClick={speak} aria-label="Read aloud" title="Read aloud">
          <Volume2 size={14} />
        </button>
      )}
      <span className="message-time">{clock(message.createdAt)}</span>
      {message.usage && message.usage.totalTokens > 0 && (
        <span className="message-usage" title={message.usage.inputTokens + " in / " + message.usage.outputTokens + " out"}>{message.usage.totalTokens.toLocaleString()} tok</span>
      )}
      {message.engine && <span className="message-engine" title={message.engine}>{message.engine}</span>}
      {message.role === "bot" && bot.name && <span className="sr-only">from {bot.name}</span>}
    </div>
  );
}

function ApprovalCard({ message, onDecide }: { message: Message; onDecide: (decision: string) => void }) {
  const approval = message.approval;
  if (!approval) return null;
  const pending = message.status === "pending";
  const decision = message.status === "denied" ? "Denied" : message.status === "always" ? "Always allowed" : "Allowed";
  if (!pending) {
    const denied = message.status === "denied";
    return (
      <div className={cn("decision-card settled", denied && "is-denied")}>
        <div className="decision-head">
          {denied ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
          <div>
            <div className="decision-title">{approval.title}</div>
            <div className="decision-state">{decision} · {approval.command}</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="decision-card">
      <div className="decision-head">
        <span className="decision-icon"><ShieldCheck size={18} /></span>
        <div className="decision-heading">
          <div className="decision-title">{approval.title || "Approval needed"}</div>
          <div className="decision-kicker">This bot waits for you before it acts.</div>
        </div>
      </div>
      {approval.command && <pre className="decision-command">{approval.command}</pre>}
      {approval.reason && <p className="decision-reason">{approval.reason}</p>}
      {approval.risk && <p className="decision-risk">{approval.risk}</p>}
      <div className="decision-actions">
        <button type="button" className="btn btn-primary" onClick={() => onDecide("allow")}>Allow once</button>
        <button type="button" className="btn btn-secondary" onClick={() => onDecide("always")}>Always allow</button>
        <button type="button" className="btn btn-ghost danger-text" onClick={() => onDecide("deny")}>Deny</button>
      </div>
    </div>
  );
}

function OptionsCard({ message, onAnswer }: { message: Message; onAnswer: (answer: string) => void }) {
  const [custom, setCustom] = useState("");
  const pending = message.status === "pending";
  const options = message.options ?? [];
  return (
    <div className={cn("options-card", !pending && "is-settled")}>
      <div className="options-heading">
        <div>
          <div className="options-kicker"><Sparkles size={14} /> A question for you</div>
          <div className="options-title">{message.text || "Which way should we go?"}</div>
          <div className="options-sub">Pick whatever is closest; we can always expand from there.</div>
        </div>
        {!pending && <span className="settled-pill"><Check size={12} /> Answered</span>}
      </div>
      <div className="options-list">
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className="option-row"
            disabled={!pending}
            onClick={() => onAnswer(option.id)}
          >
            <span className="option-letter">{String.fromCharCode(65 + index)}</span>
            <span className="option-copy">
              <span className="option-label">{option.label}</span>
              {option.description && <span className="option-desc">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>
      {pending && (
        <form
          className="option-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (custom.trim()) onAnswer(custom.trim());
          }}
        >
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="Type your own answer"
            aria-label="Your own answer"
          />
          <button type="submit" disabled={!custom.trim()} aria-label="Send answer">
            <Check size={16} />
          </button>
        </form>
      )}
    </div>
  );
}

export function MessageItem({ message, bot, showSender, onDecide, onAnswer }: {
  message: Message;
  bot: Bot;
  showSender?: boolean;
  onDecide: (messageId: string, decision: string) => void;
  onAnswer: (messageId: string, answer: string) => void;
}) {
  const user = message.role === "user";
  if (message.kind === "approval") {
    return (
      <div className="message-row is-bot card-row" data-message-id={message.id}>
        {showSender && message.senderName && <SenderLabel bot={bot} name={message.senderName} />}
        <ApprovalCard message={message} onDecide={(decision) => onDecide(message.id, decision)} />
      </div>
    );
  }
  if (message.kind === "options") {
    return (
      <div className="message-row is-bot card-row" data-message-id={message.id}>
        {showSender && message.senderName && <SenderLabel bot={bot} name={message.senderName} />}
        <OptionsCard message={message} onAnswer={(answer) => onAnswer(message.id, answer)} />
      </div>
    );
  }
  if (message.kind === "notice") {
    return <div className="notice-row">{message.text}</div>;
  }

  return (
    <div className={cn("message-row", user ? "is-user" : "is-bot")} data-message-id={message.id}>
      <div className={cn("message-stack", user && "align-end")}>
        {!user && showSender && message.senderName && <SenderLabel bot={bot} name={message.senderName} />}
        <ActivityChips message={message} />
        {(message.text || message.pending || (message.attachments?.length ?? 0) > 0) && (
          <div className={cn("bubble", user ? "bubble-user" : "bubble-bot", message.error && "is-error", message.pending && "is-pending")}>
            {user ? (
              <>
                {message.text && <div className="plain-text">{message.text}</div>}
                <AttachmentGallery attachments={message.attachments ?? []} />
              </>
            ) : message.text ? (
              <Markdown>{message.text}</Markdown>
            ) : (
              <span className="typing-dots" aria-label="Typing"><i /><i /><i /></span>
            )}
            {message.pending && message.text && <span className="typing-caret" aria-hidden="true" />}
          </div>
        )}
        <MessageActions message={message} bot={bot} />
      </div>
    </div>
  );
}

function SenderLabel({ bot, name }: { bot: Bot; name: string }) {
  return (
    <div className="message-sender">
      <Mascot seed={name} size={22} title={name} />
      <span>{name}</span>
    </div>
  );
}

export function WorkingRow({ botName, status }: { botName: string; status: string }) {
  return (
    <div className="working-row" role="status" aria-live="polite">
      <span className="working-orb" />
      <span className="working-copy">{botName} is {status ? status.toLowerCase() : "working"}<span className="working-ellipsis"><i>.</i><i>.</i><i>.</i></span></span>
    </div>
  );
}
