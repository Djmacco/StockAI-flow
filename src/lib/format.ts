export type Lang = 'fr' | 'en';

export function formatMoney(n: number, lang: Lang = 'fr', withCurrency = true): string {
  const v = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 0 }).format(Math.round(n));
  // Intl uses a narrow no-break space in fr: normalise to a plain no-break space for receipts/printing.
  const s = v.replace(/[\u202f\u00a0]/g, '\u00a0');
  return withCurrency ? `${s}\u00a0FCFA` : s;
}

export function formatQty(n: number, lang: Lang = 'fr'): string {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 3 }).format(n);
}

const frUnder100 = (n: number): string => {
  const one = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
  if (n < 10) return one[n];
  if (n < 17) return ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'][n - 10];
  if (n < 20) return `dix-${one[n - 10]}`;
  if (n < 70) { const tens = ['','','vingt','trente','quarante','cinquante','soixante'][Math.floor(n / 10)]; const u = n % 10; return `${tens}${u === 1 ? ' et un' : u ? `-${one[u]}` : ''}`; }
  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante-${frUnder100(n - 60)}`;
  return n === 80 ? 'quatre-vingts' : `quatre-vingt-${frUnder100(n - 80)}`;
};
const frNumber = (n: number): string => {
  if (n < 100) return frUnder100(n);
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return `${h === 1 ? 'cent' : `${frNumber(h)} cent${r ? '' : 's'}`}${r ? ` ${frUnder100(r)}` : ''}`; }
  if (n < 1_000_000) { const k = Math.floor(n / 1000), r = n % 1000; return `${k === 1 ? 'mille' : `${frNumber(k)} mille`}${r ? ` ${frNumber(r)}` : ''}`; }
  const m = Math.floor(n / 1_000_000), r = n % 1_000_000;
  return `${frNumber(m)} million${m > 1 ? 's' : ''}${r ? ` ${frNumber(r)}` : ''}`;
};
const enUnder100 = (n: number): string => {
  const one = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  return n < 20 ? one[n] : `${['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'][Math.floor(n / 10)]}${n % 10 ? `-${one[n % 10]}` : ''}`;
};
const enNumber = (n: number): string => {
  if (n < 100) return enUnder100(n);
  if (n < 1000) return `${enUnder100(Math.floor(n / 100))} hundred${n % 100 ? ` ${enUnder100(n % 100)}` : ''}`;
  const unit = n >= 1_000_000 ? 1_000_000 : 1000, label = unit === 1_000_000 ? 'million' : 'thousand';
  const q = Math.floor(n / unit), r = n % unit;
  return `${enNumber(q)} ${label}${unit === 1_000_000 && q > 1 ? 's' : ''}${r ? ` ${enNumber(r)}` : ''}`;
};
export function amountInWords(amount: number, lang: Lang): string {
  const n = Math.max(0, Math.min(999_999_999, Math.round(amount)));
  return lang === 'fr' ? frNumber(n) : enNumber(n);
}

export function formatDate(iso: string | null | undefined, lang: Lang = 'fr', withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
