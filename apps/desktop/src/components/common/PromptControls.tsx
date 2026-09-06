import { useEffect, useRef, useState } from "react";
import { EFFORTS, type AgentMode, type Effort, type PermissionMode } from "../../bridge/types";
import { useI18n } from "../../lib/i18n";
import { useDesktop } from "../../state/store";
import { useProviderCapability } from "../../state/providerCapabilityStore";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "./ChipSelect";

export function ProviderSwitcher() {
  const { language } = useI18n();
  const provider = useProviderCapability((state) => state.provider);
  const profiles = useProviderCapability((state) => state.profiles);
  const activeProfileId = useProviderCapability((state) => state.activeProfileId);
  const switching = useProviderCapability((state) => state.switching);
  const configure = useDesktop((state) => state.configureProvider);
  const activate = useDesktop((state) => state.activateProviderProfile);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const activeId = activeProfileId ?? provider.kind;
  const label = switching
    ? (language === "zh-CN" ? "等待本轮完成" : "WAITING FOR TURN")
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
  efforts = EFFORTS,
}: {
  mode: AgentMode;
  effort: Effort;
  permissionMode: PermissionMode;
  onMode(mode: AgentMode): void;
  onEffort(effort: Effort): void;
  onPermission(mode: PermissionMode): void;
  efforts?: readonly Effort[];
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
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="chip max-w-[220px]"
        title={language === "zh-CN" ? "模式、权限与思考强度" : "Mode, access and reasoning effort"}
      >
        <Icon name="gear" size={10} />
        <span className="truncate">{mode.toUpperCase()} · {effort.toUpperCase()}</span>
        <Icon name="chevronDown" size={8} className="text-faint" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={language === "zh-CN" ? "模式、权限与思考强度" : "Mode, access and reasoning effort"}
          className="absolute bottom-full left-0 z-40 mb-1.5 w-[min(360px,calc(100vw-32px))] rounded-[18px] border border-line2 bg-raise p-3.5 shadow-[0_8px_28px_rgba(0,0,0,0.55)] animate-fade-up"
        >
          <OptionRow groupLabel="mode" rowLabel={language === "zh-CN" ? "工作模式" : "MODE"} values={[
            ["agent", language === "zh-CN" ? "执行" : "AGENT"],
            ["plan", language === "zh-CN" ? "计划" : "PLAN"],
            ["ask", language === "zh-CN" ? "问答" : "ASK"],
          ]} active={mode} onSelect={(value) => onMode(value as AgentMode)} />
          <OptionRow groupLabel="permission" rowLabel={language === "zh-CN" ? "工具权限" : "ACCESS"} values={[
            ["default", language === "zh-CN" ? "按需确认" : "DEFAULT"],
            ["auto", language === "zh-CN" ? "自动策略" : "AUTO"],
            ["bypass", "YOLO"],
          ]} active={permissionMode} onSelect={(value) => onPermission(value as PermissionMode)} />
          <OptionRow groupLabel="effort" rowLabel={language === "zh-CN" ? "思考强度" : "EFFORT"} values={efforts.map((value) => [value, value.toUpperCase()])} active={effort} onSelect={(value) => onEffort(value as Effort)} last />
        </div>
      )}
    </div>
  );
}

function OptionRow({ groupLabel, rowLabel, values, active, onSelect, last = false }: { groupLabel: string; rowLabel: string; values: readonly (readonly [string, string])[]; active: string; onSelect(value: string): void; last?: boolean }) {
  // 单选分段组：radio 语义 + 方向键在组内移动（Tab 仍可跨组）。
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const row = event.currentTarget.parentElement;
    const options = row ? [...row.querySelectorAll<HTMLButtonElement>('[role="radio"]')] : [];
    if (options.length === 0) return;
    const index = options.indexOf(event.currentTarget as HTMLButtonElement);
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    options[(index + step + options.length) % options.length]?.focus();
  };
  return (
    <div className={last ? "" : "mb-3 border-b border-line pb-3"}>
      <p className="lbl mb-1.5 !text-[9px]" id={`prompt-option-${groupLabel}`}>{rowLabel}</p>
      <div role="radiogroup" aria-labelledby={`prompt-option-${groupLabel}`} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
        {values.map(([value, text]) => (
          <button
            key={value}
            role="radio"
            aria-checked={active === value}
            onClick={() => onSelect(value)}
            onKeyDown={onKeyDown}
            className={`min-w-0 truncate rounded-full border px-2.5 py-1.5 font-mono text-[9.5px] ${active === value ? "border-acc-dim bg-acc-wash text-acc" : "border-line2 text-dim hover:text-fg2"}`}
            title={text}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
