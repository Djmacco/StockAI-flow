import type { AssistantMessage } from '../ai/assistant';
import { cn } from './ui';

/** Chat bubbles with optional rows (tables) and quick-pick options. Shared by the drawer and the Voice page. */
export function MessageList({ msgs, onPick }: { msgs: AssistantMessage[]; onPick: (o: string) => void }) {
  return (
    <>
      {msgs.map((m) => (
        <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
          <div className={cn('max-w-[92%] rounded-lg px-3 py-2 text-[13px]', m.role === 'user' ? 'bg-brand text-on-brand' : m.confirm ? 'border border-warn/40 bg-warn-soft text-ink' : 'border border-line bg-muted/60 text-ink')}>
            <div className="whitespace-pre-wrap">{m.text}</div>
            {m.rows && m.rows.length > 0 && (
              <div className="mt-2 divide-y divide-line/70 rounded border border-line bg-surface">
                {m.rows.map((r, i) => <div key={i} className="flex justify-between gap-3 px-2 py-1 text-[12px]"><span className="truncate">{r.label}</span><span className="num shrink-0 font-semibold">{r.value}</span></div>)}
              </div>)}
            {m.options && <div className="mt-2 flex flex-wrap gap-1.5">{m.options.map((o) => <button key={o} onClick={() => onPick(o)} className="rounded-full border border-ai/40 bg-ai-soft px-2.5 py-1 text-[12px] font-medium text-ai-text hover:bg-ai hover:text-white">{o}</button>)}</div>}
          </div>
        </div>
      ))}
    </>
  );
}
