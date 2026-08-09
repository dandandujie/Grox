import { describe, expect, it } from "vitest";
import {
  dedupeProjects,
  dismissProjectId,
  ensureProject,
  isDraftSessionId,
  isEphemeralSessionId,
  mergeDiscoveredProjects,
  normalizeWorkspacePath,
  projectId,
  projectName,
  samePath,
  undismissProjectId,
} from "./projectCatalog";

describe("normalizeWorkspacePath / projectId", () => {
  it("treats Windows backslash and slash spellings as one identity", () => {
    const a = "C:\\Users\\Harry\\Desktop\\Grok";
    const b = "C:/Users/Harry/Desktop/Grok";
    const c = "c:\\Users\\Harry\\Desktop\\Grok\\";
    expect(projectId(a)).toBe(projectId(b));
    expect(projectId(a)).toBe(projectId(c));
    expect(samePath(a, b)).toBe(true);
    expect(normalizeWorkspacePath(a)).toBe("C:/Users/Harry/Desktop/Grok");
  });

  it("strips extended-length prefixes", () => {
    expect(projectId("\\\\?\\C:\\Work\\repo")).toBe(projectId("C:\\Work\\repo"));
  });

  it("derives folder basenames from mixed separators", () => {
    expect(projectName("C:\\Users\\Harry\\Desktop\\spoofer")).toBe("spoofer");
    expect(projectName("C:/Users/Harry/Desktop/Grok/")).toBe("Grok");
  });
});

describe("dedupeProjects", () => {
  it("merges duplicate rows that only differ by path spelling", () => {
    const now = 1_000;
    const merged = dedupeProjects([
      {
        id: "c:\\users\\harry\\desktop\\grok",
        path: "C:\\Users\\Harry\\Desktop\\Grok",
        name: "Grok",
        pinned: true,
        archived: false,
        createdAt: now,
        lastOpenedAt: now,
      },
      {
        id: "c:/users/harry/desktop/grok",
        path: "C:/Users/Harry/Desktop/Grok",
        name: "Grok",
        pinned: false,
        archived: false,
        createdAt: now + 1,
        lastOpenedAt: now + 5,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(projectId("C:\\Users\\Harry\\Desktop\\Grok"));
    expect(merged[0].pinned).toBe(true);
    expect(merged[0].lastOpenedAt).toBe(now + 5);
  });

  it("keeps a custom rename when collapsing duplicates", () => {
    const merged = dedupeProjects([
      {
        id: "a",
        path: "C:\\work\\repo",
        name: "My Repo",
        pinned: false,
        archived: false,
        createdAt: 1,
        lastOpenedAt: 1,
      },
      {
        id: "b",
        path: "C:/work/repo",
        name: "repo",
        pinned: false,
        archived: false,
        createdAt: 2,
        lastOpenedAt: 2,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("My Repo");
  });
});

describe("ensureProject", () => {
  it("updates lastOpenedAt instead of inserting a slash-variant twin", () => {
    const base = ensureProject([], "C:\\Users\\Harry\\Desktop\\Grok", 10);
    const next = ensureProject(base, "C:/Users/Harry/Desktop/Grok", 20);
    expect(next).toHaveLength(1);
    expect(next[0].lastOpenedAt).toBe(20);
    expect(next[0].id).toBe(projectId("C:\\Users\\Harry\\Desktop\\Grok"));
  });
});

describe("mergeDiscoveredProjects + dismiss", () => {
  it("re-discovers projects from session history by default", () => {
    const discovered = mergeDiscoveredProjects(
      [],
      [
        {
          cwd: "C:\\Users\\Harry\\Desktop\\Temp",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    );
    expect(discovered).toHaveLength(1);
    expect(discovered[0].name).toBe("Temp");
  });

  it("does not re-create an operator-removed project after CLI import", () => {
    const id = projectId("C:\\Users\\Harry\\Desktop\\Temp");
    const dismissed = new Set(dismissProjectId([], id));
    const discovered = mergeDiscoveredProjects(
      [],
      [
        {
          cwd: "C:/Users/Harry/Desktop/Temp",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      dismissed,
    );
    expect(discovered).toHaveLength(0);
  });

  it("undismiss lets ensureProject surface the project again", () => {
    const id = projectId("C:\\work\\repo");
    let dismissed = dismissProjectId([], id);
    expect(dismissed).toContain(id);
    dismissed = undismissProjectId(dismissed, "C:/work/repo");
    expect(dismissed).not.toContain(id);
    const projects = ensureProject([], "C:\\work\\repo", 1);
    const merged = mergeDiscoveredProjects(
      projects,
      [{ cwd: "C:/work/repo", createdAt: 1, updatedAt: 2 }],
      new Set(dismissed),
    );
    expect(merged).toHaveLength(1);
  });
});

describe("ephemeral session ids", () => {
  it("recognizes draft and pending shells", () => {
    expect(isDraftSessionId("draft-abc")).toBe(true);
    expect(isDraftSessionId("pending-abc")).toBe(false);
    expect(isEphemeralSessionId("draft-abc")).toBe(true);
    expect(isEphemeralSessionId("pending-abc")).toBe(true);
    expect(isEphemeralSessionId("real-session")).toBe(false);
  });
});
