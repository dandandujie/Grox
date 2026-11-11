---
botmrr: 1
id: signal-desk
release: 1.0.0
name: Signal Desk
agents:
  - key: scout
    name: Imported Scout
    title: Researcher
    description: Find evidence.
    appearance:
      color: cyan
    skills:
      - source-check
    playbooks:
      - signal-check
  - key: editor
    name: Imported Editor
    title: Editor
rooms:
  - key: signals
    name: Imported Room
    members: [scout, editor]
    defaultResponder:
      kind: agent
      agent: scout
routines:
  - key: morning
    name: Morning signals
    agent: scout
    prompt: Prepare the morning signal brief.
    runOn: maus
    schedule:
      type: weekdays
      time: "09:00"
playbooks:
  - key: signal-check
    name: Signal Check
    instructions: Keep the source URL and confidence.
    triggers: [signal brief]
skills:
  version: 1
  entries:
    - name: source-check
      description: Check sources.
      instructions: Check the source before writing.
---

# Signal Desk
