import { useEffect, useMemo, useState } from "react";
import type { SessionBlock } from "../../bridge/types";
import { Markdown } from "../../lib/markdown";
import { useI18n } from "../../lib/i18n";
import { usePreferences } from "../../state/preferences";
import { useDesktop } from "../../state/store";
import { ResizeHandle } from "../common/ResizeHandle";
import { Icon } from "../fx/Icon";

type PlanBlock = Extract<SessionBlock, { type: "plan" }>;
type PermissionBlock = Extract<SessionBlock, { type: "permission" }>;

export function PlanPreviewPane() {
  const { language } = useI18n();
  const session = useDesktop((state) => state.activeId ? state.sessions[state.activeId] : null);
  const close = useDesktop((state) => state.setPlanPreviewOpen);
  const resolve = useDesktop((state) => state.resolvePermission);
  const width = usePreferences((state) => state.previewWidth);
  const setWidth = usePreferences((state) => state.setPreviewWidth);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState<"approve" | "revise" | null>(null);

  const { plan, review } = useMemo(() => {
    const blocks = session?.blocks ?? [];
    const reversed = [...blocks].reverse();
    return {
      plan: reversed.find((block): block is PlanBlock => block.type === "plan"),
      review: reversed.find((block): block is PermissionBlock =>
        block.type === "permission" && block.req.purpose === "plan" && !block.resolved),
    };
  }, [session?.blocks]);

  const done = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const total = plan?.steps.length ?? 0;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const generated = plan?.steps.length
    ? `# ${language === "zh-CN" ? "实施计划" : "Implementation plan"}\n\n${plan.steps.map((step) =>
        `- [${step.status === "completed" ? "x" : " "}] ${step.content}`,
      ).join("\n")}`
    : `# ${language === "zh-CN" ? "计划准备中" : "Preparing plan"}\n\n${language === "zh-CN" ? "Grok 正在探索项目并编写计划。" : "Grok is exploring the project and drafting the plan."}`;
  const content = review?.req.payload?.trim() || generated;
  const revising = !review && session?.status === "running";

  useEffect(() => {
    setSubmitting(null);
    setEditing(false);
  }, [review?.id]);

  const approve = () => {
    if (!review || submitting) return;
    setSubmitting("approve");
    resolve(review.id, "allow_once");
  };

  const requestChanges = () => {
    const note = feedback.trim();
    if (!review || !note || submitting) return;
    setSubmitting("revise");
    resolve(review.id, "deny", note);
    setEditing(false);
    setFeedback("");
  };

  return (
    <>
      <ResizeHandle side="left" value={width} onChange={setWidth} />
      <aside className="plan-preview flex min-w-0 shrink-0 flex-col border-l border-line bg-raise" style={{ width }}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-[4px] border border-gold/25 bg-gold/5 text-gold">
            <Icon name="file" size={12} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[10.5px] text-fg2">plan.md</p>
            <p className="font-mono text-[8.5px] tracking-[0.08em] text-faint">
              {review ? (language === "zh-CN" ? "等待审阅" : "AWAITING REVIEW") : revising ? (language === "zh-CN" ? "正在修订" : "REVISING") : (language === "zh-CN" ? "计划预览" : "PLAN PREVIEW")}
            </p>
          </div>
          {total > 0 && <span className="tnum text-[9.5px] text-gold">{done}/{total}</span>}
          <button onClick={() => close(false)} className="flex h-6 w-6 items-center justify-center text-dim hover:text-fg" title={language === "zh-CN" ? "关闭计划预览" : "Close plan preview"}>
            <Icon name="x" size={12} />
          </button>
        </header>

        {total > 0 && (
          <div className="relative h-[2px] shrink-0 overflow-hidden bg-line">
            <span className="absolute inset-y-0 left-0 bg-gold transition-[width] duration-500" style={{ width: `${progress}%` }} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto bg-base">
          <article className="mx-auto max-w-[760px] p-5 text-[13px] leading-relaxed text-fg2">
            <Markdown text={content} />
          </article>
        </div>

        <footer className="shrink-0 border-t border-line bg-raise p-3">
          {review ? (
            editing ? (
              <div className="animate-fade-up">
                <label className="lbl !text-[9px] !text-gold">{language === "zh-CN" ? "计划修改要求" : "REVISION NOTES"}</label>
                <textarea
                  autoFocus
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") requestChanges();
                    if (event.key === "Escape") setEditing(false);
                  }}
                  rows={3}
                  placeholder={language === "zh-CN" ? "说明需要补充、删减或调整的内容…" : "Describe what should be added, removed, or changed…"}
                  className="mt-2 block w-full resize-none rounded-[5px] border border-line2 bg-base px-3 py-2 text-[12px] leading-relaxed text-fg placeholder:text-faint focus:border-gold/50 focus:outline-none"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button onClick={() => setEditing(false)} className="h-8 rounded-[4px] border border-line2 px-3 text-[11px] text-mute hover:border-line3 hover:text-fg">{language === "zh-CN" ? "取消" : "Cancel"}</button>
                  <button onClick={requestChanges} disabled={!feedback.trim() || Boolean(submitting)} className="ml-auto flex h-8 items-center gap-2 rounded-[4px] bg-gold px-3 text-[11px] font-medium text-base disabled:opacity-40">
                    {submitting === "revise" && <span className="plan-spinner" />}
                    {language === "zh-CN" ? "发送修改要求" : "Request changes"}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="mb-2.5 text-[10.5px] leading-relaxed text-dim">{language === "zh-CN" ? "确认后 Grok 将退出只读计划模式并开始实施。" : "Approval exits read-only plan mode and starts implementation."}</p>
                <div className="flex gap-2">
                  <button onClick={() => setEditing(true)} disabled={Boolean(submitting)} className="flex h-8 flex-1 items-center justify-center gap-2 rounded-[4px] border border-line3 text-[11px] text-fg2 hover:border-gold/50 hover:text-gold disabled:opacity-40">
                    <Icon name="edit" size={11} />{language === "zh-CN" ? "要求修改" : "Request changes"}
                  </button>
                  <button onClick={approve} disabled={Boolean(submitting)} className="flex h-8 flex-1 items-center justify-center gap-2 rounded-[4px] bg-acc text-[11px] font-medium text-base hover:bg-acc-deep disabled:opacity-60">
                    {submitting === "approve" ? <span className="plan-spinner" /> : <Icon name="check" size={11} />}{language === "zh-CN" ? "确认并实施" : "Approve & build"}
                  </button>
                </div>
              </div>
            )
          ) : revising ? (
            <div className="flex items-center gap-3 py-1 text-[10.5px] text-dim">
              <span className="plan-spinner !border-gold/25 !border-t-gold" />
              <span>{language === "zh-CN" ? "Grok 正在根据你的意见更新计划…" : "Grok is revising the plan from your feedback…"}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-1 text-[10px] text-faint"><Icon name="check" size={10} className="text-green" />{language === "zh-CN" ? "计划已保存在当前任务中" : "Plan saved in this mission"}</div>
          )}
        </footer>
      </aside>
    </>
  );
}
