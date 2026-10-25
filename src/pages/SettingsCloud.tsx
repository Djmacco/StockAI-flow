import { Check, CheckCircle2, Cloud, Crown, Lock, RefreshCw, ScanLine, ShieldCheck, Smartphone, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudError, type TrialStatus } from '../cloud/client';
import { beginPayment, getPending, verifyPayment, type Provider } from '../cloud/payment';
import { hasFeature, installToken, PREMIUM_PRICE_XAF } from '../entitlement/entitlement';
import { Badge, Button, Card, Empty, Field, Input, Modal, Pill, Segmented, cn, useAction } from '../components/ui';
import { AppError } from '../lib/errors';
import { formatDate, formatMoney } from '../lib/format';
import { maskCmPhone, normalizeCmPhone } from '../lib/phone';
import { setSetting, getSetting } from '../services/settings';
import { SyncTransportError } from '../sync/protocol';
import { getNetConfig, lanActive } from '../lan/network';
import { restoreLocalVersion } from '../sync/restore';
import { errorText, rt, syncErrorText, useApp, useCan, useCtx } from '../state/app';
import { useLive, useOnline } from '../state/hooks';

// =================================================================== SUBSCRIPTION
const OPERATORS: { id: Provider; label: string; bg: string; fg: string; ring: string }[] = [
  { id: 'MTN_MOMO', label: 'MTN MoMo', bg: '#FFCC00', fg: '#111827', ring: 'ring-[#FFCC00]' },
  { id: 'ORANGE_MONEY', label: 'Orange Money', bg: '#FF7900', fg: '#FFFFFF', ring: 'ring-[#FF7900]' },
];
const WAIT_SECONDS = 180;

