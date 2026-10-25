import { Check, Copy, Network, PlugZap, RefreshCw, Server, ShieldAlert, Trash2, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, ConfirmDialog, Empty, Field, Input, Pill } from '../components/ui';
import {
  closePairing, defaultDeviceName, enableHost, findDuplicateReceipts, getNetConfig, hasLocalBusinessData, hubStatus, joinHub, leaveNetwork, netInfo, openPairing,
  revokeDevice, syncIntervalFor, type HubStatus, type NetInfo, type NetMode,
} from '../lan/network';
import { DEFAULT_HUB_PORT, LanError } from '../lan/transport';
import { formatDate } from '../lib/format';
import { getBackupStatus } from '../cloud/backup';
import { getSetting, setSetting } from '../services/settings';
import { rt, syncErrorText, useApp, useCan, useCtx } from '../state/app';
import { useLive } from '../state/hooks';

/** LanError -> a sentence a shop owner understands (the codes come from the main PC / the network). */
export function netErrorText(e: unknown, t: (k: string, o?: any) => string): string {
  const kind = (e as { kind?: string } | null)?.kind;   // SyncTransportError (sync engine)
  const code = e instanceof LanError ? e.code : kind === 'NETWORK' ? 'NETWORK' : kind === 'AUTH' ? 'UNAUTHORIZED' : 'UNKNOWN';
  const key = `network.err.${code}`; const s = t(key);
  return s === key ? t('network.err.UNKNOWN') : s;
}

const hubAddress = (ip: string, port: number | null) => (port && port !== DEFAULT_HUB_PORT ? `${ip}:${port}` : ip);

export function NetworkTab() {
  const desktop = useApp((s) => s.desktop);
  return desktop ? <DesktopNetworkTab /> : <BrowserNetworkNotice />;
}

