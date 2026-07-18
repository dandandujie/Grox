/* ─────────────────────────────────────────────────────────────────────────
   PermissionCard — the moment the agent asks the operator.
   Bright-bordered, gold-headed, keyboard-first (1 / 2 / 3). Resolves in
   place and quiets down into the transcript.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect } from "react";
import type { PermissionOption, SessionBlock } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

type PermissionBlock = Extract<SessionBlock, { type: "permission" }>;

export function PermissionCard({ block, sessionId }: { block: PermissionBlock; sessionId: string }) {
  const { language } = useI18n();
  const resolvePermission = useDesktop((s) => s.resolvePermission);
  const isActive = useDesktop((s) => s.activeId === sessionId && s.sessions[sessionId]?.status === "awaiting_permission");
  const resolved = block.resolved;
  const order: PermissionOption[] = ["allow_once", "allow_always", "deny"];
  const options = order.filter((o) => block.req.options.includes(o));
  const optionLabels: Record<PermissionOption, string> = {
    allow_once: language === "zh-CN" ? "仅本次允许" : "Allow once",
    allow_always: language === "zh-CN" ? "始终允许" : "Always allow",
    deny: language === "zh-CN" ? "拒绝" : "Deny",
  };

  useEffect(() => {
    if (resolved || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const idx = ["1", "2", "3"].indexOf(e.key);
      if (idx >= 0 && options[idx]) {
        e.preventDefault();
        resolvePermission(block.id, options[idx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resolved, isActive, options, block.id, resolvePermission]);

  return (
    <div
      className={`mb-5 animate-fade-up rounded-[6px] border p-4 transition-opacity ${
        resolved ? "border-line2 bg-raise opacity-60" : "border-focus bg-raise"
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon name="bolt" size={13} className={resolved ? "text-dim" : "text-gold"} />
        <span className={`lbl ${resolved ? "" : "!text-gold"}`}>
          {resolved
            ? resolved === "deny"
              ? language === "zh-CN" ? "已由用户拒绝" : "DENIED · BY OPERATOR"
              : language === "zh-CN"
                ? `已批准 · ${resolved === "allow_always" ? "始终" : "本次"}`
                : `APPROVED · ${resolved === "allow_always" ? "ALWAYS" : "ONCE"}`
            : language === "zh-CN" ? "需要用户批准" : "APPROVAL REQUIRED"}
        </span>
        {!resolved && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-gold" />}
      </div>

      <p className="mt-2 text-[12px] text-fg2">{block.req.description}</p>

      {block.req.payload && (
        <div className="mt-2.5 rounded-[5px] border border-line2 bg-void px-3 py-2">
          <code className="font-mono text-[11px] text-fg2 select-text">{block.req.payload}</code>
        </div>
      )}

      {!resolved && (
        <div className="mt-3.5 flex items-center gap-2">
          {options.map((opt, i) => {
            const styles =
              opt === "allow_once"
                ? "bg-acc text-base hover:bg-acc-deep font-medium"
                : opt === "allow_always"
                  ? "border border-acc-dim text-acc hover:bg-acc-wash"
                  : "border border-line3 text-mute hover:border-red hover:text-red";
            return (
              <button
                key={opt}
                onClick={() => resolvePermission(block.id, opt)}
                className={`flex h-7 items-center gap-2 rounded-[4px] px-3 text-[11.5px] transition-colors ${styles}`}
              >
                {optionLabels[opt]}
                <kbd
                  className={`font-mono text-[9.5px] ${opt === "allow_once" ? "text-base/70" : "text-faint"}`}
                >
                  {i + 1}
                </kbd>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
