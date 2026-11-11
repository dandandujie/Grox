// Deterministic 1-bit portrait generator for Grox.
//
// The portrait is a stack of independent 32x32 layers. Each layer is stored as
// coordinate sets for black pixels and white pixels; applying a later layer
// overwrites earlier pixels, so white fills can occlude what is beneath.
// The renderer only emits #000000 and #FFFFFF and rasterizes the circular
// background mask on the same grid, avoiding anti-aliased colors.

export const AVATAR_SIZE = 32;

type Cell = 0 | 1 | 2;
type Grid = Cell[][];
export type PixelCoord = readonly [number, number];

export interface AvatarLayer {
  id: string;
  name: string;
  black: PixelCoord[];
  white: PixelCoord[];
}

export interface AvatarOption<T extends string = string> {
  id: T;
  name: string;
  layer: AvatarLayer;
}

const BLACK: Cell = 1;
const WHITE: Cell = 2;

function blank(): Grid {
  return Array.from({ length: AVATAR_SIZE }, () => Array<Cell>(AVATAR_SIZE).fill(0));
}

function put(grid: Grid, x: number, y: number, value: Cell): void {
  if (x < 0 || y < 0 || x >= AVATAR_SIZE || y >= AVATAR_SIZE) return;
  grid[y]![x] = value;
}

function rect(grid: Grid, x0: number, y0: number, x1: number, y1: number, value: Cell): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) put(grid, x, y, value);
  }
}

function ellipse(grid: Grid, cx: number, cy: number, rx: number, ry: number, fill: Cell): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) put(grid, x, y, fill);
    }
  }
}

function outlinedEllipse(grid: Grid, cx: number, cy: number, rx: number, ry: number): void {
  ellipse(grid, cx, cy, rx, ry, BLACK);
  ellipse(grid, cx, cy, Math.max(0.5, rx - 1), Math.max(0.5, ry - 1), WHITE);
}

function line(grid: Grid, x0: number, y0: number, x1: number, y1: number, value: Cell): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    put(grid, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), value);
  }
}

function layerFrom(id: string, name: string, grid: Grid): AvatarLayer {
  const black: PixelCoord[] = [];
  const white: PixelCoord[] = [];
  for (let y = 0; y < AVATAR_SIZE; y += 1) {
    for (let x = 0; x < AVATAR_SIZE; x += 1) {
      if (grid[y]![x] === BLACK) black.push([x, y]);
      else if (grid[y]![x] === WHITE) white.push([x, y]);
    }
  }
  return { id, name, black, white };
}

// ── Base: shoulders, ears, neck, head ─────────────────────────────────────
const base = blank();
for (let y = 25; y < AVATAR_SIZE; y += 1) {
  const spread = Math.round(((y - 25) / 6) * 3);
  for (let x = 7 - spread; x <= 24 + spread; x += 1) put(base, x, y, BLACK);
}
outlinedEllipse(base, 8, 15, 2, 3);
outlinedEllipse(base, 23, 15, 2, 3);
outlinedEllipse(base, 16, 14, 8, 9);
rect(base, 13, 21, 18, 26, WHITE);
rect(base, 12, 22, 12, 26, BLACK);
rect(base, 19, 22, 19, 26, BLACK);
put(base, 15, 17, BLACK);
put(base, 16, 17, BLACK);
export const BASE_LAYER = layerFrom("base", "Base", base);

// ── Hair ──────────────────────────────────────────────────────────────────
function hairBuzz(): AvatarLayer {
  const g = blank();
  for (let y = 4; y <= 8; y += 1) {
    const inset = y === 4 ? 2 : y === 8 ? 1 : 0;
    rect(g, 9 + inset, y, 22 - inset, y, BLACK);
  }
  for (let y = 9; y <= 14; y += 1) {
    put(g, 8, y, BLACK);
    put(g, 23, y, BLACK);
  }
  put(g, 12, 5, WHITE);
  put(g, 13, 5, WHITE);
  put(g, 12, 6, WHITE);
  return layerFrom("buzz", "Buzz cut", g);
}

