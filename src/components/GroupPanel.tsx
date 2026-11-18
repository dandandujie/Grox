import { useEffect, useState } from "react";
import { ChevronLeft, Download, Hash, MessagesSquare, Plus, Trash2, Users, X } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { IconButton, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { COLOR_NAMES, MAUS_COLORS, swatch } from "@/lib/mascot";

export function GroupPanel() {
  const { activeGroup, state, setUI, updateGroup, deleteGroup, newTask, backend, toast } = useApp();
  const [name, setName] = useState(activeGroup?.name ?? "");
  const [description, setDescription] = useState(activeGroup?.description ?? "");
  const [instructions, setInstructions] = useState(activeGroup?.instructions ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(activeGroup?.memberIds ?? []);
  const [leadId, setLeadId] = useState(activeGroup?.leadId ?? "");
  const [includeMemory, setIncludeMemory] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNotes, setExportNotes] = useState<string[]>([]);

  useEffect(() => {
    setName(activeGroup?.name ?? "");
    setDescription(activeGroup?.description ?? "");
    setInstructions(activeGroup?.instructions ?? "");
    setMemberIds(activeGroup?.memberIds ?? []);
    setLeadId(activeGroup?.leadId ?? "");
    setIncludeMemory(false);
    setExportNotes([]);
  }, [activeGroup?.id]);

  if (!activeGroup) return null;
  const bots = state.bots.filter((bot) => !bot.archived);
  const members = memberIds.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));
  const threads = activeGroup.threads;
  const messages = threads.reduce((sum, thread) => sum + thread.messages.length, 0);

  const saveIdentity = () => {
    const patch: { name?: string; description?: string } = {};
    if (name.trim() && name.trim() !== activeGroup.name) patch.name = name.trim();
    if (description.trim() !== activeGroup.description) patch.description = description.trim();
    if (Object.keys(patch).length) void updateGroup(activeGroup.id, patch);
  };

  const saveRoster = () => {
    if (memberIds.length === 0) return;
    void updateGroup(activeGroup.id, { memberIds, leadId: memberIds.includes(leadId) ? leadId : memberIds[0]});
  };

  const toggle = (id: string) => {
    setMemberIds((previous) => {
      if (previous.includes(id)) {
        const next = previous.filter((item) => item !== id);
        if (leadId === id) setLeadId(next[0] ?? "");
        return next;
      }
      return [...previous, id];
    });
  };

  const exportTeam = async (format: "grox" | "openmaus") => {
    if (!activeGroup || exporting) return;
    setExporting(true);
    setExportNotes([]);
    try {
      const outcome = format === "openmaus"
        ? await backend.exportOpenMausTeam(activeGroup.id, includeMemory)
        : {
          document: await backend.exportTeam(activeGroup.id),
          filename: (activeGroup.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team") + ".grox-team.json",
          warnings: [],
        };
      const blob = new Blob([outcome.document], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = outcome.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportNotes(outcome.warnings ?? []);
      toast({ kind: "success", title: "Team package exported" });
    } catch (cause) {
      toast({ kind: "error", title: "Could not export the team", body: cause instanceof Error ? cause.message : "Try again." });
    } finally {
      setExporting(false);
    }
  };

  return (
    <aside className="side-panel group-panel">
      <header className="side-panel-head drag-region">
        <div className="no-drag">
          <IconButton label="Back" size={30} onClick={() => setUI({ panel: null })}>
            <ChevronLeft size={18} />
          </IconButton>
        </div>
        <h2>Channel</h2>
        <div className="no-drag">
          <IconButton label="Close" size={30} onClick={() => setUI({ panel: null })}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <div className="side-panel-scroll group-panel-scroll">
        <section className="group-identity">
          <div className="group-identity-head">
            <span className={cn("group-color-dot", "color-" + activeGroup.color)} />
            <span className="group-identity-name"># {activeGroup.name}</span>
          </div>
          <div className="group-avatar-row">
            <Mascot seed={activeGroup.name} title={activeGroup.name} size={58} />
          </div>
          <div className="group-stats">
            <span><Users size={13} /> {members.length} bots</span>
            <span><MessagesSquare size={13} /> {messages} messages</span>
          </div>
        </section>

        <section className="group-section">
          <div className="group-section-title"><Download size={13} /> Share team</div>
          <div className="data-row">
            <span className="data-hint">Include starter notes in OpenMaus file</span>
            <Switch checked={includeMemory} label="Include starter notes in OpenMaus file" onChange={setIncludeMemory} disabled={exporting} />
          </div>
          <div className="data-row">
            <button type="button" className="btn btn-secondary" disabled={exporting} onClick={() => void exportTeam("openmaus")}>Export OpenMaus file</button>
            <button type="button" className="btn btn-secondary" disabled={exporting} onClick={() => void exportTeam("grox")}>Export Grox file</button>
          </div>
          {exportNotes.length > 0 && (
            <ul className="about-note" role="status">{exportNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>
          )}
        </section>

        <section className="group-section">
          <div className="group-section-title"><Hash size={13} /> Channel details</div>
          <label className="panel-field">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} onBlur={saveIdentity} placeholder="launch-room" />
          </label>
          <label className="panel-field">
            <span>About</span>
            <textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} onBlur={saveIdentity} placeholder="What happens here?" />
          </label>
          <label className="panel-field">
            <span>Shared instructions</span>
            <textarea rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} onBlur={() => {
              if (instructions.trim() !== (activeGroup.instructions ?? "")) {
                void updateGroup(activeGroup.id, { instructions: instructions.trim() });
              }
            }} />
          </label>
          <div className="avatar-section-label">Color</div>
          <div className="color-grid" role="group" aria-label="Channel color">
            {Object.keys(MAUS_COLORS).map((color) => (
              <button
                key={color}
                type="button"
                title={COLOR_NAMES[color]}
                aria-label={COLOR_NAMES[color]}
                aria-pressed={activeGroup.color === color}
                className={cn("color-swatch", activeGroup.color === color && "is-selected")}
                style={{ background: swatch(color) }}
                onClick={() => void updateGroup(activeGroup.id, { color })}
              />
            ))}
          </div>
        </section>

        <section className="group-section">
          <div className="group-section-title"><Users size={13} /> Members</div>
          <div className="group-member-list">
            {bots.map((bot) => {
              const checked = memberIds.includes(bot.id);
              return (
                <div key={bot.id} className={cn("group-member-row", checked && "is-checked")}>
                  <button type="button" className="group-member-main" onClick={() => toggle(bot.id)} aria-pressed={checked}>
                    <Mascot seed={bot.name} size={28} />
                    <span>{bot.name}</span>
                    <span className="group-member-check">{checked ? "✓" : ""}</span>
                  </button>
                  {checked && (
                    <button type="button" className={cn("group-lead-pill", leadId === bot.id && "is-lead")} onClick={() => setLeadId(bot.id)}>
                      {leadId === bot.id ? "Lead" : "Lead?"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button type="button" className="btn btn-secondary group-save" onClick={saveRoster} disabled={memberIds.length === 0}>
            Save roster
          </button>
        </section>

        <section className="group-section">
          <div className="group-section-title">Conversations</div>
          <button type="button" className="btn btn-secondary group-new-thread" onClick={() => { newTask(); setUI({ panel: null }); }}>
            <Plus size={14} /> New conversation
          </button>
          {threads.slice(0, 5).map((thread) => (
            <div key={thread.id} className="group-thread-row">
              <span>{thread.title}</span>
              <span>{thread.messages.length} msgs</span>
            </div>
          ))}
        </section>

        <section className="group-section group-danger">
          <button type="button" className="btn btn-danger" onClick={() => deleteGroup(activeGroup.id)}>
            <Trash2 size={14} /> Delete channel
          </button>
          <p>Messages are removed. The bots and their direct conversations stay.</p>
        </section>
      </div>

      <div className="side-panel-tabs">
        <button type="button" className="is-active">Channel</button>
      </div>
    </aside>
  );
}
