import { peakNormalize, resampleLinear } from './audio';
import { EndpointDetector, type VadConfig } from './vad';

/** Offline capture with browser noise suppression, native filters, and bounded pre-roll. */
export interface CaptureOptions { onLevel?: (level01: number) => void; onSpeechStart?: () => void; cfg?: VadConfig }
export type CaptureReason = 'end' | 'max' | 'no-speech' | 'cancelled' | 'manual';
export interface CaptureResult { samples: Float32Array | null; reason: CaptureReason }
export interface Capture { done: Promise<CaptureResult>; finish(): void; cancel(): void }

const TARGET_RATE = 16000;
const PRE_ROLL_MS = 400;
const PROCESSOR_BUFFER = 4096;

export function startCapture(opts: CaptureOptions = {}): Capture {
  let stopNow: ((r: CaptureReason) => void) | null = null;
  let early: CaptureReason | null = null;
  const done = new Promise<CaptureResult>((resolve, reject) => {
    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: { ideal: 1 }, echoCancellation: { ideal: true }, noiseSuppression: { ideal: true },
          // Prevent the microphone AGC from raising room noise during pauses.
          autoGainControl: { ideal: false },
        } });
      } catch (e: any) {
        return reject(new Error(e?.name === 'NotFoundError' ? 'no-mic' : 'not-allowed'));
      }

      let ctx: AudioContext;
      try { ctx = new AudioContext({ sampleRate: TARGET_RATE }); } catch { ctx = new AudioContext(); }
      const source = ctx.createMediaStreamSource(stream);
      const highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass'; highPass.frequency.value = 90; highPass.Q.value = 0.707;
      const lowPass = ctx.createBiquadFilter();
      lowPass.type = 'lowpass'; lowPass.frequency.value = Math.min(7600, ctx.sampleRate * 0.45); lowPass.Q.value = 0.707;
      const proc = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
      const det = new EndpointDetector(opts.cfg);
      const frames: Float32Array[] = [];
      const preRoll: Float32Array[] = [];
      const preRollLimit = Math.round(ctx.sampleRate * PRE_ROLL_MS / 1000);
      let preRollSamples = 0;
      let started = false, finished = false;

      const rememberPreRoll = (input: Float32Array) => {
        const frame = new Float32Array(input);
        preRoll.push(frame); preRollSamples += frame.length;
        while (preRoll.length && preRollSamples - preRoll[0].length >= preRollLimit) preRollSamples -= preRoll.shift()!.length;
      };
      const finish = (reason: CaptureReason) => {
        if (finished) return;
        finished = true; proc.onaudioprocess = null;
        try { source.disconnect(); highPass.disconnect(); lowPass.disconnect(); proc.disconnect(); } catch { /* already disconnected */ }
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate; void ctx.close().catch(() => undefined);
        if (reason === 'cancelled' || reason === 'no-speech' || (reason === 'manual' && !started))
          return resolve({ samples: null, reason: reason === 'manual' ? 'no-speech' : reason });
        const total = frames.reduce((sum, frame) => sum + frame.length, 0);
        const all = new Float32Array(total); let offset = 0;
        for (const frame of frames) { all.set(frame, offset); offset += frame.length; }
        resolve({ samples: peakNormalize(resampleLinear(all, rate, TARGET_RATE)), reason });
      };
      stopNow = finish;
      if (early) return finish(early);

      proc.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let sum = 0; for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const vadEvent = det.push(rms, input.length / ctx.sampleRate * 1000);
        opts.onLevel?.(Math.min(1, rms * 9));
        if (vadEvent === 'speaking' && !started) {
          started = true; frames.push(...preRoll); preRoll.length = 0; preRollSamples = 0;
          frames.push(new Float32Array(input)); opts.onSpeechStart?.();
        } else if (started) frames.push(new Float32Array(input));
        else if (vadEvent === 'waiting') rememberPreRoll(input);
        if (vadEvent === 'end' || vadEvent === 'max' || vadEvent === 'no-speech') finish(vadEvent);
      };
      source.connect(highPass); highPass.connect(lowPass); lowPass.connect(proc);
      proc.connect(ctx.destination); // Some WebViews require an output connection to process audio.
    })();
  });
  return { done, finish: () => { early ??= 'manual'; stopNow?.('manual'); }, cancel: () => { early ??= 'cancelled'; stopNow?.('cancelled'); } };
}
