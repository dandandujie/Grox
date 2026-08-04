/* ─────────────────────────────────────────────────────────────────────────
   TitleBar — frameless window chrome. Draggable strip; macOS keeps its
   traffic lights under an overlay, Windows gets drawn controls.
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import { baseName } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";
import { EnvironmentSummary } from "./EnvironmentSummary";
import {
  getAvailableOpenApplications,
  getDefaultOpenApplication,
  refreshOpenApplications,
  setDefaultOpenApplication,
  type OpenApplicationOption,
} from "../../lib/defaultOpen";

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
  const toggleInspector = useDesktop((s) => s.toggleInspector);
  const inspectorOpen = useDesktop((s) => s.inspectorOpen);
  const toggleTerminal = useDesktop((s) => s.toggleTerminal);
  const terminalOpen = useDesktop((s) => s.terminalOpen);
  const setPaletteOpen = useDesktop((s) => s.setPaletteOpen);

  return (
    <header
      data-tauri-drag-region
      className="relative z-40 flex h-10 shrink-0 items-center border-b border-line bg-void pl-[78px] pr-2 select-none"
    >
      {/* center — mission breadcrumb */}
      <div
        data-tauri-drag-region
        className="pointer-events-none flex min-w-0 flex-1 items-center justify-center px-3"
      >
        <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden whitespace-nowrap text-[11px]">
          {activeId && meta ? (
            <>
              <span className="lbl max-w-[35%] shrink-0 truncate">{baseName(meta.cwd)}</span>
              <span className="shrink-0 text-faint">/</span>
              <span className="min-w-0 truncate text-fg2">{meta.title}</span>
            </>
          ) : (
            <span className="lbl" style={{ letterSpacing: "0.3em" }}>
              GROX DESKTOP
            </span>
          )}
        </div>
      </div>

      {/* right cluster */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          className="chip mr-1"
          onClick={() => window.dispatchEvent(new Event("grox:open-update-center"))}
          title={language === "zh-CN" ? "检查更新并查看更新日志" : "Check for updates and view the changelog"}
        >
          <Icon name="refresh" size={11} />
          <span>{language === "zh-CN" ? "更新日志" : "CHANGELOG"}</span>
        </button>

        <DefaultOpenMenu language={language} />

        <button
          className="chip"
          onClick={() => setPaletteOpen(true)}
          title={language === "zh-CN" ? "命令面板" : "Command palette"}
        >
          <Icon name="command" size={11} />
          <span>⌘K</span>
        </button>

        <EnvironmentSummary />

        <button
          className={`chip ${terminalOpen ? "!text-fg2 !border-line3" : ""}`}
          onClick={toggleTerminal}
          title={language === "zh-CN" ? "显示/隐藏终端" : "Toggle terminal"}
          aria-pressed={terminalOpen}
        >
          <Icon name="terminal" size={12} />
        </button>

        <button
          className={`chip ${inspectorOpen ? "!text-fg2 !border-line3" : ""}`}
          onClick={toggleInspector}
          title={language === "zh-CN" ? "显示/隐藏检查器" : "Toggle inspector"}
          aria-pressed={inspectorOpen}
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

function DefaultOpenMenu({ language }: { language: "zh-CN" | "en-US" }) {
  const [open, setOpen] = useState(false);
  const [applications, setApplications] = useState<OpenApplicationOption[]>(() => getAvailableOpenApplications());
  const [application, setApplication] = useState<OpenApplicationOption>(() => getDefaultOpenApplication());
  const ref = useRef<HTMLDivElement>(null);
  const zh = language === "zh-CN";

  useEffect(() => {
    let alive = true;
    const syncApplications = (event: Event) => {
      const value = (event as CustomEvent<OpenApplicationOption[]>).detail;
      if (Array.isArray(value)) setApplications(value);
    };
    const sync = (event: Event) => {
      const value = (event as CustomEvent<OpenApplicationOption>).detail;
      if (value?.id) setApplication(value);
    };
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("grox:open-applications", syncApplications);
    window.addEventListener("grox:default-open-application", sync);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    void refreshOpenApplications().then((next) => {
      if (!alive) return;
      setApplications(next);
      setApplication(getDefaultOpenApplication());
    });
    return () => {
      alive = false;
      window.removeEventListener("grox:open-applications", syncApplications);
      window.removeEventListener("grox:default-open-application", sync);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const label = (value: OpenApplicationOption) => value.isDefault
    ? (zh ? "系统默认" : "System default")
    : value.name;
  const fallbackIcon = (value: OpenApplicationOption): React.ComponentProps<typeof Icon>["name"] => {
    const name = value.name.toLowerCase();
    if (name.includes("finder")) return "folder";
    if (name.includes("terminal") || name.includes("ghostty") || name.includes("shell")) return "terminal";
    return "external";
  };

  const current = applications.find((item) => item.id === application.id) ?? application;
  const appIcon = (value: OpenApplicationOption, size: number) => value.iconDataUrl
    ? <img src={value.iconDataUrl} alt="" width={size} height={size} className="shrink-0 rounded-[3px] object-contain" />
    : <Icon name={fallbackIcon(value)} size={size} className="shrink-0" />;

  return (
    <div ref={ref} className="relative">
      <button
        className={`chip gap-1 ${open ? "!border-line3 !text-fg2" : ""}`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) {
            void refreshOpenApplications().then((items) => {
              setApplications(items);
              setApplication(getDefaultOpenApplication());
            });
          }
        }}
        title={zh ? "选择文件的默认打开方式" : "Choose the default application for files"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {appIcon(current, 13)}
        <span>{zh ? "打开方式" : "OPEN WITH"}</span>
        <Icon name="chevronDown" size={9} className="text-faint" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-[60] w-52 overflow-hidden rounded-[7px] border border-line3 bg-raise p-1.5 shadow-2xl" role="menu">
          <p className="px-2 pb-1.5 pt-1 font-mono text-[8.5px] tracking-[0.12em] text-faint">{zh ? "文件默认打开应用" : "DEFAULT FILE APPLICATION"}</p>
          {applications.map((item) => (
            <button
              key={item.id}
              role="menuitemradio"
              aria-checked={application.id === item.id}
              onClick={() => {
                setDefaultOpenApplication(item);
                setApplication(item);
                setOpen(false);
              }}
              className={`flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[10.5px] transition-colors ${application.id === item.id ? "bg-acc-wash text-fg" : "text-mute hover:bg-high hover:text-fg2"}`}
            >
              <span className={application.id === item.id ? "text-acc" : "text-dim"}>{appIcon(item, 15)}</span>
              <span className="flex-1">{label(item)}</span>
              {application.id === item.id && <Icon name="check" size={10} className="text-acc" />}
            </button>
          ))}
        </div>
      )}
    </div>
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
