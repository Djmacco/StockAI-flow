/** Accent- and case-insensitive text normalisation (French friendly). */
export const norm = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s.%]/g, ' ').replace(/\s+/g, ' ').trim();

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity between a query and a candidate name (token-aware, typo tolerant). */
export function similarity(query: string, candidate: string): number {
  const q = norm(query);
  const c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q)) return 0.85 + 0.1 * (q.length / c.length);
  const qt = q.split(' ');
  const ct = c.split(' ');
  let score = 0;
  for (const t of qt) {
    let best = 0;
    for (const u of ct) {
      if (u.startsWith(t) || t.startsWith(u)) best = Math.max(best, 0.9);
      else {
        const d = levenshtein(t, u);
        const s = 1 - d / Math.max(t.length, u.length);
        if (s > best && d <= Math.max(1, Math.floor(t.length / 4))) best = s;
      }
    }
    score += best;
  }
  return (score / qt.length) * 0.8;
}
