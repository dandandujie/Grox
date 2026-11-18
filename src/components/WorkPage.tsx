import { useLanguage, useT } from "@/i18n";
import { useMemo } from "react";
import { ArrowRight, Clock3, Plus } from "lucide-react";
import { useApp } from "@/state/store";
import { conversationStatus, conversations, threadTitle } from "@/lib/conversations";
import { sidebarTime } from "@/lib/format";
import { cn } from "@/lib/cn";

export function WorkPage() {
  const t = useT();
  const language = useLanguage();
  const { state, activeBot, activeGroup, openThread, openGroupThread, newTask, setUI } = useApp();
  const sections = useMemo(() => {
    const attention = [], running = [], recent = [];
    for (const item of conversations(state)) {
      const status = conversationStatus(item.thread);
      const row = { ...item, status };
      if (status === "Working") running.push(row);
      else if (status) attention.push(row);
      else if (item.thread.messages?.some((message) => message.role === "user")) recent.push(row);
    }
    return [
      { title: t("Needs attention"), rows: attention },
      { title: t("In progress"), rows: running },
      { title: t("Recent conversations"), rows: recent },
    ];
  }, [state, t]);

  return (
    <section className="work-page">
      <header className="page-head drag-region">
        <h1 className="page-title">{t("Work")}</h1>
        <button type="button" className="btn btn-secondary no-drag" onClick={() => activeBot || activeGroup ? newTask() : setUI({ newBotOpen: true })}>
          <Plus size={15} /> {activeBot || activeGroup ? t("New task · {0}", activeGroup?.name ?? activeBot?.name) : t("New bot")}
        </button>
      </header>
      <div className="page-scroll work-scroll">
        {sections.every((section) => section.rows.length === 0) && (
          <div className="work-empty">
            <Clock3 size={24} aria-hidden="true" />
            <h2>{t("No conversations yet")}</h2>
            <button type="button" className="btn btn-primary" onClick={() => setUI({ view: "chat" })}>{t("Open chat")} <ArrowRight size={14} /></button>
          </div>
        )}
        {sections.filter((section) => section.rows.length > 0).map((section) => (
          <section className="work-section" key={section.title}>
            <h2>{section.title}</h2>
            <div className="work-list">
              {section.rows.map(({ owner, thread, status }) => (
                <button type="button" className="work-row" key={owner.id + "/" + thread.id} onClick={() => {
                  if (owner.kind === "group") openGroupThread(owner.id, thread.id);
                  else openThread(owner.id, thread.id);
                }}>
                  <span className="work-copy"><strong>{threadTitle(thread, t)}</strong><span>{owner.name}</span></span>
                  {status && <span className={cn("work-status", status === "Failed" && "is-error")}>{t(status)}</span>}
                  <time dateTime={thread.updatedAt}>{sidebarTime(thread.updatedAt, language)}</time>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
