/** Deterministic mulberry32 PRNG for reproducible scheduling runs (Req 1.4). */
export interface SeededRng {
  readonly seed: number;
  /** Returns float in [0, 1). */
  next(): number;
  /** Returns integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Returns a new shuffled copy of `items` (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
  /** Picks one random element (throws if empty). */
  pick<T>(items: readonly T[]): T;
}

export function createSeededRng(seed: number): SeededRng {
  let state = (Number.isFinite(seed) ? seed : 1) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (max <= min) return min;
    return min + Math.floor(next() * (max - min + 1));
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  };
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('SeededRng.pick called on empty array');
    return items[Math.floor(next() * items.length)]!;
  };
  return { seed: seed >>> 0, next, int, shuffle, pick };
}