export function SubscriptionTab() {
  const { t } = useTranslation(); const can = useCan(); const ctx = useCtx();
  const { lang, entitlement: e, refreshEntitlement, toast } = useApp();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const { data: pending, reload } = useLive(() => getPending(ctx.db));
  const premium = e.state === 'ACTIVE';
  const { data: source } = useLive((c) => getSetting(c.db, 'premium_source'));
  const borrowed = premium && source === 'shared';           // Premium paid by the shop's main PC
  const admin = can('settings.manage');
  const price = formatMoney(PREMIUM_PRICE_XAF, lang);

  const verify = useAction(async () => {
    try {
      const r = await verifyPayment(rt(), pending!.ref);
      await refreshEntitlement(); reload();
      toast(r === 'ACTIVE' ? 'success' : r === 'FAILED' ? 'error' : 'info', t(r === 'ACTIVE' ? 'subscription.activated' : r === 'FAILED' ? 'subscription.paymentFailed' : 'subscription.stillPending'));
    } catch (err) { toast('error', cloudErr(err, lang, t)); }
  });

  const stateTone = premium ? 'ai' : e.state === 'EXPIRED' ? 'warn' : e.state === 'NONE' ? 'neutral' : 'bad';
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[1fr_340px] gap-4">
      <div className="space-y-4">
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Pill tone={stateTone} icon={<Crown className="h-3 w-3" />}>{premium ? t('header.premium') : t('header.free')}</Pill>
                {e.state !== 'NONE' && e.state !== 'ACTIVE' && <Badge tone={e.state === 'EXPIRED' ? 'warn' : 'bad'}>{t(`subscription.state.${e.state}`)}</Badge>}
              </div>
              {premium ? <p className="text-[14px] text-ink">{t('subscription.activeUntil', { date: formatDate(e.expiresAt, lang), days: e.daysLeft })}</p>
                : <p className="max-w-md text-[14px] text-body">{e.state === 'EXPIRED' ? t('subscription.expiredText', { date: formatDate(e.expiresAt, lang) }) : t('subscription.freeText')}</p>}
            </div>
            <div className="text-right"><div className="num font-display text-[30px] font-bold leading-9 text-ink">{price}</div><div className="text-[12px] text-faint">{t('subscription.perMonth')}</div></div>
          </div>

          {borrowed && <p className="mt-4 rounded border border-ok/40 bg-ok-soft p-3 text-[13px] text-ok-text">{t('network.premiumShared', { date: formatDate(e.expiresAt, lang) })}</p>}
          {admin && !borrowed ? (
            <Button size="lg" variant="ai" className="mt-5 w-full" icon={<Crown className="h-5 w-5" />} onClick={() => setOpen(true)}>
              {premium || e.state === 'EXPIRED' ? t('subscription.renewBtn', { price }) : t('subscription.subscribeBtn', { price })}
            </Button>
          ) : !borrowed && <p className="mt-4 text-[13px] text-faint">{t('subscription.adminOnly')}</p>}

          {pending && admin && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-warn-text">
              <span>{t('subscription.pendingFound')}</span>
              <Button size="sm" variant="secondary" loading={verify.busy} onClick={() => verify.run()} disabled={!online}>{t('subscription.checkPayment')}</Button>
            </div>)}
          <p className="mt-4 flex items-start gap-2 rounded border border-ok/30 bg-ok-soft p-2.5 text-[12px] text-ok-text"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />{t('subscription.dataSafe')}</p>
        </Card>

        <div className="grid grid-cols-2 gap-4">
          <Card title={t('subscription.freeIncludes')}><ul className="space-y-1.5 text-[13px]">{['inv', 'pos', 'purchases', 'customers', 'expiry', 'reports', 'ai', 'voice', 'roles', 'offline'].map((k) => <li key={k} className="flex items-center gap-2"><Check className="h-3.5 w-3.5 shrink-0 text-ok" />{t(`subscription.free.${k}`)}</li>)}</ul></Card>
          <Card title={<span className="flex items-center gap-2 text-ai-text"><Crown className="h-4 w-4" />{t('subscription.premiumIncludes')}</span>} className="border-ai/40">
            <ul className="space-y-3 text-[13px]">
              <li className="flex gap-2"><Cloud className="mt-0.5 h-4 w-4 shrink-0 text-ai" /><div><b>{t('subscription.cloudSync')}</b><div className="text-faint">{t('subscription.cloudSyncText')}</div></div>{hasFeature(e, 'CLOUD_SYNC') && <Check className="ml-auto h-4 w-4 shrink-0 text-ok" />}</li>
              <li className="flex gap-2"><ScanLine className="mt-0.5 h-4 w-4 shrink-0 text-ai" /><div><b>{t('subscription.storeScan')}</b><div className="text-faint">{t('subscription.storeScanText')}</div></div>{hasFeature(e, 'AI_STORE_SCAN') && <Check className="ml-auto h-4 w-4 shrink-0 text-ok" />}</li>
            </ul>
            <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 text-[11px] text-faint"><WifiOff className="h-3.5 w-3.5" />{t('subscription.needsInternet')}</p>
          </Card>
        </div>
      </div>

      <div className="space-y-4">
        <Card title={t('subscription.howTitle')}>
          <ol className="space-y-3 text-[13px]">{[1, 2, 3].map((n) => (
            <li key={n} className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ai-soft text-[12px] font-bold text-ai-text">{n}</span><span>{t(`subscription.how${n}`)}</span></li>))}</ol>
        </Card>
        <AdvancedServer />
        <DevToken />
      </div>

      {open && <PaymentModal onClose={() => { setOpen(false); reload(); }} />}
    </div>
  );
}

const cloudErr = (err: unknown, lang: 'fr' | 'en', t: (k: string, o?: any) => string) =>
  err instanceof CloudError ? t(`subscription.err.${err.kind}`) : errorText(err, lang);

/** The pop-up payment page: operator -> phone -> prompt on the phone -> PIN -> activation. Needs internet. */
function PaymentModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { lang, refreshEntitlement, toast } = useApp();
  const online = useOnline();
  const { data: serverUp } = useLive(() => rt().cloud.isConfigured());
  const [step, setStep] = useState<'form' | 'waiting' | 'success' | 'failed'>('form');
  const [provider, setProvider] = useState<Provider>('MTN_MOMO');
  const [phone, setPhone] = useState('');
  const [ref, setRef] = useState<string | null>(null);
  const [hint, setHint] = useState<string | undefined>();
  const [left, setLeft] = useState(WAIT_SECONDS);
  const [until, setUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const price = formatMoney(PREMIUM_PRICE_XAF, lang);
  const normalized = normalizeCmPhone(phone);
  const stop = () => { if (timer.current) clearInterval(timer.current); if (tick.current) clearInterval(tick.current); timer.current = tick.current = null; };
  useEffect(() => stop, []);

  const check = async (reference: string): Promise<boolean> => {
    const r = await verifyPayment(rt(), reference);
    if (r === 'ACTIVE') { stop(); await refreshEntitlement(); setUntil(useApp.getState().entitlement.expiresAt); setStep('success'); return true; }
    if (r === 'FAILED') { stop(); setError(t('subscription.paymentFailed')); setStep('failed'); return true; }
    return false;
  };
  const startWaiting = (reference: string) => {
    stop(); setLeft(WAIT_SECONDS); const started = Date.now();
    tick.current = setInterval(() => setLeft(Math.max(0, WAIT_SECONDS - Math.round((Date.now() - started) / 1000))), 1000);
    timer.current = setInterval(async () => {
      try { if (await check(reference)) return; } catch { /* offline for a moment: keep waiting */ }
      if (Date.now() - started > WAIT_SECONDS * 1000) { stop(); setError(t('subscription.timedOut')); setStep('failed'); }
    }, 4000);
  };

  const pay = useAction(async () => {
    setError(null);
    try {
      const r = await beginPayment(rt(), provider, phone);
      setRef(r.reference); setHint(r.message); setStep('waiting'); startWaiting(r.reference);
    } catch (err) {
      if (err instanceof AppError) toast('error', errorText(err, lang));
      else toast('error', cloudErr(err, lang, t));
    }
  });
  const manual = useAction(async () => { try { if (ref && !(await check(ref))) toast('info', t('subscription.stillPending')); } catch (err) { toast('error', cloudErr(err, lang, t)); } });
  const close = () => { if (step === 'waiting') stop(); onClose(); };
  const mm = String(Math.floor(left / 60)).padStart(1, '0'), ss = String(left % 60).padStart(2, '0');

  return (
    <Modal open wide title={<span className="flex items-center gap-2"><Crown className="h-5 w-5 text-ai" />{t('subscription.payTitle')}</span>} onClose={close}
      footer={step === 'form' ? <><Button variant="secondary" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="ai" size="lg" loading={pay.busy} disabled={!online || !normalized || serverUp === false} onClick={() => pay.run()}>{t('subscription.pay', { price })}</Button></>
        : step === 'waiting' ? <><Button variant="secondary" onClick={close}>{t('subscription.closeWaiting')}</Button><Button variant="ai" loading={manual.busy} onClick={() => manual.run()}>{t('subscription.checkPayment')}</Button></>
        : step === 'success' ? <Button onClick={close}>{t('common.close')}</Button>
        : <><Button variant="secondary" onClick={close}>{t('common.close')}</Button><Button variant="ai" onClick={() => { setStep('form'); setError(null); }}>{t('subscription.retry')}</Button></>}>

      {step === 'form' && (
        <div className="space-y-5">
          {!online && <div className="flex items-center gap-2 rounded border border-warn/40 bg-warn-soft p-3 text-[13px] text-warn-text"><WifiOff className="h-4 w-4 shrink-0" />{t('subscription.offlineBlock')}</div>}
          {online && serverUp === false && <div className="flex items-center gap-2 rounded border border-line-strong bg-muted p-3 text-[13px] text-body"><Cloud className="h-4 w-4 shrink-0" />{t('subscription.noServerNotice')}</div>}
          <div className="flex items-center justify-between rounded-lg border border-line bg-muted/40 p-4">
            <div><div className="font-display text-[16px] font-semibold text-ink">{t('subscription.planName')}</div><div className="text-[12px] text-faint">{t('subscription.planDetail')}</div></div>
            <div className="text-right"><div className="num font-display text-[24px] font-bold text-ink">{price}</div><div className="text-[11px] text-faint">{t('subscription.perMonth')}</div></div>
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-body">{t('subscription.chooseOperator')}</div>
            <div className="grid grid-cols-2 gap-3">{OPERATORS.map((o) => (
              <button key={o.id} onClick={() => setProvider(o.id)} aria-pressed={provider === o.id}
                className={cn('relative flex h-20 items-center justify-center gap-2 rounded-lg text-[16px] font-bold shadow-card transition', provider === o.id ? `ring-4 ${o.ring}/40 scale-[1.02]` : 'opacity-60 hover:opacity-100')} style={{ background: o.bg, color: o.fg }}>
                <Smartphone className="h-5 w-5" />{o.label}{provider === o.id && <CheckCircle2 className="absolute right-2 top-2 h-5 w-5" />}</button>))}</div>
          </div>
          <Field label={t('subscription.phone')} hint={phone && !normalized ? t('errors.invalidPhone') : t('subscription.phoneHint')}>
            <div className="flex"><span className="flex h-9 items-center rounded-l border border-r-0 border-line-strong bg-muted px-3 text-[13px] font-medium text-body">+237</span>
              <Input autoFocus inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="6 XX XX XX XX" className="!rounded-l-none" /></div>
          </Field>
          <p className="flex items-start gap-2 text-[11px] text-faint"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('subscription.verifyNote')}</p>
        </div>)}

      {step === 'waiting' && (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="relative flex h-24 w-24 items-center justify-center"><span className="orb-ripple absolute h-24 w-24 rounded-full border-2 border-ai/60" /><span className="orb-ripple absolute h-24 w-24 rounded-full border-2 border-ai/60" style={{ animationDelay: '0.8s' }} />
            <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-ai to-brand text-white"><Smartphone className="h-9 w-9" /></span></div>
          <div className="font-display text-[20px] font-semibold text-ink">{t('subscription.waitingTitle')}</div>
          <p className="max-w-sm text-[14px] text-body">{hint ?? t('subscription.confirmOnPhone', { phone: normalized ? maskCmPhone(normalized) : '', operator: OPERATORS.find((o) => o.id === provider)?.label })}</p>
          <div className="num font-mono text-[22px] font-semibold text-ai-text">{mm}:{ss}</div>
          <div className="flex items-center gap-2 text-[12px] text-faint"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{t('subscription.autoCheck')}</div>
          {ref && <div className="font-mono text-[11px] text-faint">ref: {ref}</div>}
        </div>)}

      {step === 'success' && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-ok-soft text-ok"><CheckCircle2 className="h-12 w-12" /></div>
          <div className="font-display text-[22px] font-bold text-ink">{t('subscription.activated')}</div>
          <p className="text-[14px] text-body">{t('subscription.activeUntilShort', { date: formatDate(until, lang) })}</p>
        </div>)}

      {step === 'failed' && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-bad-soft text-bad-text"><WifiOff className="h-8 w-8" /></div>
          <div className="font-display text-[18px] font-semibold text-ink">{error}</div>
          <p className="max-w-sm text-[13px] text-faint">{t('subscription.failedHelp')}</p>
        </div>)}
    </Modal>
  );
}

