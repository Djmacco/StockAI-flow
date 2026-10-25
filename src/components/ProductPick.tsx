import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listProducts, type ProductListItem } from '../services/products';
import { useDebounced, useLive } from '../state/hooks';
import { SearchInput } from './ui';

/** Inline product search with a dropdown of matches. */
export function ProductPick({ onPick, placeholder }: { onPick: (p: ProductListItem) => void; placeholder?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState(''); const dq = useDebounced(q, 120);
  const { data } = useLive((c) => (dq.trim() ? listProducts(c, { search: dq, limit: 6 }) : Promise.resolve({ items: [], total: 0 })), [dq]);
  return (
    <div className="relative">
      <SearchInput value={q} onChange={setQ} placeholder={placeholder ?? t('products.search')} />
      {dq.trim() && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded border border-line-strong bg-surface shadow-pop">
          {(data?.items ?? []).map((p) => (
            <li key={p.id}><button className="flex w-full justify-between px-3 py-2 text-left text-[13px] hover:bg-muted" onClick={() => { onPick(p); setQ(''); }}><span>{p.name}</span><span className="text-faint">{p.unit}</span></button></li>))}
          {data && data.items.length === 0 && <li className="px-3 py-2 text-[12px] text-faint">{t('pos.noResults')}</li>}
        </ul>)}
    </div>
  );
}
