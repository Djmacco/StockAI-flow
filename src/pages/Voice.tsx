import { AlertTriangle, Bot, Check, Keyboard, MessageSquare, Mic, Send, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageList } from '../components/Messages';
import { Button, cn } from '../components/ui';
import { translate } from '../i18n';
import { useApp } from '../state/app';
import { type VoiceState, useAssistant, voiceState } from '../state/assistant';
import { useOnline } from '../state/hooks';
import { getSpeechProvider, ttsSupported } from '../voice/speech';

/** The animated agent: the orb breathes when idle, ripples while listening, spins while thinking, pulses with bars while speaking. */
export function Orb({ state, onClick, disabled, level = 0 }: { state: VoiceState; onClick: () => void; disabled?: boolean; level?: number }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-[300px] w-[300px] items-center justify-center" data-state={state} data-testid="voice-orb">
      {state === 'listening' && <span aria-hidden data-testid="voice-level" className="absolute h-[180px] w-[180px] rounded-full bg-ai/30 transition-transform duration-75" style={{ transform: `scale(${1 + level * 0.75})`, opacity: 0.35 + level * 0.4 }} />}
      {state === 'listening' && [0, 0.7, 1.4].map((d) => <span key={d} className="orb-ripple absolute h-[180px] w-[180px] rounded-full border-2 border-ai/70" style={{ animationDelay: `${d}s` }} />)}
      {state === 'thinking' && <span className="orb-spin absolute h-[212px] w-[212px] rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent 0 70%, rgb(var(--ai)) 100%)', WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))', mask: 'radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))' }} />}
      <button onClick={onClick} disabled={disabled} aria-label={t(`voice.state.${state}`)}
        className={cn('relative flex h-[180px] w-[180px] items-center justify-center rounded-full text-white transition-transform focus:outline-none focus-visible:ring-4 focus-visible:ring-ai/40 disabled:opacity-60',
          'bg-gradient-to-br from-ai via-ai to-brand', `orb-${state}`)}>
        <span className="absolute inset-2 rounded-full bg-gradient-to-b from-white/25 to-transparent" />
        {state === 'speaking'
          ? <span className="relative flex h-20 items-center gap-1.5">{[0, 0.15, 0.3, 0.45, 0.6, 0.45, 0.3, 0.15, 0].map((d, i) => <span key={i} className="orb-bar h-full w-2 rounded-full bg-white" style={{ animationDelay: `${d}s` }} />)}</span>
          : <Mic className={cn('relative h-24 w-24 drop-shadow', state === 'listening' && 'orb-mic')} strokeWidth={1.6} />}
      </button>
    </div>
  );
}

