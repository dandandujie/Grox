import { mergeProjectSessionsPure } from "../lib/sessionCatalogMerge";
import { mergeDiscoveredProjects as mergeDiscoveredProjectsPure, type ProjectRecord, samePath } from "../lib/projectCatalog";

export type CatalogSession = {
  id: string;
  cwd: string;
  updatedAt: number;
  title?: string;
  createdAt?: number;
  model?: string;
  pinned?: boolean;
  archived?: boolean;
};

export type CatalogProject = ProjectRecord;

export function decorateSessionMetas<T extends CatalogSession>(
  metas: T[],
  flags: Record<string, { pinned?: boolean; archived?: boolean; completionUnread?: boolean }>,
  legacyArchivedPaths: string[],
): T[] {
  return metas.map((meta) => ({
    ...meta,
    ...flags[meta.id],
    ...(legacyArchivedPaths.some((path) => samePath(path, meta.cwd)) ? { archived: true } : {}),
  }));
}

export function mergeSessionMetas<T extends CatalogSession>(
  existing: T[],
  incoming: T[],
  cwd: string | undefined,
  deleted: ReadonlySet<string>,
  decorate: (metas: T[]) => T[],
): T[] {
  const visibleExisting = existing.filter((meta) => !deleted.has(meta.id));
  const visibleIncoming = incoming.filter((meta) => !deleted.has(meta.id));
  if (!cwd) {
    const incomingIds = new Set(visibleIncoming.map((meta) => meta.id));
    return [...decorate(visibleIncoming), ...visibleExisting.filter((meta) => !incomingIds.has(meta.id))]
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return mergeProjectSessionsPure(
    visibleExisting,
    samePath,
    cwd,
    decorate(visibleIncoming),
    deleted,
  ) as T[];
}

export function mergeProjectMetas(
  projects: CatalogProject[],
  sessions: CatalogSession[],
  dismissed: ReadonlySet<string>,
): CatalogProject[] {
  return mergeDiscoveredProjectsPure(projects, sessions as unknown as Parameters<typeof mergeDiscoveredProjectsPure>[1], dismissed) as CatalogProject[];
}
