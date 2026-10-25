import { Database, Download, KeyRound, Plus, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, Field, Input, Modal, PageHeader, PageLoader, Segmented, Select, Tabs, useAction } from '../components/ui';
import { ReceiptPreview } from '../components/Receipt';
import { formatDate } from '../lib/format';
import { fileToLogo } from '../lib/image';
import { NewKeyModal } from '../components/RecoveryKey';
import { recoveryStatus, regenerateRecoveryKey } from '../services/recovery';
import { createUser, listRolePermissions, listUsers, setRolePermission, updateUser } from '../services/auth';
import { backupStatus, exportBackup, pickRestoreFile, restoreBackup } from '../services/backup';
import { listAudit } from '../services/audit';
import { seedDemo } from '../services/demo';
import { PERMISSIONS, type Permission } from '../services/permissions';
import { getPaymentMethods, saveShopSettings, type PaymentMethodCfg } from '../services/settings';
import { useApp, useCan, useCtx } from '../state/app';
import { useLive } from '../state/hooks';
import { SubscriptionTab, SyncTab } from './SettingsCloud';
import { NetworkTab } from './SettingsNetwork';

type Tab = 'general' | 'users' | 'backup' | 'subscription' | 'sync' | 'network' | 'audit';

export function SettingsPage() {
  const { t } = useTranslation(); const can = useCan();
  const [params, setParams] = useSearchParams();
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'general', label: t('settings.general'), show: true }, { id: 'users', label: t('settings.users'), show: can('users.manage') },
    { id: 'backup', label: t('settings.backup'), show: can('backup.manage') }, { id: 'subscription', label: t('settings.subscription'), show: true },
    { id: 'sync', label: t('settings.sync'), show: true }, { id: 'network', label: t('settings.network'), show: can('sync.manage') }, { id: 'audit', label: t('settings.audit'), show: can('users.manage') },
  ];
  const visible = tabs.filter((x) => x.show);
  const tab = (visible.find((x) => x.id === params.get('tab'))?.id ?? 'general') as Tab;
  return (
    <div>
      <PageHeader title={t('nav.settings')} />
      <Tabs tabs={visible.map(({ id, label }) => ({ id, label }))} value={tab} onChange={(x) => setParams({ tab: x })} />
      <div className="pt-4">
        {tab === 'general' && <General />}{tab === 'users' && <Users />}{tab === 'backup' && <Backup />}
        {tab === 'subscription' && <SubscriptionTab />}{tab === 'sync' && <SyncTab />}{tab === 'network' && <NetworkTab />}{tab === 'audit' && <Audit />}
      </div>
    </div>
  );
}

