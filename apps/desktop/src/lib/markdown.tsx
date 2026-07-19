/* Markdown rendering for untrusted agent output. */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
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

function readableStreamingText(text: string): string {
  return text
    .replace(/^\s{0,3}```[^\n]*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)]\((?:[^()]|\([^)]*\))*\)/g, "$1");
}

export const Markdown = memo(function Markdown({ text, className = "", streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  const html = useMemo(() => {
    if (streaming) return "";
    const rendered = marked.parse(text, { async: false });
    return DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "iframe", "object", "embed"],
      FORBID_ATTR: ["style"],
    });
  }, [streaming, text]);
  if (streaming) {
    return <div className={`md md-streaming whitespace-pre-wrap ${className}`}>{readableStreamingText(text)}</div>;
  }
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
      className={`md ${className}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
