import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{languageOf(className)}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function languageOf(className?: string): string {
  const match = /language-([\\w-]+)/.exec(className ?? "");
  return match?.[1] ?? "code";
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: text }) => (
            <a href={href} target="_blank" rel="noreferrer">{text}</a>
          ),
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          code: ({ className: codeClass, children: codeChildren, ...props }) => {
            const inline = !codeClass && typeof codeChildren === "string" && !codeChildren.includes("\\n");
            if (inline) return <code className="inline-code" {...props}>{codeChildren}</code>;
            return <CodeBlock className={codeClass}>{codeChildren}</CodeBlock>;
          },
          table: ({ children: tableChildren }) => <div className="table-wrap"><table>{tableChildren}</table></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
