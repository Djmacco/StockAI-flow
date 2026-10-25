import { Check, Copy, KeyRound, Printer, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from './ui';
import { useApp } from '../state/app';
import { PrintPortal } from './PrintPortal';

/** Printable sheet (hidden on screen, printed through the same print stylesheet as receipts). */
function PrintSheet({ code }: { code: string }) {
  const { t } = useTranslation();
  const name = useApp((s) => s.settings.business_name);
  return (
    <PrintPortal><div className="receipt-root" style={{ fontSize: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 14, textAlign: 'center' }}>{name}</div>
      <div style={{ textAlign: 'center', margin: '6px 0' }}>{t('recovery.printTitle')}</div>
      <div style={{ border: '1px solid #000', padding: 8, textAlign: 'center', fontWeight: 700, fontSize: 15, letterSpacing: 1 }}>{code}</div>
      <p style={{ marginTop: 8 }}>{t('recovery.printNote')}</p>
    </div></PrintPortal>
  );
}

export function KeyBox({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="select-all rounded-lg border-2 border-dashed border-brand bg-brand-soft px-4 py-5 text-center font-mono text-[22px] font-bold tracking-[0.15em] text-ink" data-testid="recovery-key">{code}</div>
      <div className="mt-3 flex justify-center gap-2">
        <Button variant="secondary" size="sm" icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ } }}>{copied ? t('recovery.copied') : t('recovery.copy')}</Button>
        <Button variant="secondary" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('recovery.print')}</Button>
      </div>
      <PrintSheet code={code} />
    </div>
  );
}

/** Blocking screen shown once after first setup: the user must confirm they stored the key. */
export function RecoveryKeyScreen({ code }: { code: string }) {
  const { t } = useTranslation();
  const ack = useApp((s) => s.ackRecoveryKey);
  const [ok, setOk] = useState(false);
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[520px] rounded-lg border border-line bg-surface p-7 shadow-pop">
        <div className="mb-1 flex items-center gap-2 font-display text-[22px] font-bold text-ink"><KeyRound className="h-6 w-6 text-brand" />{t('recovery.title')}</div>
        <p className="mb-4 text-[13px] text-body">{t('recovery.intro')}</p>
        <KeyBox code={code} />
        <div className="mt-4 flex items-start gap-2 rounded border border-warn/40 bg-warn-soft p-3 text-[12px] text-warn-text"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{t('recovery.warning')}</div>
        <label className="mt-4 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />{t('recovery.saved')}</label>
        <Button size="lg" className="mt-4 w-full" disabled={!ok} onClick={ack}>{t('recovery.continue')}</Button>
      </div>
    </div>
  );
}

/** Used after a reset / regeneration: shows the NEW key. */
export function NewKeyModal({ code, onClose }: { code: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [ok, setOk] = useState(false);
  if (!code) return null;
  return (
    <Modal open title={t('recovery.newKeyTitle')} onClose={() => ok && onClose()} footer={<Button disabled={!ok} onClick={() => { setOk(false); onClose(); }}>{t('recovery.continue')}</Button>}>
      <p className="mb-3 text-[13px] text-body">{t('recovery.newKeyText')}</p>
      <KeyBox code={code} />
      <label className="mt-4 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />{t('recovery.saved')}</label>
    </Modal>
  );
}
