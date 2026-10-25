import type { Lang } from '../lib/format';

/**
 * Voice interface = an ADDITIONAL input/output channel for the same assistant.
 * Speech-to-text goes through a provider interface so a fully offline engine (Whisper / Vosk bundled
 * with the app) can replace the default WebView speech API without touching the assistant or UI.
 *   Voice -> Speech-to-Text -> Assistant -> Services -> SQLite -> Assistant reply -> Text-to-Speech
 */
export interface Listener {
  /** "I'm done talking": stop recording but still process what was said. */
  stop: () => void;
  /** Abort and discard. */
  cancel?: () => void;
}
export interface ListenHandlers {
  onInterim?: (t: string) => void;
  onFinal: (t: string) => void;
  onEnd: () => void;
  onError: (code: string) => void;
  /** Microphone loudness 0..1 (offline engine) — drives the orb. */
  onLevel?: (level01: number) => void;
  /** Recording finished, the engine is now transcribing. */
  onProcessing?: () => void;
}
export interface SpeechProvider {
  readonly name: string;
  supported(): boolean;
  listen(lang: Lang, h: ListenHandlers): Listener;
}

const BCP47: Record<Lang, string> = { fr: 'fr-FR', en: 'en-US' };

/** Default provider: the speech API of the webview (WebView2 / WebKit). Availability depends on the OS. */
export const webSpeechProvider: SpeechProvider = {
  name: 'webview',
  supported() {
    const w = window as any;
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  },
  listen(lang, h) {
    const w = window as any;
    const Rec = w.SpeechRecognition || w.webkitSpeechRecognition;
    const r = new Rec();
    r.lang = BCP47[lang];
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = '';
    r.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
      }
      if (interim) h.onInterim?.(interim);
    };
    r.onerror = (e: any) => h.onError(String(e.error ?? 'error'));
    r.onend = () => { if (finalText.trim()) h.onFinal(finalText.trim()); h.onEnd(); };
    try { r.start(); } catch { h.onError('start-failed'); }
    return { stop: () => { try { r.stop(); } catch { /* already stopped */ } }, cancel: () => { try { r.abort(); } catch { /* already stopped */ } } };
  },
};

let provider: SpeechProvider = webSpeechProvider;
export const setSpeechProvider = (p: SpeechProvider) => { provider = p; };
export const getSpeechProvider = () => provider;

// ------------------------------------------------------------------ text to speech (OS voices, works offline)
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

export function speak(text: string, lang: Lang): Promise<void> {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/\u00a0/g, ' '));
    u.lang = BCP47[lang];
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
    if (voice) u.voice = voice;
    u.rate = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}
export const stopSpeaking = () => { if (ttsSupported()) window.speechSynthesis.cancel(); };
