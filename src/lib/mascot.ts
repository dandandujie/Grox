export const MAUS_COLORS: Record<string, string> = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  silver: "#A8ADB4",
  chrome: "#B3BAC4",
};

export const COLOR_NAMES: Record<string, string> = {
  green: "Green", blue: "Blue", red: "Red", orange: "Orange", purple: "Purple",
  cyan: "Cyan", pink: "Pink", yellow: "Yellow", teal: "Teal", coral: "Coral",
  silver: "Silver", chrome: "Chrome",
};

export const MASCOT_SHAPES = ["cursor", "blob", "circle", "rounded", "square"] as const;
export type MascotShape = (typeof MASCOT_SHAPES)[number];

export const EXPRESSIONS = [
  "idle", "happy", "curious", "drowsy", "working",
  "thinking", "listening", "sleeping", "suspicious", "proud",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const EXPRESSION_NAMES: Record<string, string> = {
  idle: "Idle", happy: "Happy", curious: "Curious", drowsy: "Drowsy", working: "Working",
  thinking: "Thinking", listening: "Listening", sleeping: "Sleeping", suspicious: "Suspicious", proud: "Proud",
};

export function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const va = (a >> shift) & 0xff;
    const vb = (b >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${[channel(16), channel(8), channel(0)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

export function gradientFor(color: string): [string, string, string] {
  if (color === "chrome") return ["#F1F4F7", "#AEB8C3", "#66717E"];
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green!;
  return [mix(fill, "#ffffff", 0.55), fill, mix(fill, "#000000", 0.42)];
}

export function swatch(color: string): string {
  if (color !== "chrome") return MAUS_COLORS[color] ?? MAUS_COLORS.green!;
  return "radial-gradient(circle at 34% 26%, #ffffff 0%, #F1F4F7 20%, #AEB8C3 55%, #66717E 100%)";
}

export function faceInk(faceColor?: string | null): string | null {
  if (!faceColor) return null;
  return faceColor;
}