function hairSidePart(): AvatarLayer {
  const g = blank();
  for (let y = 3; y <= 8; y += 1) {
    rect(g, 8, y, 23, y, BLACK);
  }
  for (let y = 9; y <= 13; y += 1) {
    put(g, 8, y, BLACK);
    put(g, 9, y, BLACK);
    put(g, 22, y, BLACK);
    put(g, 23, y, BLACK);
  }
  // A white parting slices the black cap; the fringe falls to the right.
  line(g, 15, 3, 12, 9, WHITE);
  put(g, 16, 4, WHITE);
  put(g, 14, 5, WHITE);
  put(g, 10, 4, WHITE);
  put(g, 11, 4, WHITE);
  return layerFrom("side-part", "Side part", g);
}

function hairSpiky(): AvatarLayer {
  const g = blank();
  for (let y = 5; y <= 8; y += 1) rect(g, 8, y, 23, y, BLACK);
  const spikes = [7, 11, 15, 19, 23];
  spikes.forEach((x, index) => {
    const top = index % 2 === 0 ? 1 : 2;
    line(g, x, 6, x, top, BLACK);
    line(g, x - 1, 6, x - 1, top + 2, BLACK);
    line(g, x + 1, 6, x + 1, top + 2, BLACK);
  });
  put(g, 13, 5, WHITE);
  put(g, 14, 5, WHITE);
  put(g, 20, 6, WHITE);
  return layerFrom("spiky", "Spiky", g);
}

function hairCap(): AvatarLayer {
  const g = blank();
  for (let y = 3; y <= 7; y += 1) {
    const inset = y === 3 ? 4 : y === 4 ? 2 : 0;
    rect(g, 9 + inset, y, 22 - inset, y, BLACK);
  }
  rect(g, 6, 8, 25, 9, BLACK);
  rect(g, 5, 9, 26, 9, BLACK);
  // White front panel and a small white button.
  rect(g, 11, 5, 17, 7, WHITE);
  put(g, 16, 3, WHITE);
  put(g, 17, 4, WHITE);
  return layerFrom("baseball-cap", "Baseball cap", g);
}

function hairCowboy(): AvatarLayer {
  const g = blank();
  // Crown.
  for (let y = 2; y <= 7; y += 1) {
    const inset = y === 2 ? 4 : y === 3 ? 3 : y === 4 ? 2 : 0;
    rect(g, 11 + inset, y, 20 - inset, y, BLACK);
  }
  // Brim, with upturned ends.
  rect(g, 3, 8, 28, 9, BLACK);
  rect(g, 4, 7, 6, 7, BLACK);
  rect(g, 25, 7, 27, 7, BLACK);
  // White hat band.
  rect(g, 11, 6, 20, 7, WHITE);
  rect(g, 10, 8, 21, 8, BLACK);
  put(g, 12, 4, WHITE);
  put(g, 13, 4, WHITE);
  return layerFrom("cowboy-hat", "Cowboy hat", g);
}

export const HAIR_OPTIONS: AvatarOption[] = [
  { id: "buzz", name: "Buzz cut", layer: hairBuzz() },
  { id: "side-part", name: "Side part", layer: hairSidePart() },
  { id: "spiky", name: "Spiky", layer: hairSpiky() },
  { id: "baseball-cap", name: "Baseball cap", layer: hairCap() },
  { id: "cowboy-hat", name: "Cowboy hat", layer: hairCowboy() },
];

// ── Eyes ──────────────────────────────────────────────────────────────────
function eyesBrow(): AvatarLayer {
  const g = blank();
  rect(g, 9, 10, 14, 11, BLACK);
  rect(g, 17, 10, 22, 11, BLACK);
  rect(g, 10, 12, 14, 14, WHITE);
  rect(g, 17, 12, 21, 14, WHITE);
  put(g, 12, 13, BLACK);
  put(g, 13, 13, BLACK);
  put(g, 19, 13, BLACK);
  put(g, 20, 13, BLACK);
  return layerFrom("thick-brow", "Thick brows", g);
}

