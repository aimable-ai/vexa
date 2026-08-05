import { log } from '../utils';
import { isHallucination } from './hallucination-filter';
import { PRIMER_PCM16_NL_BASE64, PRIMER_PCM16_EN_BASE64 } from './primer-audio';

/** Spoken language primers, played as the first audio of every WS session so
 * the model locks onto the meeting language (it has no language parameter —
 * it locks on whatever it hears first). Keyed by 2-letter language code. */
const PRIMERS: Record<string, Buffer> = {
  nl: Buffer.from(PRIMER_PCM16_NL_BASE64, 'base64'),
  en: Buffer.from(PRIMER_PCM16_EN_BASE64, 'base64'),
};
/** Give up discarding primer transcript this long after sending it. */
const PRIMER_TIMEOUT_MS = 6000;

/**
 * Realtime per-speaker transcription via a vLLM /v1/realtime WebSocket
 * (Voxtral Mini 4B Realtime). Replaces the Whisper HTTP + LocalAgreement
 * loop: the model streams committed transcript deltas itself, so there is
 * no submit/confirm cycle — deltas accumulate into a segment that is
 * finalized on a sentence boundary, a silence gap, or a size cap.
 *
 * Exposes the same speaker-facing surface as SpeakerStreamManager
 * (addSpeaker / feedAudio / updateSpeakerName / removeAll / ...) so the
 * bot pipeline can hold either implementation.
 */

export interface RealtimeTranscriptionConfig {
  /** ws:// or wss:// URL of the vLLM realtime endpoint, e.g. ws://host:8085/v1/realtime */
  realtimeUrl: string;
  /** Model name sent in session.update. */
  model?: string;
  /** Sample rate of input audio. Default 16000. */
  sampleRate?: number;
  /** Finalize the open segment after this many ms without new deltas. Default 1200. */
  segmentGapMs?: number;
  /** Force-finalize a segment at this many characters. Default 600. */
  maxSegmentChars?: number;
  /** Close an idle speaker session after this many seconds without audio. Default 20. */
  idleTimeoutSec?: number;
  /** Meeting language (2-letter code). Selects the spoken primer that locks the
   * model's language on every session open; no primer when unset/unknown. */
  language?: string;
}

interface SpeakerSession {
  speakerId: string;
  speakerName: string;
  ws: any | null;
  wsReady: boolean;
  /** Audio queued while the socket is connecting. */
  pendingAudio: Buffer[];
  /** Text of the segment currently being built from deltas. */
  segmentText: string;
  /** Wall-clock ms when the current segment started (first audio after last finalize). */
  segmentStartMs: number;
  lastDeltaMs: number;
  lastAudioMs: number;
  sequenceNumber: number;
  generation: number;
  closed: boolean;
  /** Primer transcript not yet fully received/discarded on this connection. */
  primerPending: boolean;
  primerText: string;
  primerSentMs: number;
  /** Audio appended since the last input_audio_buffer.commit. */
  audioSinceCommit: boolean;
  lastCommitMs: number;
}