function DesktopNetworkTab() {
  const { t } = useTranslation(); const ctx = useCtx(); const can = useCan();
  const { lang, sync, toast, refreshSync } = useApp();
  const manage = can('sync.manage');
  const { data: cfg, reload } = useLive((c) => getNetConfig(c.db));
  const { data: netError } = useLive((c) => getSetting(c.db, 'net_error'));
  const { data: notice, reload: reloadNotice } = useLive((c) => getSetting(c.db, 'net_notice'));
  const { data: dups } = useLive((c) => findDuplicateReceipts(c.db));
  const mode: NetMode = cfg?.mode ?? 'off';
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'host' | 'leave'>(null);
  const [f, setF] = useState({ address: '', code: '', name: defaultDeviceName(ctx.deviceId), merge: false });
  const [hasData, setHasData] = useState(false);
  useEffect(() => { hasLocalBusinessData(ctx.db).then(setHasData); }, [ctx.db, mode]);

  const restartSync = async () => { const r = rt(); r.sync.start(await syncIntervalFor(r.db)); await refreshSync(); };
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast('error', netErrorText(e, t)); } finally { setBusy(false); }
  };

  const becomeHost = () => guard(async () => { await enableHost(ctx.db, ctx.deviceId); let startupFailed = false; try { await enableAutostart(); } catch { startupFailed = true; } setConfirm(null); await reload(); await restartSync(); toast(startupFailed ? 'error' : 'success', t(startupFailed ? 'network.autostartFailed' : 'network.hostOn')); });
  const connect = () => guard(async () => {
    await joinHub(ctx.db, ctx.deviceId, { address: f.address, code: f.code, deviceName: f.name, mergeLocalData: f.merge });
    setF({ ...f, code: '' }); await reload(); await restartSync(); toast('success', t('network.joined'));
  });
  const leave = () => guard(async () => { await leaveNetwork(ctx.db); let startupFailed = false; if (mode === 'host') { try { await disableAutostart(); } catch { startupFailed = true; } } setConfirm(null); await reload(); await restartSync(); toast(startupFailed ? 'error' : 'info', t(startupFailed ? 'network.autostartDisableFailed' : 'network.left')); });
  const syncNow = () => guard(async () => { const r = await rt().sync.syncNow(); await refreshSync(); toast(r.failed ? 'error' : 'success', t('sync.report', { pushed: r.pushed, pulled: r.pulled })); });

  const offline = mode !== 'off' && sync?.state === 'OFFLINE';
  const displayState = sync?.state === 'SYNCING' && sync.pending === 0 && sync.failed === 0 ? 'IDLE' : sync?.state ?? 'IDLE';
  const tiles = [[t('common.status'), offline ? t('network.offlineShort') : t(`sync.state.${displayState}`)], [t('sync.pending'), String(sync?.pending ?? 0)], [t('sync.failed'), String(sync?.failed ?? 0)], [t('sync.lastSync'), sync?.lastSyncAt ? formatDate(sync.lastSyncAt, lang, true) : '—']];
  if (!manage) return <Card><Empty icon={<Network className="h-6 w-6" />} title={t('network.title')} hint={t('network.adminOnly')} /></Card>;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <Network className="mt-0.5 h-5 w-5 text-brand" />
          <div className="flex-1"><div className="font-display text-[16px] font-semibold text-ink">{t('network.title')}</div><p className="mt-1 text-[13px] text-body">{t('network.intro')}</p></div>
          <Pill tone={mode === 'off' ? 'neutral' : 'ok'} icon={<Wifi className="h-3 w-3" />}>{t(`network.mode.${mode}`)}</Pill>
        </div>
      </Card>

      {offline && (
        <div className="flex gap-3 rounded border border-warn/40 bg-warn-soft p-3 text-warn-text">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-[13px]"><div className="font-semibold">{t(mode === 'host' ? 'network.offlineTitleHost' : 'network.offlineTitle')}</div><p className="mt-1">{t(mode === 'host' ? 'network.offlineTextHost' : 'network.offlineText', { count: sync?.pending ?? 0 })}</p></div>
        </div>
      )}
      {(dups?.length ?? 0) > 0 && (
        <div className="flex gap-3 rounded border border-bad/30 bg-bad-soft p-3 text-bad-text">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-[13px]"><div className="font-semibold">{t('network.dupTitle')}</div><p className="mt-1">{t('network.dupText', { count: dups!.length, list: dups!.slice(0, 5).map((d) => d.receipt_no).join(', ') })}</p></div>
        </div>
      )}
      {mode !== 'off' && notice === 'HUB_RESET' && (
        <div className="flex items-start gap-3 rounded border border-brand/30 bg-brand-soft p-3 text-brand">
          <RefreshCw className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1 text-[13px]"><div className="font-semibold">{t('network.resetTitle')}</div><p className="mt-1">{t('network.resetText')}</p></div>
          <Button size="sm" variant="secondary" onClick={async () => { await setSetting(ctx.db, 'net_notice', ''); reloadNotice(); }}>{t('network.dismiss')}</Button>
        </div>
      )}
      {mode !== 'off' && (
        <div className="grid grid-cols-4 gap-4">
          {tiles.map(([k, v]) => <div key={k} className="rounded-lg border border-line bg-surface p-4 shadow-card"><div className="text-[11px] font-semibold uppercase tracking-wide text-faint">{k}</div><div className="num font-display text-[18px] font-bold text-ink">{v}</div></div>)}
        </div>
      )}
      {mode !== 'off' && sync?.lastError && <div className="rounded border border-bad/30 bg-bad-soft p-3 text-[12px] text-bad-text">{t('sync.lastError')}: {syncErrorText(sync.lastError, lang, true)}<div className="mt-1 text-faint">{t('sync.dataSafe')}</div></div>}

      {mode === 'host' && <HostPanel port={cfg?.port ?? DEFAULT_HUB_PORT} netError={netError ?? ''} />}

      {mode === 'client' && (
        <Card title={t('network.clientTitle')}>
          <p className="text-[13px] text-body">{t('network.clientText', { address: cfg?.url.replace('http://', '') })}</p>
          <div className="mt-3 flex gap-2"><Button icon={<RefreshCw className="h-4 w-4" />} loading={busy} onClick={syncNow}>{t('sync.now')}</Button><Button variant="danger" onClick={() => setConfirm('leave')}>{t('network.leave')}</Button></div>
        </Card>
      )}

      {mode === 'off' && (
        <div className="grid grid-cols-2 gap-4">
          <Card title={t('network.hostTitle')}>
            <p className="text-[13px] text-body">{t('network.hostIntro')}</p>
            <Button className="mt-3" icon={<Server className="h-4 w-4" />} onClick={() => setConfirm('host')}>{t('network.makeHost')}</Button>
          </Card>
          <Card title={t('network.joinTitle')}>
            <div className="space-y-3">
              <Field label={t('network.address')} hint={t('network.addressHint')}><Input value={f.address} placeholder="192.168.1.10" onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
              <Field label={t('network.code')}><Input value={f.code} inputMode="numeric" maxLength={7} placeholder="123456" onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^\d ]/g, '') })} /></Field>
              <Field label={t('network.pcName')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              {hasData && (
                <label className="flex items-start gap-2 rounded border border-warn/30 bg-warn-soft p-2.5 text-[12px] text-warn-text">
                  <input type="checkbox" className="mt-0.5" checked={f.merge} onChange={(e) => setF({ ...f, merge: e.target.checked })} /><span>{t('network.mergeWarn')}</span>
                </label>
              )}
              <Button className="w-full" icon={<PlugZap className="h-4 w-4" />} loading={busy} disabled={!f.address.trim() || f.code.replace(/\s/g, '').length < 6} onClick={connect}>{t('network.connect')}</Button>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog open={confirm === 'host'} title={t('network.makeHost')} message={<div className="space-y-2"><p>{t('network.hostConfirm')}</p><p className="text-faint">{t('network.cloudPaused')}</p></div>} confirmLabel={t('network.makeHost')} busy={busy} onConfirm={becomeHost} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'leave'} danger title={t('network.leave')} message={<div className="space-y-2"><p>{mode === 'host' ? t('network.leaveHost') : t('network.leaveClient')}</p><p className="text-faint">{t('network.dataKept')}</p></div>} confirmLabel={t('network.leave')} busy={busy} onConfirm={leave} onCancel={() => setConfirm(null)} />
    </div>
  );
}