function General() {
  const { t } = useTranslation(); const ctx = useCtx(); const can = useCan();
  const { settings, lang, theme, setLang, setTheme, refreshSettings, toast } = useApp();
  const admin = can('settings.manage');
  const [f, setF] = useState({ business_name: settings.business_name, branch_name: settings.branch_name, receipt_tagline: settings.receipt_tagline, business_phone: settings.business_phone, business_address: settings.business_address,
    receipt_footer: settings.receipt_footer, receipt_logo: settings.receipt_logo, receipt_show_time: settings.receipt_show_time, default_minimum_stock: settings.default_minimum_stock, max_discount_percent: settings.max_discount_percent });
  const [days, setDays] = useState<number[]>(() => { try { return JSON.parse(settings.expiry_alert_days); } catch { return [30, 7, 1]; } });
  const { data: methods } = useLive((c) => getPaymentMethods(c.db));
  const [pm, setPm] = useState<PaymentMethodCfg[] | null>(null);
  const list = pm ?? methods ?? [];
  const [newM, setNewM] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const save = useAction(async () => {
    await saveShopSettings(ctx, {
      ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])),
      expiry_alert_days: JSON.stringify([...days].sort((a, b) => b - a)),
      payment_methods: JSON.stringify(list),
    });
    await refreshSettings(); toast('success', t('common.saved'));
  });
  const demo = useAction(async () => { setProgress(0); await seedDemo(ctx, { onProgress: setProgress }); setProgress(null); toast('success', t('settings.demoDone')); });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title={t('settings.appearance')}>
        <div className="space-y-4"><Field label={t('settings.language')}><Segmented options={[{ id: 'fr', label: 'Français' }, { id: 'en', label: 'English' }]} value={lang} onChange={(l) => setLang(l)} /></Field>
          <Field label={t('settings.theme')}><Segmented options={[{ id: 'light', label: t('settings.light') }, { id: 'dark', label: t('settings.dark') }]} value={theme} onChange={(x) => setTheme(x)} /></Field></div>
      </Card>
      {admin && <Card title={t('settings.business')}><div className="grid grid-cols-2 gap-3">
        <Field label={t('auth.businessName')}><Input value={f.business_name} onChange={set('business_name')} /></Field><Field label={t('auth.branchName')}><Input value={f.branch_name} onChange={set('branch_name')} /></Field>
        <Field label={t('common.phone')}><Input value={f.business_phone} onChange={set('business_phone')} /></Field><Field label={t('common.address')}><Input value={f.business_address} onChange={set('business_address')} /></Field></div></Card>}
      {admin && <Card title={t('settings.paymentMethods')}>
        <ul className="space-y-1.5">{list.map((m, i) => <li key={m.code} className="flex items-center justify-between rounded border border-line px-3 py-2 text-[13px]"><span><b>{lang === 'fr' ? m.label_fr : m.label_en}</b> <span className="text-faint">· {m.code}</span></span>
          <input type="checkbox" checked={m.enabled} onChange={() => setPm(list.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))} /></li>)}</ul>
        <div className="mt-3 flex gap-2"><Input value={newM} onChange={(e) => setNewM(e.target.value)} placeholder={t('settings.newMethod')} /><Button variant="secondary" disabled={!newM.trim()} icon={<Plus className="h-4 w-4" />} onClick={() => { setPm([...list, { code: newM.trim().toUpperCase().replace(/\W+/g, '_'), label_fr: newM.trim(), label_en: newM.trim(), enabled: true }]); setNewM(''); }}>{t('common.add')}</Button></div></Card>}
      {admin && <Card title={t('settings.receiptTitle')} className="col-span-2">
        <div className="grid grid-cols-[1fr_300px] gap-6">
          <div className="space-y-4">
            <Field label={t('settings.receiptLogo')} hint={t('settings.logoHint')}>
              <div className="flex items-center gap-3">
                <div className="flex h-16 w-40 items-center justify-center overflow-hidden rounded border border-dashed border-line-strong bg-white text-[11px] text-faint">
                  {f.receipt_logo ? <img src={f.receipt_logo} alt="" className="max-h-full max-w-full" /> : t('settings.logoPlaceholder')}</div>
                <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded border border-line-strong bg-surface px-3 text-[13px] font-semibold hover:bg-muted"><Upload className="h-4 w-4" />{t('settings.logoUpload')}
                  <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setF({ ...f, receipt_logo: await fileToLogo(file) }); e.target.value = ''; }} /></label>
                {f.receipt_logo && <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setF({ ...f, receipt_logo: '' })}>{t('settings.logoRemove')}</Button>}
              </div></Field>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.receipt_show_time !== '0'} onChange={(e) => setF({ ...f, receipt_show_time: e.target.checked ? '1' : '0' })} />{t('settings.showTime')}</label>
            <Field label={t('settings.receiptTagline')}><Input value={f.receipt_tagline} onChange={set('receipt_tagline')} /></Field>
            <Field label={t('settings.receiptFooter')}><Input value={f.receipt_footer} onChange={(e) => setF({ ...f, receipt_footer: e.target.value })} /></Field>
          </div>
          <div><div className="mb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-faint">{t('settings.preview')}</div><ReceiptPreview settings={{ ...settings, ...f, receipt_logo: f.receipt_logo }} lang={lang} /></div>
        </div></Card>}
      {admin && <Card title={t('settings.rules')}><div className="grid grid-cols-2 gap-3">
        <Field label={t('settings.maxDiscount')} hint={t('settings.maxDiscountHint')}><Input type="number" min={0} max={100} value={f.max_discount_percent} onChange={set('max_discount_percent')} /></Field>
        <Field label={t('settings.defaultMin')}><Input type="number" min={0} value={f.default_minimum_stock} onChange={set('default_minimum_stock')} /></Field>
        <div className="col-span-2"><div className="mb-1 text-[12px] font-medium">{t('settings.expiryAlerts')}</div><div className="flex items-center gap-2">{days.map((d, i) => <Input key={i} type="number" min={1} className="w-20" value={d} onChange={(e) => setDays(days.map((x, j) => (j === i ? Number(e.target.value) || 1 : x)))} />)}<span className="text-[12px] text-faint">{t('settings.daysBefore')}</span></div></div></div></Card>}
      {admin && <div className="col-span-2 flex items-center justify-between"><Card className="flex-1" title={t('settings.demo')}><div className="flex items-center justify-between gap-4"><p className="text-[12px] text-faint">{t('settings.demoText')}</p>
        <Button variant="secondary" icon={<Database className="h-4 w-4" />} loading={demo.busy} onClick={() => demo.run()}>{progress !== null ? `${progress}%` : t('settings.demoLoad')}</Button></div></Card></div>}
      {admin && <div className="col-span-2"><Button loading={save.busy} onClick={() => save.run()}>{t('common.save')}</Button></div>}
    </div>
  );
}

