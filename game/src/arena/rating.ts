// Elo ratings for the arena boards. House AI levels have fixed ratings, so beating Gosu is worth the most.

export const START_RATING = 1000;
export const HOUSE_RATING = [800, 1000, 1200, 1400];
export const HOUSE_NAMES = ['Novice', 'Adept', 'Master', 'Gosu'];

export function expected(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

/** Rating change for a player rated `ra` (with `games` played) scoring `score` (1 win, 0 loss) against `rb`. */
export function eloDelta(ra: number, rb: number, score: number, games: number): number {
  const k = games < 10 ? 40 : 24;
  return Math.round(k * (score - expected(ra, rb)));
}
