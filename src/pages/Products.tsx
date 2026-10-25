import { ArrowUpDown, Image as ImageIcon, Pencil, Plus, SlidersHorizontal, Tags, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Empty, Field, Input, Modal, PageHeader, PageLoader, SearchInput, Select, Textarea, cn, useAction } from '../components/ui';
import { formatMoney, formatQty } from '../lib/format';
import { fileToThumb } from '../lib/image';
import { createCategory, deleteCategory, listCategories, renameCategory } from '../services/categories';
import { adjustStock, type AdjustKind } from '../services/inventory';
import { listSuppliers } from '../services/parties';
import { createProduct, deleteProduct, findByBarcodeOrSku, listProducts, updateProduct, type ProductListItem, type SortKey } from '../services/products';
import { findCatalogProductName } from '../services/barcodeCatalog';
import { useApp, useCan, useCtx } from '../state/app';
import { useDebounced, useLive } from '../state/hooks';

type Status = 'all' | 'low' | 'out' | 'expiring' | 'expired';
const STATUSES: Status[] = ['all', 'low', 'out', 'expiring', 'expired'];

export function StockBadge({ p }: { p: ProductListItem }) {
  const { t } = useTranslation();
  const { lang } = useApp(); const can = useCan();
  if (!can('products.stock.read')) return <span className="text-faint">—</span>;
  if (p.stock_level === 'OUT') return <Badge tone="bad" dot>{t('products.out')}</Badge>;
  if (p.stock_level === 'LOW') return <Badge tone="warn" dot>{t('products.low')} · {formatQty(p.quantity, lang)}</Badge>;
  return <span className="num font-medium">{formatQty(p.quantity, lang)} <span className="text-faint">{p.unit}</span></span>;
}
export function ExpiryBadge({ p }: { p: ProductListItem }) {
  const { t } = useTranslation();
  if (p.expiry_level === 'NONE') return <span className="text-faint">—</span>;
  if (p.expiry_level === 'EXPIRED') return <Badge tone="bad">{t('products.expired')}</Badge>;
  if (p.expiry_level === 'OK') return <span className="text-[12px] text-faint">{p.expiry_date}</span>;
  return <Badge tone={p.expiry_level === 'NOTICE' ? 'neutral' : 'warn'}>{t('products.inDays', { count: p.expiry_days ?? 0 })}</Badge>;
}

