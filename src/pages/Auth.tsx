import { CheckCircle2, Cloud, Network, PackageSearch, RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NewKeyModal } from '../components/RecoveryKey';
import { Button, Field, Input, Segmented, Toaster, useAction } from '../components/ui';
import { resetPasswordWithRecoveryKey } from '../services/recovery';
import { rt } from '../state/app';
import { CloudError } from '../cloud/client';
import { SyncTransportError } from '../sync/protocol';
import { hasAnyUser } from '../services/auth';
import { useOnline } from '../state/hooks';
import { joinHub } from '../lan/network';
import { netErrorText } from './SettingsNetwork';
import { useApp } from '../state/app';

function Frame({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  const { lang, setLang, desktop } = useApp();
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-on-brand"><PackageSearch className="h-5 w-5" /></div>
            <div className="font-display text-[20px] font-bold text-ink">StockFlow AI</div>
          </div>
          <Segmented options={[{ id: 'fr', label: 'FR' }, { id: 'en', label: 'EN' }]} value={lang} onChange={(l) => setLang(l)} />
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-pop">
          <h1 className="font-display text-[22px] font-bold text-ink">{title}</h1>
          <p className="mb-5 mt-1 text-[13px] text-faint">{subtitle}</p>
          {children}
        </div>
        {desktop && <div className="mt-4 flex items-center justify-center gap-2 text-[12px] text-faint"><WifiOff className="h-3.5 w-3.5" />{t('auth.offlineNote')}</div>}
      </div>
      <Toaster />
    </div>
  );
}

export function Login() {
  const { t } = useTranslation();
  const login = useApp((s) => s.login);
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [forgot, setForgot] = useState(false);
  const { run, busy } = useAction(() => login(u, p));
  if (forgot) return <Forgot username={u} onBack={() => setForgot(false)} />;
  return (
    <Frame title={t('auth.welcome')} subtitle={t('auth.loginSubtitle')}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <Field label={t('auth.username')}><Input autoFocus value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" /></Field>
        <Field label={t('auth.password')}><Input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></Field>
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!u || !p}>{t('auth.signIn')}</Button>
        <button type="button" onClick={() => setForgot(true)} className="block w-full text-center text-[13px] font-medium text-brand hover:underline">{t('recovery.forgot')}</button>
      </form>
    </Frame>
  );
}

/** Offline password reset with the recovery key. */
function Forgot({ username, onBack }: { username: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { lang, toast } = useApp();
  const [f, setF] = useState({ username, key: '', pw: '', confirm: '' });
  const [fresh, setFresh] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const { run, busy } = useAction(async () => {
    if (f.pw !== f.confirm) return toast('error', t('auth.passwordsDontMatch'));
    const r = rt();
    const key = await resetPasswordWithRecoveryKey({ db: r.db, deviceId: r.deviceId, user: null, permissions: new Set(), now: () => new Date() }, { username: f.username, key: f.key, newPassword: f.pw });
    setFresh(key); toast('success', t('recovery.resetDone'));
  });
  void lang;
  return (
    <Frame title={t('recovery.resetTitle')} subtitle={t('recovery.resetSubtitle')}>
      <form className="space-y-3.5" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <Field label={t('auth.username')}><Input autoFocus value={f.username} onChange={set('username')} /></Field>
        <Field label={t('recovery.keyLabel')} hint={t('recovery.keyHint')}><Input value={f.key} onChange={set('key')} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" className="font-mono uppercase" autoComplete="off" spellCheck={false} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('settings.newPassword')}><Input type="password" value={f.pw} onChange={set('pw')} autoComplete="new-password" /></Field>
          <Field label={t('auth.confirmPassword')}><Input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!f.username || !f.key || !f.pw}>{t('recovery.reset')}</Button>
        <button type="button" onClick={onBack} className="block w-full text-center text-[13px] text-faint hover:text-ink">{t('recovery.backToLogin')}</button>
        <p className="text-[11px] text-faint">{t('recovery.noKeyHelp')}</p>
      </form>
      <NewKeyModal code={fresh} onClose={() => { setFresh(null); onBack(); }} />
    </Frame>
  );
}

