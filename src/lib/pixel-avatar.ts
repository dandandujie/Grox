export const AVATAR_SIZE = 32;

type Span = readonly [left: number, right: number];
type Profile = {
  name: string;
  head: "oval" | "square" | "round" | "long";
  hair: keyof typeof hair;
  detail?: "readers" | "frames" | "visor" | "monocle" | "hoops";
  beard?: "mustache" | "trim" | "full";
  clothes: "jacket" | "crew" | "collar";
  expression?: "soft" | "focused";
};

type Canvas = ReturnType<typeof canvas>;
type Draw = (p: Canvas) => void;

function canvas() {
  const pixels = new Uint8Array(AVATAR_SIZE ** 2);
  const span = (y: number, left: number, right = left, color = 1) => {
    for (let x = left; x <= right; x++) pixels[y * AVATAR_SIZE + x] = color;
  };
  const rows = (top: number, shape: readonly Span[], color = 1) =>
    shape.forEach(([left, right], offset) => span(top + offset, left, right, color));
  return { pixels, span, rows };
}

// Silhouettes are ordered row by row from the temple to the chin.
const heads: Record<Profile["head"], readonly Span[]> = {
  oval: [[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[9,22],[9,22],[10,21],[11,20],[12,19],[14,17]],
  square: [[8,24],[8,24],[8,24],[8,24],[8,24],[8,24],[8,24],[8,24],[8,24],[8,24],[9,23],[9,23],[10,22],[11,21],[13,19]],
  round: [[8,23],[8,23],[7,24],[7,24],[7,24],[7,24],[7,24],[7,24],[7,24],[8,23],[8,23],[9,22],[10,21],[11,20],[13,18]],
  long: [[9,23],[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[8,23],[9,23],[9,22],[10,22],[11,21],[12,20],[13,19],[15,18]],
};

const clothes: Record<Profile["clothes"], Draw> = {
  jacket(p) {
    p.rows(26, [[10,21],[8,23],[6,25],[4,27],[3,28],[3,28]]);
    p.rows(26, [[13,18],[13,18],[12,19],[13,18],[14,17],[15,16]], 0);
    p.rows(28, [[15,16],[15,16],[15,16],[15,16]]);
    p.span(29, 9, 10, 0);
    p.span(29, 21, 22, 0);
  },
  crew(p) {
    p.rows(26, [[10,21],[8,23],[6,25],[4,27],[3,28],[3,28]]);
    p.rows(26, [[13,18],[13,18],[14,17]], 0);
    p.rows(29, [[11,12],[13,18]], 0);
    p.span(29, 19, 20, 0);
  },
  collar(p) {
    p.rows(26, [[10,21],[8,23],[6,25],[4,27],[3,28],[3,28]]);
    p.rows(26, [[13,18],[13,18],[14,17],[15,16]], 0);
    p.rows(28, [[10,11],[11,12],[12,13]], 0);
    p.rows(28, [[20,21],[19,20],[18,19]], 0);
  },
};

function face(p: Canvas, shape: Profile["head"]) {
  const outline = heads[shape];
  p.rows(10, outline);
  p.rows(10, outline.slice(0, -1).map(([left, right], row) => {
    const [belowLeft, belowRight] = outline[row + 1]!;
    return [Math.max(left + 1, belowLeft), Math.min(right - 1, belowRight)];
  }), 0);
  const [left, right] = outline[6]!;
  p.rows(16, [[left - 1,left],[left - 2,left],[left - 2,left],[left - 1,left]]);
  p.rows(16, [[right,right + 1],[right,right + 2],[right,right + 2],[right,right + 1]]);
  p.span(17, left - 1, left - 1, 0);
  p.span(17, right + 1, right + 1, 0);
}

const hair = {
  ivy(p) {
    p.rows(4, [[14,20],[11,22],[9,23],[8,24],[7,24],[7,24],[7,23]]);
    p.rows(11, [[7,12],[7,9],[7,9],[7,8],[8,8]]);
    p.rows(11, [[21,24],[22,24],[22,24],[23,24],[23,23]]);
    p.rows(6, [[13,16],[11,13],[10,11]], 0);
    p.span(8, 20, 21, 0);
    p.span(10, 17, 20, 0);
  },
  cap(p) {
    p.rows(5, [[11,20],[9,22],[8,23],[8,23],[7,24],[6,26],[5,27],[5,27]]);
    p.span(9, 9, 22, 0);
    p.span(11, 19, 24, 0);
    p.rows(6, [[13,13],[12,14],[13,13]], 0);
    p.rows(13, [[7,8],[7,8],[8,8]]);
    p.rows(13, [[23,24],[23,24],[23,23]]);
  },
  bob(p) {
    p.rows(4, [[13,18],[10,21],[8,23],[7,24],[6,25],[6,25],[6,25]]);
    p.rows(11, [[6,12],[6,10],[6,9],[6,8],[5,8],[5,8],[5,8],[5,8],[5,8],[5,8],[5,8],[5,9],[5,10],[6,10],[7,10]]);
    p.rows(11, [[20,25],[22,25],[23,25],[23,25],[24,26],[24,26],[24,26],[24,26],[24,26],[24,26],[24,26],[23,26],[22,26],[22,25],[22,24]]);
    p.rows(6, [[14,15],[12,14],[11,12]], 0);
    p.rows(8, [[20,21],[21,22],[22,23]], 0);
  },
  ranger(p) {
    p.rows(4, [[10,12],[9,14],[9,17],[8,22],[8,23],[7,24],[5,26],[4,27],[5,26]]);
    p.rows(4, [[21,22],[19,23]]);
    p.rows(5, [[11,12],[10,13],[10,20],[10,21]], 0);
    p.span(10, 9, 22, 0);
    p.rows(13, [[8,9],[8,9],[8,8]]);
    p.rows(13, [[22,23],[22,23],[23,23]]);
  },
  knit(p) {
    p.rows(4, [[13,18],[11,20],[9,22],[8,23],[7,24],[7,24],[7,24],[7,24],[7,24]]);
    for (const x of [10,14,18,22]) p.span(7, x, x, 0);
    p.span(8, 14, 14, 0); p.span(8, 18, 18, 0);
    p.span(10, 8, 23, 0);
  },
  waves(p) {
    p.rows(4, [[13,19],[10,22],[8,23],[8,24],[7,24],[7,25],[7,25]]);
    p.rows(11, [[7,17],[7,13],[7,11],[7,9],[8,8]]);
    p.rows(11, [[20,25],[22,25],[23,25],[23,24],[24,24]]);
    p.rows(6, [[15,18],[12,15],[10,12]], 0);
    p.span(8, 20, 23, 0);
    p.span(10, 15, 17, 0);
  },
  crop(p) {
    p.rows(6, [[11,21],[9,23],[8,24],[7,24],[7,24],[7,24]]);
    p.span(8, 10, 12, 0);
    p.span(8, 14, 15, 0);
    p.span(8, 18, 19, 0);
    p.span(8, 21, 22, 0);
    p.rows(12, [[7,9],[7,8],[7,8],[8,8]]);
    p.rows(12, [[22,24],[23,24],[23,24],[24,24]]);
  },
  afro(p) {
    p.rows(3, [[13,16],[10,22],[8,24],[7,25],[5,26],[5,27],[4,27],[4,27],[4,27]]);
    p.rows(12, [[4,10],[4,8],[4,8],[4,7],[4,6],[4,6],[4,6],[5,7],[5,7],[6,8],[7,9]]);
    p.rows(12, [[21,27],[23,27],[23,27],[24,27],[25,27],[25,27],[25,27],[24,26],[24,26],[23,25],[22,24]]);
    p.rows(6, [[12,13],[9,11],[8,9]], 0);
    p.span(6, 17, 19, 0);
    p.span(8, 22, 24, 0);
    p.span(10, 6, 7, 0);
  },
  scarf(p) {
    p.rows(3, [[13,18],[11,20],[9,22],[8,23],[7,24],[6,25],[6,25],[5,26],[5,26]]);
    p.rows(12, [[5,10],[5,9],[5,8],[5,8],[5,8],[5,8],[5,8],[4,8],[4,9],[4,9],[4,10],[3,10],[3,11],[4,12],[5,13],[7,14]]);
    p.rows(12, [[21,26],[22,26],[23,26],[23,26],[23,26],[23,26],[23,26],[23,27],[22,27],[22,27],[21,27],[21,28],[20,28],[19,27],[18,26],[17,24]]);
    p.rows(6, [[13,20],[10,13],[9,10],[8,9]], 0);
    p.rows(21, [[6,6],[6,7],[7,7],[7,8],[8,9]], 0);
    p.rows(21, [[25,25],[24,25],[24,24],[23,24],[22,23]], 0);
  },
  bare(p) {
    p.rows(5, [[13,19],[11,12],[9,10],[8,9],[8,8],[8,8],[8,8]]);
    p.rows(6, [[20,21],[22,23],[23,24],[24,24],[24,24],[24,24]]);
  },
  pompadour(p) {
    p.rows(3, [[19,21],[16,23],[12,24],[10,25],[8,25],[7,25],[7,25],[7,24]]);
    p.rows(11, [[7,13],[7,10],[7,9],[8,8]]);
    p.rows(11, [[23,24],[23,24],[23,24],[23,23]]);
    p.rows(6, [[18,22],[14,20],[11,15],[9,10]], 0);
  },
  bun(p) {
    hair.ivy(p);
    p.rows(2, [[14,17],[13,18],[13,18],[14,17]]);
    p.span(3, 15, 16, 0);
  },
  beret(p) {
    p.rows(4, [[13,18],[10,22],[8,24],[7,25],[6,25],[6,25],[6,24],[7,22],[8,18]]);
    p.rows(7, [[12,17],[9,12]], 0);
    p.rows(13, [[8,9],[8,9],[8,8]]);
    p.rows(12, [[22,23],[23,24],[23,24]]);
  },
  headphones(p) {
    hair.crop(p);
    p.rows(5, [[11,20],[9,22],[7,24],[6,7],[6,6],[5,6],[5,5],[5,6]]);
    p.rows(8, [[24,25],[25,25],[25,26],[26,26],[25,26]]);
    p.rows(13, [[4,7],[4,7],[4,7],[4,7],[4,7],[5,7],[5,6]]);
    p.rows(13, [[24,27],[24,27],[24,27],[24,27],[24,27],[24,26],[25,26]]);
    p.span(15, 5, 5, 0); p.span(15, 26, 26, 0);
  },
  puffs(p) {
    hair.afro(p);
    p.rows(5, [[5,6],[4,7],[3,6],[3,6],[3,6],[4,7]]);
    p.rows(5, [[24,26],[24,27],[25,28],[25,28],[24,28],[24,27]]);
    p.span(7, 5, 5, 0); p.span(7, 26, 26, 0);
  },
  braids(p) {
    hair.ivy(p);
    p.rows(15, [[6,8],[6,8],[6,8],[6,7],[6,7],[5,7],[5,7],[5,7],[5,7],[6,7]]);
    p.rows(15, [[23,25],[23,25],[23,25],[24,25],[24,25],[24,26],[24,26],[24,26],[24,26],[24,25]]);
    p.span(20, 6, 6, 0); p.span(20, 25, 25, 0);
  },
  spikes(p) {
    hair.crop(p);
    p.rows(4, [[15,15],[10,10],[9,10],[9,11]]);
    p.rows(4, [[20,20],[15,16],[14,16],[13,17]]);
    p.rows(5, [[24,24],[20,21],[20,24]]);
  },
} satisfies Record<string, Draw>;

const portraits: readonly Profile[] = [
  { name: "Side-part & blazer", head: "oval", hair: "ivy", clothes: "jacket" },
  { name: "Field cap & frames", head: "square", hair: "cap", detail: "frames", clothes: "crew" },
  { name: "Spikes & chin beard", head: "square", hair: "spikes", beard: "trim", clothes: "crew", expression: "focused" },
  { name: "Close cut & collar", head: "square", hair: "crop", clothes: "collar", expression: "focused" },
  { name: "Ranger hat & readers", head: "round", hair: "ranger", detail: "readers", clothes: "jacket" },
  { name: "Close cut & watch glasses", head: "square", hair: "crop", detail: "visor", clothes: "collar" },
  { name: "Afro & hoops", head: "round", hair: "afro", detail: "hoops", clothes: "crew", expression: "soft" },
  { name: "Headscarf & coat", head: "oval", hair: "scarf", clothes: "collar", expression: "soft" },
  { name: "Swept hair & leather jacket", head: "oval", hair: "pompadour", clothes: "collar" },
  { name: "Bob & readers", head: "oval", hair: "bob", detail: "readers", clothes: "jacket", expression: "soft" },
  { name: "Silver sweep & suit", head: "long", hair: "waves", beard: "mustache", clothes: "jacket" },
  { name: "Headphones & crewneck", head: "round", hair: "headphones", clothes: "crew" },
  { name: "Knit cap & work jacket", head: "oval", hair: "knit", clothes: "collar" },
  { name: "Shaved head & full beard", head: "square", hair: "bare", beard: "full", clothes: "crew" },
  { name: "Ribbed cap & scarf", head: "round", hair: "knit", detail: "frames", clothes: "crew" },
  { name: "Topknot & hoops", head: "oval", hair: "bun", detail: "hoops", clothes: "collar", expression: "soft" },
  { name: "Beret & striped collar", head: "long", hair: "beret", clothes: "crew", expression: "soft" },
  { name: "Aviator cap & goggles", head: "square", hair: "cap", detail: "readers", clothes: "collar" },
  { name: "Twin puffs & crewneck", head: "round", hair: "puffs", clothes: "crew", expression: "soft" },
  { name: "Monocle & bow tie", head: "square", hair: "ivy", detail: "monocle", clothes: "jacket", beard: "mustache" },
  { name: "Braids & work shirt", head: "oval", hair: "braids", clothes: "collar", expression: "soft" },
  { name: "Wide curls & moustache", head: "square", hair: "afro", beard: "mustache", clothes: "jacket" },
];

function glasses(p: Canvas, style: Profile["detail"]) {
  if (style === "visor") {
    p.span(15, 9, 22);
    p.span(19, 10, 21);
    for (const x of [9, 22]) p.rows(16, [[x, x],[x, x],[x, x]]);
    return;
  }
  if (style === "readers" || style === "frames" || style === "monocle") {
    const rim: Span = style === "frames" ? [0, 5] : [1, 4];
    for (const x of style === "monocle" ? [17] : [9, 17]) {
      p.span(14, x + rim[0], x + rim[1]);
      p.rows(15, [[x,x],[x,x],[x,x]]);
      p.rows(15, [[x + 5,x + 5],[x + 5,x + 5],[x + 5,x + 5]]);
      p.span(18, x + 1, x + 4);
    }
    if (style !== "monocle") p.span(15, 15, 16);
    else p.rows(19, [[22,22],[23,23],[23,23]]);
  }
}

function features(p: Canvas, profile: Profile) {
  const frames = profile.detail && profile.detail !== "hoops";
  if (!frames || profile.detail === "monocle") {
    p.span(13, 10, 12);
    if (profile.detail !== "monocle") p.span(13, 19, 21);
  }
  if (profile.expression === "focused" && !frames) {
    p.span(14, 13); p.span(14, 18);
  }
  const plainEyes = !frames;
  if (plainEyes || profile.detail === "monocle") {
    p.rows(15, [[10,12],[11,12]]);
  } else {
    p.span(16 + Number(profile.detail === "visor"), 11, 12);
  }
  if (plainEyes) {
    p.rows(15, [[19,21],[19,20]]);
  } else {
    p.span(16 + Number(profile.detail === "visor"), 19, 20);
  }
  p.span(18, 15);
  p.span(19, 15);
  p.span(20, 15, 16);
  p.span(22, profile.expression === "soft" ? 14 : 13, 17);
  if (profile.beard === "mustache") {
    p.span(21, 13, 18);
    p.span(22, 13, 13); p.span(22, 18, 18);
    p.span(22, 14, 17, 0);
    p.span(23, 15, 17);
  } else if (profile.beard === "trim") {
    p.rows(24, [[14,17],[14,17]]);
  } else if (profile.beard === "full") {
    p.rows(21, [[9,10],[9,11],[9,12],[10,13],[11,14]]);
    p.rows(21, [[22,23],[21,23],[20,23],[19,22],[18,21]]);
    p.span(25, 12, 20);
    p.span(24, 15, 17);
  }
  if (profile.detail === "hoops") {
    p.rows(20, [[6,7],[5,5],[6,7]]);
    p.rows(20, [[24,25],[26,26],[24,25]]);
  } else {
    glasses(p, profile.detail);
  }
}

const namedPortraits = new Map([
  ["brody", 0], ["gitscout", 1], ["emaily", 9], ["omiii", 4], ["onyx", 12],
  ["grox", 11], ["launch room", 6],
]);

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function inCircle(x: number, y: number): boolean {
  const radius = AVATAR_SIZE / 2;
  return (x + 0.5 - radius) ** 2 + (y + 0.5 - radius) ** 2 <= radius ** 2;
}

function pixelPath(isFilled: (x: number, y: number) => boolean): string {
  let path = "";
  for (let y = 0; y < AVATAR_SIZE; y++) {
    let start = -1;
    for (let x = 0; x <= AVATAR_SIZE; x++) {
      if (x < AVATAR_SIZE && isFilled(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        path += `M${start} ${y}h${x - start}v1H${start}z`;
        start = -1;
      }
    }
  }
  return path;
}

export const CIRCLE_PATH = pixelPath(inCircle);

const designs = portraits.map((profile) => {
  const p = canvas();
  clothes[profile.clothes](p);
  face(p, profile.head);
  hair[profile.hair](p);
  features(p, profile);
  const paths = [false, true].map((mirrored) =>
    pixelPath((x, y) => inCircle(x, y) && p.pixels[y * AVATAR_SIZE + (mirrored ? AVATAR_SIZE - 1 - x : x)] === 1),
  );
  return { name: profile.name, paths };
});

export function generateAvatar(seed: string): { name: string; path: string } {
  const normalized = seed.trim().toLowerCase();
  const hash = hashSeed(normalized);
  const fixed = namedPortraits.get(normalized);
  const design = designs[fixed ?? hash % designs.length]!;
  const facing = fixed === undefined ? (hash >>> 8) & 1 : 0;
  return { name: design.name, path: design.paths[facing]! };
}
