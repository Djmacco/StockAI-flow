import { Bot, Lightbulb, Mic, MicOff, Send, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { translate } from '../i18n';
import { useApp } from '../state/app';
import { useAssistant } from '../state/assistant';
import { getSpeechProvider, ttsSupported } from '../voice/speech';
import { MessageList } from './Messages';
import { Button, cn } from './ui';

/** Right-hand drawer: text AND voice talk to the same controlled assistant (see also the Voice page). */
export function AssistantPanel() {
  const { t } = useTranslation();
  const open = useApp((s) => s.assistantOpen);
  const lang = useApp((s) => s.lang);
  const a = useAssistant();
  const [input, setInput] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const sttOk = getSpeechProvider().supported();
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [a.msgs, a.interim, a.busy]);
  if (!open) return null;
  const pending = a.hasPendingConfirmation();
  const examples = [t('assistant.ex1'), t('assistant.ex2'), t('assistant.ex3'), t('assistant.ex4')];

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-ai/40 bg-surface shadow-pop">
      <header className="flex items-center justify-between border-b border-ai/30 bg-ai-soft px-4 py-3">
        <div className="flex items-center gap-2 font-display text-[15px] font-semibold text-ai-text"><Sparkles className="h-4 w-4" />{t('assistant.title')}</div>
        <div className="flex items-center gap-1">
          {ttsSupported() && <button onClick={() => a.setVoiceReplies(!a.voiceReplies)} className="rounded p-1.5 text-ai-text hover:bg-ai/10" title={t('assistant.voiceReplies')}>{a.voiceReplies ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</button>}
          <button onClick={() => { a.interrupt(); useApp.getState().setAssistantOpen(false); }} className="rounded p-1.5 text-ai-text hover:bg-ai/10" aria-label="close"><X className="h-4 w-4" /></button>
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {a.msgs.length === 0 && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-line bg-muted/50 p-3 text-[13px]"><Bot className="mt-0.5 h-4 w-4 shrink-0 text-ai" /><span>{t('assistant.welcome')}</span></div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t('assistant.try')}</div>
            <div className="flex flex-col gap-1.5">{examples.map((e) => <button key={e} onClick={() => a.send(e)} className="rounded border border-line bg-surface px-3 py-2 text-left text-[13px] hover:border-ai/50 hover:bg-ai-soft">{e}</button>)}</div>
            <div className="flex items-start gap-2 text-[11px] text-faint"><Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('assistant.safety')}</div>
          </div>)}
        <MessageList msgs={a.msgs} onPick={(o) => a.send(o)} />
        {a.interim && <div className="text-right text-[13px] italic text-faint">{a.interim}…</div>}
        {a.busy && <div className="text-[12px] text-faint">…</div>}
        <div ref={bottom} />
      </div>
      {pending && (
        <div className="flex gap-2 border-t border-warn/40 bg-warn-soft px-4 py-2.5">
          <Button className="flex-1" onClick={() => a.send(translate(lang, 'assistant.yesWord'))}>{t('common.confirm')}</Button>
          <Button className="flex-1" variant="secondary" onClick={() => a.send(translate(lang, 'assistant.noWord'))}>{t('common.cancel')}</Button>
        </div>)}
      <form className="flex items-center gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); a.send(input); setInput(''); }}>
        <button type="button" onClick={() => (a.listening ? a.stopListening() : a.startListening())} disabled={!sttOk} title={sttOk ? t('assistant.mic') : t('assistant.micUnsupported')}
          className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-40', a.listening ? 'animate-pulse border-ai bg-ai text-white' : 'border-ai/40 bg-ai-soft text-ai-text hover:bg-ai hover:text-white')}>
          {a.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={a.listening ? t('assistant.listening') : t('assistant.placeholder')} className="h-9 min-w-0 flex-1 rounded border border-line-strong bg-surface px-3 text-[13px] text-ink focus-ring" />
        <Button type="submit" variant="ai" icon={<Send className="h-4 w-4" />} disabled={!input.trim() || a.busy} aria-label="send" />
      </form>
      {!sttOk && <div className="border-t border-line bg-muted/50 px-4 py-1.5 text-[11px] text-faint">{t('assistant.micUnsupported')}</div>}
    </aside>
  );
}
