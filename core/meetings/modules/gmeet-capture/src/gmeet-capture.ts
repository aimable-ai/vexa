/**
 * Google Meet per-participant audio capture — THE shared implementation.
 *
 * Pure browser code (no Node, no Playwright). Consumed by BOTH:
 *  - the bot: bundled into browser-utils.global.js; index.ts installs it in-page
 *    and feeds onAudio → __vexaPerSpeakerAudioData (the Playwright bridge).
 *  - the extension: imported by inpage.ts; onAudio → postMessage to the WS.
 *
 * Google Meet renders each participant's audio as a separate <audio>/<video>
 * element whose srcObject is a live MediaStream. This wires each into a
 * dedicated AudioContext → AudioWorklet, resampled to 16 kHz, and delivers
 * per-element PCM chunks via onAudio(index, pcm). It rescans for late joiners /
 * recycled elements and silence-gates each chunk. The channel index is stable per
 * ELEMENT (the basis for per-track speaker attribution in gmeet-speakers.ts).
 *
 * Track swaps (AIM-1377): Meet replaces the audio TRACK inside an element's existing
 * MediaStream mid-meeting (reconnects, long mute/unmute, re-slotting). A
 * MediaStreamAudioSourceNode stays bound to the track it was created with, so a
 * stream-keyed capture goes silently deaf to that participant. Each element is
 * therefore bound per TRACK through its own single-track MediaStream, rebound on
 * `addtrack` / `ended` / rescan, and keeps its channel index across swaps.
 */

import { createPcmCaptureNode } from './pcm-capture.js';

export interface GmeetCaptureOptions {
  /** One per-element PCM chunk (already 16 kHz). index is the stable track index. */
  onAudio: (index: number, pcm: Float32Array) => void;
  log?: (msg: string) => void;
  targetSampleRate?: number;   // default 16000
  bufferSize?: number;         // default 4096
  silenceThreshold?: number;   // default 0.005 — skip near-silent chunks
  /** Keep emitting a speaker's REAL below-threshold audio this long after their last loud chunk
   *  (default 1500). The live engine is delay-conditioned (~1 s): it releases a turn's last words
   *  only once it hears audio AFTER them, and the synthetic silence the transcriber used to push
   *  instead can lock audio.cpp's Voxtral decoder into a pad-only state for 10–25 s of real speech
   *  (meeting 14, 2026-08-19). Room tone is what the model was trained on; a second of it per pause
   *  is the whole GPU cost. */
  hangoverMs?: number;
  rescanMs?: number;           // default 5000 — discover late joiners + track swaps
  findRetries?: number;        // default 10
  findDelayMs?: number;        // default 2000
}

export interface GmeetCapture {
  start(): Promise<void>;
  stop(): void;
  /** Number of currently-connected participant streams. */
  streamCount(): number;
  /** The channel index currently bound to a track whose id starts with `prefix` (the transport
   *  sensor names slots by the receiver track's first 8 chars). Undefined when no channel holds it. */
  channelOfTrack(prefix: string): number | undefined;
}

/** Silence gate with hangover: a chunk passes when it is loud, or when a loud chunk was heard within
 *  the last `hangoverMs` of audio — so a speaker's REAL trailing room tone follows every utterance
 *  (the delay-conditioned live engine needs ~1 s of audio after the last word to release it). Pure;
 *  exported for tests. */
export function createHangoverGate(threshold: number, hangoverMs: number, sampleRate: number): { pass(peak: number, samples: number): boolean } {
  let left = 0; // ms of below-threshold audio still to pass
  return {
    pass(peak, samples) {
      if (peak > threshold) { left = hangoverMs; return true; }
      if (left <= 0) return false;
      left -= (samples / sampleRate) * 1000;
      return true;
    },
  };
}

