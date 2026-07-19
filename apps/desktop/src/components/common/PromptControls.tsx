import { useEffect, useRef, useState } from "react";
import { EFFORTS, type AgentMode, type Effort, type PermissionMode } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "./ChipSelect";

export function ProviderSwitcher() {
  const { language } = useI18n();
  const provider = useDesktop((state) => state.provider);
  const profiles = useDesktop((state) => state.providerProfiles);
  const activeProfileId = useDesktop((state) => state.activeProviderProfileId);
  const switching = useDesktop((state) => state.providerSwitching);
  const configure = useDesktop((state) => state.configureProvider);
  const activate = useDesktop((state) => state.activateProviderProfile);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const activeId = activeProfileId ?? provider.kind;
  const label = switching
    ? (language === "zh-CN" ? "切换中" : "SWITCHING")
    : activeProfile?.name ?? (provider.kind === "oauth" ? "GROK OAUTH" : provider.kind === "official" ? "XAI API" : "OPENAI API");
  const items = [
    { id: "oauth", label: "Grok OAuth", hint: language === "zh-CN" ? "官方账户" : "Official account" },
    ...(provider.kind === "official" && !activeProfileId
      ? [{ id: "official", label: "xAI API", hint: language === "zh-CN" ? "当前官方密钥" : "Current official key" }]
      : []),
    ...profiles.map((profile) => ({
      id: profile.id,
      label: profile.name,
      hint: profile.baseUrl.replace(/^https?:\/\//, ""),
    })),
  ];

  return (
    <ChipSelect
      label={<span className="text-fg2">{label}</span>}
      items={items}
      activeId={activeId}
      disabled={switching}
      width={330}
      onSelect={(id) => {
        if (id === activeId || id === "official") return;
        if (id === "oauth") void configure({ kind: "oauth" }).catch(() => {});
        else void activate(id).catch(() => {});
      }}
    />
  );
}

export function PromptOptionsMenu({
  mode,
  effort,
  permissionMode,
  onMode,
  onEffort,
  onPermission,
}: {
  mode: AgentMode;
  effort: Effort;
  permissionMode: PermissionMode;
  onMode(mode: AgentMode): void;
  onEffort(effort: Effort): void;
  onPermission(mode: PermissionMode): void;
}) {
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((value) => !value)} className="chip max-w-[190px]" title={language === "zh-CN" ? "模式、权限与思考强度" : "Mode, access and reasoning effort"}>
        <Icon name="gear" size={10} />
        <span className="truncate">{mode.toUpperCase()} · {effort.toUpperCase()}</span>
        <Icon name="chevronDown" size={8} className="text-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 w-[min(360px,calc(100vw-32px))] rounded-[7px] border border-line2 bg-raise p-3 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up">
          <OptionRow label={language === "zh-CN" ? "工作模式" : "MODE"} values={[
            ["agent", language === "zh-CN" ? "执行" : "AGENT"],
            ["plan", language === "zh-CN" ? "计划" : "PLAN"],
            ["ask", language === "zh-CN" ? "问答" : "ASK"],
          ]} active={mode} onSelect={(value) => onMode(value as AgentMode)} />
          <OptionRow label={language === "zh-CN" ? "工具权限" : "ACCESS"} values={[
            ["default", language === "zh-CN" ? "按需确认" : "DEFAULT"],
            ["auto", language === "zh-CN" ? "自动策略" : "AUTO"],
            ["bypass", "YOLO"],
          ]} active={permissionMode} onSelect={(value) => onPermission(value as PermissionMode)} />
          <OptionRow label={language === "zh-CN" ? "思考强度" : "EFFORT"} values={EFFORTS.map((value) => [value, value.toUpperCase()])} active={effort} onSelect={(value) => onEffort(value as Effort)} last />
        </div>
      )}
    </div>
  );
}

function OptionRow({ label, values, active, onSelect, last = false }: { label: string; values: readonly (readonly [string, string])[]; active: string; onSelect(value: string): void; last?: boolean }) {
  return (
    <div className={last ? "" : "mb-3 border-b border-line pb-3"}>
      <p className="lbl mb-1.5 !text-[9px]">{label}</p>
      <div className="grid grid-cols-4 gap-1">
        {values.map(([value, text]) => (
          <button key={value} onClick={() => onSelect(value)} className={`min-w-0 truncate rounded-[4px] border px-2 py-1.5 font-mono text-[9.5px] ${active === value ? "border-acc-dim bg-acc-wash text-acc" : "border-line2 text-dim hover:text-fg2"}`} title={text}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