export function Setup() {
  const { t } = useTranslation();
  const { completeSetup, toast, desktop, lang } = useApp();
  const [restore, setRestore] = useState(false);
  const [join, setJoin] = useState(false);
  const [f, setF] = useState({ business_name: '', branch_name: '', full_name: '', username: '', password: '', confirm: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const { run, busy } = useAction(async () => {
    if (f.password !== f.confirm) return toast('error', t('auth.passwordsDontMatch'));
    await completeSetup({ business_name: f.business_name, branch_name: f.branch_name || t('auth.defaultBranch'), full_name: f.full_name, username: f.username, password: f.password });
  });
  if (restore) return <RestoreFlow onBack={() => setRestore(false)} />;
  if (join) return <JoinFlow onBack={() => setJoin(false)} />;
  if (!desktop) return (
    <Frame title={lang === 'fr' ? 'Connectez-vous à votre magasin' : 'Connect to your shop'} subtitle={lang === 'fr' ? 'Ouvrez votre inventaire synchronisé dans StockFlow AI Web.' : 'Open your existing cloud-synced inventory in StockFlow AI Web.'}>
      <p className="mb-5 text-[13px] text-body">{lang === 'fr' ? 'Cette version affiche les données du magasin en lecture seule. La restauration utilise le compte cloud du magasin et conserve une copie distincte dans ce navigateur.' : 'This is a secure, read-only view of your shop. Restore uses your shop cloud account and keeps a separate copy in this browser.'}</p>
      <Button size="lg" className="w-full" onClick={() => setRestore(true)} icon={<Cloud className="h-4 w-4" />}>{lang === 'fr' ? 'Connecter les données du magasin' : 'Connect to shop data'}</Button>
    </Frame>
  );
  return (
    <Frame title={t('auth.setupTitle')} subtitle={t('auth.setupSubtitle')}>
      <form className="space-y-3.5" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <Field label={t('auth.businessName')} required><Input autoFocus value={f.business_name} onChange={set('business_name')} /></Field>
        <Field label={t('auth.branchName')}><Input value={f.branch_name} onChange={set('branch_name')} placeholder={t('auth.defaultBranch')} /></Field>
        <div className="h-px bg-line" />
        <Field label={t('auth.fullName')} required><Input value={f.full_name} onChange={set('full_name')} /></Field>
        <Field label={t('auth.username')} required><Input value={f.username} onChange={set('username')} autoComplete="username" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('auth.password')} required><Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
          <Field label={t('auth.confirmPassword')} required><Input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
        </div>
        <p className="text-[11px] text-faint">{t('auth.adminNote')}</p>
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!f.business_name || !f.full_name || !f.username || !f.password}>{t('auth.createAccount')}</Button>
        <button type="button" onClick={() => setRestore(true)} className="flex w-full items-center justify-center gap-2 border-t border-line pt-3 text-[13px] font-medium text-brand hover:underline"><Cloud className="h-4 w-4" />{t('restore.link')}</button>
        {desktop && <button type="button" onClick={() => setJoin(true)} className="flex w-full items-center justify-center gap-2 text-[13px] font-medium text-brand hover:underline"><Network className="h-4 w-4" />{t('network.joinLink')}</button>}
      </form>
    </Frame>
  );
}

/** New PC of an existing shop: connect to the main PC and download everything BEFORE creating any account. */
function JoinFlow({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { toast, finishRestore } = useApp();
  const [stage, setStage] = useState<'form' | 'running' | 'done' | 'empty'>('form');
  const [f, setF] = useState({ address: '', code: '', name: '' }); const [count, setCount] = useState(0);
  const start = useAction(async () => {
    try {
      await joinHub(rt().db, rt().deviceId, { address: f.address, code: f.code, deviceName: f.name || undefined });
      setStage('running'); setCount(0);
      const rep = await rt().sync.restoreFromCloud({ full: true, onProgress: setCount });
      setCount(rep.pulled);
      setStage((await hasAnyUser(rt().db)) ? 'done' : 'empty');
    } catch (e) { setStage('form'); toast('error', netErrorText(e, t)); }
  });
  return (
    <Frame title={t('network.joinFirstTitle')} subtitle={t('network.joinFirstSubtitle')}>
      {stage === 'form' ? (
        <form className="space-y-3.5" onSubmit={(e) => { e.preventDefault(); start.run(); }}>
          <Field label={t('network.address')} hint={t('network.addressHint')}><Input autoFocus value={f.address} placeholder="192.168.1.10" onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label={t('network.code')}><Input value={f.code} inputMode="numeric" maxLength={7} placeholder="123456" onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^\d ]/g, '') })} /></Field>
          <Field label={t('network.pcName')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Button type="submit" size="lg" className="w-full" loading={start.busy} disabled={!f.address.trim() || f.code.replace(/\s/g, '').length < 6} icon={<Network className="h-5 w-5" />}>{t('network.connect')}</Button>
        </form>)
        : stage === 'running' ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center"><RefreshCw className="h-8 w-8 animate-spin text-ai" /><div className="font-display text-[16px] font-semibold text-ink">{t('restore.running', { count })}</div><p className="text-[12px] text-faint">{t('restore.keepOpen')}</p></div>)
        : stage === 'done' ? (
          <div className="space-y-4 text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-ok" /><div className="font-display text-[18px] font-semibold text-ink">{t('restore.done', { count })}</div><p className="text-[13px] text-body">{t('network.joinDoneNext')}</p>
            <Button size="lg" className="w-full" onClick={() => finishRestore()}>{t('restore.toLogin')}</Button></div>)
        : (<div className="space-y-3 text-center"><p className="text-[14px] text-body">{t('network.joinEmpty')}</p><Button variant="secondary" onClick={() => setStage('form')}>{t('subscription.retry')}</Button></div>)}
      {stage !== 'running' && stage !== 'done' && <button type="button" onClick={onBack} className="mt-4 block w-full text-center text-[13px] text-faint hover:text-ink">{t('restore.back')}</button>}
    </Frame>
  );
}