function eyesSerious(): AvatarLayer {
  const g = blank();
  line(g, 9, 11, 14, 10, BLACK);
  line(g, 17, 10, 22, 11, BLACK);
  rect(g, 10, 13, 14, 14, BLACK);
  rect(g, 18, 13, 22, 14, BLACK);
  put(g, 11, 13, WHITE);
  put(g, 20, 13, WHITE);
  return layerFrom("serious", "Serious squint", g);
}

function eyesGlasses(): AvatarLayer {
  const g = blank();
  rect(g, 8, 11, 15, 15, BLACK);
  rect(g, 16, 12, 16, 13, BLACK);
  rect(g, 17, 11, 24, 15, BLACK);
  rect(g, 9, 12, 14, 14, WHITE);
  rect(g, 18, 12, 23, 14, WHITE);
  put(g, 12, 13, BLACK);
  put(g, 13, 13, BLACK);
  put(g, 19, 13, BLACK);
  put(g, 20, 13, BLACK);
  rect(g, 6, 12, 7, 13, BLACK);
  rect(g, 25, 12, 26, 13, BLACK);
  return layerFrom("glasses", "Black frame glasses", g);
}

function eyesTactical(): AvatarLayer {
  const g = blank();
  rect(g, 7, 11, 24, 14, BLACK);
  rect(g, 9, 12, 12, 13, WHITE);
  rect(g, 19, 12, 22, 13, WHITE);
  rect(g, 5, 12, 6, 13, BLACK);
  rect(g, 25, 12, 26, 13, BLACK);
  put(g, 10, 13, WHITE);
  put(g, 21, 13, WHITE);
  return layerFrom("tactical", "Tactical shades", g);
}

export const EYES_OPTIONS: AvatarOption[] = [
  { id: "thick-brow", name: "Thick brows", layer: eyesBrow() },
  { id: "serious", name: "Serious squint", layer: eyesSerious() },
  { id: "glasses", name: "Glasses", layer: eyesGlasses() },
  { id: "tactical", name: "Tactical shades", layer: eyesTactical() },
];

// ── Mouth and facial hair ────────────────────────────────────────────────
function mouthNeutral(): AvatarLayer {
  const g = blank();
  rect(g, 14, 20, 18, 20, BLACK);
  put(g, 15, 21, WHITE);
  return layerFrom("neutral", "Neutral mouth", g);
}

function mouthSerious(): AvatarLayer {
  const g = blank();
  rect(g, 13, 20, 19, 20, BLACK);
  put(g, 13, 21, BLACK);
  put(g, 19, 21, BLACK);
  put(g, 15, 20, WHITE);
  put(g, 17, 20, WHITE);
  return layerFrom("serious", "Serious mouth", g);
}

function facialStubble(): AvatarLayer {
  const g = blank();
  rect(g, 14, 20, 18, 20, BLACK);
  const dots: PixelCoord[] = [
    [11, 18], [13, 19], [15, 19], [17, 19], [19, 18], [12, 21], [14, 22], [16, 22], [18, 21], [20, 20],
  ];
  dots.forEach(([x, y]) => put(g, x, y, BLACK));
  put(g, 15, 21, WHITE);
  put(g, 17, 21, WHITE);
  return layerFrom("stubble", "Stubble", g);
}

