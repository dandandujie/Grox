/* ─────────────────────────────────────────────────────────────────────────
   TitleBar — frameless window chrome. Draggable strip; macOS keeps its
   traffic lights under an overlay, Windows gets drawn controls.
   ───────────────────────────────────────────────────────────────────────── */

import { useDesktop } from "../../state/store";
import { baseName } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

const inTauri = () => "__TAURI_INTERNALS__" in window;
const isWindows = () => navigator.userAgent.includes("Windows");

async function winCtl(action: "min" | "max" | "close") {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (action === "min") await win.minimize();
  else if (action === "max") await win.toggleMaximize();
  else await win.close();
}

export function TitleBar() {
  const { language } = useI18n();
  const activeId = useDesktop((s) => s.activeId);
  const meta = useDesktop((s) => s.sessionIndex.find((m) => m.id === s.activeId));
  const bridgeKind = useDesktop((s) => s.bridgeKind);
  const toggleInspector = useDesktop((s) => s.toggleInspector);
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const setPaletteOpen = useDesktop((s) => s.setPaletteOpen);

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-10 shrink-0 items-center border-b border-line bg-void pl-[78px] pr-2 select-none"
    >
      {/* center — mission breadcrumb */}
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          {activeId && meta ? (
            <>
              <span className="lbl">{baseName(meta.cwd)}</span>
              <span className="text-faint">/</span>
              <span className="truncate text-fg2">{meta.title}</span>
            </>
          ) : (
            <span className="lbl" style={{ letterSpacing: "0.3em" }}>
              GROX DESKTOP
            </span>
          )}
        </div>
      </div>

      {/* left placeholder keeps drag region balanced on mac (traffic lights) */}
      <div className="flex-1" data-tauri-drag-region />

      {/* right cluster */}
      <div className="flex items-center gap-1">
        <span className={`chip mr-1 ${bridgeKind === "mock" ? "" : "!text-acc !border-acc-dim"}`}>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              bridgeKind === "mock" ? "bg-dim" : "bg-acc animate-pulse-dot"
            }`}
          />
          {bridgeKind === "mock" ? "MOCK LINK" : "ACP LINK"}
        </span>

        <button
          className="chip"
          onClick={() => setPaletteOpen(true)}
          title={language === "zh-CN" ? "命令面板" : "Command palette"}
        >
          <Icon name="command" size={11} />
          <span>⌘K</span>
        </button>

        <button
          className={`chip ${inspectorOpen ? "!text-fg2 !border-line3" : ""}`}
          onClick={toggleInspector}
          title={language === "zh-CN" ? "显示/隐藏检查器" : "Toggle inspector"}
        >
          <Icon name="panelRight" size={12} />
        </button>

        {isWindows() && (
          <div className="ml-1 flex items-center">
            <WinBtn onClick={() => winCtl("min")} label="—" />
            <WinBtn onClick={() => winCtl("max")} label="▢" />
            <WinBtn onClick={() => winCtl("close")} label="✕" danger />
          </div>
        )}
      </div>
    </header>
  );
}

function WinBtn({ onClick, label, danger }: { onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-8 w-11 items-center justify-center text-[10px] text-mute transition-colors ${
        danger ? "hover:bg-red hover:text-base" : "hover:bg-high hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