function BrowserNetworkNotice() {
  const { t } = useTranslation();
  const { sync, toast, refreshSync } = useApp();
  const syncNow = async () => {
    try {
      const result = await rt().sync.syncNow();
      await refreshSync();
      toast(result.failed ? 'error' : 'success', t('sync.report', { pushed: result.pushed, pulled: result.pulled }));
    } catch { toast('error', t('subscription.err.SERVER')); }
  };
  return <Card title={t('network.title')}>
    <p className="text-[13px] text-body">This browser uses secure cloud sync. The local network hub is available from the desktop app.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => void syncNow()}>{t('sync.now')}</Button>
      <span className="text-[12px] text-faint">{sync?.pending ?? 0} pending · {sync?.failed ?? 0} failed</span>
    </div>
    <p className="mt-3 text-[12px] text-faint">Sign in to your cloud account under Settings → Synchronization. Cloud sync requires an active Premium entitlement for this browser device.</p>
  </Card>;
}

function HostPanel({ port, netError }: { port: number; netError: string }) {
  const { t } = useTranslation(); const { lang, toast } = useApp(); const ctx = useCtx();
  const [st, setSt] = useState<HubStatus | null>(null); const [info, setInfo] = useState<NetInfo | null>(null);
  const [now, setNow] = useState(Date.now()); const [copied, setCopied] = useState('');
  const [revoke, setRevoke] = useState<string | null>(null);
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  const refresh = () => hubStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => { refresh(); netInfo().then(setInfo).catch(() => undefined); isAutostartEnabled().then(setAutoStart).catch(() => setAutoStart(false)); const a = setInterval(refresh, 4000), b = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(a); clearInterval(b); }; }, []);

  const left = st?.pairing ? Math.max(0, st.pairing.expiresAt - Math.floor(now / 1000)) : 0;
  const publicNet = info?.profiles.filter((p) => p.category === 'Public') ?? [];
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1500); } catch { /* clipboard unavailable */ } };
  const open = async () => { try { await openPairing(10); await refresh(); } catch (e) { toast('error', netErrorText(e, t)); } };

  return (
    <div className="space-y-4">
      {netError && <div className="rounded border border-bad/30 bg-bad-soft p-3 text-[13px] text-bad-text">{t(`network.err.${netError}`, { defaultValue: t('network.err.UNKNOWN') })}</div>}
      {publicNet.length > 0 && (
        <div className="flex gap-3 rounded border border-warn/40 bg-warn-soft p-3 text-warn-text">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-[13px]"><div className="font-semibold">{t('network.publicTitle')}</div><p className="mt-1">{t('network.publicText', { name: publicNet.map((p) => p.name).join(', ') })}</p></div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Card title={t('network.addressTitle')}>
          <p className="mb-2 text-[12px] text-faint">{t('network.addressHelp')}</p>
          <p className="mb-2 text-[12px] font-medium text-warn-text">{t(autoStart ? 'network.autostartOn' : 'network.keepOpen')}</p>
          {autoStart === false && <Button size="sm" variant="secondary" className="mb-2" onClick={async () => { try { await enableAutostart(); setAutoStart(true); } catch { toast('error', t('network.autostartFailed')); } }}>{t('network.autostartEnable')}</Button>}
          {(st?.addresses.length ?? 0) === 0 ? <p className="text-[13px] text-warn-text">{t('network.noAddress')}</p> : st!.addresses.map((a) => {
            const v = hubAddress(a.ip, st!.port ?? port);
            return <div key={a.ip} className="mb-2 flex items-center justify-between rounded border border-line bg-muted px-3 py-2"><span className="num font-display text-[18px] font-bold text-ink">{v}</span><Button size="sm" variant="ghost" icon={copied === v ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={() => copy(v)}>{copied === v ? t('network.copied') : t('network.copy')}</Button></div>;
          })}
          <p className="mt-2 text-[12px] text-faint">{st?.running ? t('network.serverOn') : t('network.serverOff')} · {t('network.changesCount', { count: st?.changes ?? 0 })}</p>
        </Card>
        <Card title={t('network.pairTitle')}>
          {left > 0 && st?.pairing ? (
            <div className="space-y-2 text-center">
              <div className="num font-display text-[34px] font-bold tracking-[0.25em] text-ink">{st.pairing.code}</div>
              <p className="text-[12px] text-faint">{t('network.pairExpires', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</p>
              <Button size="sm" variant="secondary" onClick={() => closePairing().then(refresh)}>{t('network.pairClose')}</Button>
            </div>
          ) : (<><p className="text-[13px] text-body">{t('network.pairHint')}</p><Button className="mt-3" icon={<PlugZap className="h-4 w-4" />} onClick={open}>{t('network.pairOpen')}</Button></>)}
        </Card>
      </div>
      <Card title={`${t('network.devices')} (${st?.devices.filter((d) => !d.revoked).length ?? 0})`} bodyClass="!p-0">
        {!st || st.devices.length === 0 ? <Empty title={t('network.noDevices')} /> : (
          <table className="tbl"><thead><tr><th>{t('network.pcName')}</th><th>{t('network.pcCode')}</th><th>{t('network.lastSeen')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>{st.devices.map((d) => (
              <tr key={d.deviceId}><td className="font-medium">{d.name}{d.deviceId === ctx.deviceId && <Badge className="ml-2">{t('network.thisPc')}</Badge>}</td>
                <td className="num font-semibold">{d.code ?? '—'}</td>
                <td className="text-faint">{d.lastSeenAt ? formatDate(new Date(d.lastSeenAt * 1000).toISOString(), lang, true) : '—'}</td>
                <td>{d.revoked ? <Badge tone="bad">{t('network.revoked')}</Badge> : <Badge tone="ok">{t('network.paired')}</Badge>}</td>
                <td className="text-right">{!d.revoked && d.deviceId !== ctx.deviceId && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setRevoke(d.deviceId)}>{t('network.revoke')}</Button>}</td></tr>))}</tbody></table>)}
      </Card>
      <BackupCard devices={st?.devices.filter((d) => !d.revoked && d.deviceId !== ctx.deviceId).length ?? 0} />
      <Card title={t('network.firewallTitle')}><p className="text-[13px] text-body">{t('network.firewallText')}</p></Card>
      <ConfirmDialog open={!!revoke} danger title={t('network.revoke')} message={t('network.revokeConfirm')} confirmLabel={t('network.revoke')} onConfirm={async () => { await revokeDevice(revoke!); setRevoke(null); refresh(); }} onCancel={() => setRevoke(null)} />
    </div>
  );
}

/** Cloud backup of the whole shop + the shop-wide Premium, as seen on the main PC. */
function BackupCard({ devices }: { devices: number }) {
  const { t } = useTranslation(); const { lang, toast, entitlement } = useApp(); const ctx = useCtx();
  const { data: b, reload } = useLive((c) => getBackupStatus(c.db));
  const { data: source } = useLive((c) => getSetting(c.db, 'premium_source'));
  const { data: sharedAt } = useLive((c) => getSetting(c.db, 'premium_shared_at'));
  const [busy, setBusy] = useState(false); const [why, setWhy] = useState<string>('');
  const [trialAvailable, setTrialAvailable] = useState(false);
  const [trialExpiresAt, setTrialExpiresAt] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const cloud = rt().cloud;
        const status = await cloud.hasSession() && await cloud.isConfigured() ? await cloud.trialStatus() : null;
        if (live) { setTrialAvailable(!!status?.sync.available); setTrialExpiresAt(status?.sync.expiresAt ?? null); }
      } catch { if (live) setTrialAvailable(false); }
    })();
    return () => { live = false; };
  }, [ctx.db]);
  const premium = entitlement.state === 'ACTIVE' && source !== 'shared';
  const run = async () => {
    setBusy(true);
    try { const r = await rt().backup?.run(); setWhy(r?.kind === 'WAITING' ? r.why : r?.kind === 'ERROR' ? 'ERROR' : ''); await reload(); if (r?.kind === 'DONE') toast('success', t('network.backupDone')); }
    finally { setBusy(false); }
  };
  const startTrial = async () => {
    setBusy(true);
    try {
      const r = await rt().cloud.startSyncTrial();
      if (r.expiresAt) await setSetting(ctx.db, 'cloud_sync_trial_expires_at', r.expiresAt);
      setTrialExpiresAt(r.expiresAt);
      setTrialAvailable(false);
      const result = await rt().backup?.run();
      await reload();
      if (result?.kind === 'DONE') toast('success', t('network.backupDone'));
      else if (result?.kind === 'WAITING') setWhy(result.why);
    } catch (e) { toast('error', netErrorText(e, t)); }
    finally { setBusy(false); }
  };
  const trialActive = !!trialExpiresAt && Date.parse(trialExpiresAt) > clock;
  return (
    <Card title={t('network.backupTitle')}>
      {!premium && !trialActive ? (
        <div className="space-y-2"><p className="text-[13px] text-body">{t('network.backupNoPremium')}</p>
          {trialAvailable && <><p className="text-[12px] text-ok-text">{t('network.backupTrialText')}</p><Button size="sm" loading={busy} onClick={startTrial}>{t('network.backupTrialButton')}</Button></>}
        </div>
      ) : (
        <div className="space-y-2 text-[13px] text-body">
          {trialActive && <p className="rounded border border-ok/30 bg-ok-soft p-2 text-ok-text">{t('network.backupTrialActive')}</p>}
          <p>{t('network.backupIntro')}</p>
          <p className="text-faint">{b?.lastAt ? t('network.backupLast', { date: formatDate(b.lastAt, lang, true), count: b.waiting }) : t('network.backupNever')}</p>
          {why && why !== 'ERROR' && <p className="text-warn-text">{t(`network.backupWhy.${why}`)}</p>}
          {(b?.error || why === 'ERROR') && <p className="text-bad-text">{t('network.backupError')}: {b?.error}</p>}
          {(b?.skipped ?? 0) > 0 && <p className="text-faint">{t('network.backupSkipped')}</p>}
          <p className="text-faint">{t('network.premiumSharedWith', { count: devices })}{sharedAt ? ` · ${formatDate(sharedAt, lang, true)}` : ''}</p>
          <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={busy} onClick={run}>{t('network.backupNow')}</Button>
        </div>
      )}
    </Card>
  );
}
