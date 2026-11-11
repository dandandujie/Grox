import { ArrowRight, Bot, Plug, ShieldCheck } from "lucide-react";
import { useApp } from "@/state/store";
import { Modal } from "@/components/ui";
import { GroxLogo } from "@/components/Icons";
import { Mascot } from "@/components/Mascot";

export function Onboarding() {
  const { state, ui, setUI, patchSettings } = useApp();
  const open = !state.settings.onboarded && !ui.newBotOpen && !ui.settingsOpen && !ui.newChannelOpen;

  const finish = (action?: () => void) => {
    void patchSettings({ onboarded: true });
    action?.();
  };

  return (
    <Modal open={open} onClose={() => finish()} title="Welcome to Grox" width={640}>
      <div className="onboarding">
        <div className="onboarding-hero">
          <Mascot seed="Grox" size={92} />
          <div>
            <GroxLogo size={24} />
            <h2>Your local bot team</h2>
            <p>Grox runs on this Mac. Bring your own CLI logins or API keys; nothing is uploaded to a Grox cloud.</p>
          </div>
        </div>
        <div className="onboarding-points">
          <div><ShieldCheck size={16} /><span><strong>Local by default</strong>Workspace, memory and credentials stay on this machine.</span></div>
          <div><Bot size={16} /><span><strong>A portrait per bot</strong>Every bot gets a deterministic layered 1-bit face, generated from its name.</span></div>
          <div><Plug size={16} /><span><strong>Real engines</strong>Demo works offline; connect Grok, Claude, Codex, Gemini or an OpenAI-compatible API when ready.</span></div>
        </div>
        <div className="modal-actions split">
          <button type="button" className="btn btn-ghost" onClick={() => finish(() => setUI({ settingsOpen: true, settingsSection: "engines" }))}>Connect an engine</button>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => finish()}>Start with demo</button>
            <button type="button" className="btn btn-primary" onClick={() => finish(() => setUI({ newBotOpen: true }))}>Create a bot <ArrowRight size={14} /></button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