function Users() {
  const { t } = useTranslation(); const ctx = useCtx(); const { toast, user: me } = useApp();
  const { data: users } = useLive((c) => listUsers(c));
  const { data: rp } = useLive((c) => listRolePermissions(c.db));
  const [form, setForm] = useState<any | 'new' | null>(null);
  const toggle = useAction(async (role: string, p: Permission, v: boolean) => { await setRolePermission(ctx, role, p, v); });
  return (
    <div className="space-y-4">
      <Card title={t('settings.users')} actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm('new')}>{t('settings.newUser')}</Button>} bodyClass="!p-0">
        {!users ? <PageLoader /> : <table className="tbl"><thead><tr><th>{t('common.name')}</th><th>{t('auth.username')}</th><th>{t('settings.role')}</th><th>{t('settings.lastLogin')}</th><th>{t('common.status')}</th><th /></tr></thead>
          <tbody>{users.map((u) => <tr key={u.id}><td className="font-medium">{u.full_name}</td><td className="text-faint">{u.username}</td><td><Badge tone={u.role_code === 'ADMIN' ? 'ai' : 'neutral'}>{t(`roles.${u.role_code}`)}</Badge></td><td className="text-faint">{u.last_login_at ? formatDate(u.last_login_at, useApp.getState().lang, true) : '—'}</td>
            <td>{u.active ? <Badge tone="ok">{t('settings.active')}</Badge> : <Badge tone="bad">{t('settings.disabled')}</Badge>}</td><td className="text-right"><Button size="sm" variant="ghost" onClick={() => setForm(u)}>{t('common.edit')}</Button></td></tr>)}</tbody></table>}
      </Card>
      <RecoveryCard />
      <Card title={t('settings.permissions')} bodyClass="!p-0">
        <p className="px-4 pt-3 text-[12px] text-faint">{t('settings.permissionsHint')}</p>
        {rp && <table className="tbl mt-2"><thead><tr><th>{t('settings.permission')}</th>{['ADMIN', 'MANAGER', 'CASHIER'].map((r) => <th key={r} className="text-center">{t(`roles.${r}`)}</th>)}</tr></thead>
          <tbody>{PERMISSIONS.map((p) => <tr key={p}><td><span className="font-mono text-[12px]">{p}</span> <span className="text-faint">· {t(`perm.${p}`)}</span></td>{['ADMIN', 'MANAGER', 'CASHIER'].map((r) => <td key={r} className="text-center"><input type="checkbox" checked={rp[r]?.includes(p) ?? false} disabled={r === 'ADMIN' || toggle.busy} onChange={(e) => toggle.run(r, p, e.target.checked)} /></td>)}</tr>)}</tbody></table>}
      </Card>
      {form && <UserForm user={form === 'new' ? null : form} isMe={form !== 'new' && form.id === me?.id} onClose={() => setForm(null)} done={() => toast('success', t('common.saved'))} />}
    </div>
  );
}