/** Developer-only: where the online backend lives. Hidden in release builds (the address is baked in via VITE_CLOUD_API_URL). */
function AdvancedServer() {
  const { t } = useTranslation(); const ctx = useCtx(); const { refreshSettings } = useApp(); const can = useCan();
  const { data, reload } = useLive(async () => ({ url: await rt().cloud.baseUrl() }));
  const [url, setUrl] = useState('');
  const save = useAction(async () => { await setSetting(ctx.db, 'cloud_api_url', url.trim()); await refreshSettings(); reload(); });
  if (!import.meta.env.DEV || !can('settings.manage')) return null;
  return (
    <details className="rounded-lg border border-line bg-surface shadow-card">
      <summary className="cursor-pointer px-4 py-2.5 font-display text-[14px] font-semibold text-ink">{t('subscription.server')}</summary>
      <div className="space-y-2 border-t border-line p-4">
        <p className="text-[12px] text-faint">{t('subscription.serverExplain')}</p>
        <p className="text-[12px] font-medium text-body">{data?.url ? data.url : t('subscription.noBackend')}</p>
        <div className="flex gap-2"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com" /><Button variant="secondary" disabled={!url.trim()} loading={save.busy} onClick={() => save.run()}>{t('common.save')}</Button></div>
      </div>
    </details>
  );
}

