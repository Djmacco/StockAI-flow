import { Check, Loader2, Search, X } from 'lucide-react';
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../state/app';

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'ai';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-muted',
  danger: 'bg-bad-soft text-bad-text border-bad/30 hover:bg-bad/20',
  ghost: 'bg-transparent text-body border-transparent hover:bg-muted',
  ai: 'bg-ai-soft text-ai-text border-ai/40 hover:bg-ai hover:text-white',
};
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; loading?: boolean }
export function Button({ variant = 'primary', size = 'md', icon, loading, children, className, disabled, ...p }: BtnProps) {
  return (
    <button
      {...p}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
        size === 'sm' ? 'h-8 px-2.5 text-[12px]' : size === 'lg' ? 'h-12 px-5 text-[15px]' : 'h-9 px-3.5 text-[13px]',
        VARIANTS[variant], className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Inputs
const inputCls = 'h-9 w-full rounded border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-faint/70 focus-ring disabled:bg-muted disabled:text-faint';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} {...p} className={cn(inputCls, p.type === 'number' && 'num', className)} />
));
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => (
  <select ref={ref} {...p} className={cn(inputCls, 'pr-8', className)} />
));
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} {...p} className={cn(inputCls, 'h-auto py-2', className)} />
));
export function Field({ label, hint, required, children, className }: { label: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-[12px] font-medium text-body">{label}{required && <span className="ml-0.5 text-bad">*</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}
export function SearchInput({ value, onChange, placeholder, shortcut, autoFocus, inputRef, onEnter }: {
  value: string; onChange: (v: string) => void; placeholder?: string; shortcut?: string; autoFocus?: boolean; inputRef?: React.Ref<HTMLInputElement>; onEnter?: () => void;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
      <Input ref={inputRef} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()} className="pl-9 pr-12" />
      {shortcut && <span className="kbd absolute right-2 top-1/2 -translate-y-1/2">{shortcut}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ Containers
export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="font-display text-[14px] font-semibold text-ink">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cn('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'ai' | 'neutral';
const TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok-text border-ok/30', warn: 'bg-warn-soft text-warn-text border-warn/30', bad: 'bg-bad-soft text-bad-text border-bad/30',
  info: 'bg-brand-soft text-brand border-brand/30', ai: 'bg-ai-soft text-ai-text border-ai/30', neutral: 'bg-muted text-body border-line',
};
export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold', TONES[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}{children}
    </span>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('flex max-h-[92vh] w-full flex-col rounded-lg border border-line-strong bg-surface shadow-modal', wide === 'xl' ? 'max-w-5xl' : wide ? 'max-w-2xl' : 'max-w-md')} role="dialog" aria-modal="true">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-display text-[16px] font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-faint hover:bg-muted hover:text-ink" aria-label="close"><X className="h-4 w-4" /></button>
        </header>
        <div className="overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line bg-muted/40 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel, danger, onConfirm, onCancel, busy }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} title={title} onClose={onCancel}
      footer={<><Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</Button></>}>
      <div className="text-[13px] text-body">{message}</div>
    </Modal>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((tb) => (
        <button key={tb.id} onClick={() => onChange(tb.id)}
          className={cn('-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors', value === tb.id ? 'border-brand text-brand' : 'border-transparent text-faint hover:text-ink')}>
          {tb.label}{tb.badge}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded border border-line-strong bg-muted p-0.5">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} className={cn('rounded px-2.5 py-1 text-[12px] font-semibold', value === o.id ? 'bg-surface text-ink shadow-card' : 'text-faint hover:text-ink')}>{o.label}</button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="font-display text-[15px] font-semibold text-ink">{title}</div>
      {hint && <div className="max-w-sm text-[13px] text-faint">{hint}</div>}
      {action}
    </div>
  );
}

export const Spinner = () => <Loader2 className="h-5 w-5 animate-spin text-faint" />;
export const PageLoader = () => <div className="flex h-40 items-center justify-center"><Spinner /></div>;

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[24px] font-bold leading-8 tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="text-[13px] text-faint">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

// ------------------------------------------------------------------ Toasts
export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[60] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={cn('pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] shadow-pop',
          t.kind === 'error' ? 'border-bad/40 bg-bad-soft text-bad-text' : t.kind === 'success' ? 'border-ok/40 bg-ok-soft text-ok-text' : 'border-line bg-surface text-body')}>
          {t.kind === 'success' && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Wraps an async handler: busy state + translated error toast. Local data is never at risk from a failed UI action. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const fail = useApp((s) => s.fail);
  const run = async (...a: A) => {
    setBusy(true);
    try { await fn(...a); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return { run, busy };
}

export function Pill({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: Tone; icon?: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide', TONES[tone])}>{icon}{children}</span>;
}
