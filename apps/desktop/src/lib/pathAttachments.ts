import { invoke } from "@tauri-apps/api/core";
import type { PromptAttachment } from "../bridge/types";
import { validateAttachmentSet } from "./attachments";

interface PromptPathImage {
  path: string;
  name: string;
  mime: string;
  size: number;
  data: string;
}

const IMAGE_EXT = "(?:png|jpe?g|gif|webp|svg|bmp)";
// A path may contain spaces; stop at the image extension instead of whitespace
// so `/Users/me/reference image.png` works when pasted directly into a prompt.
const PATH_BOUNDARY = `(?:^|[\\s("'\\x60:=：])`;
const ABSOLUTE_IMAGE_PATH = new RegExp(`${PATH_BOUNDARY}((?:file:\\/\\/(?:\\/)?|\\/)[^\\n\\r"'<>|*?]*?\\.${IMAGE_EXT}\\b)`, "gi");
const WINDOWS_IMAGE_PATH = new RegExp(`${PATH_BOUNDARY}((?:[a-z]:[\\\\/]|~[\\\\/]|\\.\\.?[\\\\/])[^\\n\\r"'<>|*?]*?\\.${IMAGE_EXT}\\b)`, "gi");
// A project-relative path like `assets/diagram.png` is also explicit enough,
// but a bare `image.png` in prose is not — it may be a filename the model is
// about to create rather than a file the operator wants to upload.
const PROJECT_IMAGE_PATH = new RegExp(`${PATH_BOUNDARY}((?:[^\\s\\\\/"'<>|*?:=：]+[\\\\/])+[^\\s\\\\/"'<>|*?:=：]+\\.${IMAGE_EXT})\\b`, "gi");
const QUOTED_IMAGE_PATH = new RegExp(`["'\\x60]([^"'\\x60\\n]+?\\.${IMAGE_EXT})["'\\x60]`, "gi");

/** Extract explicitly-mentioned local image paths without treating ordinary prose as a file. */
export function imagePathsInText(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of [ABSOLUTE_IMAGE_PATH, WINDOWS_IMAGE_PATH]) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) matches.push(match[1]);
    }
  }
  for (const match of text.matchAll(PROJECT_IMAGE_PATH)) matches.push(match[1]);
  for (const match of text.matchAll(QUOTED_IMAGE_PATH)) matches.push(match[1]);
  return [...new Set(matches.map((path) => path.trim()).filter((path) => path && !path.startsWith("//")))];
}

/**
 * Turn image paths named by the operator into normal multimodal attachments.
 *
 * ACP's filesystem callback can only return UTF-8 text. Preparing the image
 * before the turn means the agent receives the same `image` content block it
 * receives for a pasted image, while it retains no broader external-FS access.
 */
export async function attachExplicitPromptImages(
  cwd: string,
  text: string,
  attachments: PromptAttachment[],
): Promise<PromptAttachment[]> {
  const paths = imagePathsInText(text);
  if (paths.length === 0) return attachments;
  // The browser showcase intentionally uses MockBridge and has no Tauri
  // command layer. Keep ordinary mock-mode prompts usable even when they
  // mention a path; only the native desktop can turn that path into bytes.
  if (!("__TAURI_INTERNALS__" in window)) return attachments;
  const images = await invoke<PromptPathImage[]>("read_prompt_image_paths", { cwd, paths });
  if (images.length === 0) return attachments;
  const added = images.map<PromptAttachment>((image) => ({
    id: crypto.randomUUID(),
    kind: "image",
    name: image.name,
    mime: image.mime,
    size: image.size,
    data: image.data,
  }));
  const next = [...attachments, ...added];
  validateAttachmentSet(next);
  return next;
}