/** Development helper (never in production builds): paste a certificate signed with the dev tool. */
function DevToken() {
  const ctx = useCtx(); const { refreshEntitlement, toast } = useApp();
  const [token, setToken] = useState('');
  const act = useAction(async () => { try { await installToken(ctx.db, token, rt().deviceId, new Date()); await refreshEntitlement(); setToken(''); toast('success', 'OK'); } catch (e: any) { toast('error', String(e?.message ?? e)); } });
  if (!import.meta.env.DEV) return null;
  return (
    <Card title="DEV · certificate"><textarea value={token} onChange={(e) => setToken(e.target.value)} rows={3} className="w-full rounded border border-line-strong bg-surface p-2 font-mono text-[11px]" placeholder="eyJ…" />
      <Button size="sm" variant="secondary" className="mt-2" disabled={!token.trim()} loading={act.busy} onClick={() => act.run()}>Install</Button>
      <p className="mt-1 text-[11px] text-faint">Visible only in development builds. <code>npm run dev:entitlement</code></p>
      <p className="mt-1 break-all font-mono text-[10px] text-faint">device: {rt().deviceId}</p></Card>
  );
}

const syncMsg = (e: unknown, t: (k: string, o?: any) => string) => {
  const kind = e instanceof CloudError || e instanceof SyncTransportError ? e.kind : null;
  return kind ? t(`subscription.err.${kind}`) : t('errors.unexpected');
};

