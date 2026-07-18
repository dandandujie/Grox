import { useMemo, useState } from "react";
import type {
  QuestionAnswers,
  QuestionNotes,
  QuestionResponse,
  SessionBlock,
} from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

type QuestionBlock = Extract<SessionBlock, { type: "question" }>;

function responseLabel(response: QuestionResponse, zh: boolean): string {
  switch (response.outcome) {
    case "accepted":
      return zh ? `已回答 ${Object.keys(response.answers).length} 项` : `${Object.keys(response.answers).length} ANSWERED`;
    case "chat_about_this":
      return zh ? "已返回对话" : "RETURNED TO CHAT";
    case "skip_interview":
      return zh ? "已跳过问答" : "INTERVIEW SKIPPED";
    case "cancelled":
      return zh ? "已取消" : "CANCELLED";
  }
}

export function QuestionCard({
  block,
}: {
  block: QuestionBlock;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const resolveQuestion = useDesktop((state) => state.resolveQuestion);
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [notes, setNotes] = useState<QuestionNotes>({});
  const resolved = block.response;

  const normalizedAnswers = useMemo(() => {
    const next: QuestionAnswers = {};
    for (const question of block.req.questions) {
      const selected = answers[question.question] ?? [];
      const note = notes[question.question]?.trim();
      if (selected.length > 0) next[question.question] = selected;
      else if (note) next[question.question] = ["Other"];
    }
    return next;
  }, [answers, block.req.questions, notes]);

  const partialAnswers = () =>
    Object.fromEntries(
      Object.entries(normalizedAnswers).map(([question, selected]) => [question, selected[0]]),
    );

  const choose = (questionText: string, label: string, multiSelect: boolean) => {
    setAnswers((current) => {
      const selected = current[questionText] ?? [];
      const next = multiSelect
        ? selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
        : [label];
      return { ...current, [questionText]: next };
    });
  };

  return (
    <section
      className={`mb-5 animate-fade-up overflow-hidden rounded-[6px] border bg-raise transition-opacity ${
        resolved ? "border-line2 opacity-65" : "border-gold/50"
      }`}
      aria-label="Agent question"
    >
      <header className="flex items-center gap-2 border-b border-line2 bg-gold/[0.035] px-4 py-3">
        <Icon name={resolved ? "check" : "bolt"} size={13} className={resolved ? "text-dim" : "text-gold"} />
        <span className={`lbl ${resolved ? "" : "!text-gold"}`}>
          {resolved ? responseLabel(resolved, zh) : zh ? "需要用户输入" : "OPERATOR INPUT REQUIRED"}
        </span>
        {!resolved && <span className="ml-auto font-mono text-[9.5px] tracking-[0.12em] text-faint">{zh ? `${block.req.questions.length} 项` : `${block.req.questions.length} FIELD${block.req.questions.length === 1 ? "" : "S"}`}</span>}
      </header>

      <div className="space-y-5 p-4">
        {block.req.questions.map((question, questionIndex) => {
          const selected = resolved?.outcome === "accepted"
            ? resolved.answers[question.question] ?? []
            : answers[question.question] ?? [];
          const note = resolved?.outcome === "accepted"
            ? resolved.notes[question.question] ?? ""
            : notes[question.question] ?? "";
          const activePreview = question.options.find(
            (option) => selected.includes(option.label) && option.preview,
          )?.preview;

          return (
            <fieldset key={question.question} disabled={Boolean(resolved)}>
              <legend className="flex w-full items-start gap-3 text-[12px] text-fg2">
                <span className="mt-px font-mono text-[9.5px] text-gold">{String(questionIndex + 1).padStart(2, "0")}</span>
                <span>{question.question}</span>
                {question.multiSelect && <span className="ml-auto shrink-0 font-mono text-[9.5px] tracking-[0.12em] text-faint">{zh ? "可多选" : "MULTI SELECT"}</span>}
              </legend>

              <div className="mt-2.5 grid gap-1.5 pl-7">
                {question.options.map((option) => {
                  const isSelected = selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => choose(question.question, option.label, question.multiSelect)}
                      className={`group flex min-h-10 w-full items-start gap-3 rounded-[4px] border px-3 py-2 text-left transition-colors ${
                        isSelected
                          ? "border-acc-dim bg-acc-wash"
                          : "border-line2 bg-base/50 hover:border-line3 hover:bg-high"
                      }`}
                    >
                      <span className={`mt-1.5 h-2 w-2 shrink-0 border ${question.multiSelect ? "rounded-[1px]" : "rounded-full"} ${isSelected ? "border-acc bg-acc" : "border-line3"}`} />
                      <span className="min-w-0">
                        <span className={isSelected ? "text-[11.5px] text-fg" : "text-[11.5px] text-fg2"}>{option.label}</span>
                        {option.description && <span className="ml-2 text-[10.5px] text-dim">{option.description}</span>}
                      </span>
                    </button>
                  );
                })}

                <textarea
                  value={note}
                  onChange={(event) => setNotes((current) => ({ ...current, [question.question]: event.target.value }))}
                  rows={2}
                  placeholder={zh ? "其他选项或补充说明…" : "Other or additional context…"}
                  className="mt-0.5 w-full resize-y rounded-[4px] border border-line2 bg-void px-3 py-2 font-mono text-[10.5px] leading-relaxed text-fg2 placeholder:text-faint focus:border-acc-dim focus:outline-none disabled:opacity-70"
                />

                {activePreview && (
                  <pre className="max-h-48 overflow-auto rounded-[4px] border border-line2 bg-void px-3 py-2 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-fg2 select-text">{activePreview}</pre>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>

      {!resolved && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line2 px-4 py-3">
          <button
            type="button"
            disabled={Object.keys(normalizedAnswers).length === 0}
            onClick={() => resolveQuestion(block.id, { outcome: "accepted", answers: normalizedAnswers, notes })}
            className="h-7 rounded-[4px] bg-acc px-3 text-[11px] font-medium text-base transition-colors hover:bg-acc-deep disabled:cursor-not-allowed disabled:opacity-35"
          >
            {zh ? "提交回答" : "Submit answers"}
          </button>
          {block.req.mode === "plan" && (
            <>
              <button
                type="button"
                onClick={() => resolveQuestion(block.id, { outcome: "chat_about_this", partialAnswers: partialAnswers() })}
                className="h-7 rounded-[4px] border border-acc-dim px-3 text-[10.5px] text-acc transition-colors hover:bg-acc-wash"
              >
                {zh ? "回到对话讨论" : "Chat about this"}
              </button>
              <button
                type="button"
                onClick={() => resolveQuestion(block.id, { outcome: "skip_interview", partialAnswers: partialAnswers() })}
                className="h-7 rounded-[4px] border border-line3 px-3 text-[10.5px] text-mute transition-colors hover:bg-high hover:text-fg2"
              >
                {zh ? "跳过问答" : "Skip interview"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => resolveQuestion(block.id, { outcome: "cancelled" })}
            className="ml-auto h-7 rounded-[4px] px-2 text-[10.5px] text-dim transition-colors hover:text-red"
          >
            {zh ? "取消" : "Cancel"}
          </button>
        </footer>
      )}
    </section>
  );
}
