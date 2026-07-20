/* Markdown rendering for untrusted agent output. */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";
import { invoke } from "@tauri-apps/api/core";
import type { MouseEvent } from "react";
import { memo, useMemo } from "react";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ESCAPES[char]);

function renderCodeBlock(text: string, lang: string): string {
  const language = lang.trim().toLowerCase();
  const valid = language !== "" && hljs.getLanguage(language) ? language : "";
  let highlighted: string;
  if (valid) {
    try {
      highlighted = hljs.highlight(text, { language: valid }).value;
    } catch {
      highlighted = escapeHtml(text);
    }
  } else {
    highlighted = escapeHtml(text);
  }
  const label = escapeHtml(valid || "text");
  return (
    `<div class="md-code"><div class="md-code-bar"><span class="md-code-lang">${label}</span>` +
    `<button type="button" class="md-code-copy" data-code-copy>copy</button></div>` +
    `<pre><code class="hljs${valid ? ` language-${valid}` : ""}">${highlighted}</code></pre></div>`
  );
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      return renderCodeBlock(text, lang ?? "");
    },
  },
});
marked.use(markedKatex({ throwOnError: false, nonStandard: true, output: "mathml" }));

export function normalizeMathDelimiters(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  let displayMath = false;
  return text.split("\n").map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      return line;
    }

    let output = "";
    let inlineTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineTicks = inlineTicks === 0 ? ticks : inlineTicks === ticks ? 0 : inlineTicks;
        output += line.slice(index, end);
        index = end;
        continue;
      }
      const next = line[index + 1];
      if (inlineTicks === 0 && line.startsWith("$$", index)) {
        output += displayMath ? "\n$$\n\n" : "\n\n$$\n";
        displayMath = !displayMath;
        index += 2;
        continue;
      }
      if (inlineTicks === 0 && line[index] === "\\" && line[index - 1] !== "\\" && (next === "(" || next === ")" || next === "[" || next === "]")) {
        if (next === "[") {
          output += "\n\n$$\n";
          displayMath = true;
        } else if (next === "]") {
          output += "\n$$\n\n";
          displayMath = false;
        } else {
          output += "$";
        }
        index += 2;
        continue;
      }
      output += line[index];
      index += 1;
    }
    return output;
  }).join("\n");
}

export function renderMarkdownHtml(text: string): string {
  const rendered = marked.parse(normalizeMathDelimiters(text), { async: false });
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

export const Markdown = memo(function Markdown({ text, className = "", streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdownHtml(text), [text]);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const copyButton = target.closest("[data-code-copy]");
    if (copyButton instanceof HTMLElement) {
      const code = copyButton.closest(".md-code")?.querySelector("pre code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(() => {
        copyButton.classList.add("copied");
        copyButton.textContent = "copied";
        setTimeout(() => {
          copyButton.classList.remove("copied");
          copyButton.textContent = "copy";
        }, 1200);
      });
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    try {
      const url = new URL(href);
      if (url.protocol === "https:" || url.protocol === "http:") {
        void invoke("open_external", { url: url.toString() });
      }
    } catch {
      // Relative links stay inert because there is no trusted navigation base.
    }
  };
  return (
    <div
      className={`md ${streaming ? "md-streaming" : ""} ${className}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
