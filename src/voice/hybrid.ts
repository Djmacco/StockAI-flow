import type { ListenHandlers, Listener, SpeechProvider } from './speech';

/**
 * HYBRID speech engine:
 *   internet available  -> the system's online speech recognition (as before)
 *   no internet         -> offline Whisper
 *   "online" but the online service fails (weak or captive connection) -> automatic fallback to Whisper
 * The choice is made fresh on every tap of the microphone, so it follows the connection as it comes and goes.
 */
const FALLBACK_CODES = new Set(['network', 'service-not-allowed', 'language-not-supported', 'start-failed', 'audio-capture-failed']);

export function createHybridProvider(online: SpeechProvider, offline: SpeechProvider, isOnline: () => boolean = () => typeof navigator === 'undefined' || navigator.onLine !== false): SpeechProvider {
  return {
    name: 'hybrid',
    supported: () => online.supported() || offline.supported(),
    listen(lang, h: ListenHandlers): Listener {
      const useOnline = isOnline() && online.supported();
      if (!useOnline) return offline.listen(lang, h);

      let current: Listener;
      let fellBack = false, cancelled = false, swallowedEnd = false;
      const wrapped: ListenHandlers = {
        ...h,
        onError: (code) => {
          if (!fellBack && !cancelled && FALLBACK_CODES.has(code) && offline.supported()) {
            fellBack = true;
            current = offline.listen(lang, h);            // the offline engine reports to the real handlers
            return;
          }
          h.onError(code);                                 // e.g. 'no-speech', 'not-allowed': not a connectivity problem
        },
        onEnd: () => {
          if (fellBack && !swallowedEnd) { swallowedEnd = true; return; } // the failed online attempt's "end" must not stop the offline one
          h.onEnd();
        },
      };
      current = online.listen(lang, wrapped);
      return {
        stop: () => current.stop(),
        cancel: () => { cancelled = true; (current.cancel ?? current.stop).call(current); },
      };
    },
  };
}
