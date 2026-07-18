/* Markdown rendering for untrusted agent output. */

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const rendered = marked.parse(text, { async: false });
  const html = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
