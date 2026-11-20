// Worlds and character looks. Everything here is cosmetic: it never changes a position, a score or a rating.
// Items unlock at a PEAK rating (the highest rating an account has reached), so a bad day never takes a reward away.
export type Kind = "world" | "color" | "hat" | "trail";
export interface Item { id: string; name: string; minRating: number }
export interface Look { world: string; color: string; hat: string; trail: string }

export const KINDS: Kind[] = ["world", "color", "hat", "trail"];

export const CATALOG: Record<Kind, Item[]> = {
  world: [
    { id: "dusk", name: "Dusk Hills", minRating: 0 },
    { id: "snow", name: "Snowfield", minRating: 1020 },
    { id: "neon", name: "Neon City", minRating: 1060 },
    { id: "space", name: "Deep Space", minRating: 1120 },
  ],
  color: [
    { id: "lime", name: "Lime", minRating: 0 },
    { id: "aqua", name: "Aqua", minRating: 0 },
    { id: "coral", name: "Coral", minRating: 0 },
    { id: "violet", name: "Violet", minRating: 1030 },
    { id: "amber", name: "Amber", minRating: 1050 },
    { id: "pink", name: "Pink", minRating: 1080 },
    { id: "gold", name: "Gold", minRating: 1150 },
    { id: "rainbow", name: "Rainbow", minRating: 1250 },
  ],
  hat: [
    { id: "none", name: "No hat", minRating: 0 },
    { id: "cap", name: "Cap", minRating: 1030 },
    { id: "headband", name: "Headband", minRating: 1060 },
    { id: "tophat", name: "Top hat", minRating: 1090 },
    { id: "wizard", name: "Wizard hat", minRating: 1130 },
    { id: "halo", name: "Halo", minRating: 1200 },
  ],
  trail: [
    { id: "lines", name: "Speed lines", minRating: 0 },
    { id: "sparkles", name: "Sparkles", minRating: 1040 },
    { id: "flames", name: "Flames", minRating: 1070 },
    { id: "ribbon", name: "Rainbow ribbon", minRating: 1160 },
    { id: "lightning", name: "Lightning", minRating: 1220 },
  ],
};

export const DEFAULT_LOOK: Look = { world: "dusk", color: "lime", hat: "none", trail: "lines" };

const find = (kind: Kind, id: unknown): Item | undefined => CATALOG[kind].find((i) => i.id === id);
export const isUnlocked = (kind: Kind, id: string, peak: number): boolean => (find(kind, id)?.minRating ?? Infinity) <= peak;

/** A look that is safe to use: anything unknown or still locked falls back to the default for that slot. */
export function sanitizeLook(input: unknown, peak: number): Look {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_LOOK };
  for (const k of KINDS) { const id = src[k]; if (typeof id === "string" && isUnlocked(k, id, peak)) out[k] = id; }
  return out;
}

/** For saving a choice: unknown items are a bad request, locked items are refused. */
export function validateLook(input: unknown, peak: number): { ok: true; look: Look } | { ok: false; status: 400 | 403; error: string } {
  if (!input || typeof input !== "object") return { ok: false, status: 400, error: "Choose a world, colour, hat and trail." };
  const src = input as Record<string, unknown>, out = { ...DEFAULT_LOOK };
  for (const k of KINDS) {
    const item = find(k, src[k]);
    if (!item) return { ok: false, status: 400, error: `Unknown ${k}.` };
    if (item.minRating > peak) return { ok: false, status: 403, error: `${item.name} unlocks at rating ${item.minRating}.` };
    out[k] = item.id;
  }
  return { ok: true, look: out };
}

/** The closest reward still to come. */
export function nextUnlock(peak: number): { kind: Kind; id: string; name: string; minRating: number } | null {
  let best: { kind: Kind; id: string; name: string; minRating: number } | null = null;
  for (const k of KINDS) for (const i of CATALOG[k]) if (i.minRating > peak && (!best || i.minRating < best.minRating)) best = { kind: k, id: i.id, name: i.name, minRating: i.minRating };
  return best;
}
