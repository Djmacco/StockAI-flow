import type { Lang } from '../lib/format';
import { buildVocabularyPrompt } from './audio';
import { type SpeechProvider, webSpeechProvider } from './speech';
import { createHybridProvider } from './hybrid';
import { createWhisperProvider, startCapture, tauriTranscribe } from './whisper';

export interface EngineInfo {
  /** hybrid = online system recognition when connected, offline Whisper otherwise. */
  kind: 'hybrid' | 'whisper' | 'web' | 'none';
  model?: string;
  sizeMb?: number;
  /** Why the offline engine is not in use. */
  reason?: 'model-missing' | 'not-compiled' | 'no-mic-api' | 'browser' | 'status-failed';
  searched?: string[];
}
interface SttStatus { compiled: boolean; available: boolean; model: string | null; size_mb: number | null; searched: string[] }

export interface DetectDeps {
  desktop: boolean;
  status?: () => Promise<SttStatus>;
  vocabulary: (lang: Lang) => Promise<string>;
  webSupported?: () => boolean;
  canCapture?: () => boolean;
  isOnline?: () => boolean;
}

/**
 * Picks the speech engine:
 *   Whisper model present + system speech available -> HYBRID (online when connected, offline Whisper otherwise)
 *   Whisper only -> offline Whisper   ·   system speech only -> system speech   ·   neither -> none
 */
export async function detectEngine(d: DetectDeps): Promise<{ info: EngineInfo; provider: SpeechProvider }> {
  const webOk = (d.webSupported ?? (() => webSpeechProvider.supported()))();
  const fallback = (reason: EngineInfo['reason'], extra: Partial<EngineInfo> = {}) => ({ info: { kind: webOk ? 'web' : 'none', reason, ...extra } as EngineInfo, provider: webSpeechProvider });
  if (!d.desktop) return fallback('browser');
  const canCapture = d.canCapture ? d.canCapture() : typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  if (!canCapture) return fallback('no-mic-api');
  let st: SttStatus;
  try {
    st = d.status ? await d.status() : await (await import('@tauri-apps/api/core')).invoke<SttStatus>('stt_status');
  } catch { return fallback('status-failed'); }
  if (!st.compiled) return fallback('not-compiled');
  if (!st.available) return fallback('model-missing', { searched: st.searched });
  const whisper = createWhisperProvider({ capture: startCapture, transcribe: tauriTranscribe, vocabulary: d.vocabulary, canCapture: () => true });
  const model = { model: st.model ?? undefined, sizeMb: st.size_mb ?? undefined };
  if (webOk) return { info: { kind: 'hybrid', ...model }, provider: createHybridProvider(webSpeechProvider, whisper, d.isOnline) };
  return { info: { kind: 'whisper', ...model }, provider: whisper };
}

export { buildVocabularyPrompt };
