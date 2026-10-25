/** Linear-interpolation resampler (browser/webview audio is often 44.1 or 48 kHz; Whisper wants 16 kHz). */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, input.length - 1), f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/** Float [-1,1] -> 16-bit little-endian PCM bytes (the format the Rust command expects). */
export function floatToPcm16Bytes(f: Float32Array): Uint8Array {
  const out = new Uint8Array(f.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return out;
}

/** Quiet microphones: raise the level (capped gain) so Whisper hears the speech well. */
export function peakNormalize(f: Float32Array, target = 0.7, maxGain = 6): Float32Array {
  let peak = 0;
  for (const v of f) peak = Math.max(peak, Math.abs(v));
  if (peak < 0.005 || peak >= target) return f;
  const g = Math.min(maxGain, target / peak);
  return f.map((v) => v * g);
}

/**
 * Whisper sometimes "hallucinates" captions on near-silence (it was trained on subtitled videos).
 * Those must never reach the assistant as if the person had said them.
 */
const HALLUCINATIONS: RegExp[] = [
  /sous[- ]?titr/i, /amara\.org/i, /merci d['’]avoir (regard|suivi|écout)/i, /merci à tous/i, /à la prochaine/i, /abonnez[- ]vous/i,
  /thanks? (so much )?for (watching|listening)/i, /subtitles? (by|from)/i, /transcribed by/i, /please subscribe/i, /www\.|https?:\/\//i,
];
export function cleanTranscript(raw: string): string {
  let t = raw.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ').replace(/\s+/g, ' ').trim(); // [BLANK_AUDIO], (Musique), *rires*
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (HALLUCINATIONS.some((r) => r.test(t))) return '';
  t = t.replace(/^[\s.,;:!?…-]+|[\s…-]+$/g, '');
  return t;
}

/** A hint that biases Whisper toward the shop's own words (product names, commands). Kept short on purpose. */
export function buildVocabularyPrompt(lang: 'fr' | 'en', names: string[], maxChars = 420): string {
  const head = lang === 'fr' ? 'Assistant de boutique. Commandes : vends, ajoute, retire, stock, prix, achat, FCFA. Produits : ' : 'Shop assistant. Commands: sell, add, remove, stock, price, purchase, FCFA. Products: ';
  let out = head; let first = true;
  for (const n of names) {
    const piece = (first ? '' : ', ') + n.replace(/\s+/g, ' ').trim();
    if ((out + piece).length > maxChars) break;
    out += piece; first = false;
  }
  return first ? head.replace(/ (Produits|Products) : ?$| (Produits|Products): ?$/, '').trim() : out + '.';
}
