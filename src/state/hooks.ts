import { useCallback, useEffect, useRef, useState } from 'react';
import { dataBus } from '../lib/events';
import type { AppContext } from '../services/context';
import { useApp, useCtx } from './app';

/** Runs `fn` now, whenever `deps` change, and again after ANY committed write (dataBus). */
export function useLive<T>(fn: (ctx: AppContext) => Promise<T>, deps: unknown[] = []) {
  const ctx = useCtx();
  const fail = useApp((s) => s.fail);
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const out = await fnRef.current(ctx);
      if (my === seq.current) { setData(out); setLoading(false); }
    } catch (e) {
      if (my === seq.current) { setLoading(false); fail(e); }
    }
  }, [ctx, fail]);

  useEffect(() => { reload(); }, [reload, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const off = dataBus.subscribe(() => { reload(); });
    return () => { off(); };
  }, [reload]);
  return { data, loading, reload };
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Browser/webview connectivity (navigator.onLine + online/offline events). */
export function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}
