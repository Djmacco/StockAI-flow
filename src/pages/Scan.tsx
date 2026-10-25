import { Camera, Crown, Lock, ScanLine, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CloudError } from '../cloud/client';
import { hasFeature } from '../entitlement/entitlement';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, useAction } from '../components/ui';
import { fileToBase64 } from '../lib/image';
import { listProducts } from '../services/products';
import { applyScan, buildProposals, type ScanProposal } from '../services/scan';
import { rt, useApp, useCtx } from '../state/app';
import { formatQty } from '../lib/format';

const DEMO = import.meta.env.DEV;

export function Scan() {
  const { t } = useTranslation();
  const nav = useNavigate(); const ctx = useCtx(); const { lang, entitlement, toast } = useApp();
  const unlocked = hasFeature(entitlement, 'AI_STORE_SCAN');
  const [trialAvailable, setTrialAvailable] = useState<boolean | null>(null);
  const [trialIssue, setTrialIssue] = useState<'setup' | 'check' | 'used' | 'main-device' | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ScanProposal[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [cam, setCam] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => () => stream.current?.getTracks().forEach((x) => x.stop()), []);
  useEffect(() => {
    let live = true;
    if (unlocked) { setTrialAvailable(false); setTrialIssue(null); return () => { live = false; }; }
    void (async () => {
      try {
        const cloud = rt().cloud;
        const hasSession = await cloud.hasSession();
        const configured = await cloud.isConfigured();
        if (!hasSession || !configured) {
          if (live) { setTrialAvailable(false); setTrialIssue('setup'); }
          return;
        }
        const status = await cloud.trialStatus();
        if (live) {
          setTrialAvailable(!!status.scan.available);
          setTrialIssue(status.scan.available ? null : status.scan.used ? 'used' : !status.mainDevice ? 'main-device' : null);
        }
      } catch { if (live) { setTrialAvailable(false); setTrialIssue('check'); } }
    })();
    return () => { live = false; };
  }, [unlocked, ctx.db]);

  const pick = (f: File) => { setFile(f); setPreview(URL.createObjectURL(f)); setRows(null); setEdit({}); setSkip(new Set()); };
  const startCam = async () => {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setCam(true); setTimeout(() => { if (video.current) video.current.srcObject = stream.current; }, 50);
    } catch { toast('error', t('scan.cameraError')); }
  };
  const snap = () => {
    const v = video.current; if (!v) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) pick(new File([b], 'scan.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.85);
    stream.current?.getTracks().forEach((x) => x.stop()); setCam(false);
  };

  const analyze = useAction(async () => {
    if (!file) return;
    try {
      const res = await rt().cloud.storeScan(await fileToBase64(file), file.type || 'image/jpeg', lang);
      setRows(await buildProposals(ctx, res.detections));
      if (!unlocked) { setTrialAvailable(false); setTrialIssue('used'); }
    } catch (e) {
      if (e instanceof CloudError && e.reason === 'TRIAL_SCAN_USED') { setTrialAvailable(false); setTrialIssue('used'); toast('info', t('scan.trialUsed')); }
      else if (e instanceof CloudError) toast('error', t(`scan.err.${e.kind}`, { defaultValue: t('scan.err.SERVER') }));
      else throw e;
      if (!unlocked) {
        try {
          const status = await rt().cloud.trialStatus();
          setTrialAvailable(status.scan.available);
          setTrialIssue(status.scan.available ? null : status.scan.used ? 'used' : !status.mainDevice ? 'main-device' : null);
        } catch { setTrialAvailable(false); setTrialIssue('check'); }
      }
    }
  });
  const demo = useAction(async () => { // DEV builds only: lets you try the review flow without the backend
    const ps = (await listProducts(ctx, { limit: 4 })).items;
    setRows(await buildProposals(ctx, ps.map((p, i) => ({ label: p.name, quantity: i === 2 ? null : Math.max(0, Math.round(p.quantity) + (i % 2 ? -2 : 3)), confidence: i === 2 ? 'LOW' : i === 3 ? 'MEDIUM' : 'HIGH' }))));
  });

  const value = (r: ScanProposal) => (edit[r.key] !== undefined ? edit[r.key] : r.counted === null ? '' : String(r.counted));
  const changes = (rows ?? []).filter((r) => r.product && !skip.has(r.key) && value(r) !== '').map((r) => ({ product_id: r.product!.id, counted: Number(value(r)) }));
  const apply = useAction(async () => { const n = await applyScan(ctx, changes); toast('success', t('scan.applied', { count: n })); setRows(null); setPreview(null); setFile(null); });

  if (!unlocked && trialAvailable === null) return <div><PageHeader title={t('scan.title')} subtitle={t('scan.subtitle')} /><Card><Empty title={t('scan.checkingTrial')} /></Card></div>;

  if (!unlocked && !trialAvailable && !rows) return (
    <div><PageHeader title={t('scan.title')} subtitle={t('scan.subtitle')} />
      <Card><Empty icon={<Lock className="h-10 w-10" />} title={t('scan.locked')} hint={trialIssue === 'setup' ? t('scan.trialSetup') : trialIssue === 'check' ? t('scan.trialCheckFailed') : trialIssue === 'main-device' ? t('scan.trialMainDevice') : trialIssue === 'used' ? t('scan.trialUsed') : entitlement.state === 'EXPIRED' ? t('scan.lockedExpired') : t('scan.lockedHint')}
        action={trialIssue === 'setup' || trialIssue === 'check'
          ? <Button variant="secondary" onClick={() => nav('/settings?tab=sync')}>{t('scan.trialSetupAction')}</Button>
          : <Button variant="ai" icon={<Crown className="h-4 w-4" />} onClick={() => nav('/settings?tab=subscription')}>{t('dashboard.premiumCta')}</Button>} /></Card></div>
  );

  return (
    <div>
      <PageHeader title={t('scan.title')} subtitle={t('scan.subtitle')} actions={unlocked ? <Badge tone="ai"><Crown className="mr-1 h-3 w-3" />Premium</Badge> : <Badge tone="ok">{t('scan.trialBadge')}</Badge>} />
      {!unlocked && trialAvailable && <div className="mb-4 rounded-lg border border-ok/30 bg-ok-soft px-4 py-3 text-[13px] text-ok-text">{t('scan.trialAvailable')}</div>}
      <div className="grid grid-cols-[360px_1fr] gap-5">
        <Card title={t('scan.image')}>
          {cam ? (<div className="space-y-2"><video ref={video} autoPlay playsInline className="w-full rounded border border-line" /><Button className="w-full" onClick={snap} icon={<Camera className="h-4 w-4" />}>{t('scan.capture')}</Button></div>)
            : preview ? <img src={preview} alt="" className="w-full rounded border border-line" />
            : <div className="flex h-48 items-center justify-center rounded border-2 border-dashed border-line-strong text-center text-[13px] text-faint"><ScanLine className="mr-2 h-5 w-5" />{t('scan.noImage')}</div>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded border border-line-strong bg-surface text-[13px] font-semibold hover:bg-muted"><Upload className="h-4 w-4" />{t('scan.upload')}<input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} /></label>
            <Button variant="secondary" icon={<Camera className="h-4 w-4" />} onClick={startCam}>{t('scan.camera')}</Button>
          </div>
          <Button className="mt-3 w-full" variant="ai" disabled={!file || (!unlocked && !trialAvailable)} loading={analyze.busy} onClick={() => analyze.run()} icon={<ScanLine className="h-4 w-4" />}>{!unlocked && trialAvailable ? t('scan.tryFree') : t('scan.analyze')}</Button>
          {DEMO && <Button className="mt-2 w-full" variant="ghost" size="sm" loading={demo.busy} onClick={() => demo.run()}>DEV: demo detections</Button>}
          <p className="mt-3 text-[11px] text-faint">{t('scan.onlineNote')}</p>
        </Card>

        <Card title={t('scan.proposal')} bodyClass="!p-0">
          {!rows ? <Empty title={t('scan.noResult')} hint={t('scan.noResultHint')} /> : rows.length === 0 ? <Empty title={t('scan.nothingFound')} /> : (<>
            <table className="tbl"><thead><tr><th className="w-8" /><th>{t('scan.detected')}</th><th>{t('scan.matchedProduct')}</th><th className="r">{t('scan.current')}</th><th className="w-32">{t('scan.counted')}</th><th>{t('scan.confidence')}</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.key} className={skip.has(r.key) ? 'opacity-40' : ''}>
                  <td><input type="checkbox" checked={!skip.has(r.key) && !!r.product} disabled={!r.product} onChange={() => setSkip((s) => { const n = new Set(s); n.has(r.key) ? n.delete(r.key) : n.add(r.key); return n; })} /></td>
                  <td className="font-medium">{r.detection.label}</td>
                  <td>{r.product ? r.product.name : <span className="text-bad-text">{t('scan.noMatch')}</span>}</td>
                  <td className="r text-faint">{r.current !== null ? formatQty(r.current, lang) : '—'}</td>
                  <td><Input type="number" min={0} disabled={!r.product} value={value(r)} placeholder={t('scan.enterQty')} onChange={(e) => setEdit({ ...edit, [r.key]: e.target.value })} className={r.counted === null && value(r) === '' ? '!border-warn' : ''} /></td>
                  <td>{r.confidence === 'NONE' ? <Badge>—</Badge> : <Badge tone={r.confidence === 'HIGH' ? 'ok' : r.confidence === 'MEDIUM' ? 'warn' : 'bad'}>{t(`scan.conf.${r.confidence}`)}</Badge>}{r.counted === null && r.product && <div className="text-[11px] text-warn-text">{t('scan.uncertain')}</div>}</td></tr>))}</tbody></table>
            <div className="flex items-center justify-between border-t border-line bg-muted/40 px-4 py-3">
              <span className="text-[12px] text-faint">{t('scan.confirmNote')}</span>
              <Button loading={apply.busy} disabled={!changes.length} onClick={() => apply.run()}>{t('scan.apply', { count: changes.length })}</Button></div></>)}
        </Card>
      </div>
    </div>
  );
}
void Select;