const SENTENCE_END = /[.!?…]["')\]]?\s*$/;

export class RealtimeSpeakerStreamManager {
  private sessions: Map<string, SpeakerSession> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private cfg: Required<Omit<RealtimeTranscriptionConfig, 'model'>> & { model: string };

  /** Confirmed segment — same signature as SpeakerStreamManager.onSegmentConfirmed. */
  onSegmentConfirmed:
    | ((speakerId: string, speakerName: string, transcript: string, bufferStartMs: number, bufferEndMs: number, segmentId: string) => void)
    | null = null;

  /** Draft (still-growing) segment text, for pending publication. */
  onPending: ((speakerId: string, speakerName: string, text: string, segmentStartMs: number) => void) | null = null;

  private primer: Buffer | null;

  constructor(config: RealtimeTranscriptionConfig) {
    this.cfg = {
      realtimeUrl: config.realtimeUrl.replace(/\/+$/, ''),
      model: config.model || 'mistralai/Voxtral-Mini-4B-Realtime-2602',
      sampleRate: config.sampleRate ?? 16000,
      segmentGapMs: config.segmentGapMs ?? 1200,
      maxSegmentChars: config.maxSegmentChars ?? 600,
      idleTimeoutSec: config.idleTimeoutSec ?? 20,
      language: config.language ?? '',
    };
    const langKey = this.cfg.language.toLowerCase().slice(0, 2);
    this.primer = PRIMERS[langKey] ?? null;
    if (this.cfg.language && !this.primer) {
      log(`[Realtime] No language primer for "${this.cfg.language}" — sessions rely on auto-detection`);
    }
    this.sweepTimer = setInterval(() => this.sweep(), 500);
  }

  addSpeaker(speakerId: string, speakerName: string): void {
    if (this.sessions.has(speakerId)) return;
    const now = Date.now();
    this.sessions.set(speakerId, {
      speakerId, speakerName,
      ws: null, wsReady: false, pendingAudio: [],
      segmentText: '', segmentStartMs: now, lastDeltaMs: 0, lastAudioMs: now,
      sequenceNumber: 0, generation: 0, closed: false,
      primerPending: false, primerText: '', primerSentMs: 0,
      audioSinceCommit: false, lastCommitMs: 0,
    });
    log(`[Realtime] Added speaker "${speakerName}" (${speakerId})`);
  }

  hasSpeaker(speakerId: string): boolean { return this.sessions.has(speakerId); }
  getSpeakerName(speakerId: string): string | undefined { return this.sessions.get(speakerId)?.speakerName; }
  getActiveSpeakers(): string[] { return [...this.sessions.keys()]; }
  getBufferStartMs(speakerId: string): number { return this.sessions.get(speakerId)?.segmentStartMs ?? Date.now(); }
  getLastConfirmedText(_speakerId: string): string { return ''; }
  getSegmentId(speakerId: string): string { return `${speakerId}:${this.sessions.get(speakerId)?.sequenceNumber ?? 0}`; }
  /** Whisper-path compat no-op — the realtime pipeline has no submit/confirm loop. */
  handleTranscriptionResult(_speakerId: string, _transcript: string, _segmentEndSec?: number, _segments?: unknown[]): void {}

  updateSpeakerName(speakerId: string, newName: string): boolean {
    const s = this.sessions.get(speakerId);
    if (!s) return false;
    log(`[Realtime] Updated speaker name "${s.speakerName}" → "${newName}" (${speakerId})`);
    s.speakerName = newName;
    return true;
  }

  feedAudio(speakerId: string, audioData: Float32Array): void {
    const s = this.sessions.get(speakerId);
    if (!s || s.closed) return;
    const now = Date.now();
    if (!s.segmentText && s.lastAudioMs < now - this.cfg.segmentGapMs) {
      // Fresh audio after a quiet stretch with nothing pending — restart timing.
      s.segmentStartMs = now;
    }
    s.lastAudioMs = now;
    const pcm = this.float32ToPcm16(audioData);
    if (s.ws && s.wsReady) {
      this.sendAudio(s, pcm);
    } else {
      s.pendingAudio.push(pcm);
      if (!s.ws) this.connect(s);
    }
  }

  async flushSpeaker(speakerId: string): Promise<void> {
    const s = this.sessions.get(speakerId);
    if (!s) return;
    this.finalizeSegment(s, 'flush');
  }

  removeSpeaker(speakerId: string): void {
    const s = this.sessions.get(speakerId);
    if (!s) return;
    this.finalizeSegment(s, 'remove');
    this.closeSession(s);
    this.sessions.delete(speakerId);
  }

  removeAll(): void {
    for (const id of [...this.sessions.keys()]) this.removeSpeaker(id);
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private connect(s: SpeakerSession): void {
    const generation = s.generation;
    let WS: any = (globalThis as any).WebSocket;
    if (!WS) {
      try { WS = require('ws'); } catch { log('[Realtime] No WebSocket implementation available'); return; }
    }
    log(`[Realtime] Connecting session for "${s.speakerName}" → ${this.cfg.realtimeUrl}`);
    const ws = new WS(this.cfg.realtimeUrl);
    s.ws = ws;
    s.wsReady = false;

    const onMessage = (data: any) => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      let msg: any;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
      if (msg.type === 'session.created') {
        try { ws.send(JSON.stringify({ type: 'session.update', model: this.cfg.model })); } catch {}
        s.wsReady = true;
        // Language primer FIRST — the model locks onto the language of the
        // first audio it hears. Its transcript is discarded in handleDelta.
        if (this.primer) {
          s.primerPending = true;
          s.primerText = '';
          s.primerSentMs = Date.now();
          this.sendAudio(s, this.primer);
          this.sendCommit(s); // flush the primer promptly → language locks first
        }
        for (const pcm of s.pendingAudio.splice(0)) this.sendAudio(s, pcm);
      } else if (msg.type === 'transcription.delta' && typeof msg.delta === 'string') {
        this.handleDelta(s, msg.delta);
      } else if (msg.type === 'transcription.done') {
        // Final commit of the session — anything not yet finalized goes out now.
        this.finalizeSegment(s, 'done');
      } else if (msg.type === 'error') {
        log(`[Realtime] Server error for "${s.speakerName}": ${JSON.stringify(msg.error ?? msg)}`);
      }
    };

    const onClose = () => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      s.ws = null;
      s.wsReady = false;
      // Reconnect lazily: the next feedAudio() reopens.
    };

    if (typeof ws.on === 'function') {
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', (err: any) => { log(`[Realtime] WS error ("${s.speakerName}"): ${err?.message || err}`); onClose(); });
    } else {
      ws.onmessage = (ev: any) => onMessage(ev.data);
      ws.onclose = onClose;
      ws.onerror = (ev: any) => { log(`[Realtime] WS error ("${s.speakerName}"): ${ev?.message || 'unknown'}`); };
    }
  }

  private sendAudio(s: SpeakerSession, pcm: Buffer): void {
    try {
      // ~4KB raw audio per append message.
      for (let off = 0; off < pcm.length; off += 4096) {
        const chunk = pcm.subarray(off, Math.min(off + 4096, pcm.length));
        s.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
      }
      s.audioSinceCommit = true;
    } catch (err: any) {
      log(`[Realtime] send failed ("${s.speakerName}"): ${err?.message}`);
    }
  }

  /** vLLM's realtime endpoint only generates text on commit — without a
   * commit cadence the model buffers audio forever and emits nothing.
   * (Commits during active generation are ignored server-side, so a fixed
   * cadence is safe.) */
  private sendCommit(s: SpeakerSession): void {
    if (!s.ws || !s.wsReady) return;
    try {
      s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      s.audioSinceCommit = false;
      s.lastCommitMs = Date.now();
    } catch (err: any) {
      log(`[Realtime] commit failed ("${s.speakerName}"): ${err?.message}`);
    }
  }

  private handleDelta(s: SpeakerSession, delta: string): void {
    if (!delta) return;
    if (s.primerPending) {
      if (Date.now() - s.primerSentMs > PRIMER_TIMEOUT_MS) {
        // Primer transcript never fully arrived — stop discarding and treat
        // this delta as real text.
        s.primerPending = false;
        s.primerText = '';
        s.segmentStartMs = Date.now();
      } else {
        // Discard the primer's own transcript. The primer sentence ends with
        // a period, so a sentence boundary marks it fully received.
        s.primerText += delta;
        if (SENTENCE_END.test(s.primerText)) {
          s.primerPending = false;
          s.primerText = '';
          s.segmentStartMs = Date.now();
        }
        return;
      }
    }
    if (!s.segmentText) s.segmentStartMs = Math.min(s.segmentStartMs, Date.now());
    s.segmentText += delta;
    s.lastDeltaMs = Date.now();
    const text = s.segmentText.trim();
    if (text && this.onPending) this.onPending(s.speakerId, s.speakerName, text, s.segmentStartMs);
    if (s.segmentText.length >= this.cfg.maxSegmentChars ||
        (SENTENCE_END.test(s.segmentText) && s.segmentText.trim().length > 40)) {
      this.finalizeSegment(s, 'boundary');
    }
  }

  private finalizeSegment(s: SpeakerSession, reason: string): void {
    const text = s.segmentText.trim();
    s.segmentText = '';
    const startMs = s.segmentStartMs;
    const endMs = Date.now();
    s.segmentStartMs = endMs;
    if (!text) return;
    if (isHallucination(text)) {
      log(`[Realtime] [FILTERED] Hallucination for "${s.speakerName}": "${text.substring(0, 60)}"`);
      return;
    }
    const segmentId = `${s.speakerId}:${s.sequenceNumber++}`;
    log(`[Realtime] CONFIRMED (${reason}) ${s.speakerName} | "${text.substring(0, 60)}"`);
    if (this.onSegmentConfirmed) this.onSegmentConfirmed(s.speakerId, s.speakerName, text, startMs, endMs, segmentId);
  }

  private closeSession(s: SpeakerSession): void {
    s.closed = true;
    s.generation++;
    if (s.ws) {
      try { s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: true })); } catch {}
      try { s.ws.close(); } catch {}
    }
    s.ws = null;
    s.wsReady = false;
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Commit cadence — the model only transcribes committed audio.
      if (s.audioSinceCommit && now - s.lastCommitMs >= 1500) {
        this.sendCommit(s);
      }
      // Silence gap → the open segment is done.
      if (s.segmentText && s.lastDeltaMs && now - s.lastDeltaMs > this.cfg.segmentGapMs) {
        this.finalizeSegment(s, 'gap');
      }
      // Long idle → close the socket (reopens on next audio).
      if (s.ws && now - s.lastAudioMs > this.cfg.idleTimeoutSec * 1000) {
        log(`[Realtime] Idle close for "${s.speakerName}"`);
        this.finalizeSegment(s, 'idle');
        const gen = s.generation;
        this.closeSession(s);
        s.closed = false;          // speaker stays known; next audio reconnects
        s.generation = gen + 1;
      }
    }
  }

  private float32ToPcm16(audio: Float32Array): Buffer {
    const buf = Buffer.allocUnsafe(audio.length * 2);
    for (let i = 0; i < audio.length; i++) {
      const v = Math.max(-1, Math.min(1, audio[i]));
      buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
    }
    return buf;
  }
}
