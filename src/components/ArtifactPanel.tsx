import { useMemo, useState } from "react";
import { ArrowUpRight, FileText, Search, X } from "lucide-react";
import { formatBytes } from "@/components/Attachments";
import { IconButton } from "@/components/ui";
import { useApp } from "@/state/store";

export function ArtifactPanel() {
  const { activeBot, activeGroup, backend, openThread, openGroupThread, setUI, toast } = useApp();
  const [query, setQuery] = useState("");
  const threads = activeGroup?.threads ?? activeBot?.threads;

  const files = useMemo(() =>
    (threads ?? []).flatMap((thread) =>
      (thread.messages ?? []).flatMap((message) =>
        (message.attachments ?? []).map((file) => ({ file, thread, role: message.role, messageId: message.id })),
      ),
    ).sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt)), [threads]);

  const normalized = query.trim().toLowerCase();
  const shown = files.filter(({ file, thread }) =>
    file.name.toLowerCase().includes(normalized) || thread.title.toLowerCase().includes(normalized),
  );

  return (
    <aside className="side-panel">
      <header className="side-panel-head drag-region">
        <span />
        <h2>Conversation files</h2>
        <div className="no-drag">
          <IconButton label="Close" size={30} onClick={() => setUI({ panel: null })}><X size={17} /></IconButton>
        </div>
      </header>
      <div className="panel-body artifact-panel">
        {files.length > 0 && (
          <label className="artifact-search panel-field">
            <Search size={15} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search conversation files" placeholder="Search files" />
          </label>
        )}
        {shown.length === 0 && <p className="panel-note">{files.length ? "No matching files." : "Files shared in these conversations appear here."}</p>}
        {shown.map(({ file, thread, role, messageId }) => (
          <article className="artifact-row" key={messageId + ":" + file.id}>
            <button type="button" className="attachment-file" title={file.name}
              onClick={() => void backend.openAttachment(file.id).catch((error: unknown) =>
                toast({ kind: "error", title: "Could not open file", body: String(error) }),
              )}>
              <span className="attachment-file-icon"><FileText size={16} /></span>
              <span className="attachment-file-copy">
                <span className="attachment-file-name">{file.name}</span>
                <span className="attachment-file-size">{formatBytes(file.size)} · {role === "bot" ? "Agent" : "You"}</span>
              </span>
            </button>
            <button type="button" className="btn btn-ghost artifact-thread" title={thread.title} onClick={() => {
              if (activeGroup) openGroupThread(activeGroup.id, thread.id);
              else if (activeBot) openThread(activeBot.id, thread.id);
            }}>
              <span>{thread.title}</span>
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
    </aside>
  );
}
