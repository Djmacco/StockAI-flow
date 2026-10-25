import { norm } from '../lib/text';

/**
 * Deterministic FR/EN intent parser. It only ever produces an *intent + arguments*;
 * what happens next is decided by the tool registry (permissions, validation, confirmation).
 * It works offline and never builds SQL.
 */
export type Period = 'today' | 'yesterday' | 'week' | 'month' | 'last_week' | 'last_two_weeks' | 'last_month';
export type Intent =
  | 'SALES_SUMMARY' | 'LIST_SALES' | 'PROFIT' | 'STOCK_OF' | 'LOW_STOCK' | 'EXPIRING' | 'PRICE_OF' | 'BEST_SELLERS'
  | 'INVENTORY_VALUE' | 'SYNC_STATUS' | 'SUBSCRIPTION' | 'INSIGHTS' | 'INSIGHT_WHY' | 'INSIGHT_DAY' | 'INSIGHT_PREPARE'
  | 'CUSTOMER_HISTORY' | 'SUPPLIER_HISTORY'
  | 'ADD_STOCK' | 'REMOVE_STOCK' | 'SET_PRICE' | 'SELL' | 'PURCHASE'
  | 'CONFIRM' | 'CANCEL' | 'HELP' | 'UNKNOWN';

export interface Parsed {
  intent: Intent;
  product?: string;
  quantity?: number;
  price?: number;
  period?: Period;
  fromDate?: string;
  toDate?: string;
  dow?: number; // 0 = Sunday
  name?: string;
  days?: number;
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5, six: 6, sept: 7, seven: 7,
  huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10, douze: 12, twelve: 12, quinze: 15, fifteen: 15, vingt: 20, twenty: 20,
  trente: 30, thirty: 30, quarante: 40, forty: 40, cinquante: 50, fifty: 50, cent: 100, hundred: 100,
};
const DOW: Record<string, number> = {
  dimanche: 0, sunday: 0, lundi: 1, monday: 1, mardi: 2, tuesday: 2, mercredi: 3, wednesday: 3, jeudi: 4, thursday: 4,
  vendredi: 5, friday: 5, samedi: 6, saturday: 6,
};

const N = '(\\d+(?:[.,]\\d+)?)';
const UNITS = '(?:(?:unites?|units?|pieces?|pcs|cartons?|bouteilles?|bottles?|sacs?|bags?|paquets?|packs?|boites?|boxes|kg|litres?|liters?|l)(?![a-z]))';
const ART = '(?:de |d |du |des |de la |de l |of |the |le |la |les |l )?';
const CUR = '(?:cfa|fcfa|xaf|f|francs?)';

