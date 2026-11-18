import { useT } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Search, Wrench } from "lucide-react";
import type { ComposioTool } from "@/lib/bridge";
import { useApp } from "@/state/store";
import { Modal } from "@/components/ui";
import { cn } from "@/lib/cn";

export function ComposioToolsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { backend, toast } = useApp();
  const [tools, setTools] = useState<ComposioTool[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ComposioTool | null>(null);
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setResult("");
    void backend.listComposioTools().then((items) => {
      setTools(items);
      setSelected(items[0] ?? null);
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setLoading(false));
  }, [open, backend]);

  useEffect(() => {
    if (!selected) return;
    const schema = selected.inputSchema;
    const properties = schema && typeof schema === "object" ? (schema as Record<string, unknown>).properties : undefined;
    setArgs(properties ? "{}" : "{}");
  }, [selected?.slug]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool) => [tool.slug, tool.name, tool.description, tool.toolkit].some((value) => value.toLowerCase().includes(q)));
  }, [tools, query]);

  const run = async () => {
    if (!selected) return;
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(args || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("Arguments must be a JSON object."));
      parsed = value as Record<string, unknown>;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setRunning(true);
    setError("");
    setResult("");
    try {
      const data = await backend.executeComposioTool(selected.slug, parsed);
      setResult(JSON.stringify(data, null, 2));
      toast({ kind: "success", title: selected.name + " returned" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("Composio tools")} width={780} className="tools-modal">
      <div className="tools-layout">
        <div className="tools-list-column">
          <div className="sidebar-search tools-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search live tools")} aria-label={t("Search tools")} spellCheck={false} />
          </div>
          {loading && <div className="tools-empty"><Loader2 size={15} className="spin" /> {t("Loading tools…")}</div>}
          {!loading && error && !tools.length && <div className="tools-empty is-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && <div className="tools-empty">{t("No tools match.")}</div>}
          <div className="tools-list">
            {filtered.slice(0, 200).map((tool) => (
              <button
                type="button"
                key={tool.slug}
                className={cn("tools-row", selected?.slug === tool.slug && "is-selected")}
                onClick={() => { setSelected(tool); setResult(""); setError(""); }}
              >
                <span className="tools-row-icon"><Wrench size={13} /></span>
                <span className="tools-row-copy">
                  <span className="tools-row-name">{tool.name || tool.slug}</span>
                  <span className="tools-row-meta">{tool.toolkit} · {tool.slug}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="tools-run-column">
          {selected ? (
            <>
              <h3>{selected.name || selected.slug}</h3>
              <p className="tools-description">{selected.description || t("No description.")}</p>
              <div className="tools-schema-label">{t("Arguments")}</div>
              <textarea
                className="tools-args"
                rows={7}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                spellCheck={false}
                aria-label={t("Tool arguments JSON")}
              />
              {selected.inputSchema && (
                <details className="tools-schema">
                  <summary>{t("Input schema")}</summary>
                  <pre>{JSON.stringify(selected.inputSchema, null, 2)}</pre>
                </details>
              )}
              {error && <p className="tools-error">{error}</p>}
              <button type="button" className="btn btn-primary tools-run" onClick={() => void run()} disabled={running}>
                {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {running ? t("Running…") : t("Run tool")}
              </button>
              <p className="tools-warning">{t("This runs a real third-party tool with the connected account. Review the arguments before running it.")}</p>
              {result && <pre className="tools-result">{result}</pre>}
            </>
          ) : (
            <div className="tools-empty">{t("Pick a tool to see its schema and run it.")}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
