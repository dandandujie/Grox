from pathlib import Path
p=Path('src/components/SettingsModal.tsx')
s=p.read_text()
s=s.replace('''  const importRef = useRef<HTMLInputElement>(null);''','''  const importRef = useRef<HTMLInputElement>(null);
  const [grokText, setGrokText] = useState("");
  const [grokBusy, setGrokBusy] = useState(false);''',1)
needle='''      <SectionCard title="Danger zone" hint="These actions affect this workspace.">'''
insert='''      <SectionCard title="Move from Grok Bot" hint="Paste a Grok Bot export JSON. Grox creates new bots and never overwrites existing ones. Skills are not imported because Grox skills are global.">
        <label className="panel-field">
          <span>Grok Bot export</span>
          <textarea rows={5} value={grokText} onChange={(event) => setGrokText(event.target.value)} placeholder="Paste the grok-bot-export JSON or the chat reply containing it" spellCheck={false} />
        </label>
        <button type="button" className="btn btn-secondary" disabled={grokBusy || !grokText.trim()} onClick={() => {
          setGrokBusy(true);
          void backend.importGrokBot(grokText).then((result) => {
            setGrokText("");
            toast({ kind: "success", title: "Grok Bot import complete", body: result.bots + " bots, " + result.routines + " routines, " + result.memories + " notes, " + result.apps + " MCP servers." });
          }).catch((cause: unknown) => {
            toast({ kind: "error", title: "Grok Bot import failed", body: cause instanceof Error ? cause.message : "Try again." });
          }).finally(() => setGrokBusy(false));
        }}>{grokBusy ? "Importing…" : "Import from Grok Bot"}</button>
      </SectionCard>

'''
if needle not in s:
    raise SystemExit('danger zone needle missing')
s=s.replace(needle, insert+needle,1)
p.write_text(s)
