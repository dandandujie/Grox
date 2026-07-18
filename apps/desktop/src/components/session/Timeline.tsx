import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionBlock } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { AssistantMsg, SystemEvent, UserMsg } from "./blocks";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanCard } from "./PlanCard";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";

interface Turn {
  id: string;
  blocks: SessionBlock[];
}

function groupTurns(blocks: SessionBlock[]): Turn[] {
  const turns: Turn[] = [];
  for (const block of blocks) {
    if (block.type === "user" || turns.length === 0) {
      turns.push({ id: block.id, blocks: [block] });
    } else {
      turns[turns.length - 1].blocks.push(block);
    }
  }
  return turns;
}

function renderBlock(block: SessionBlock, sessionId: string) {
  switch (block.type) {
    case "user":
      return <UserMsg key={block.id} block={block} />;
    case "assistant":
      return <AssistantMsg key={block.id} block={block} />;
    case "thinking":
      return <ThinkingBlock key={block.id} block={block} />;
    case "tool":
      return <ToolCallCard key={block.id} block={block} />;
    case "plan":
      return <PlanCard key={block.id} block={block} />;
    case "permission":
      return <PermissionCard key={block.id} block={block} sessionId={sessionId} />;
    case "question":
      return <QuestionCard key={block.id} block={block} />;
    case "system":
      return <SystemEvent key={block.id} block={block} />;
  }
}

function TurnGroup({
  turn,
  session,
  active,
}: {
  turn: Turn;
  session: Session;
  active: boolean;
}) {
  const { t } = useI18n();
  const complete = !active || session.status === "idle";
  const [processOpen, setProcessOpen] = useState(!complete);

  useEffect(() => {
    if (complete) setProcessOpen(false);
  }, [complete]);

  const visible = turn.blocks.filter(
    (block) =>
      block.type === "user" ||
      block.type === "assistant" ||
      (block.type === "permission" && !block.resolved) ||
      (block.type === "question" && !block.response),
  );
  const process = turn.blocks.filter((block) => !visible.includes(block));
  const toolCount = process.filter((block) => block.type === "tool").length;

  return (
    <section className="mb-3">
      {visible.filter((block) => block.type === "user").map((block) => renderBlock(block, session.id))}

      {process.length > 0 && (
        <div className="mb-3 rounded-[5px] border border-line bg-panel/55">
          <button
            className="flex h-8 w-full items-center gap-2 px-2.5 text-left hover:bg-high/60"
            onClick={() => setProcessOpen((open) => !open)}
          >
            {active && session.status !== "idle" ? (
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-acc" />
            ) : (
              <Icon name="check" size={10} className="text-dim" />
            )}
            <span className="font-mono text-[9.5px] tracking-[0.08em] text-mute">
              {t("process")}
            </span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
              {toolCount > 0 ? `${toolCount} tools · ` : ""}{t("processCollapsed")}
            </span>
            <Icon
              name="chevronRight"
              size={9}
              className={`text-faint transition-transform ${processOpen ? "rotate-90" : ""}`}
            />
          </button>
          {processOpen && (
            <div className="border-t border-line px-2.5 py-2">
              {process.map((block) => renderBlock(block, session.id))}
            </div>
          )}
        </div>
      )}

      {visible.filter((block) => block.type !== "user").map((block) => renderBlock(block, session.id))}
    </section>
  );
}

export function Timeline({ session }: { session: Session }) {
  const { language } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const turns = useMemo(() => groupTurns(session.blocks), [session.blocks]);

  const lastBlock = session.blocks[session.blocks.length - 1];
  const signature =
    session.blocks.length +
    ":" +
    (lastBlock?.type === "assistant" || lastBlock?.type === "thinking"
      ? lastBlock.text.length
      : lastBlock?.id ?? "") +
    `:${session.status}`;

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [signature]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  if (session.blocks.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-24">
        <BlackHole size={44} spin="slow" />
        <div className="text-center">
          <p className="text-[14px] text-mute">
            {language === "zh-CN" ? "任务通道已打开。" : "Mission channel open."}
          </p>
          <p className="lbl mt-1.5 !text-[10px]">
            {language === "zh-CN" ? "输入你的第一个请求" : "TRANSMIT YOUR FIRST DIRECTIVE"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 py-6">
        {turns.map((turn, index) => (
          <TurnGroup
            key={turn.id}
            turn={turn}
            session={session}
            active={index === turns.length - 1}
          />
        ))}
        <div className="h-2" />
      </div>
    </div>
  );
}
