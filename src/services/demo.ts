import { addDays } from '../lib/time';
import { type AppContext, requirePermission } from './context';
import { createCategory } from './categories';
import { adjustStock } from './inventory';
import { createCustomer, createSupplier } from './parties';
import { createProduct } from './products';
import { createPurchase } from './purchases';
import { createSale, type CartLine } from './sales';
import type { Product } from './types';

/**
 * Demo data: realistic Cameroonian shop with ~45 days of sales that contain real patterns
 * (cacao sells double on Sundays, soft drinks +30% on weekends, bread in the morning, rice trending up,
 * sardines slowing down). Built with the REAL services, so every rule (ledger, FEFO, sync queue) applies.
 */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Def { name: string; cat: string; unit: string; cost: number; price: number; min: number; daily: number; stock: number }
const DEFS: Def[] = [
  { name: 'Coca-Cola 50cl', cat: 'Boissons', unit: 'btl', cost: 300, price: 500, min: 24, daily: 14, stock: 600 },
  { name: 'Fanta Orange 50cl', cat: 'Boissons', unit: 'btl', cost: 300, price: 500, min: 24, daily: 10, stock: 500 },
  { name: 'Eau minérale 1.5L', cat: 'Boissons', unit: 'btl', cost: 250, price: 400, min: 30, daily: 12, stock: 500 },
  { name: 'Cacao 500g', cat: 'Épicerie', unit: 'boîte', cost: 1800, price: 2500, min: 10, daily: 9, stock: 400 },
  { name: 'Riz parfumé 5kg', cat: 'Épicerie', unit: 'sac', cost: 3800, price: 4500, min: 10, daily: 6, stock: 300 },
  { name: 'Huile Dinor 1L', cat: 'Épicerie', unit: 'btl', cost: 1100, price: 1350, min: 12, daily: 5, stock: 250 },
  { name: 'Sucre 1kg', cat: 'Épicerie', unit: 'kg', cost: 650, price: 800, min: 20, daily: 7, stock: 300 },
  { name: 'Lait concentré Bonnet Rouge', cat: 'Épicerie', unit: 'boîte', cost: 450, price: 600, min: 20, daily: 6, stock: 300 },
  { name: 'Pain de mie', cat: 'Boulangerie', unit: 'pcs', cost: 700, price: 1000, min: 10, daily: 8, stock: 200 },
  { name: 'Baguette', cat: 'Boulangerie', unit: 'pcs', cost: 100, price: 150, min: 30, daily: 22, stock: 700 },
  { name: 'Sardines Titus 125g', cat: 'Épicerie', unit: 'boîte', cost: 350, price: 500, min: 15, daily: 5, stock: 250 },
  { name: 'Savon Azur 200g', cat: 'Entretien', unit: 'pcs', cost: 250, price: 350, min: 15, daily: 4, stock: 200 },
  { name: 'Javel 1L', cat: 'Entretien', unit: 'btl', cost: 500, price: 700, min: 10, daily: 2, stock: 120 },
  { name: 'Yaourt nature', cat: 'Frais', unit: 'pcs', cost: 200, price: 300, min: 12, daily: 5, stock: 40 },
];

