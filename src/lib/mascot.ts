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

export function swatch(color: string): string {
  if (color !== "chrome") return MAUS_COLORS[color] ?? MAUS_COLORS.green!;
  return "radial-gradient(circle at 34% 26%, #ffffff 0%, #F1F4F7 20%, #AEB8C3 55%, #66717E 100%)";
}