function UserForm({ user, isMe, onClose, done }: { user: any | null; isMe: boolean; onClose: () => void; done: () => void }) {
  const { t } = useTranslation(); const ctx = useCtx();
  const [f, setF] = useState({ username: user?.username ?? '', full_name: user?.full_name ?? '', role_code: user?.role_code ?? 'CASHIER', password: '', active: user ? !!user.active : true });
  const save = useAction(async () => {
    if (user) await updateUser(ctx, user.id, { full_name: f.full_name, role_code: f.role_code, active: f.active, password: f.password || undefined });
    else await createUser(ctx, { username: f.username, full_name: f.full_name, password: f.password, role_code: f.role_code });
    done(); onClose();
  });
  return (
    <Modal open title={user ? t('common.edit') : t('settings.newUser')} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.busy} disabled={!f.full_name || (!user && (!f.username || !f.password))} onClick={() => save.run()}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <Field label={t('auth.fullName')}><Input autoFocus value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label={t('auth.username')}><Input disabled={!!user} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label={t('settings.role')}><Select disabled={isMe} value={f.role_code} onChange={(e) => setF({ ...f, role_code: e.target.value })}>{['ADMIN', 'MANAGER', 'CASHIER'].map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}</Select></Field>
        <Field label={user ? t('settings.newPassword') : t('auth.password')} hint={user ? t('settings.passwordKeep') : undefined}><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        {user && !isMe && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t('settings.active')}</label>}
      </div>
    </Modal>
  );
}

function Backup() {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang, toast, desktop } = useApp();
  const { data, reload } = useLive((c) => backupStatus(c));
  const [file, setFile] = useState<string | null>(null);
  const exp = useAction(async () => { const p = await exportBackup(ctx); if (p) { toast('success', t('settings.backupDone', { path: p })); reload(); } });
  const pick = useAction(async () => { const f = await pickRestoreFile(); if (f) setFile(f); });
  const restore = useAction(async () => { const safety = await restoreBackup(ctx, file!); toast('success', t('settings.restoreDone', { path: safety })); setTimeout(() => window.location.reload(), 1200); });
  if (!desktop) return <Card><p className="text-[13px] text-faint">{t('errors.backupDesktopOnly')}</p></Card>;
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title={t('settings.backupStatus')}>
        <dl className="space-y-2 text-[13px]"><div className="flex justify-between"><dt className="text-faint">{t('settings.lastBackup')}</dt><dd className="font-medium">{data?.lastBackupAt ? formatDate(data.lastBackupAt, lang, true) : t('settings.never')}</dd></div>
          <div className="flex justify-between"><dt className="text-faint">{t('settings.dbSize')}</dt><dd className="num font-medium">{data?.info ? `${(data.info.size_bytes / 1024 / 1024).toFixed(2)} MB` : '—'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-faint">{t('settings.dbPath')}</dt><dd className="truncate font-mono text-[11px]" title={data?.info?.path}>{data?.info?.path}</dd></div></dl>
        <div className="mt-4 flex gap-2"><Button icon={<Download className="h-4 w-4" />} loading={exp.busy} onClick={() => exp.run()}>{t('settings.exportBackup')}</Button>
          <Button variant="secondary" icon={<Upload className="h-4 w-4" />} loading={pick.busy} onClick={() => pick.run()}>{t('settings.restoreBackup')}</Button></div>
        <p className="mt-3 text-[11px] text-faint">{t('settings.autoBackupNote')}</p>
      </Card>
      <Card title={t('settings.autoBackups')} bodyClass="!p-0"><ul className="divide-y divide-line/60">{(data?.files ?? []).slice(0, 10).map((f) => <li key={f.path} className="flex items-center justify-between px-4 py-2 text-[12px]"><span className="truncate font-mono">{f.name}</span>
        <span className="flex items-center gap-2"><span className="num text-faint">{(f.size_bytes / 1024).toFixed(0)} KB</span><Button size="sm" variant="ghost" onClick={() => setFile(f.path)}>{t('settings.restore')}</Button></span></li>)}{(data?.files.length ?? 0) === 0 && <li className="p-4 text-[13px] text-faint">—</li>}</ul></Card>
      <ConfirmDialog open={!!file} danger title={t('settings.restoreTitle')} confirmLabel={t('settings.restoreConfirm')} busy={restore.busy} onCancel={() => setFile(null)} onConfirm={() => restore.run()}
        message={<div className="space-y-2"><div className="flex items-start gap-2 text-bad-text"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{t('settings.restoreWarning')}</span></div><div className="break-all rounded bg-muted p-2 font-mono text-[11px]">{file}</div><p className="text-[12px] text-faint">{t('settings.restoreSafety')}</p></div>} />
    </div>
  );
}