const restoreMsg = (e: unknown, t: (k: string, o?: any) => string) => {
  const kind = e instanceof CloudError || e instanceof SyncTransportError ? e.kind : null;
  return kind ? t(`subscription.err.${kind}`) : t('errors.unexpected');
};

/** New PC: get the whole business back (products, sales, customers, staff accounts, settings) BEFORE creating any account. */
function RestoreFlow({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { toast, finishRestore } = useApp();
  const online = useOnline();
  const [stage, setStage] = useState<'auth' | 'ready' | 'running' | 'done' | 'empty'>('auth');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [count, setCount] = useState(0);
  useEffect(() => { (async () => { const c = rt().cloud; setConfigured(await c.isConfigured()); const s = await c.getSession(); if (s) { setAccount(s.email); setStage('ready'); } })(); }, []);
  const login = useAction(async () => {
    try { await rt().cloud.login(email, pw, navigator.platform || 'desktop'); setAccount(email); setPw(''); setStage('ready'); }
    catch (e) { toast('error', restoreMsg(e, t)); }
  });
  const start = useAction(async () => {
    setStage('running'); setCount(0);
    try {
      const rep = await rt().sync.restoreFromCloud({ full: true, onProgress: setCount });
      setCount(rep.pulled);
      setStage((await hasAnyUser(rt().db)) ? 'done' : 'empty');
    } catch (e) { setStage('ready'); toast('error', restoreMsg(e, t)); }
  });
  return (
    <Frame title={t('restore.title')} subtitle={t('restore.subtitle')}>
      {configured === false ? <p className="rounded border border-line-strong bg-muted p-3 text-[13px] text-body">{t('subscription.noServerNotice')}</p>
        : stage === 'auth' ? (
          <form className="space-y-3.5" onSubmit={(e) => { e.preventDefault(); login.run(); }}>
            {!online && <p className="flex items-center gap-2 rounded border border-warn/40 bg-warn-soft p-2.5 text-[12px] text-warn-text"><WifiOff className="h-4 w-4 shrink-0" />{t('subscription.offlineBlock')}</p>}
            <Field label="Email"><Input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
            <Field label={t('auth.password')}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
            <Button type="submit" size="lg" className="w-full" loading={login.busy} disabled={!email || !pw || !online}>{t('subscription.signIn')}</Button>
          </form>)
        : stage === 'ready' ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-[13px] text-body"><CheckCircle2 className="h-4 w-4 text-ok" />{t('restore.signedInAs', { email: account })}</p>
            <p className="rounded border border-ok/30 bg-ok-soft p-2.5 text-[12px] text-ok-text">{t('restore.free')}</p>
            <Button size="lg" className="w-full" loading={start.busy} disabled={!online} onClick={() => start.run()} icon={<Cloud className="h-5 w-5" />}>{t('restore.start')}</Button>
          </div>)
        : stage === 'running' ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center"><RefreshCw className="h-8 w-8 animate-spin text-ai" /><div className="font-display text-[16px] font-semibold text-ink">{t('restore.running', { count })}</div><p className="text-[12px] text-faint">{t('restore.keepOpen')}</p></div>)
        : stage === 'done' ? (
          <div className="space-y-4 text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-ok" /><div className="font-display text-[18px] font-semibold text-ink">{t('restore.done', { count })}</div><p className="text-[13px] text-body">{t('restore.doneNext')}</p>
            <Button size="lg" className="w-full" onClick={() => finishRestore()}>{t('restore.toLogin')}</Button></div>)
        : (<div className="space-y-3 text-center"><p className="text-[14px] text-body">{t('restore.empty')}</p><Button variant="secondary" onClick={() => setStage('ready')}>{t('subscription.retry')}</Button></div>)}
      {stage !== 'running' && stage !== 'done' && <button type="button" onClick={onBack} className="mt-4 block w-full text-center text-[13px] text-faint hover:text-ink">{t('restore.back')}</button>}
    </Frame>
  );
}