export function createGmeetCapture(opts: GmeetCaptureOptions): GmeetCapture {
  const log = opts.log || (() => { /* silent */ });
  const SR = opts.targetSampleRate ?? 16000;
  const SILENCE = opts.silenceThreshold ?? 0.005;
  const HANGOVER_MS = opts.hangoverMs ?? 1500;
  const RESCAN = opts.rescanMs ?? 5000;
  const FIND_RETRIES = opts.findRetries ?? 10;
  const FIND_DELAY = opts.findDelayMs ?? 2000;

  let running = false;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  interface Bound { index: number; ctx: AudioContext; node: AudioNode | null; source: MediaStreamAudioSourceNode | null; trackId: string | null; stream: MediaStream }
  /** One binding per media ELEMENT (channel index); the source inside follows the current track. */
  const bound = new Map<HTMLMediaElement, Bound>();
  let nextIndex = 0;

  function findMediaElements(): HTMLMediaElement[] {
    return Array.from(document.querySelectorAll('audio, video')).filter((el: any) =>
      !el.paused &&
      el.srcObject instanceof MediaStream &&
      el.srcObject.getAudioTracks().length > 0
    ) as HTMLMediaElement[];
  }

  /** Point the element's capture at its CURRENT audio track (idempotent per track id). */
  function bindTrack(b: Bound): boolean {
    const track = b.stream.getAudioTracks().find((t) => t.readyState === 'live') ?? b.stream.getAudioTracks()[0];
    if (!track || track.id === b.trackId) return false;
    try { b.source?.disconnect(); } catch { /* already gone */ }
    // Own single-track stream: a source node never follows a swap inside the element's stream.
    const source = b.ctx.createMediaStreamSource(new MediaStream([track]));
    if (b.node) source.connect(b.node);
    b.source = source;
    b.trackId = track.id;
    track.addEventListener('ended', () => { if (running) queueMicrotask(() => { if (b.trackId === track.id) bindTrack(b); }); });
    log(`stream ${b.index} bound track ${track.id.substring(0, 8)}`);
    return true;
  }

  function connectElement(el: HTMLMediaElement, index: number): boolean {
    try {
      const stream: MediaStream = (el as any).srcObject;
      if (!stream || stream.getAudioTracks().length === 0) return false;
      const existing = bound.get(el);
      if (existing) {
        if (existing.stream !== stream) { existing.stream = stream; existing.trackId = null; }
        bindTrack(existing);
        return false;
      }

      const ctx = new AudioContext({ sampleRate: SR });
      // Chrome's autoplay policy can create the context SUSPENDED (no user gesture) → the worklet
      // never runs → zero PCM even while people talk. Resume it explicitly. (L4 capture fix.)
      void ctx.resume().then(() => log(`stream ${index} ctx.state=${ctx.state}`)).catch(() => { /* */ });
      const b: Bound = { index, ctx, node: null, source: null, trackId: null, stream };
      bound.set(el, b);
      // AudioWorklet (audio-thread) instead of the deprecated ScriptProcessor,
      // which duplicates/drops buffers under main-thread load — the captured-audio
      // stutter. connectElement is sync, so wire the node when addModule resolves.
      let seen = 0, emitted = 0; // L4 frame-flow diagnostic
      const gate = createHangoverGate(SILENCE, HANGOVER_MS, SR);
      createPcmCaptureNode(ctx, (data) => {
        if (!running) return;
        seen++;
        let maxVal = 0;
        for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > maxVal) maxVal = a; }
        if (gate.pass(maxVal, data.length)) { emitted++; if (emitted === 1 || emitted % 100 === 0) log(`stream ${index} AUDIO seen=${seen} emitted=${emitted} max=${maxVal.toFixed(3)}`); opts.onAudio(index, data); } // worklet already yields a fresh copy
        else if (seen % 250 === 0) log(`stream ${index} silent seen=${seen} emitted=${emitted} max=${maxVal.toFixed(4)} ctx=${ctx.state}`);
      }).then((node) => { b.node = node; node.connect(ctx.destination); if (b.source) b.source.connect(node); })
        .catch((err: any) => console.log(`[gmeet-capture] worklet init failed: ${err?.message}`));
      bindTrack(b);
      // Meet swaps tracks inside the stream: follow it the moment it happens, not at the next rescan.
      stream.addEventListener('addtrack', () => { if (running) bindTrack(b); });

      log(`stream ${index} connected`);
      return true;
    } catch (err: any) {
      log(`stream ${index} error: ${err.message}`);
      return false;
    }
  }

  return {
    channelOfTrack(prefix: string): number | undefined {
      if (!prefix) return undefined;
      for (const b of bound.values()) if (b.trackId && b.trackId.startsWith(prefix)) return b.index;
      return undefined;
    },
    async start(): Promise<void> {
      if (running) return;
      running = true;

      let mediaElements: HTMLMediaElement[] = [];
      for (let attempt = 0; attempt < FIND_RETRIES && running; attempt++) {
        mediaElements = findMediaElements();
        if (mediaElements.length > 0) break;
        await new Promise(r => setTimeout(r, FIND_DELAY));
      }
      if (!running) return;

      for (let i = 0; i < mediaElements.length; i++) {
        if (connectElement(mediaElements[i], i)) nextIndex = i + 1;
      }
      nextIndex = Math.max(nextIndex, mediaElements.length);

      rescanTimer = setInterval(() => {
        if (!running) return;
        // Known elements re-check their current track (swap), new elements get the next channel.
        for (const el of findMediaElements()) {
          if (connectElement(el, nextIndex)) nextIndex++;
        }
      }, RESCAN);

      log(`capture started with ${bound.size} stream(s)`);
    },

    stop(): void {
      running = false;
      if (rescanTimer !== null) { clearInterval(rescanTimer); rescanTimer = null; }
      for (const b of bound.values()) { try { b.ctx.close(); } catch { /* ignore */ } }
      bound.clear();
      nextIndex = 0;
      log('capture stopped');
    },

    streamCount(): number { return bound.size; },
  };
}
