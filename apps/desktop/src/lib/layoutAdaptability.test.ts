/**
 * Adaptability / layout regression gate.
 *
 * Fails when density or font prefs re-introduce known layout hazards.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../styles/tokens.css"),
  "utf8",
);

function blockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const match = tokens.match(re);
  return match?.[1] ?? "";
}

describe("layout adaptability — density isolation", () => {
  it("density blocks only set content/composer max-width", () => {
    for (const name of ["narrow", "medium", "wide", "fill"] as const) {
      const body = blockFor(`html[data-density="${name}"]`);
      expect(body, name).toBeTruthy();
      expect(body).toMatch(/--grox-content-max\s*:/);
      expect(body).toMatch(/--grox-composer-max\s*:/);
      expect(body).not.toMatch(/--grox-turn-gap/);
      expect(body).not.toMatch(/--grox-content-px/);
      expect(body).not.toMatch(/--grox-prose-max/);
      expect(body).not.toMatch(/--grox-assistant-max/);
      expect(body).not.toMatch(/--grox-prose-size/);
      expect(body).not.toMatch(/--grox-font/);
      expect(body).not.toMatch(/font-size/);
      expect(body).not.toMatch(/line-height/);
      expect(body).not.toMatch(/padding/);
      expect(body).not.toMatch(/margin/);
    }
  });

  it("content max equals composer max in each density tier", () => {
    for (const name of ["narrow", "medium", "wide", "fill"] as const) {
      const body = blockFor(`html[data-density="${name}"]`);
      const content = body.match(/--grox-content-max\s*:\s*([^;]+);/)?.[1]?.trim();
      const composer = body.match(/--grox-composer-max\s*:\s*([^;]+);/)?.[1]?.trim();
      expect(content).toBeTruthy();
      expect(composer).toBe(content);
    }
  });

  it("fill tier uses 100% so the reading column spans the main pane", () => {
    const body = blockFor(`html[data-density="fill"]`);
    expect(body).toMatch(/--grox-content-max\s*:\s*100%/);
    expect(body).toMatch(/--grox-composer-max\s*:\s*100%/);
  });

  it("does not reintroduce global fractional font-increase on text utilities", () => {
    expect(tokens).not.toMatch(/--grox-font-increase\s*:/);
  });

  it("timeline and composer share fixed horizontal padding variable", () => {
    expect(tokens).toMatch(/--grox-content-px\s*:\s*2rem/);
    expect(tokens).toMatch(/--grox-turn-gap\s*:\s*1\.75rem/);
    const timeline = blockFor(".timeline-content");
    const dock = blockFor(".composer-dock");
    expect(timeline).toMatch(/max-width:\s*var\(--grox-content-max/);
    expect(timeline).toMatch(/padding-left:\s*var\(--grox-content-px/);
    expect(dock).toMatch(/max-width:\s*var\(--grox-content-max/);
    expect(dock).toMatch(/padding-left:\s*var\(--grox-content-px/);
  });

  it("timeline uses native scroller (Virtuoso yanks scroll on process expand)", () => {
    const timelineSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../components/session/Timeline.tsx"),
      "utf8",
    );
    expect(timelineSrc).not.toMatch(/from ["']react-virtuoso["']/);
    expect(timelineSrc).not.toMatch(/<Virtuoso\b/);
    expect(timelineSrc).toMatch(/timeline-scroller/);
    expect(timelineSrc).toMatch(/data-turn-id/);
  });

  it("assistant content fills reading column (no nested hollow max)", () => {
    expect(tokens).toMatch(/\.assistant-message__content\s*\{[\s\S]*?max-width:\s*100%/);
    expect(tokens).toMatch(/\.assistant-prose\s*\{[\s\S]*?max-width:\s*100%/);
    expect(tokens).not.toMatch(/--grox-prose-max/);
    expect(tokens).not.toMatch(/--grox-assistant-max/);
  });

  it("timeline-turn does not use content-visibility (breaks scroll height)", () => {
    const body = blockFor(".timeline-turn");
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/content-visibility/);
    expect(body).not.toMatch(/contain-intrinsic/);
  });

  it("font tiers only change integer size tokens", () => {
    for (const name of ["sm", "md", "lg", "xl"] as const) {
      const body = blockFor(`html[data-font="${name}"]`);
      expect(body).toMatch(/--grox-prose-size\s*:\s*\d+px/);
      expect(body).not.toMatch(/--grox-content-max/);
      expect(body).not.toMatch(/--grox-turn-gap/);
      expect(body).not.toMatch(/--grox-prose-size\s*:\s*\d+\.\d+px/);
    }
  });
});

describe("layout adaptability — chrome hard rules", () => {
  it("settings shell uses fixed 15px chrome scale", () => {
    const shell = blockFor(".settings-shell");
    expect(shell).toBeTruthy();
    expect(shell).not.toMatch(/--grox-content-max/);
    expect(shell).toMatch(/font-size:\s*15px/);
  });

  it("lbl/chip stay fixed component size", () => {
    expect(tokens).toMatch(/\.lbl,\s*\r?\n\.chip\s*\{[\s\S]*?font-size:\s*var\(--grox-component-font-size/);
  });
});
