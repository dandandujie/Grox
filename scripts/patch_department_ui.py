from pathlib import Path
p=Path('src/components/NewBotDialog.tsx')
s=p.read_text()
s=s.replace('''  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");''','''  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("General");
  const [description, setDescription] = useState("");''')
s=s.replace('''    setTitle("");
    setDescription("");''','''    setTitle("");
    setDepartment("General");
    setDescription("");''')
s=s.replace('''    const bot = await createBot({ name: name.trim(), title: title.trim(), description: description.trim(), soul: soul.trim(), color: "green", modelId });''','''    const bot = await createBot({ name: name.trim(), title: title.trim(), department: department.trim() || "General", description: description.trim(), soul: soul.trim(), color: "green", modelId });''')
s=s.replace('''        <div className="form-two">
          <label className="panel-field">
            <span>Role</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Personal assistant" />
          </label>
          <label className="panel-field">
            <span>Model</span>''','''        <div className="form-two">
          <label className="panel-field">
            <span>Role</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Personal assistant" />
          </label>
          <label className="panel-field">
            <span>Department</span>
            <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="General" />
          </label>
        </div>
        <div className="form-two">
          <label className="panel-field">
            <span>Model</span>''')
# The replacement above leaves a div with only Model; adjust by adding another field? It will render fine but form-two one child.
p.write_text(s)
p=Path('src/components/BotPanel.tsx')
s=p.read_text()
s=s.replace('''  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);''','''  const [title, setTitle] = useState(bot.title);
  const [department, setDepartment] = useState(bot.department ?? "General");
  const [description, setDescription] = useState(bot.description);''')
s=s.replace('''    setTitle(bot.title);
    setDescription(bot.description);''','''    setTitle(bot.title);
    setDepartment(bot.department ?? "General");
    setDescription(bot.description);''')
s=s.replace('''    name, setName, title, setTitle, description, setDescription, soul, setSoul, folder, setFolder, saved, setSaved,''','''    name, setName, title, setTitle, department, setDepartment, description, setDescription, soul, setSoul, folder, setFolder, saved, setSaved,''')
s=s.replace('''    if (drafts.title !== bot.title) patch.title = drafts.title;
    if (drafts.description !== bot.description) patch.description = drafts.description;''','''    if (drafts.title !== bot.title) patch.title = drafts.title;
    if (drafts.department !== (bot.department ?? "General")) patch.department = drafts.department.trim() || "General";
    if (drafts.description !== bot.description) patch.description = drafts.description;''')
# add profile field after title field block; locate name/title/description inputs
needle='''        <label className="panel-field">
          <span>Role</span>'''
# We'll insert department after the Role label block by targeted replace of title input block ending
old='''            value={drafts.title}
            onChange={(event) => drafts.setTitle(event.target.value)}
            placeholder="What this bot is for"
          />
        </label>'''
new='''            value={drafts.title}
            onChange={(event) => drafts.setTitle(event.target.value)}
            placeholder="What this bot is for"
          />
        </label>
        <label className="panel-field">
          <span>Department</span>
          <input
            value={drafts.department}
            onChange={(event) => drafts.setDepartment(event.target.value)}
            onBlur={commitText}
            placeholder="General"
          />
        </label>'''
if old not in s:
    raise SystemExit('profile title block missing')
s=s.replace(old,new,1)
p.write_text(s)
