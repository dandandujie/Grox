import { useEffect, useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import type { Attachment } from "@/lib/bridge";
import { useApp } from "@/state/store";
import { cn } from "@/lib/cn";

const cache = new Map<string, string>();

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function useAttachmentData(attachment: Attachment): string | null {
  const { backend } = useApp();
  const [data, setData] = useState<string | null>(() => cache.get(attachment.id) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attachment.kind !== "image") return;
    const cached = cache.get(attachment.id);
    if (cached) {
      setData(cached);
      return;
    }
    let cancelled = false;
    void backend.readAttachment(attachment.id).then((value) => {
      if (cancelled) return;
      const url = "data:" + (attachment.mime || "image/png") + ";base64," + value;
      cache.set(attachment.id, url);
      setData(url);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attachment.id, attachment.kind, attachment.mime, backend]);
  return failed ? null : data;
}

function ImageAttachment({ attachment, removable, onRemove }: { attachment: Attachment; removable?: boolean; onRemove?: () => void }) {
  const { backend } = useApp();
  const data = useAttachmentData(attachment);
  if (!data && attachment.kind === "image" && attachment.size > 12 * 1024 * 1024) {
    return <FileAttachment attachment={attachment} removable={removable} onRemove={onRemove} />;
  }
  return (
    <div className="attachment-image-wrap">
      <button type="button" className="attachment-image" onClick={() => void backend.openAttachment(attachment.id)} title={attachment.name}>
        {data ? <img src={data} alt={attachment.name} /> : <span className="attachment-image-loading"><Loader2 size={15} className="spin" /> Loading preview</span>}
      </button>
      {removable && (
        <button type="button" className="attachment-remove" aria-label={"Remove " + attachment.name} onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function FileAttachment({ attachment, removable, onRemove }: { attachment: Attachment; removable?: boolean; onRemove?: () => void }) {
  const { backend } = useApp();
  return (
    <div className="attachment-file-wrap">
      <button type="button" className="attachment-file" onClick={() => void backend.openAttachment(attachment.id)} title={attachment.name}>
        <span className="attachment-file-icon"><FileText size={15} /></span>
        <span className="attachment-file-copy">
          <span className="attachment-file-name">{attachment.name}</span>
          <span className="attachment-file-size">{formatBytes(attachment.size)}</span>
        </span>
      </button>
      {removable && (
        <button type="button" className="attachment-remove" aria-label={"Remove " + attachment.name} onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function AttachmentGallery({ attachments, removable, onRemove, className }: {
  attachments: Attachment[];
  removable?: boolean;
  onRemove?: (id: string) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn("attachment-gallery", className)}>
      {attachments.map((attachment) => (
        attachment.kind === "image"
          ? <ImageAttachment key={attachment.id} attachment={attachment} removable={removable} onRemove={() => onRemove?.(attachment.id)} />
          : <FileAttachment key={attachment.id} attachment={attachment} removable={removable} onRemove={() => onRemove?.(attachment.id)} />
      ))}
    </div>
  );
}
