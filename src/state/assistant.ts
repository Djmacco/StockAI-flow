import { create } from 'zustand';
import { Assistant, type AssistantMessage } from '../ai/assistant';
import { translate } from '../i18n';
import { uuid } from '../lib/ids';
import { buildVocabularyPrompt } from '../voice/audio';
import { detectEngine, type EngineInfo } from '../voice/engine';
import { getSpeechProvider, setSpeechProvider, speak, stopSpeaking, ttsSupported, type Listener } from '../voice/speech';
import { speechVocabulary } from '../services/products';
import { getCtx, rt, useApp } from './app';

/**
 * ONE conversation shared by the side drawer and the Voice page.
 * Voice states:  idle -> listening -> thinking -> speaking -> (listening again in conversation mode)
 */
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface AState {
  msgs: AssistantMessage[];
  busy: boolean;
  listening: boolean;
  speaking: boolean;
  /** Recording is over and the engine is turning audio into text. */
  transcribing: boolean;
  /** Microphone loudness 0..1 (offline engine) — makes the orb react to the real voice. */
  level: number;
  /** Short message under the orb (e.g. "I heard nothing"). */
  notice: string | null;
  engine: EngineInfo;
  interim: string;
  voiceReplies: boolean;
  conversation: boolean;
  send: (text: string, viaVoice?: boolean) => Promise<void>;
  startListening: () => void;
  stopListening: () => void;
  interrupt: () => void;
  setVoiceReplies: (b: boolean) => void;
  setConversation: (b: boolean) => void;
  reset: () => void;
  hasPendingConfirmation: () => boolean;
}

let assistant: Assistant | null = null;
let listener: Listener | null = null;
const get = () => {
  assistant ??= new Assistant({
    ctx: getCtx, t: translate, uiLang: () => useApp.getState().lang,
    entitlement: () => useApp.getState().entitlement, syncStatus: () => rt().sync.getStatus(),
  });
  return assistant;
};

export const voiceState = (s: Pick<AState, 'busy' | 'listening' | 'speaking' | 'transcribing'>): VoiceState =>
  s.listening ? 'listening' : s.busy || s.transcribing ? 'thinking' : s.speaking ? 'speaking' : 'idle';

export const useAssistant = create<AState>((set, getS) => ({
  msgs: [], busy: false, listening: false, speaking: false, transcribing: false, level: 0, notice: null, engine: { kind: 'web' }, interim: '', voiceReplies: true, conversation: true,

  async send(text, viaVoice = false) {
    const clean = text.trim();
    if (!clean || getS().busy) return;
    const lang = useApp.getState().lang;
    set({ msgs: [...getS().msgs, { id: uuid(), role: 'user', text: clean, lang }], busy: true, interim: '' });
    const replies = await get().send(clean);
    set({ msgs: [...getS().msgs, ...replies], busy: false });

    const last = replies[replies.length - 1];
    if (viaVoice && getS().voiceReplies && ttsSupported() && last) {
      const spoken = last.confirm ? `${last.text} ${translate(last.lang, 'ai.voiceConfirmHint')}` : last.text;
      set({ speaking: true });
      await speak(spoken, last.lang);
      set({ speaking: false });
    }
    // Hands-free: always listen for yes/no after a confirmation request; otherwise only in conversation mode.
    if (viaVoice && last && (last.confirm || getS().conversation)) getS().startListening();
  },

  startListening() {
    const p = getSpeechProvider();
    if (!p.supported() || getS().listening || getS().transcribing) return;
    stopSpeaking(); set({ speaking: false, listening: true, interim: '', notice: null, level: 0 });
    const lang = useApp.getState().lang;
    let lastLevel = 0;
    listener = p.listen(lang, {
      onInterim: (t) => set({ interim: t }),
      onLevel: (l) => { if (Math.abs(l - lastLevel) > 0.04) { lastLevel = l; set({ level: l }); } },
      onProcessing: () => set({ listening: false, transcribing: true, level: 0 }),
      onFinal: (t) => { set({ interim: '', transcribing: false }); void getS().send(t, true); },
      onEnd: () => { listener = null; set({ listening: false, transcribing: false, interim: '', level: 0 }); },
      onError: (code) => {
        set({ listening: false, transcribing: false, interim: '', level: 0 });
        if (code === 'no-speech') return void set({ notice: translate(lang, 'voice.noSpeech') });
        const key = code === 'not-allowed' ? 'voice.micDenied' : code === 'no-mic' ? 'voice.noMicDevice' : code === 'model-missing' ? 'voice.engine.modelMissing' : 'voice.engineFailed';
        useApp.getState().toast('error', translate(lang, key));
      },
    });
  },
  stopListening() { listener?.stop(); },                       // "I'm done talking": still transcribes what was said
  interrupt() { const l = listener; listener = null; (l?.cancel ?? l?.stop)?.call(l); stopSpeaking(); set({ listening: false, transcribing: false, speaking: false, interim: '', level: 0 }); },
  setVoiceReplies(voiceReplies) { if (!voiceReplies) stopSpeaking(); set({ voiceReplies, speaking: voiceReplies ? getS().speaking : false }); },
  setConversation(conversation) { set({ conversation }); },
  reset() { const l = listener; listener = null; (l?.cancel ?? l?.stop)?.call(l); stopSpeaking(); assistant?.reset(); assistant = null; set({ msgs: [], busy: false, listening: false, speaking: false, transcribing: false, level: 0, notice: null, interim: '' }); },
  hasPendingConfirmation: () => !!get().hasPendingConfirmation() && getS().msgs.length > 0 && !!getS().msgs[getS().msgs.length - 1].confirm,
}));

// Logging out wipes the conversation (and any pending, unconfirmed action).
useApp.subscribe((s, prev) => { if (prev.user && !s.user) useAssistant.getState().reset(); });

/** Called once at startup: installs the offline Whisper engine when the model file is present. */
export async function initVoice() {
  const { info, provider } = await detectEngine({
    desktop: useApp.getState().desktop,
    vocabulary: async (lang) => buildVocabularyPrompt(lang, await speechVocabulary(getCtx(), 40)),
  });
  setSpeechProvider(provider);
  useAssistant.setState({ engine: info });
}
