// Elo-style ratings for races with many players.
export const START_RATING = 1000;

export interface RatedEntry { id: string; rating: number; games: number; rank: number } // rank 1 = best

/** New players move faster, so a new account finds its level in a few matches. */
export const kFactor = (games: number): number => (games < 10 ? 40 : 24);

/**
 * Every player is compared with every other player as if they had raced head to head (higher rank wins),
 * then the result is averaged. With 2 players this is plain Elo; with 10 it is the average of 9 duels.
 * Returns the rating change for each id.
 */
export function computeRatingChanges(entries: RatedEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = entries.length;
  if (n < 2) return out;
  for (const a of entries) {
    let actual = 0, expected = 0;
    for (const b of entries) {
      if (a === b) continue;
      actual += a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      expected += 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    }
    out.set(a.id, Math.round((kFactor(a.games) * (actual - expected)) / (n - 1)));
  }
  return out;
}
