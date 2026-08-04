import type { Session, SessionMeta } from "../bridge/types";

export function normalizeSessionQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function sessionMatchesLoadedContent(
  meta: SessionMeta,
  session: Session | undefined,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  if (meta.title.toLocaleLowerCase().includes(normalizedQuery)) return true;
  return session?.blocks.some((block) => {
    if (block.type !== "user" && block.type !== "assistant") return false;
    return block.text.toLocaleLowerCase().includes(normalizedQuery);
  }) ?? false;
}
