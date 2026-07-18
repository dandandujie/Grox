/* Shared inline diff renderer — official insert/delete colors. */

import type { DiffHunk } from "../../bridge/types";
import { Icon } from "../fx/Icon";

export function DiffView({ diff, collapsed = false }: { diff: DiffHunk[]; collapsed?: boolean }) {
  return (
    <div className="space-y-2">
      {diff.map((hunk, i) => (
        <details key={`${hunk.path}-${i}`} className="group/diff overflow-hidden rounded-[5px] border border-line2 bg-void" open={!collapsed}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
            <Icon name="chevronRight" size={8} className="shrink-0 text-faint transition-transform group-open/diff:rotate-90" />
            <Icon name="file" size={10} className="text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute select-text">
              {hunk.path}
            </span>
            <span className="tnum text-[9.5px] text-diff-add-fg">+{hunk.added}</span>
            <span className="tnum text-[9.5px] text-diff-del-fg">−{hunk.removed}</span>
          </summary>
          <div className="border-t border-line py-1 font-mono text-[10.5px] leading-[1.7] select-text">
            {hunk.lines.map((line, j) => (
              <div
                key={j}
                className={`flex ${
                  line.kind === "add"
                    ? "bg-diff-add-bg/60 text-diff-add-fg"
                    : line.kind === "del"
                      ? "bg-diff-del-bg/60 text-diff-del-fg"
                      : "text-dim"
                }`}
              >
                <span className="w-7 shrink-0 select-none text-center opacity-70">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre-wrap">{line.text || " "}</span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
