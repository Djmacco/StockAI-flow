/**
 * Endpoint detector: decides WHEN the person starts and stops talking, from per-frame loudness (RMS).
 * Pure logic (no audio APIs) so it is unit-tested. The noise floor is measured in the first moments,
 * so it works in a quiet shop and next to a noisy fridge.
 */
export interface VadConfig {
  calibrationMs?: number;   // measure the room noise during this time
  minThreshold?: number;    // never trigger below this loudness
  maxThreshold?: number;    // never demand more than this (someone who talks right away is not 'noise')
  noiseMultiplier?: number; // speech must be this many times louder than the room
  silenceMs?: number;       // this much quiet after speech = finished
  noSpeechMs?: number;      // give up if nobody speaks for this long
  maxMs?: number;           // hard limit for one utterance
  minSpeechMs?: number;     // shorter bursts (clicks, bumps) are ignored
}
export type VadEvent = 'waiting' | 'speaking' | 'end' | 'no-speech' | 'max';

export const VAD_DEFAULTS: Required<VadConfig> = {
  calibrationMs: 250, minThreshold: 0.012, maxThreshold: 0.1, noiseMultiplier: 3, silenceMs: 1100, noSpeechMs: 7000, maxMs: 15000, minSpeechMs: 250,
};

export class EndpointDetector {
  private c: Required<VadConfig>;
  private elapsed = 0;
  private noise = Infinity;
  private speaking = false;
  private speechMs = 0;
  private lastVoice = 0;
  /** Time (ms from start) when the current/last speech burst began. */
  speechStartMs = 0;

  constructor(cfg: VadConfig = {}) { this.c = { ...VAD_DEFAULTS, ...cfg }; }

  get threshold() { return Math.min(this.c.maxThreshold, Math.max(this.c.minThreshold, (Number.isFinite(this.noise) ? this.noise : 0) * this.c.noiseMultiplier)); }

  push(rms: number, ms: number): VadEvent {
    this.elapsed += ms;
    // Any frame that STARTS inside the calibration window counts (real frames last ~85-256 ms, so a strict
    // 'ends before 250 ms' test would skip calibration entirely and break in noisy rooms).
    if (this.elapsed - ms < this.c.calibrationMs) {
      this.noise = Math.min(this.noise, Math.max(rms, 0.002)); // the quietest frame ≈ the room
      return 'waiting';
    }
    if (rms > this.threshold) {
      if (!this.speaking) { this.speaking = true; this.speechStartMs = this.elapsed - ms; }
      this.speechMs += ms;
      this.lastVoice = this.elapsed;
    } else if (this.speaking && this.elapsed - this.lastVoice >= this.c.silenceMs) {
      if (this.speechMs >= this.c.minSpeechMs) return 'end';
      this.speaking = false; this.speechMs = 0;          // it was just a click or a bump
    }
    if (this.elapsed >= this.c.maxMs) return this.speaking ? 'max' : 'no-speech';
    if (!this.speaking && this.elapsed >= this.c.noSpeechMs) return 'no-speech';
    return this.speaking ? 'speaking' : 'waiting';
  }
}
