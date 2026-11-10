import { useMemo, useState } from "react";
import { Check, Plug, Search, ShieldCheck, Sparkles } from "lucide-react";
import { useApp } from "@/state/store";
import { BrandIcon } from "@/components/Icons";
import { cn } from "@/lib/cn";

const GROUPS = ["All", "Communication", "Productivity", "Developer", "Design", "Finance", "Social", "Lifestyle", "Automation"];

export function AppsPage() {
  const { apps, setConnection, state } = useApp();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (group !== "All" && app.category !== group) return false;
      if (!q) return true;
      return [app.name, app.description, app.category].some((value) => value.toLowerCase().includes(q));
    });
  }, [apps, query, group]);

  const connected = apps.filter((app) => app.connected);
  return (
    <section className="apps-page">
      <header className="page-head drag-region">
        <div className="page-head-copy no-drag">
          <div className="page-title"><Plug size={20} /> Connected apps</div>
          <p>One place for the services your bots can use. Connections in this build are local switches.</p>
        </div>
        <div className="page-head-actions no-drag">
          <div className="apps-connected-pill"><span className="status-dot is-ready" />{connected.length} connected</div>
        </div>
      </header>

      <div className="page-scroll apps-scroll">
        <div className="apps-note">
          <ShieldCheck size={17} />
          <div>
            <strong>Local-first, and honest about it.</strong>
            <p>OpenMausBot uses Composio sessions for Gmail, Slack, GitHub and hundreds of others. Grox records the connection here so the shape of the workflow is real; the OAuth broker and live tool calls are not wired in this build. Nothing is pretending to be connected.</p>
          </div>
        </div>

        <div className="apps-toolbar">
          <div className="sidebar-search apps-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps" aria-label="Search apps" spellCheck={false} />
          </div>
          <div className="category-row">
            {GROUPS.map((item) => (
              <button key={item} type="button" className={cn("category-chip", group === item && "is-active")} onClick={() => setGroup(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="apps-empty">
            <Sparkles size={24} />
            <h3>No apps match that</h3>
            <p>Try a different name or category.</p>
          </div>
        ) : (
          <div className="apps-grid">
            {filtered.map((app) => (
              <article className={cn("app-card", app.connected && "is-connected")} key={app.id}>
                <div className="app-card-icon" style={{ background: "#ffffff" }}>
                  <BrandIcon slug={app.icon} size={24} />
                </div>
                <div className="app-card-copy">
                  <div className="app-card-top">
                    <h3>{app.name}</h3>
                    <span className="app-category">{app.category}</span>
                  </div>
                  <p>{app.description}</p>
                  {app.connected && <span className="app-account">{app.account || "Local connection"}</span>}
                </div>
                <button
                  type="button"
                  className={cn("app-connect", app.connected && "is-connected")}
                  onClick={() => void setConnection(app.id, !app.connected)}
                >
                  {app.connected ? <><Check size={14} /> Connected</> : "Connect"}
                </button>
              </article>
            ))}
          </div>
        )}

        <div className="apps-foot">
          <span>{filtered.length} apps in the catalog</span>
          <span>{Object.values(state.connections).filter((connection) => connection.connected).length} connected locally</span>
        </div>
      </div>
    </section>
  );
}