/** Digits for number words, thousand separators removed ("2,500" / "2 500" -> 2500). */
function prepare(raw: string): string {
  let s = raw.replace(/[\u202f\u00a0]/g, ' ');
  for (let i = 0; i < 3; i++) s = s.replace(/(\d)[ ,.](\d{3})(?!\d)/g, '$1$2');
  s = norm(s).replace(/\.(?!\d)/g, ' ').replace(/(?<!\d)\./g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').map((w) => (NUMBER_WORDS[w] !== undefined ? String(NUMBER_WORDS[w]) : w)).join(' ');
}

const num = (s: string) => parseFloat(s.replace(',', '.'));

export function cleanProduct(s: string): string {
  let p = s.trim();
  p = p.replace(new RegExp(`^(?:${UNITS}\\s+)`), '');
  p = p.replace(/\b(?:en|to|in|au|dans le|dans mon|from|du|de)\s+(?:mon |le |the |my )?(?:stock|inventaire|inventory)\b/g, '');
  p = p.replace(/\b(?:restants?|restantes?|left|remaining|available|disponibles?|en stock|in stock|please|s il te plait|svp|stp)\b/g, '');
  p = p.replace(/^(?:l |le |la |les |du |des |de |d |the |a |an |of )+/g, '');
  return p.replace(/\s+/g, ' ').trim();
}

function periodOf(s: string, fallback: Period): Period {
  if (/\b(hier|yesterday)\b/.test(s)) return 'yesterday';
  if (/\b(les deux dernieres semaines|deux dernieres semaines|derniere quinzaine|last two weeks|past two weeks|previous two weeks|fortnight|14 derniers jours|last 14 days|past 14 days|previous 14 days|last 2 weeks|past 2 weeks|previous 2 weeks)\b/.test(s)) return 'last_two_weeks';
  if (/\b(semaine derniere|derniere semaine|last week|previous week|past week)\b/.test(s)) return 'last_week';
  if (/\b(mois dernier|dernier mois|last month|previous month|past month)\b/.test(s)) return 'last_month';
  if (/\b(semaine|week(?:ly)?|7 jours|7 days)\b/.test(s)) return 'week';
  if (/\b(mois|month(?:ly)?|30 jours)\b/.test(s)) return 'month';
  if (/\b(aujourd hui|aujourdhui|today|ce jour|ce jourd hui)\b/.test(s)) return 'today';
  return fallback;
}

function parseDateToken(value: string): string | null {
  const parts = value.includes('-') ? value.split('-').map(Number) : value.split(/[/.]/).map(Number).reverse();
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/** Explicit ranges accept ISO dates or day/month/year, e.g. "from 2026-10-01 to 2026-10-14". */
function dateRangeOf(raw: string): Pick<Parsed, 'fromDate' | 'toDate'> | undefined {
  const token = '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{4})';
  const normalized = raw.normalize('NFD').replace(/\p{M}/gu, '');
  const match = normalized.match(new RegExp(`${token}\\s*(?:to|through|until|and|au|a|-)\\s*${token}`, 'i'));
  if (!match) return undefined;
  const fromDate = parseDateToken(match[1]); const toDate = parseDateToken(match[2]);
  return fromDate && toDate && fromDate <= toDate ? { fromDate, toDate } : undefined;
}

function dowOf(s: string): number | undefined {
  for (const w of s.split(' ')) if (DOW[w] !== undefined) return DOW[w];
  return undefined;
}

export function parse(raw: string): Parsed {
  const s = prepare(raw);
  if (!s) return { intent: 'UNKNOWN' };
  const dates = dateRangeOf(raw);

  // ---- yes / no (short replies only, so "annule la vente" style sentences still parse normally)
  if (s.split(' ').length <= 4) {
    if (/^(oui|yes|yep|yeah|ok|okay|confirme|confirmer|confirm|d accord|go|valide|valider|bien sur|sure|c est bon|vas y)\b/.test(s)) return { intent: 'CONFIRM' };
    if (/^(non|no|nope|annule|annuler|cancel|stop|laisse tomber|never mind|pas maintenant|abandon)\b/.test(s)) return { intent: 'CANCEL' };
  }

  let m: RegExpMatchArray | null;

  // ================= WRITE intents =================
  // purchase (checked before add-stock: "enregistre un achat de 50 unites")
  if (/\b(achat|purchase|reception|restock|reapprovisionn\w*)\b/.test(s) && /\b(enregistre|enregistrer|record|saisis|saisir|cree|creer|create|nouvel|nouvelle|new|fais|faire|add|ajoute|ajouter|log)\b/.test(s)) {
    const tail = `(?:\\s+(?:a|at|@)\\s*${N}\\s*${CUR}?(?:\\s*(?:chacun|each|piece|l unite|per unit))?)?`;
    const full = s.match(new RegExp(`\\b(?:de|of|d|for)\\s+${N}\\s*${UNITS}?\\s*${ART}(.+?)${tail}\\s*$`));
    const qOnly = s.match(new RegExp(`\\b(?:de|of|d|for)\\s+${N}\\s*${UNITS}?`)) ?? s.match(new RegExp(`${N}\\s*${UNITS}`));
    const cost = s.match(new RegExp(`\\b(?:a|at|@|cost|cout|prix)\\s*${N}\\s*${CUR}?(?:\\s*(?:chacun|each|piece|unite|per unit))?\\s*$`));
    const q = full ?? qOnly;
    let product = full ? cleanProduct(full[2]) : undefined;
    if (product && /^(?:purchase|achat|units?|unites?|pieces?)$/.test(product)) product = undefined;
    return { intent: 'PURCHASE', quantity: q ? num(q[1]) : undefined, product: product || undefined, price: cost ? num(cost[1]) : undefined };
  }

  if ((m = s.match(new RegExp(`^(?:vends?|vendre|vendu|sell|sold|sale of|vente de|enregistre une vente de|record a sale of|fais une vente de)\\s+${N}\\s*${UNITS}?\\s*${ART}(.+?)(?:\\s+(?:a|at|@)\\s*${N}\\s*${CUR}(?:\\s*(?:chacun|chaque|each|la piece|l unite|per unit|piece|unite))?|\\s+(?:a|at|@)\\s*${N}\\s*(?:chacun|chaque|each|la piece|l unite|per unit|piece|unite))?\\s*$`)))) {
    return { intent: 'SELL', quantity: num(m[1]), product: cleanProduct(m[2]), price: m[3] ? num(m[3]) : m[4] ? num(m[4]) : undefined };
  }

  if ((m = s.match(new RegExp(`^(?:ajoute|ajouter|add|rajoute|augmente|increase|rentre|restock)\\s+${N}\\s*${UNITS}?\\s*${ART}(.+)$`)))) {
    return { intent: 'ADD_STOCK', quantity: num(m[1]), product: cleanProduct(m[2]) };
  }
  if ((m = s.match(new RegExp(`^(?:retire|retirer|enleve|enlever|remove|reduce|diminue|sors|deduct)\\s+${N}\\s*${UNITS}?\\s*${ART}(.+)$`)))) {
    return { intent: 'REMOVE_STOCK', quantity: num(m[1]), product: cleanProduct(m[2]) };
  }
  if ((m = s.match(new RegExp(`(?:change|changer|modifie|modifier|met|mets|mettre|set|update|fixe|fixer)\\s+(?:le\\s+|the\\s+)?(?:prix|price)\\s*(?:de vente\\s*)?${ART}(.+?)\\s+(?:a|to|en|at|=)\\s*${N}\\s*${CUR}?\\s*$`)))) {
    return { intent: 'SET_PRICE', product: cleanProduct(m[1]), price: num(m[2]) };
  }

  // ================= READ intents =================
  if (/\b(insight|insights|conseils?|recommandations?|suggestions?|tendances?|trends?)\b/.test(s) && !/\b(pourquoi|why)\b/.test(s)) return { intent: 'INSIGHTS' };

  if (/\b(pourquoi|why)\b/.test(s) && /\b(recommand\w*|suggest\w*|conseill\w*|more|plus|davantage|augment\w*)\b/.test(s)) {
    const t = s.match(/.*\b(?:plus de|plus d|davantage de|davantage d|more|extra|additional)\s+(.+)$/) ?? s.match(/(?:recommand\w*|suggest\w*|conseill\w*|augment\w*)\s+(?:tu |vous |you )?(?:de |d |du |des |of |the |le |la |les )?(.+)$/);
    return { intent: 'INSIGHT_WHY', product: t ? cleanProduct(t[1]) : undefined };
  }
  if (/\b(que dois je|what should i|quoi)\b.*\b(preparer|prevoir|commander|prepare|stock|order|stocker)\b/.test(s) || /^(prepare|preparer)\b/.test(s)) {
    return { intent: 'INSIGHT_PREPARE', dow: dowOf(s) };
  }
  if (/\b(produits?|products?|articles?)\b/.test(s) && /\b(vendent?|vend|sell|sells|selling)\b/.test(s) && /\b(plus|davantage|more|most|best)\b/.test(s) && dowOf(s) !== undefined) {
    return { intent: 'INSIGHT_DAY', dow: dowOf(s) };
  }

  if (/\b(combien|how much)\b/.test(s) && /\b(vendu|vendus|vente|ventes|vend|sold|sell|sales|sale|encaisse|made|gagne|revenue|chiffre)\b/.test(s)) return { intent: 'SALES_SUMMARY', period: periodOf(s, 'today'), ...dates };
  if (/\b(montre|montrer|affiche|afficher|show|list|liste|voir)\b/.test(s) && /\b(ventes?|sales?)\b/.test(s)) return { intent: 'LIST_SALES', period: periodOf(s, 'today'), ...dates };
  if (/\b(chiffre d affaires?|revenue|turnover)\b/.test(s)) return { intent: 'SALES_SUMMARY', period: periodOf(s, 'today'), ...dates };
  if (/\b(benefices?|profits?|marge|margin|gagne|made)\b/.test(s)) return { intent: 'PROFIT', period: periodOf(s, 'today'), ...dates };
  if (/\b(meilleures? ventes?|plus vendus?|best.?sell\w*|top.?sell\w*|best sellers?|most sold|plus populaires?)\b/.test(s) || /\b(best|top)\b.*\bproducts?\b/.test(s)) return { intent: 'BEST_SELLERS', period: periodOf(s, 'month'), ...dates };
  if (/\b(valeur (?:du )?stock|valeur de l inventaire|stock value|inventory value|worth)\b/.test(s)) return { intent: 'INVENTORY_VALUE' };
  if (/\b(synchro\w*|sync\w*)\b/.test(s)) return { intent: 'SYNC_STATUS' };
  if (/\b(abonnement|premium|subscription)\b/.test(s)) return { intent: 'SUBSCRIPTION' };
  if (/\b(expire\w*|perime\w*|peremption|expiring|expiration|expired|expires)\b/.test(s)) {
    const p = periodOf(s, 'month');
    return { intent: 'EXPIRING', days: /\bsemaine|week\b/.test(s) ? 7 : p === 'today' ? 1 : 30 };
  }
  if (/\b(stock (?:bas|faible|critique|insuffisant)|low stock|low in stock|running low|rupture|manque|presque epuise|epuises?|out of stock|a reapprovisionner|to reorder|bientot en rupture)\b/.test(s)) return { intent: 'LOW_STOCK' };

  if ((m = s.match(/(?:historique|history)\b.*\b(client|customer)s?\s+(.+)$/))) return { intent: 'CUSTOMER_HISTORY', name: m[2].trim() };
  if ((m = s.match(/(?:historique|history)\b.*\b(fournisseur|supplier)s?\s+(.+)$/))) return { intent: 'SUPPLIER_HISTORY', name: m[2].trim() };

  if ((m = s.match(/(?:prix|price)(?: de vente)?\s*(?:de |du |d |des |of |for )?(.+)$/)) || (m = s.match(/combien (?:coute|coutent|vaut)\s+(?:le |la |les |l |un |une )?(.+)$/)) || (m = s.match(/how much (?:is|are|does)\s+(?:the |a |an )?(.+?)(?: cost)?$/))) {
    return { intent: 'PRICE_OF', product: cleanProduct(m[1]) };
  }
  if ((m = s.match(/combien (?:de |d |du |des )?(.+?)\s+(?:reste|restent|il reste|y a t il|avons nous|ai je|en stock|restant|restants)\b/)) ||
      (m = s.match(/how many (.+?)\s+(?:are |do we have |is |do i have |have we )?(?:left|in stock|remaining|available|do we have)/)) ||
      (m = s.match(/(?:check|verifie|verifier|voir|show|quel est le|what is the)\s+(?:the |le |les |l )?(?:stock|inventaire|quantite)\s*(?:de |du |d |des |of |for )?(.+)$/)) ||
      (m = s.match(/(?:check|verifie|verifier)\s+(.+?)\s+stock$/)) ||
      (m = s.match(/(?:stock|quantite)\s+(?:de |du |d |des |of |for )(.+)$/)) ||
      (m = s.match(/^(.+?)\s+en stock\??$/))) {
    return { intent: 'STOCK_OF', product: cleanProduct(m[1]) };
  }
  if (/\b(aide|help|que peux tu|what can you|comment|capabilities)\b/.test(s)) return { intent: 'HELP' };
  return { intent: 'UNKNOWN' };
}

export function detectLang(text: string, fallback: 'fr' | 'en'): 'fr' | 'en' {
  const s = norm(text);
  const fr = (s.match(/\b(le|la|les|de|du|des|combien|quels?|quelle|mon|nos|ajoute|vends|prix|aujourd|hier|semaine|mois|oui|non|stock|produits?|il reste|pourquoi|est ce|je|nous)\b/g) ?? []).length;
  const en = (s.match(/\b(the|of|how|much|many|what|which|our|add|sell|price|today|yesterday|week|month|yes|no|left|products?|why|is|are|we|my|show|check)\b/g) ?? []).length;
  if (fr === en) return fallback;
  return fr > en ? 'fr' : 'en';
}