export function VoicePage() {
  const { t } = useTranslation();
  const lang = useApp((s) => s.lang);
  const a = useAssistant();
  const state = voiceState(a);
  const sttOk = getSpeechProvider().supported();
  const [input, setInput] = useState(''); const [log, setLog] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastAssistant = [...a.msgs].reverse().find((m) => m.role === 'assistant');
  const lastUser = [...a.msgs].reverse().find((m) => m.role === 'user');
  const pending = a.hasPendingConfirmation();
  const stateLabel = a.transcribing ? t('voice.transcribing') : t(`voice.state.${state}`);

  useEffect(() => () => { useAssistant.getState().interrupt(); }, []);  // leaving the page stops mic + speech
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [a.msgs, log]);

  const click = () => {
    if (state === 'listening') a.stopListening();                 // "I'm done": transcribe what was said
    else if (state === 'speaking') a.interrupt();
    else if (state === 'idle') a.startListening();
  };
  const examples = [t('assistant.ex1'), t('assistant.ex2'), t('assistant.ex3'), t('assistant.ex4')];

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-gradient-to-b from-ai-soft/60 via-canvas to-canvas">
      <div className="flex items-center justify-between px-6 pt-5">
        <div><h1 className="font-display text-[24px] font-bold tracking-tight text-ink">{t('voice.title')}</h1><p className="text-[13px] text-faint">{t('voice.subtitle')}</p></div>
        <div className="flex items-center gap-2">
          <button onClick={() => a.setConversation(!a.conversation)} className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold', a.conversation ? 'border-ai bg-ai-soft text-ai-text' : 'border-line-strong bg-surface text-faint')} title={t('voice.conversationHint')}>
            <MessageSquare className="h-3.5 w-3.5" />{t('voice.conversation')}</button>
          {ttsSupported() && <button onClick={() => a.setVoiceReplies(!a.voiceReplies)} className="flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[12px] font-semibold text-body hover:bg-muted">{a.voiceReplies ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}{a.voiceReplies ? t('voice.voiceOn') : t('voice.voiceOff')}</button>}
          <button onClick={() => setLog(!log)} className="flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[12px] font-semibold text-body hover:bg-muted"><Bot className="h-3.5 w-3.5" />{t('voice.history')} ({a.msgs.length})</button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-6">
          <EngineBadge />
          <Orb state={state} level={a.level} onClick={click} disabled={(!sttOk && state === 'idle') || state === 'thinking'} />
          <div className="text-center" aria-live="polite">
            <div className="font-display text-[22px] font-semibold text-ink">{stateLabel}</div>
            <div className="mt-1 min-h-[22px] text-[14px] text-faint">{state === 'listening' ? (a.interim ? `« ${a.interim} »` : t('voice.sayIt')) : state === 'idle' ? (a.notice ?? (sttOk ? t('voice.tapToTalk') : t('voice.noMic'))) : ''}</div>
          </div>

          {lastUser && <div className="max-w-xl rounded-full bg-brand px-4 py-1.5 text-[13px] text-on-brand">{lastUser.text}</div>}
          {lastAssistant && (
            <div className={cn('w-full max-w-xl rounded-xl border p-4 text-[14px] shadow-card', lastAssistant.confirm ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface')}>
              <div className="whitespace-pre-wrap text-ink">{lastAssistant.text}</div>
              {lastAssistant.rows && lastAssistant.rows.length > 0 && <div className="mt-2 divide-y divide-line/70 rounded border border-line">{lastAssistant.rows.map((r, i) => <div key={i} className="flex justify-between gap-3 px-3 py-1.5 text-[13px]"><span className="truncate">{r.label}</span><span className="num font-semibold">{r.value}</span></div>)}</div>}
              {lastAssistant.options && <div className="mt-3 flex flex-wrap gap-2">{lastAssistant.options.map((o) => <button key={o} onClick={() => a.send(o)} className="rounded-full border border-ai/40 bg-ai-soft px-3 py-1 text-[13px] font-medium text-ai-text hover:bg-ai hover:text-white">{o}</button>)}</div>}
            </div>)}
          {pending && (
            <div className="flex w-full max-w-xl gap-3">
              <Button size="lg" className="flex-1" icon={<Check className="h-5 w-5" />} onClick={() => a.send(translate(lang, 'assistant.yesWord'))}>{t('common.confirm')}</Button>
              <Button size="lg" className="flex-1" variant="secondary" icon={<X className="h-5 w-5" />} onClick={() => a.send(translate(lang, 'assistant.noWord'))}>{t('common.cancel')}</Button>
            </div>)}
          {!lastAssistant && <div className="flex max-w-2xl flex-wrap justify-center gap-2 pt-2">{examples.map((e) => <button key={e} onClick={() => a.send(e, sttOk)} className="rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] text-body shadow-card hover:border-ai/50 hover:bg-ai-soft">{e}</button>)}</div>}
        </div>

        {log && <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface"><div className="flex-1 space-y-2 overflow-y-auto p-4"><MessageList msgs={a.msgs} onPick={(o) => a.send(o)} /><div ref={bottom} /></div></aside>}
      </div>

      <form className="mx-auto flex w-full max-w-xl items-center gap-2 px-6 pb-5 pt-3" onSubmit={(e) => { e.preventDefault(); a.send(input); setInput(''); }}>
        <div className="relative flex-1"><Keyboard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('voice.typeInstead')} className="h-10 w-full rounded-full border border-line-strong bg-surface pl-9 pr-4 text-[13px] text-ink focus-ring" /></div>
        <Button type="submit" variant="ai" className="h-10 w-10 !rounded-full !p-0" disabled={!input.trim() || a.busy} icon={<Send className="h-4 w-4" />} aria-label="send" />
      </form>
    </div>
  );
}

/** Tells the owner which speech engine is active, and how to fix it when the offline model is missing. */
function EngineBadge() {
  const { t } = useTranslation();
  const e = useAssistant((s) => s.engine);
  const online = useOnline();
  if (e.kind === 'hybrid')
    return (
      <div data-testid="engine-badge" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border border-ok/30 bg-ok-soft px-3 py-1 text-[12px] font-semibold text-ok-text">
        <ShieldCheck className="h-3.5 w-3.5" />{t('voice.engine.hybrid')}
        <span data-testid="engine-now" className={cn('rounded-full px-2 py-0.5 text-[11px]', online ? 'bg-brand-soft text-brand' : 'bg-warn-soft text-warn-text')}>{online ? t('voice.engine.nowOnline') : t('voice.engine.nowOffline')}</span>
      </div>);
  if (e.kind === 'whisper')
    return <div data-testid="engine-badge" className="flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok-soft px-3 py-1 text-[12px] font-semibold text-ok-text"><ShieldCheck className="h-3.5 w-3.5" />{t('voice.engine.whisper')}{e.model ? ` · ${e.model}${e.sizeMb ? ` · ${e.sizeMb} MB` : ''}` : ''}</div>;
  const warn = e.kind === 'none' || e.reason === 'model-missing' || e.reason === 'not-compiled';
  return (
    <div data-testid="engine-badge" className={cn('max-w-xl rounded-lg border px-3 py-1.5 text-center text-[12px]', warn ? 'border-warn/40 bg-warn-soft text-warn-text' : 'border-line bg-surface text-faint')}>
      <span className="flex items-center justify-center gap-1.5 font-semibold">{warn && <AlertTriangle className="h-3.5 w-3.5" />}{e.kind === 'none' ? t('voice.engine.none') : t('voice.engine.web')}</span>
      {e.reason === 'model-missing' && <div className="mt-0.5">{t('voice.engine.modelMissingHelp')}{(e.searched ?? []).slice(0, 2).map((d) => <div key={d} className="break-all font-mono text-[10px]">{d}</div>)}</div>}
      {e.reason === 'not-compiled' && <div className="mt-0.5">{t('voice.engine.notCompiled')}</div>}
    </div>
  );
}