/** FREE restore: download everything from the cloud account into this PC. Never uploads; no subscription needed. */
function RestoreCard() {
  const { t } = useTranslation(); const { toast } = useApp();
  const { data: cfg } = useLive(async () => ({ session: await rt().cloud.getSession() }));
  const online = useOnline();
  const [ask, setAsk] = useState(false); const [count, setCount] = useState(0);
  const act = useAction(async () => {
    setCount(0);
    try {
      const r = await rt().sync.restoreFromCloud({ full: true, onProgress: setCount });
      await useApp.getState().refreshSettings();
      toast('success', t('restore.done', { count: r.pulled }));
    } catch (e) { toast('error', syncMsg(e, t)); }
    setAsk(false);
  });
  return (
    <Card title={<span className="flex items-center gap-2"><Cloud className="h-4 w-4" />{t('restore.cardTitle')}</span>}
      actions={<Button size="sm" variant="secondary" disabled={!cfg?.session || !online} onClick={() => setAsk(true)}>{t('restore.cardBtn')}</Button>}>
      <p className="text-[13px] text-body">{t('restore.cardText')}</p>
      <p className="mt-1 text-[12px] text-faint">{cfg?.session ? t('restore.free') : t('restore.needAccount')}</p>
      <Modal open={ask} title={t('restore.cardTitle')} onClose={() => !act.busy && setAsk(false)}
        footer={<><Button variant="secondary" disabled={act.busy} onClick={() => setAsk(false)}>{t('common.cancel')}</Button><Button loading={act.busy} onClick={() => act.run()}>{act.busy ? t('restore.running', { count }) : t('restore.cardConfirm')}</Button></>}>
        <p className="text-[13px] text-body">{t('restore.cardConfirmText')}</p>
      </Modal>
    </Card>
  );
}

