import { useT } from "@/i18n";
import { useMemo, useState } from "react";
import { Check, KeyRound, Plug, RefreshCw, Search, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { useApp } from "@/state/store";
import { BrandIcon } from "@/components/Icons";
import { ComposioToolsDialog } from "@/components/ComposioToolsDialog";
import { cn } from "@/lib/cn";

const GROUPS = ["All", "Communication", "Productivity", "Developer", "Design", "Finance", "Social", "Lifestyle", "Automation"];

export function AppsPage() {
  const t = useT();
  const { apps, state, secrets, setUI, toast, connectApp, disconnectApp, refreshApps, requestConfirm } = useApp();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [toolsOpen, setToolsOpen] = useState(false);
  const hasComposio = Boolean(secrets.configured.composio);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (group !== "All" && app.category !== group) return false;
      if (!q) return true;
      return [app.name, app.description, t(app.description), app.category, t(app.category)].some((value) => value.toLowerCase().includes(q));
    });
  }, [apps, query, group, t]);

  const connected = apps.filter((app) => app.connected);
  const pending = (appId: string) => state.connections[appId]?.account === "Waiting for OAuth";

  const addKey = () => {
    setUI({ settingsOpen: true, settingsSection: "connections" });
  };

  const connect = (appId: string, appName: string) => {
    if (!hasComposio) {
      toast({ kind: "info", title: t("Add a Composio key first"), body: t("Connections are real OAuth links; there is no local fake toggle.") });
      addKey();
      return;
    }
    void connectApp(appId);
    toast({ kind: "info", title: t("Opening ") + appName, body: t("Finish authorization in your browser, then press Refresh.") });
  };

  const onClick = (appId: string, appName: string, isConnected: boolean) => {
    if (isConnected) {
      requestConfirm({
        title: t("Disconnect ") + appName + "?",
        body: t("The Composio connected account will be revoked. Bots lose access immediately."),
        confirmLabel: t("Disconnect"),
        danger: true,
        onConfirm: () => {
          void disconnectApp(appId);
        },
      });
      return;
    }
    if (pending(appId)) {
      void refreshApps();
      return;
    }
    connect(appId, appName);
  };

  return (
    <section className="apps-page">
      <header className="page-head drag-region">
        <div className="page-head-copy no-drag">
          <div className="page-title"><Plug size={20} /> {t("Connected apps")}</div>
          <p>{hasComposio ? t("Real OAuth connections through your Composio project. No local dummy accounts.") : t("Bring a Composio project key to give your bots real third-party tools.")}</p>
        </div>
        <div className="page-head-actions no-drag">
          {hasComposio ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => void refreshApps()}>
                <RefreshCw size={14} /> {t("Refresh")}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setToolsOpen(true)}>
                <Wrench size={14} /> {t("Tools")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={addKey}>
              <KeyRound size={14} /> {t("Add Composio key")}
            </button>
          )}
          <div className="apps-connected-pill"><span className={cn("status-dot", connected.length > 0 ? "is-ready" : "is-idle")} />{t("{0} connected", connected.length)}</div>
        </div>
      </header>

      <div className="page-scroll apps-scroll">
        <div className="apps-note">
          <ShieldCheck size={17} />
          <div>
            <strong>{hasComposio ? t("Composio is configured.") : t("Composio is not configured yet.")}</strong>
            <p>
              {hasComposio
                ? t("Connect opens the hosted Composio OAuth link; Refresh reconciles your connected accounts; Tools lists and runs real tools from a tool-router session. Auto/Full API bots can use the cached tools automatically; Ask bots never receive them. Nothing is marked connected until Composio reports an ACTIVE account.")
                : t("Add a Composio project key in Settings → Connections. Until then, Connect takes you to the key field instead of pretending a local switch is a real account.")}
            </p>
          </div>
        </div>

        <div className="apps-toolbar">
          <div className="sidebar-search apps-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search apps")} aria-label={t("Search apps")} spellCheck={false} />
          </div>
          <div className="category-row">
            {GROUPS.map((item) => (
              <button key={item} type="button" className={cn("category-chip", group === item && "is-active")} onClick={() => setGroup(item)}>
                {t(item)}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="apps-empty">
            <Sparkles size={24} />
            <h3>{t("No apps match that")}</h3>
            <p>{t("Try a different name or category.")}</p>
          </div>
        ) : (
          <div className="apps-grid">
            {filtered.map((app) => {
              const waiting = pending(app.id);
              return (
                <article className={cn("app-card", app.connected && "is-connected", waiting && "is-pending")} key={app.id}>
                  <div className="app-card-icon" style={{ background: "#ffffff" }}>
                    <BrandIcon slug={app.icon} size={24} />
                  </div>
                  <div className="app-card-copy">
                    <div className="app-card-top">
                      <h3>{app.name}</h3>
                      <span className="app-category">{t(app.category)}</span>
                    </div>
                    <p>{t(app.description)}</p>
                    {app.connected && <span className="app-account">{app.account || t("Composio account")}</span>}
                    {waiting && <span className="app-account">{t("Waiting for OAuth · press Refresh")}</span>}
                  </div>
                  <button
                    type="button"
                    className={cn("app-connect", app.connected && "is-connected", waiting && "is-pending")}
                    onClick={() => onClick(app.id, app.name, app.connected)}
                  >
                    {app.connected ? <><Check size={14} /> {t("Connected")}</> : waiting ? t("Finish setup") : hasComposio ? t("Connect") : t("Add key")}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        <div className="apps-foot">
          <span>{filtered.length} {t("apps in the catalog")}</span>
          <span>{hasComposio ? t("Composio OAuth configured") : t("No Composio key")}</span>
        </div>
      </div>

      <ComposioToolsDialog open={toolsOpen} onClose={() => setToolsOpen(false)} />
    </section>
  );
}
