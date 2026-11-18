import { useState } from "react";
import { normalizeLanguage, useLanguage, useT } from "@/i18n";
import { useApp } from "@/state/store";

export function LanguageSelect() {
  const { patchSettings } = useApp();
  const language = useLanguage();
  const t = useT();
  const [saving, setSaving] = useState(false);

  return (
    <label className="panel-field language-setting">
      <span>{t("Language")}</span>
      <select value={language} disabled={saving} onChange={async (event) => {
        const language = normalizeLanguage(event.currentTarget.value);
        setSaving(true);
        try {
          await patchSettings({ language });
        } finally {
          setSaving(false);
        }
      }}>
        <option value="zh" lang="zh-CN">简体中文</option>
        <option value="en" lang="en">English</option>
      </select>
    </label>
  );
}
