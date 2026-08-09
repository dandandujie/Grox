/**
 * Project catalogue identity and discovery.
 *
 * Path identity bugs on Windows: store used trailing-slash + toLocaleLowerCase
 * only, while the sidebar compared with `\` → `/` normalization. The same
 * folder could therefore get two project rows (e.g. `c:\foo` vs `c:/foo`) when
 * openProject / setWorkspace / CLI history returned a differently spelled cwd.
 *
 * Remove was also non-sticky: mergeDiscoveredProjects re-created rows from
 * session cwds after "导入 CLI 历史".
 */

export type ProjectRecord = {
  id: string;
  path: string;
  name: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  lastOpenedAt: number;
};

export type SessionPathRecord = {
  cwd: string;
  createdAt: number;
  updatedAt: number;
};

/** Stable display / identity path: slash-normalized, no trailing slash. */
export function normalizeWorkspacePath(path: string): string {
  let value = path.trim();
  if (!value) return "";
  // Windows extended-length / device prefixes.
  if (value.startsWith("\\\\?\\")) value = value.slice(4);
  if (value.startsWith("//?/")) value = value.slice(4);
  value = value.replace(/\\/g, "/");

  if (/^[a-zA-Z]:/.test(value)) {
    // Drive-absolute: collapse duplicate slashes after the drive root.
    value = `${value[0]}${value.slice(1).replace(/\/+/g, "/")}`;
  } else if (value.startsWith("//")) {
    // UNC: keep the leading //, collapse the rest.
    value = `//${value.slice(2).replace(/\/+/g, "/")}`;
  } else {
    value = value.replace(/\/+/g, "/");
  }

  // Keep "C:/" style roots; strip trailing slash on everything else.
  if (/^[a-zA-Z]:\/$/.test(value) || value === "/") return value;
  return value.replace(/\/+$/, "");
}

/** Case-insensitive identity key for project rows and workspace matching. */
export function projectId(path: string): string {
  return normalizeWorkspacePath(path).toLowerCase();
}

export function samePath(left: string, right: string): boolean {
  return projectId(left) === projectId(right);
}

export function projectName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized.split("/").filter(Boolean).at(-1) || normalized || path;
}

/**
 * Prefer a path that already uses native Windows separators when both spell
 * the same identity — keeps explorer / CLI hand-off looking familiar.
 */
export function preferDisplayPath(existing: string, incoming: string): string {
  if (!existing.trim()) return incoming;
  if (!incoming.trim()) return existing;
  if (!samePath(existing, incoming)) return incoming;
  const existingHasBackslash = existing.includes("\\");
  const incomingHasBackslash = incoming.includes("\\");
  if (existingHasBackslash === incomingHasBackslash) return incoming;
  return incomingHasBackslash ? incoming : existing;
}

/** Collapse duplicate project rows that only differ by path spelling. */
export function dedupeProjects(projects: ProjectRecord[]): ProjectRecord[] {
  const byId = new Map<string, ProjectRecord>();
  for (const project of projects) {
    const id = projectId(project.path || project.id);
    if (!id) continue;
    const current = byId.get(id);
    if (!current) {
      byId.set(id, {
        ...project,
        id,
        path: project.path || project.id,
        name: project.name?.trim() || projectName(project.path || project.id),
      });
      continue;
    }
    const customName = current.name.trim() && current.name !== projectName(current.path)
      ? current.name
      : project.name.trim() && project.name !== projectName(project.path)
        ? project.name
        : projectName(preferDisplayPath(current.path, project.path));
    byId.set(id, {
      ...current,
      path: preferDisplayPath(current.path, project.path),
      name: customName,
      pinned: current.pinned || project.pinned,
      // If either copy is still active, keep the project visible.
      archived: current.archived && project.archived,
      createdAt: Math.min(current.createdAt, project.createdAt),
      lastOpenedAt: Math.max(current.lastOpenedAt, project.lastOpenedAt),
    });
  }
  return [...byId.values()];
}

export function ensureProject(
  projects: ProjectRecord[],
  path: string,
  now = Date.now(),
): ProjectRecord[] {
  const id = projectId(path);
  if (!id) return dedupeProjects(projects);
  const deduped = dedupeProjects(projects);
  const current = deduped.find((project) => project.id === id);
  if (current) {
    return deduped.map((project) =>
      project.id === id
        ? {
            ...project,
            path: preferDisplayPath(project.path, path),
            lastOpenedAt: now,
          }
        : project,
    );
  }
  return [
    ...deduped,
    {
      id,
      path,
      name: projectName(path),
      pinned: false,
      archived: false,
      createdAt: now,
      lastOpenedAt: now,
    },
  ];
}

/**
 * Discover projects from session cwds, skipping operator-dismissed ids.
 * Dismissed projects stay hidden across "导入 CLI 历史" until the operator
 * re-opens that path (ensureProject clears the dismissal).
 */
export function mergeDiscoveredProjects(
  projects: ProjectRecord[],
  sessions: SessionPathRecord[],
  dismissed: ReadonlySet<string> = new Set(),
): ProjectRecord[] {
  const next = dedupeProjects(projects);
  const known = new Set(next.map((project) => project.id));
  for (const session of sessions) {
    const id = projectId(session.cwd);
    if (!id || known.has(id) || dismissed.has(id)) continue;
    known.add(id);
    next.push({
      id,
      path: session.cwd,
      name: projectName(session.cwd),
      pinned: false,
      archived: false,
      createdAt: session.createdAt,
      lastOpenedAt: session.updatedAt,
    });
  }
  return next;
}

export function dismissProjectId(
  dismissed: Iterable<string>,
  id: string,
): string[] {
  const next = new Set(
    [...dismissed].map((entry) => projectId(entry)).filter(Boolean),
  );
  const key = projectId(id);
  if (key) next.add(key);
  return [...next].sort();
}

export function undismissProjectId(
  dismissed: Iterable<string>,
  id: string,
): string[] {
  const key = projectId(id);
  return [...dismissed]
    .map((entry) => projectId(entry))
    .filter((entry) => entry && entry !== key)
    .sort();
}

export function isDraftSessionId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith("draft-"));
}

export function isEphemeralSessionId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith("draft-") || id?.startsWith("pending-"));
}

/**
 * Whether passive discovery / open may create a project row.
 * Dismissed paths stay hidden unless the operator explicitly restores them
 * (folder picker / "new project").
 */
export function maySurfaceProject(args: {
  path: string;
  dismissed: ReadonlySet<string>;
  restore?: boolean;
}): boolean {
  const id = projectId(args.path);
  if (!id) return false;
  if (args.restore) return true;
  return !args.dismissed.has(id);
}
