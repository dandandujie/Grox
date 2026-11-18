import { useT } from "@/i18n";
import { useEffect, useState } from "react";
import { Hash, Plus, Users } from "lucide-react";
import { useApp } from "@/state/store";
import { Mascot } from "@/components/Mascot";
import { Modal } from "@/components/ui";
import { cn } from "@/lib/cn";
import { COLOR_NAMES, MAUS_COLORS, swatch } from "@/lib/mascot";

export function NewChannelDialog() {
  const t = useT();
  const { state, ui, setUI, createGroup } = useApp();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("purple");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bots = state.bots.filter((bot) => !bot.archived);

  useEffect(() => {
    if (!ui.newChannelOpen) return;
    const initial = bots.filter((bot) => !bot.hidden).slice(0, 3).map((bot) => bot.id);
    setName("");
    setDescription("");
    setColor("purple");
    setMemberIds(initial);
    setLeadId(initial[0] ?? "");
    setBusy(false);
    setError("");
  }, [ui.newChannelOpen]);

  const toggleMember = (id: string) => {
    setMemberIds((previous) => {
      if (previous.includes(id)) {
        const next = previous.filter((item) => item !== id);
        if (leadId === id) setLeadId(next[0] ?? "");
        return next;
      }
      const next = [...previous, id];
      if (!leadId) setLeadId(id);
      return next;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t("Give the channel a name."));
      return;
    }
    if (memberIds.length === 0) {
      setError(t("Add at least one bot."));
      return;
    }
    setBusy(true);
    const group = await createGroup({
      name: name.trim(), description: description.trim(), color,
      memberIds, leadId: leadId || memberIds[0] || "",
    });
    setBusy(false);
    if (group) setUI({ newChannelOpen: false });
  };

  const lead = bots.find((bot) => bot.id === leadId);

  return (
    <Modal open={ui.newChannelOpen} onClose={() => setUI({ newChannelOpen: false })} title={t("New channel")} width={600}>
      <form className="new-bot new-channel" onSubmit={submit}>
        <div className="new-bot-hero channel-hero">
          <span className="channel-hero-icon"><Hash size={34} /></span>
          <div className="channel-hero-copy">
            <strong>{name.trim() ? "# " + name.trim() : t("A shared room")}</strong>
            <span>{lead ? lead.name + t(" answers unless you mention someone else.") : t("Choose who is in the room.")}</span>
          </div>
          <div className="color-grid compact" role="group" aria-label={t("Channel color")}>
            {Object.keys(MAUS_COLORS).slice(0, 10).map((value) => (
              <button
                key={value}
                type="button"
                title={COLOR_NAMES[value]}
                aria-label={COLOR_NAMES[value]}
                aria-pressed={color === value}
                className={cn("color-swatch", color === value && "is-selected")}
                style={{ background: swatch(value) }}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </div>

        <label className="panel-field">
          <span>{t("Name")}</span>
          <input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="launch-room" />
        </label>
        <label className="panel-field">
          <span>{t("What is it for?")} <span className="field-optional">{t("Optional")}</span></span>
          <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("A room for the people and bots who ship the launch")} />
        </label>

        <div className="channel-members-head">
          <span><Users size={14} /> {t("Members")}</span>
          <span className="channel-members-count">{t("{0} selected", memberIds.length)}</span>
        </div>
        <div className="channel-members">
          {bots.map((bot) => {
            const checked = memberIds.includes(bot.id);
            return (
              <div key={bot.id} className={cn("channel-member", checked && "is-checked")}>
                <button type="button" className="channel-member-toggle" onClick={() => toggleMember(bot.id)} aria-pressed={checked}>
                  <Mascot seed={bot.name} size={30} />
                  <span className="channel-member-copy">
                    <span className="channel-member-name">{bot.name}</span>
                    <span className="channel-member-title">{bot.title || t("Bot")}</span>
                  </span>
                  <span className="channel-check">{checked ? "✓" : ""}</span>
                </button>
                {checked && (
                  <button type="button" className={cn("channel-lead", leadId === bot.id && "is-lead")} onClick={() => setLeadId(bot.id)}>
                    {leadId === bot.id ? t("Lead") : t("Make lead")}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setUI({ newChannelOpen: false })}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || memberIds.length === 0}>
            {busy ? t("Creating…") : <><Plus size={15} /> {t("Create channel")}</>}
          </button>
        </div>
      </form>
    </Modal>
  );
}