/** Cloud account: needed for Cloud Sync and for restoring (the subscription itself needs none). */
function CloudAccountCard() {
  const { t } = useTranslation(); const { toast } = useApp();
  const cloud = rt().cloud;
  const { data: cfg, reload } = useLive(async () => ({ url: await cloud.baseUrl(), session: await cloud.getSession() }));
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [name, setName] = useState('');
  const auth = useAction(async () => {
    try {
      const dev = `${navigator.platform || 'desktop'}`;
      if (mode === 'login') await cloud.login(email, pw, dev); else await cloud.register(email, pw, name, dev);
      setPw(''); reload(); await useApp.getState().renewOnline(); toast('success', t('subscription.signedIn'));
    } catch (err) { toast('error', err instanceof CloudError ? t(`subscription.err.${err.kind}`) : t('errors.unexpected')); }
  });
  if (!cfg) return null;
  if (cfg.session) return (
    <Card title={t('sync.account')}><div className="flex items-center justify-between text-[13px]"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-ok" />{cfg.session.email}</span>
      <button className="text-[12px] text-faint hover:text-bad" onClick={async () => { await cloud.signOut(); reload(); }}>{t('subscription.signOut')}</button></div></Card>);
  return (
    <Card title={t('sync.account')}>
      <p className="mb-3 text-[12px] text-faint">{t('sync.accountHint')}</p>
      <form className="grid max-w-md gap-3" onSubmit={(x) => { x.preventDefault(); auth.run(); }}>
        <Segmented options={[{ id: 'login', label: t('subscription.signIn') }, { id: 'register', label: t('subscription.createAccount') }]} value={mode} onChange={setMode} />
        {mode === 'register' && <Field label={t('auth.fullName')}><Input value={name} onChange={(x) => setName(x.target.value)} /></Field>}
        <Field label="Email"><Input type="email" value={email} onChange={(x) => setEmail(x.target.value)} /></Field>
        <Field label={t('auth.password')}><Input type="password" value={pw} onChange={(x) => setPw(x.target.value)} /></Field>
        <Button type="submit" loading={auth.busy} disabled={!email || !pw || !cfg.url}>{mode === 'login' ? t('subscription.signIn') : t('subscription.createAccount')}</Button>
      </form>
    </Card>
  );
}