function facialBeard(): AvatarLayer {
  const g = blank();
  // A short, squared beard around the jaw and chin.
  for (let y = 16; y <= 22; y += 1) {
    const inset = y < 18 ? 2 : 1;
    rect(g, 10 + inset, y, 21 - inset, y, BLACK);
  }
  rect(g, 9, 18, 9, 21, BLACK);
  rect(g, 22, 18, 22, 21, BLACK);
  rect(g, 10, 22, 21, 22, BLACK);
  // White mouth opening, then a black line inside it.
  rect(g, 13, 18, 18, 19, WHITE);
  rect(g, 14, 20, 18, 20, BLACK);
  put(g, 15, 21, WHITE);
  put(g, 17, 21, WHITE);
  return layerFrom("beard", "Short beard", g);
}

export const FACIAL_OPTIONS: AvatarOption[] = [
  { id: "neutral", name: "Neutral", layer: mouthNeutral() },
  { id: "serious", name: "Serious", layer: mouthSerious() },
  { id: "stubble", name: "Stubble", layer: mouthStubble() },
  { id: "beard", name: "Short beard", layer: facialBeard() },
];

function mouthStubble(): AvatarLayer {
  return facialStubble();
}

export function hashSeed(seed: string): number {
  const normalized = (seed || "Grox").trim().toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface GeneratedAvatar {
  seed: string;
  hash: number;
  hair: AvatarOption;
  eyes: AvatarOption;
  facial: AvatarOption;
  pixels: Grid;
}

const cache = new Map<string, GeneratedAvatar>();

export function generateAvatar(seed: string): GeneratedAvatar {
  const normalized = (seed || "Grox").trim() || "Grox";
  const cached = cache.get(normalized);
  if (cached) return cached;
  const hash = hashSeed(normalized);
  const hair = HAIR_OPTIONS[hash % HAIR_OPTIONS.length]!;
  const eyes = EYES_OPTIONS[Math.floor(hash / 7) % EYES_OPTIONS.length]!;
  const facial = FACIAL_OPTIONS[Math.floor(hash / 31) % FACIAL_OPTIONS.length]!;
  const pixels = blank();
  for (const layer of [BASE_LAYER, hair.layer, eyes.layer, facial.layer] as AvatarLayer[]) {
    for (const [x, y] of layer.black) pixels[y]![x] = BLACK;
    for (const [x, y] of layer.white) pixels[y]![x] = WHITE;
  }
  const out: GeneratedAvatar = { seed: normalized, hash, hair, eyes, facial, pixels };
  cache.set(normalized, out);
  return out;
}

export function circleRows(): Array<readonly [number, number]> {
  const rows: Array<readonly [number, number]> = [];
  for (let y = 0; y < AVATAR_SIZE; y += 1) {
    let start = -1;
    let end = -1;
    for (let x = 0; x < AVATAR_SIZE; x += 1) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      if (dx * dx + dy * dy <= 15.5 * 15.5) {
        if (start < 0) start = x;
        end = x;
      }
    }
    if (start >= 0) rows.push([start, end]);
  }
  return rows;
}

export const CIRCLE_ROWS = circleRows();

export function blackPixels(avatar: GeneratedAvatar): PixelCoord[] {
  const result: PixelCoord[] = [];
  for (let y = 0; y < AVATAR_SIZE; y += 1) {
    for (let x = 0; x < AVATAR_SIZE; x += 1) {
      if (avatar.pixels[y]![x] !== BLACK) continue;
      const dx = x - 15.5;
      const dy = y - 15.5;
      if (dx * dx + dy * dy <= 15.5 * 15.5) result.push([x, y]);
    }
  }
  return result;
}

export const CIRCLE_PATH = Array.from({ length: AVATAR_SIZE }, (_, y) => {
  let start = -1;
  let end = -1;
  for (let x = 0; x < AVATAR_SIZE; x += 1) {
    const dx = x - 15.5;
    const dy = y - 15.5;
    if (dx * dx + dy * dy <= 15.5 * 15.5) {
      if (start < 0) start = x;
      end = x;
    }
  }
  if (start < 0) return "";
  return "M" + start + " " + y + "h" + (end - start + 1) + "v1H" + start + "z";
}).join(" ");
