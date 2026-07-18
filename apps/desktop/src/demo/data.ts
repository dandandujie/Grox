/* ─────────────────────────────────────────────────────────────────────────
   Demo workspace data — seeded "missions" so the shell opens with history.
   All sessions are scoped to the grok-build repo itself, because of course
   you'd use Grok to work on Grok.
   ───────────────────────────────────────────────────────────────────────── */

import type { Session, Usage } from "../bridge/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const usage = (partial: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 256_000,
  turns: 0,
  ...partial,
});

export const DEMO_CWD = "D:/Github/Grox";

export function seedSessions(): Session[] {
  const now = Date.now();

  return [
    {
      id: "m-01-scrollback",
      title: "Double-buffer the pager scrollback",
      cwd: DEMO_CWD,
      createdAt: now - 2 * HOUR,
      updatedAt: now - 1.4 * HOUR,
      model: "grok-build",
      demo: true,
      status: "idle",
      usage: usage({
        inputTokens: 112_804,
        outputTokens: 4_102,
        cacheReadTokens: 88_230,
        costUSD: 0.0311,
        contextUsed: 121_500,
        turns: 12,
      }),
      blocks: [
        {
          type: "user",
          id: "m1-u1",
          ts: now - 2 * HOUR,
          text: "The scrollback flickers on rapid redraws in the pager. Can we move rendering to a double buffer?",
        },
        {
          type: "thinking",
          id: "m1-t1",
          ts: now - 2 * HOUR + 5_000,
          live: false,
          elapsedMs: 6_200,
          text: "Flicker on rapid redraw usually means partial frames hit the terminal. The pager renders straight into the diff buffer; a back/front swap should make every frame atomic.",
        },
        {
          type: "tool",
          id: "m1-tc1",
          ts: now - 2 * HOUR + 9_000,
          call: {
            id: "c1",
            kind: "edit",
            title: "edit_file",
            detail: "crates/codegen/xai-grok-pager/src/scrollback/mod.rs",
            status: "done",
            startedAt: now - 2 * HOUR + 9_000,
            endedAt: now - 2 * HOUR + 11_000,
            diff: [
              {
                path: "crates/codegen/xai-grok-pager/src/scrollback/mod.rs",
                added: 9,
                removed: 2,
                lines: [
                  { kind: "ctx", text: "pub struct Scrollback {" },
                  { kind: "del", text: "    buf: Buffer," },
                  { kind: "add", text: "    back: Buffer," },
                  { kind: "add", text: "    front: Buffer," },
                  { kind: "ctx", text: "}" },
                  { kind: "ctx", text: "" },
                  { kind: "add", text: "    /// Swap after a full draw so frames are atomic." },
                  { kind: "add", text: "    pub fn flip(&mut self) {" },
                  { kind: "add", text: "        std::mem::swap(&mut self.back, &mut self.front);" },
                  { kind: "add", text: "    }" },
                ],
              },
            ],
          },
        },
        {
          type: "assistant",
          id: "m1-a1",
          ts: now - 2 * HOUR + 14_000,
          text: "Done. Rendering now draws into a back buffer and flips atomically — flicker is gone on 60fps resize storms. `cargo test -p xai-grok-pager scrollback` passes (14 tests).",
        },
      ],
    },
    {
      id: "m-02-fsnotify",
      title: "Fix flaky fsnotify watcher on Windows",
      cwd: DEMO_CWD,
      createdAt: now - DAY,
      updatedAt: now - 22 * HOUR,
      model: "grok-build",
      demo: true,
      status: "idle",
      usage: usage({
        inputTokens: 64_210,
        outputTokens: 2_470,
        cacheReadTokens: 39_800,
        costUSD: 0.0174,
        contextUsed: 74_600,
        turns: 8,
      }),
      blocks: [
        {
          type: "user",
          id: "m2-u1",
          ts: now - DAY,
          text: "The fs watcher drops events under load on Windows. Investigate and fix.",
        },
        {
          type: "tool",
          id: "m2-tc1",
          ts: now - DAY + 8_000,
          call: {
            id: "c2",
            kind: "terminal",
            title: "run_terminal_cmd",
            detail: "cargo test -p xai-fsnotify -- --nocapture",
            status: "done",
            startedAt: now - DAY + 8_000,
            endedAt: now - DAY + 26_000,
            terminal: {
              cmd: "cargo test -p xai-fsnotify -- --nocapture",
              lines: [
                "running 6 tests",
                "test watch::drops_under_burst ... FAILED",
                "test watch::coalesces_rapid_writes ... ok",
                "",
                "failures: 1; ReadDirectoryChangesW buffer overflows at ~4k events/s",
              ],
              exitCode: 101,
            },
          },
        },
        {
          type: "assistant",
          id: "m2-a1",
          ts: now - DAY + 40_000,
          text: "Root cause: `ReadDirectoryChangesW` buffer (64 KiB) overflows during burst writes, and overflow events were silently discarded. Fix: escalate to a full resync on `ERROR_NOTIFY_ENUM_DIR` instead of dropping. Pushed the patch; watcher now survives 40k events/s in the stress harness.",
        },
      ],
    },
    {
      id: "m-03-compaction",
      title: "Explore: how compaction picks split points",
      cwd: DEMO_CWD,
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY,
      model: "grok-4",
      demo: true,
      status: "idle",
      usage: usage({
        inputTokens: 18_420,
        outputTokens: 940,
        cacheReadTokens: 12_100,
        costUSD: 0.0042,
        contextUsed: 21_700,
        turns: 3,
      }),
      blocks: [
        {
          type: "user",
          id: "m3-u1",
          ts: now - 2 * DAY,
          text: "How does auto-compaction decide where to cut the conversation?",
        },
        {
          type: "assistant",
          id: "m3-a1",
          ts: now - 2 * DAY + 12_000,
          text: "It scores turn boundaries, not tokens. `xai-grok-compaction` walks the transcript and cuts at the last boundary that (a) lands under the context budget and (b) doesn't split a tool call from its result. Everything before the cut is summarized into a checkpoint under `compaction_checkpoints/`.",
        },
      ],
    },
    {
      id: "m-04-dashboard",
      title: "Add rename flow to /dashboard",
      cwd: DEMO_CWD,
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY,
      model: "grok-build",
      demo: true,
      status: "idle",
      usage: usage({
        inputTokens: 41_900,
        outputTokens: 1_720,
        cacheReadTokens: 28_400,
        costUSD: 0.0113,
        contextUsed: 52_300,
        turns: 6,
      }),
      blocks: [
        {
          type: "user",
          id: "m4-u1",
          ts: now - 3 * DAY,
          text: "Dashboard needs inline rename for sessions (R key, like resume uses Enter).",
        },
        {
          type: "plan",
          id: "m4-p1",
          ts: now - 3 * DAY + 6_000,
          steps: [
            { id: "s1", content: "Add editing state to dashboard rows", status: "completed" },
            { id: "s2", content: "Wire R keybinding + commit on Enter", status: "completed" },
            { id: "s3", content: "Persist via summary.json rename", status: "completed" },
          ],
        },
        {
          type: "assistant",
          id: "m4-a1",
          ts: now - 3 * DAY + 90_000,
          text: "Shipped. `R` on a dashboard row opens an inline editor, Enter commits, Esc aborts. Rename flows through the same `summary.json` path as `/rename`, so forks keep their parent link.",
        },
      ],
    },
    {
      id: "m-05-theming-docs",
      title: "Docs: refresh the theming guide",
      cwd: DEMO_CWD,
      createdAt: now - 5 * DAY,
      updatedAt: now - 5 * DAY,
      model: "grok-code-fast",
      demo: true,
      status: "idle",
      usage: usage({
        inputTokens: 9_300,
        outputTokens: 610,
        cacheReadTokens: 4_200,
        costUSD: 0.0019,
        contextUsed: 11_200,
        turns: 2,
      }),
      blocks: [
        {
          type: "user",
          id: "m5-u1",
          ts: now - 5 * DAY,
          text: "The theming guide still calls the desktop theme 'magenta'. It's now a pure monochrome black-hole theme — graphite base, starlight-white accent, no hue. Update the wording.",
        },
        {
          type: "assistant",
          id: "m5-a1",
          ts: now - 5 * DAY + 20_000,
          text: "Updated `06-theming.md`: the desktop is now documented as a pure monochrome black-hole theme — graphite base, starlight-white accent, no hue. Functional color is limited to amber (caution), red (danger), and green (success).",
        },
      ],
    },
  ];
}