export function Products() {
  const { t } = useTranslation();
  const ctx = useCtx(); const can = useCan();
  const { lang, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(''); const dq = useDebounced(search);
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState<Status>((params.get('status') as Status) || 'all');
  const [sort, setSort] = useState<SortKey>('name'); const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [form, setForm] = useState<ProductListItem | 'new' | null>(null);
  const [adjust, setAdjust] = useState<ProductListItem | null>(null);
  const [del, setDel] = useState<ProductListItem | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const [pickAdjust, setPickAdjust] = useState(params.get('adjust') === '1');

  const { data } = useLive((c) => listProducts(c, { search: dq, categoryId: cat || null, status, sort, dir }), [dq, cat, status, sort, dir]);
  const { data: cats } = useLive((c) => listCategories(c));
  useEffect(() => { if (params.get('adjust')) setParams({}, { replace: true }); }, []); // eslint-disable-line
  const doDelete = useAction(async () => { await deleteProduct(ctx, del!.id); toast('success', t('products.deleted')); setDel(null); });
  const th = (k: SortKey, label: string, cls = '') => (
    <th className={cls}><button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => (sort === k ? setDir(dir === 'asc' ? 'desc' : 'asc') : (setSort(k), setDir('asc')))}>{label}<ArrowUpDown className={cn('h-3 w-3', sort === k ? 'text-brand' : 'opacity-40')} /></button></th>
  );

  return (
    <div>
      <PageHeader title={t('products.title')} subtitle={t('products.count', { count: data?.total ?? 0 })}
        actions={<>
          {can('categories.manage') && <Button variant="secondary" icon={<Tags className="h-4 w-4" />} onClick={() => setCatsOpen(true)}>{t('categories.title')}</Button>}
          {can('inventory.adjust') && <Button variant="secondary" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setPickAdjust(true)}>{t('products.adjustStock')}</Button>}
          {can('products.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setForm('new')}>{t('products.new')}</Button>}
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="w-80"><SearchInput value={search} onChange={setSearch} placeholder={t('products.search')} autoFocus /></div>
        <Select className="w-48" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">{t('products.allCategories')}</option>{(cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.product_count})</option>)}</Select>
        <div className="flex gap-1">{STATUSES.filter((s) => can('products.stock.read') || (s !== 'low' && s !== 'out')).map((s) => <button key={s} onClick={() => setStatus(s)} className={cn('rounded-full border px-3 py-1 text-[12px] font-medium', status === s ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface hover:bg-muted')}>{t(`products.filter.${s}`)}</button>)}</div>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : data.items.length === 0 ? <Empty icon={<ImageIcon className="h-8 w-8" />} title={t('products.empty')} hint={t('products.emptyHint')} action={can('products.create') ? <Button onClick={() => setForm('new')} icon={<Plus className="h-4 w-4" />}>{t('products.new')}</Button> : undefined} /> : (
          <div className="max-h-[calc(100vh-290px)] overflow-auto">
            <table className="tbl">
              <thead><tr><th className="w-12" />{th('name', t('products.fields.name'))}<th>{t('products.fields.category')}</th>{can('reports.read') && <th className="r">{t('products.fields.costPrice')}</th>}{th('selling_price', t('products.fields.sellingPrice'), 'text-right')}{can('products.stock.read') && th('quantity', t('products.fields.quantity'))}{th('expiry_date', t('products.fields.expiry'))}<th className="w-28" /></tr></thead>
              <tbody>{data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.image ? <img src={p.image} className="h-9 w-9 rounded object-cover" alt="" /> : <div className="flex h-9 w-9 items-center justify-center rounded bg-muted text-[11px] font-bold text-faint">{p.name.slice(0, 2).toUpperCase()}</div>}</td>
                  <td><div className="font-semibold text-ink">{p.name}</div><div className="font-mono text-[11px] text-faint">{p.sku || p.barcode || ''}</div></td>
                  <td className="text-faint">{p.category_name ?? '—'}</td>
                  {can('reports.read') && <td className="r text-faint">{formatMoney(p.cost_price, lang, false)}</td>}
                  <td className="r font-semibold">{formatMoney(p.selling_price, lang, false)}{p.wholesale_price ? <div className="text-[11px] font-normal text-faint">{t('products.wholesaleShort')} {formatMoney(p.wholesale_price, lang, false)}</div> : null}</td>
                  {can('products.stock.read') && <td><StockBadge p={p} /></td>}<td><ExpiryBadge p={p} /></td>
                  <td><div className="flex justify-end gap-1">
                    {can('inventory.adjust') && <button title={t('products.adjustStock')} onClick={() => setAdjust(p)} className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand"><SlidersHorizontal className="h-3.5 w-3.5" /></button>}
                    {can('products.update') && <button title={t('common.edit')} onClick={() => setForm(p)} className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand"><Pencil className="h-3.5 w-3.5" /></button>}
                    {can('products.delete') && <button title={t('common.delete')} onClick={() => setDel(p)} className="rounded p-1.5 text-faint hover:bg-muted hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div></td>
                </tr>))}</tbody>
            </table>
          </div>)}
      </div>

      {form && <ProductForm product={form === 'new' ? null : form} onClose={() => setForm(null)} />}
      {adjust && <AdjustModal product={adjust} onClose={() => setAdjust(null)} />}
      {pickAdjust && <PickProduct onClose={() => setPickAdjust(false)} onPick={(p) => { setPickAdjust(false); setAdjust(p); }} />}
      {catsOpen && <CategoriesModal onClose={() => setCatsOpen(false)} />}
      <ConfirmDialog open={!!del} danger title={t('products.deleteTitle')} message={t('products.deleteMsg', { name: del?.name })} confirmLabel={t('common.delete')} busy={doDelete.busy} onConfirm={() => doDelete.run()} onCancel={() => setDel(null)} />
    </div>
  );
}

function PickProduct({ onPick, onClose }: { onPick: (p: ProductListItem) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const { data } = useLive((c) => listProducts(c, { search: dq, limit: 8 }), [dq]);
  return (
    <Modal open title={t('products.pickProduct')} onClose={onClose}>
      <SearchInput value={q} onChange={setQ} placeholder={t('products.search')} autoFocus />
      <ul className="mt-3 divide-y divide-line/60">{(data?.items ?? []).map((p) => <li key={p.id}><button className="flex w-full items-center justify-between py-2 text-left text-[13px] hover:bg-muted" onClick={() => onPick(p)}><span>{p.name}</span><StockBadge p={p} /></button></li>)}</ul>
    </Modal>
  );
}

function ProductForm({ product, onClose }: { product: ProductListItem | null; onClose: () => void }) {
  const { t } = useTranslation();
  const ctx = useCtx();
  const toast = useApp((s) => s.toast);
  const { data: cats } = useLive((c) => listCategories(c));
  const { data: sups } = useLive((c) => (c.permissions.has('suppliers.read') ? listSuppliers(c) : Promise.resolve([])));
  const catalogSuggestion = useRef('');
  const [f, setF] = useState({
    name: product?.name ?? '', sku: product?.sku ?? '', barcode: product?.barcode ?? '', category_id: product?.category_id ?? '', description: product?.description ?? '',
    cost_price: String(product?.cost_price ?? ''), selling_price: String(product?.selling_price ?? ''), wholesale_price: product?.wholesale_price != null ? String(product.wholesale_price) : '', minimum_stock: String(product?.minimum_stock ?? 5), unit: product?.unit ?? 'pcs',
    supplier_id: product?.supplier_id ?? '', image: product?.image ?? '', initial_quantity: '', expiry_date: '', lot_code: '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const margin = Number(f.selling_price) > 0 ? Math.round(((Number(f.selling_price) - Number(f.cost_price || 0)) / Number(f.selling_price)) * 100) : 0;
  const wholesale = Number(f.wholesale_price) || 0;
  const wholesaleAbove = wholesale > 0 && wholesale > (Number(f.selling_price) || 0);
  const wholesaleHint = wholesaleAbove ? t('products.wholesaleAbove') : wholesale > 0 && wholesale < (Number(f.cost_price) || 0) ? t('products.wholesaleBelowCost')
    : wholesale > 0 ? t('products.marginHint', { pct: Math.round(((wholesale - (Number(f.cost_price) || 0)) / wholesale) * 100) }) : t('products.wholesaleHint');
  const save = useAction(async () => {
    const input = { name: f.name, sku: f.sku, barcode: f.barcode, category_id: f.category_id || null, description: f.description, cost_price: Number(f.cost_price) || 0,
      selling_price: Number(f.selling_price) || 0, wholesale_price: wholesale > 0 ? wholesale : null, minimum_stock: Number(f.minimum_stock) || 0, unit: f.unit, supplier_id: f.supplier_id || null, image: f.image || null };
    if (product) await updateProduct(ctx, product.id, input);
    else await createProduct(ctx, { ...input, initial_quantity: Number(f.initial_quantity) || 0, expiry_date: f.expiry_date || null, lot_code: f.lot_code || null });
    toast('success', t('products.saved')); onClose();
  });
  return (
    <Modal open wide title={product ? t('products.edit') : t('products.new')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.busy} disabled={!f.name.trim() || wholesaleAbove} onClick={() => save.run()}>{t('common.save')}</Button></>}>
      <div className="grid grid-cols-[120px_1fr] gap-5">
        <div>
          <label className="flex h-[120px] w-[120px] cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-line-strong bg-muted/40 text-center text-[11px] text-faint hover:border-brand">
            {f.image ? <img src={f.image} alt="" className="h-full w-full object-cover" /> : <span className="px-2"><ImageIcon className="mx-auto mb-1 h-6 w-6" />{t('products.addImage')}</span>}
            <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setF({ ...f, image: await fileToThumb(file) }); }} />
          </label>
          {f.image && <button className="mt-1 text-[11px] text-faint hover:text-bad" onClick={() => setF({ ...f, image: '' })}>{t('common.delete')}</button>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('products.fields.name')} required className="col-span-2"><Input autoFocus value={f.name} onChange={set('name')} /></Field>
          <Field label={t('products.fields.sku')}><Input value={f.sku} onChange={set('sku')} /></Field>
          <Field label={t('products.fields.barcode')} hint={t('products.barcodeHint')}><Input value={f.barcode} onChange={(e) => {
            const barcode = e.target.value;
            const suggested = findCatalogProductName(barcode);
            setF((current) => {
              const nameWasSuggested = !!catalogSuggestion.current && current.name === catalogSuggestion.current;
              const canFillName = !current.name.trim() || nameWasSuggested;
              catalogSuggestion.current = suggested && canFillName ? suggested : '';
              return { ...current, barcode, ...(canFillName ? { name: suggested ?? (nameWasSuggested ? '' : current.name) } : {}) };
            });
          }} onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !f.barcode.trim()) return;
            e.preventDefault();
            const existing = await findByBarcodeOrSku(ctx, f.barcode);
            if (!existing) return;
            setF((current) => {
              const canFillName = !current.name.trim() || current.name === catalogSuggestion.current;
              if (!canFillName) return current;
              catalogSuggestion.current = existing.name;
              return { ...current, name: existing.name };
            });
          }} /></Field>
          <Field label={t('products.fields.category')}><Select value={f.category_id} onChange={set('category_id')}><option value="">—</option>{(cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label={t('products.fields.supplier')}><Select value={f.supplier_id} onChange={set('supplier_id')}><option value="">—</option>{(sups ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label={t('products.fields.costPrice')}><Input type="number" min={0} value={f.cost_price} onChange={set('cost_price')} /></Field>
          <Field label={t('products.fields.sellingPrice')} hint={margin ? t('products.marginHint', { pct: margin }) : undefined}><Input type="number" min={0} value={f.selling_price} onChange={set('selling_price')} /></Field>
          <Field label={t('products.fields.wholesalePrice')} hint={wholesaleHint}><Input type="number" min={0} value={f.wholesale_price} onChange={set('wholesale_price')} className={cn(wholesaleAbove && 'border-bad')} /></Field>
          <Field label={t('products.fields.unit')}><Input value={f.unit} onChange={set('unit')} list="units" /><datalist id="units">{['pcs', 'kg', 'g', 'L', 'btl', 'sac', 'carton', 'boîte', 'pack'].map((u) => <option key={u} value={u} />)}</datalist></Field>
          <Field label={t('products.fields.minimumStock')}><Input type="number" min={0} value={f.minimum_stock} onChange={set('minimum_stock')} /></Field>
          {!product && <>
            <Field label={t('products.fields.initialStock')}><Input type="number" min={0} value={f.initial_quantity} onChange={set('initial_quantity')} /></Field>
            <Field label={t('products.fields.expiry')}><Input type="date" value={f.expiry_date} onChange={set('expiry_date')} /></Field>
          </>}
          {product && <div className="col-span-2 rounded border border-line bg-muted/40 p-2.5 text-[12px] text-faint">{t('products.stockEditHint')}</div>}
          <Field label={t('products.fields.description')} className="col-span-2"><Textarea rows={2} value={f.description} onChange={set('description')} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function AdjustModal({ product, onClose }: { product: ProductListItem; onClose: () => void }) {
  const { t } = useTranslation();
  const ctx = useCtx(); const { lang, toast } = useApp();
  const [kind, setKind] = useState<AdjustKind>('ADJUSTMENT_IN');
  const [qty, setQty] = useState(''); const [reason, setReason] = useState(''); const [expiry, setExpiry] = useState('');
  const adding = kind === 'ADJUSTMENT_IN' || kind === 'RETURN';
  const q = Number(qty) || 0;
  const after = kind === 'SET' ? q : adding ? product.quantity + q : product.quantity - q;
  const save = useAction(async () => { await adjustStock(ctx, { product_id: product.id, kind, quantity: q, reason, expiry_date: adding ? expiry || null : null }); toast('success', t('products.adjusted')); onClose(); });
  return (
    <Modal open title={`${t('products.adjustStock')} — ${product.name}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.busy} disabled={kind === 'SET' ? qty === '' : q <= 0 || after < 0} onClick={() => save.run()}>{t('common.confirm')}</Button></>}>
      <div className="space-y-3">
        <div className="rounded border border-line bg-muted/40 p-3 text-[13px]">{t('products.currentStock')}: <b className="num">{formatQty(product.quantity, lang)} {product.unit}</b></div>
        <Field label={t('products.adjust.type')}><Select value={kind} onChange={(e) => setKind(e.target.value as AdjustKind)}>
          {(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGED', 'LOST', 'RETURN', 'SET'] as AdjustKind[]).map((k) => <option key={k} value={k}>{t(`products.adjust.${k}`)}</option>)}</Select></Field>
        <Field label={kind === 'SET' ? t('products.adjust.counted') : t('products.fields.quantity')}><Input autoFocus type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        {adding && <Field label={t('products.fields.expiry')}><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>}
        <Field label={t('products.adjust.reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {qty !== '' && <div className={cn('rounded border p-3 text-[13px]', after < 0 ? 'border-bad/40 bg-bad-soft text-bad-text' : 'border-brand/30 bg-brand-soft text-brand')}>{t('products.adjust.result')}: <b className="num">{formatQty(after, lang)} {product.unit}</b></div>}
      </div>
    </Modal>
  );
}

function CategoriesModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const ctx = useCtx(); const { toast } = useApp();
  const { data: cats } = useLive((c) => listCategories(c));
  const [name, setName] = useState(''); const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [del, setDel] = useState<{ id: string; name: string; count: number } | null>(null); const [repl, setRepl] = useState('');
  const add = useAction(async () => { await createCategory(ctx, name); setName(''); });
  const rename = useAction(async () => { await renameCategory(ctx, edit!.id, edit!.name); setEdit(null); });
  const remove = useAction(async () => { await deleteCategory(ctx, del!.id, del!.count ? (repl === '__none' ? null : repl) : undefined); toast('success', t('categories.deleted')); setDel(null); setRepl(''); });
  return (
    <Modal open wide title={t('categories.title')} onClose={onClose}>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add.run(); }}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('categories.newPlaceholder')} /><Button type="submit" loading={add.busy} disabled={!name.trim()} icon={<Plus className="h-4 w-4" />}>{t('common.add')}</Button></form>
      <ul className="divide-y divide-line/60 rounded border border-line">{(cats ?? []).map((c) => (
        <li key={c.id} className="flex items-center justify-between px-3 py-2 text-[13px]">
          {edit?.id === c.id ? <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); rename.run(); }}><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /><Button size="sm" type="submit">{t('common.save')}</Button></form>
            : <><span className="font-medium text-ink">{c.name} <span className="text-faint">· {t('categories.products', { count: c.product_count })}</span></span>
              <span className="flex gap-1"><button className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand" onClick={() => setEdit({ id: c.id, name: c.name })}><Pencil className="h-3.5 w-3.5" /></button>
                <button className="rounded p-1.5 text-faint hover:bg-muted hover:text-bad" onClick={() => setDel({ id: c.id, name: c.name, count: c.product_count })}><Trash2 className="h-3.5 w-3.5" /></button></span></>}
        </li>))}{cats?.length === 0 && <li className="p-4 text-center text-faint">{t('categories.empty')}</li>}</ul>
      <Modal open={!!del} title={t('categories.deleteTitle', { name: del?.name })} onClose={() => setDel(null)}
        footer={<><Button variant="secondary" onClick={() => setDel(null)}>{t('common.cancel')}</Button><Button variant="danger" loading={remove.busy} disabled={!!del?.count && !repl} onClick={() => remove.run()}>{t('common.delete')}</Button></>}>
        {del?.count ? <div className="space-y-3 text-[13px]"><p>{t('categories.inUse', { count: del.count })}</p>
          <Select value={repl} onChange={(e) => setRepl(e.target.value)}><option value="">{t('categories.chooseReplacement')}</option><option value="__none">{t('categories.uncategorised')}</option>{(cats ?? []).filter((c) => c.id !== del.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div> : <p className="text-[13px]">{t('categories.deleteEmpty')}</p>}
      </Modal>
    </Modal>
  );
}