export async function seedDemo(ctx: AppContext, opts: { days?: number; onProgress?: (pct: number) => void } = {}) {
  requirePermission(ctx, 'settings.manage');
  const days = opts.days ?? 45;
  const rand = rng(20261009);
  const real = ctx.now();
  const at = (d: Date) => ({ ...ctx, now: () => d });
  const start = addDays(real, -days);
  const c0 = at(new Date(start.getFullYear(), start.getMonth(), start.getDate(), 8, 0));

  const cats = new Map<string, string>();
  for (const name of new Set(DEFS.map((d) => d.cat))) cats.set(name, (await createCategory(c0, name)).id);
  const sup1 = await createSupplier(c0, { name: 'Brasseries du Cameroun', phone: '+237 6 77 00 00 01' });
  const sup2 = await createSupplier(c0, { name: 'Grossiste Mokolo', phone: '+237 6 99 00 00 02' });
  const customers = [await createCustomer(c0, { name: 'Boutique Mama Awa', phone: '+237 6 50 00 00 03', credit_limit: 50000 }),
    await createCustomer(c0, { name: 'Restaurant Le Sahel' }), await createCustomer(c0, { name: 'Jean Mbarga', phone: '+237 6 70 00 00 04' })];

  const products = new Map<string, Product>();
  for (const d of DEFS) {
    products.set(d.name, await createProduct(c0, {
      name: d.name, category_id: cats.get(d.cat), cost_price: d.cost, selling_price: d.price, minimum_stock: d.min, unit: d.unit,
      supplier_id: d.cat === 'Boissons' ? sup1.id : sup2.id, initial_quantity: d.stock,
      sku: d.name.slice(0, 4).toUpperCase().replace(/\W/g, '') + String(products.size + 1).padStart(2, '0'),
    }));
  }

  const isWeekend = (dow: number) => dow === 0 || dow === 6;
  for (let off = -days + 1; off <= 0; off++) {
    const day = addDays(real, off);
    const dow = day.getDay();
    const lines: { p: Product; qty: number; hour: number; minute: number }[] = [];
    for (const d of DEFS) {
      let lambda = d.daily;
      if (['Coca-Cola 50cl', 'Fanta Orange 50cl', 'Eau minérale 1.5L'].includes(d.name) && isWeekend(dow)) lambda *= 1.3;
      if (d.name === 'Cacao 500g' && dow === 0) lambda *= 2;
      if (d.name === 'Riz parfumé 5kg' && off > -8) lambda *= 1.3;               // trending up
      if (d.name === 'Sardines Titus 125g' && off > -15) lambda *= 0.25;          // slowing down
      const units = Math.max(0, Math.round(lambda * (0.75 + rand() * 0.5)));
      let left = units;
      while (left > 0) {
        const qty = Math.min(left, 1 + Math.floor(rand() * 4));
        left -= qty;
        const morning = d.name === 'Baguette' || d.name === 'Pain de mie';
        const hour = morning ? (rand() < 0.75 ? 7 + Math.floor(rand() * 3) : 11 + Math.floor(rand() * 6)) : 9 + Math.floor(rand() * 10);
        lines.push({ p: products.get(d.name)!, qty, hour, minute: Math.floor(rand() * 60) });
      }
    }
    lines.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    let i = 0;
    while (i < lines.length) {
      const n = 1 + Math.floor(rand() * 3);
      const group = lines.slice(i, i + n); i += n;
      const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), group[0].hour, group[0].minute);
      if (off === 0 && when > real) continue; // nothing in the future today
      const cart: CartLine[] = [];
      for (const g of group) if (!cart.some((l) => l.product_id === g.p.id)) cart.push({ product_id: g.p.id, quantity: g.qty });
      const method = rand() < 0.65 ? 'CASH' : rand() < 0.8 ? 'MOBILE_MONEY' : 'CARD';
      const cust = rand() < 0.12 ? customers[Math.floor(rand() * customers.length)].id : null;
      try { await createSale(at(when), { lines: cart, payment_method: method, customer_id: cust }); } catch { /* out of stock: skip ticket */ }
    }
    opts.onProgress?.(Math.round(((off + days) / days) * 100));
  }

  // Current situation: a few alerts to look at.
  const set = async (name: string, qty: number) => adjustStock(ctx, { product_id: products.get(name)!.id, kind: 'SET', quantity: qty, reason: 'Inventaire' });
  await set('Cacao 500g', 12);
  await set('Coca-Cola 50cl', 20);
  await set('Huile Dinor 1L', 0);
  const exp = (n: number) => { const d = addDays(real, n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  await createPurchase(ctx, { supplier_id: sup2.id, lines: [
    { product_id: products.get('Yaourt nature')!.id, quantity: 24, cost_price: 200, expiry_date: exp(5), lot_code: 'YA-0412' },
    { product_id: products.get('Lait concentré Bonnet Rouge')!.id, quantity: 12, cost_price: 450, expiry_date: exp(-2), lot_code: 'LC-0099' },
    { product_id: products.get('Sardines Titus 125g')!.id, quantity: 12, cost_price: 350, expiry_date: exp(20), lot_code: 'SA-1180' },
  ], amount_paid: 3000 });
}
