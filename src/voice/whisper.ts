import type { Lang } from '../lib/format';
import { cleanTranscript, floatToPcm16Bytes } from './audio';
import { type Capture, type CaptureOptions, startCapture } from './recorder';
import type { ListenHandlers, Listener, SpeechProvider } from './speech';

/**
 * Offline speech provider: microphone -> endpoint detection -> 16 kHz PCM -> Whisper (Rust, on this machine).
 * Everything is injectable, so the whole flow is tested without a microphone or a model file.
 */
export interface WhisperDeps {
  capture: (o: CaptureOptions) => Capture;
  transcribe: (pcm: Uint8Array, lang: Lang, prompt: string) => Promise<string>;
  /** Vocabulary hint (product names...) for this language. */
  vocabulary: (lang: Lang) => Promise<string>;
  canCapture?: () => boolean;
}

export const errorCode = (e: unknown): string => {
  const m = String((e as any)?.message ?? e);
  if (m.includes('not-allowed') || m.includes('Permission')) return 'not-allowed';
  if (m.includes('no-mic')) return 'no-mic';
  if (m.includes('model_missing')) return 'model-missing';
  return 'engine-failed';
};

export function createWhisperProvider(deps: WhisperDeps): SpeechProvider {
  return {
    name: 'whisper',
    supported: () => (deps.canCapture ? deps.canCapture() : typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia),
    listen(lang: Lang, h: ListenHandlers): Listener {
      let cancelled = false;
      const cap = deps.capture({ onLevel: h.onLevel });
      (async () => {
        try {
          const r = await cap.done;
          if (cancelled || r.reason === 'cancelled') return;
          if (!r.samples) { h.onError('no-speech'); return; }
          h.onProcessing?.();
          const prompt = await deps.vocabulary(lang).catch(() => '');
          const raw = await deps.transcribe(floatToPcm16Bytes(r.samples), lang, prompt);
          if (cancelled) return;
          const text = cleanTranscript(raw);
          if (text) h.onFinal(text); else h.onError('no-speech');
        } catch (e) {
          if (!cancelled) h.onError(errorCode(e));
        } finally {
          h.onEnd();
        }
      })();
      return { stop: () => cap.finish(), cancel: () => { cancelled = true; cap.cancel(); } };
    },
  };
}

/** Real transcription through the Tauri command (raw binary request: no JSON overhead for the audio). */
export async function tauriTranscribe(pcm: Uint8Array, lang: Lang, prompt: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('stt_transcribe', pcm, { headers: { 'x-lang': lang, 'x-prompt': encodeURIComponent(prompt) } });
}

export { startCapture };