// =================================================================== SYNC
export function SyncTab() {
  const { t } = useTranslation(); const ctx = useCtx(); const can = useCan();
  const { lang, entitlement: e, sync, toast, refreshSync } = useApp();
  const cloud = rt().cloud; const engine = rt().sync;
  const { data: cfg } = useLive(async () => ({ url: await cloud.baseUrl(), session: await cloud.getSession() }));
  const [trial, setTrial] = useState<TrialStatus | null>(null);
  const [clock, setClock] = useState(Date.now());
  const refreshTrial = async () => {
    if (!cfg?.session || !cfg.url) { setTrial(null); return; }
    try { setTrial(await cloud.trialStatus()); } catch { setTrial(null); }
  };
  useEffect(() => { void refreshTrial(); }, [cfg?.session?.accessToken, cfg?.url]);
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(id); }, []);
  const { data: conflicts, reload } = useLive(() => engine.listConflicts());
  const now = useAction(async () => { const r = await engine.syncNow(); await refreshSync(); toast(r.failed ? 'error' : 'success', t('sync.report', { pushed: r.pushed, pulled: r.pulled })); });
  const retry = useAction(async () => { await engine.retryFailed(); await refreshSync(); });
  const { data: net } = useLive((c) => getNetConfig(c.db));
  const lan = !!net && lanActive(net);               // syncing with the main PC of the shop: no subscription involved
  const trialActive = !!trial?.sync.expiresAt && Date.parse(trial.sync.expiresAt) > clock;
  const premium = hasFeature(e, 'CLOUD_SYNC') || lan || trialActive;
  const manage = can('sync.manage');
  const stateLabel = !premium ? t('sync.state.DISABLED') : t(`sync.state.${sync?.state ?? 'IDLE'}`);
  const startTrial = useAction(async () => {
    try {
      const r = await cloud.startSyncTrial();
      if (r.expiresAt) await setSetting(ctx.db, 'cloud_sync_trial_expires_at', r.expiresAt);
      setTrial(await cloud.trialStatus());
      const report = await engine.syncNow();
      await refreshSync();
      if ((await getNetConfig(ctx.db)).mode === 'host') await rt().backup?.run();
      toast(report.failed ? 'error' : 'success', report.failed ? t('sync.trialFailed') : t('sync.trialStarted'));
    } catch (err) { toast('error', cloudErr(err, lang, t)); }
  });
  return (
    <div className="space-y-4">
      {lan && <Card className="border-ok/40 bg-ok-soft"><p className="text-[13px] text-ok-text">{t('network.syncInfo')}</p></Card>}
      {!premium && <Card className="border-ai/40 bg-ai-soft"><div className="flex items-center gap-3"><Lock className="h-5 w-5 text-ai-text" /><div className="flex-1"><div className="font-semibold text-ai-text">{t('sync.premiumOnly')}</div><p className="text-[12px] text-body">{t('sync.premiumOnlyText')}</p></div></div></Card>}
      {!premium && !lan && manage && cfg?.session && trial?.sync.available && <Card className="border-ok/40 bg-ok-soft"><div className="flex items-center gap-3"><Cloud className="h-5 w-5 text-ok-text" /><div className="flex-1"><div className="font-semibold text-ok-text">{t('sync.trialTitle')}</div><p className="text-[12px] text-body">{t('sync.trialText')}</p></div><Button loading={startTrial.busy} onClick={() => startTrial.run()}>{t('sync.trialButton')}</Button></div></Card>}
      <div className="grid grid-cols-4 gap-4">
        {[[t('common.status'), stateLabel], [t('sync.pending'), String(sync?.pending ?? 0)], [t('sync.failed'), String(sync?.failed ?? 0)], [t('sync.lastSync'), sync?.lastSyncAt ? formatDate(sync.lastSyncAt, lang, true) : '—']].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-surface p-4 shadow-card"><div className="text-[11px] font-semibold uppercase tracking-wide text-faint">{k}</div><div className="num font-display text-[18px] font-bold text-ink">{v}</div></div>))}
      </div>
      {sync?.lastError && premium && <div className="rounded border border-bad/30 bg-bad-soft p-3 text-[12px] text-bad-text">{t('sync.lastError')}: {syncErrorText(sync.lastError, lang, lan)}<div className="mt-1 text-faint">{t('sync.dataSafe')}</div></div>}
      {manage && premium && <div className="flex gap-2"><Button icon={<RefreshCw className="h-4 w-4" />} loading={now.busy} onClick={() => now.run()} disabled={!cfg?.session && !lan}>{t('sync.now')}</Button>{(sync?.failed ?? 0) > 0 && <Button variant="secondary" loading={retry.busy} onClick={() => retry.run()}>{t('sync.retry')}</Button>}
        {!cfg?.session && !lan && <span className="self-center text-[12px] text-warn-text">{t('sync.needAccount')}</span>}</div>}
      {manage && net?.mode !== 'client' && <CloudAccountCard />}
      {manage && !lan && <RestoreCard />}
      <Card title={`${t('sync.conflicts')} (${conflicts?.length ?? 0})`} bodyClass="!p-0">
        <p className="px-4 pt-3 text-[12px] text-faint">{t('sync.conflictsHint')}</p>
        {!conflicts || conflicts.length === 0 ? <Empty title={t('sync.noConflicts')} /> : (
          <table className="tbl mt-2"><thead><tr><th>{t('common.date')}</th><th>{t('settings.entity')}</th><th>{t('sync.resolution')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>{conflicts.map((c: any) => <tr key={c.id}><td className="text-faint">{formatDate(c.detected_at, lang, true)}</td><td>{c.entity_type}</td><td><Badge>{t(`sync.res.${c.auto_resolution}`)}</Badge></td><td>{c.status === 'OPEN' ? <Badge tone="warn">{t('sync.open')}</Badge> : <Badge tone="ok">{t('sync.reviewed')}</Badge>}</td>
              <td className="text-right">{c.status === 'OPEN' && manage && <span className="flex justify-end gap-1">{['categories', 'suppliers', 'customers', 'products', 'expenses'].includes(c.entity_type) && c.auto_resolution === 'REMOTE_WINS' && <Button size="sm" variant="secondary" onClick={async () => { await restoreLocalVersion(ctx, c.id).catch((x) => useApp.getState().fail(x)); reload(); }}>{t('sync.keepMine')}</Button>}<Button size="sm" variant="ghost" onClick={async () => { await engine.markConflictReviewed(c.id); reload(); await refreshSync(); }}>{t('sync.markReviewed')}</Button></span>}</td></tr>)}</tbody></table>)}
      </Card>
    </div>
  );
}