function Audit() {
  const { t } = useTranslation(); const { lang } = useApp();
  const { data } = useLive((c) => listAudit(c, 300));
  return (
    <Card bodyClass="!p-0">{!data ? <PageLoader /> : <div className="max-h-[calc(100vh-260px)] overflow-auto"><table className="tbl"><thead><tr><th>{t('common.date')}</th><th>{t('movements.user')}</th><th>{t('settings.action')}</th><th>{t('settings.entity')}</th><th>{t('settings.details')}</th></tr></thead>
      <tbody>{data.map((a) => <tr key={a.id}><td className="whitespace-nowrap text-faint">{formatDate(a.created_at, lang, true)}</td><td>{a.user_name ?? '—'}</td><td><Badge>{a.action}</Badge></td><td className="text-faint">{a.entity_type}</td><td className="max-w-[360px] truncate font-mono text-[11px] text-faint" title={a.metadata ?? ''}>{a.metadata}</td></tr>)}</tbody></table></div>}</Card>
  );
}
void KeyRound;

function RecoveryCard() {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang } = useApp();
  const { data, reload } = useLive((c) => recoveryStatus(c.db));
  const [ask, setAsk] = useState(false); const [pw, setPw] = useState(''); const [fresh, setFresh] = useState<string | null>(null);
  const gen = useAction(async () => { setFresh(await regenerateRecoveryKey(ctx, pw)); setAsk(false); setPw(''); reload(); });
  return (
    <Card title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" />{t('recovery.cardTitle')}</span>}
      actions={<Button size="sm" variant={data?.exists ? 'secondary' : 'primary'} onClick={() => setAsk(true)}>{data?.exists ? t('recovery.regenerate') : t('recovery.create')}</Button>}>
      <p className="text-[13px] text-body">{data?.exists ? t('recovery.cardExists', { date: formatDate(data.createdAt, lang) }) : t('recovery.cardMissing')}</p>
      <p className="mt-1 text-[12px] text-faint">{t('recovery.cardHint')}</p>
      <Modal open={ask} title={t('recovery.regenerate')} onClose={() => setAsk(false)} footer={<><Button variant="secondary" onClick={() => setAsk(false)}>{t('common.cancel')}</Button><Button loading={gen.busy} disabled={!pw} onClick={() => gen.run()}>{t('common.confirm')}</Button></>}>
        <p className="mb-3 text-[13px] text-body">{t('recovery.confirmPassword')}</p>
        <Field label={t('auth.password')}><Input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
      </Modal>
      <NewKeyModal code={fresh} onClose={() => setFresh(null)} />
    </Card>
  );
}
