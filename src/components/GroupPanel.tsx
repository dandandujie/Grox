import { useEffect, useState } from "react";
import { ChevronLeft, Hash, MessagesSquare, Plus, Trash2, Users, X } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { COLOR_NAMES, MAUS_COLORS, swatch } from "@/lib/mascot";

export function GroupPanel() {
  const { activeGroup, state, setUI, updateGroup, deleteGroup, newTask } = useApp();
  const [name, setName] = useState(activeGroup?.name ?? "");
  const [description, setDescription] = useState(activeGroup?.description ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(activeGroup?.memberIds ?? []);
  const [leadId, setLeadId] = useState(activeGroup?.leadId ?? "");

  useEffect(() => {
    setName(activeGroup?.name ?? "");
    setDescription(activeGroup?.description ?? "");
    setMemberIds(activeGroup?.memberIds ?? []);
    setLeadId(activeGroup?.leadId ?? "");
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
    void updateGroup(activeGroup.id, { memberIds, leadId: memberIds.includes(leadId) ? leadId : memberIds[0] });
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
            {members.slice(0, 4).map((member) => (
              <Mascot key={member.id} color={member.color} shape={member.mascotShape} expression={member.expression} size={40} title={member.name} />
            ))}
          </div>
          <div className="group-stats">
            <span><Users size={13} /> {members.length} bots</span>
            <span><MessagesSquare size={13} /> {messages} messages</span>
          </div>
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
                    <Mascot color={bot.color} shape={bot.mascotShape} expression={bot.expression} size={28} />
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
