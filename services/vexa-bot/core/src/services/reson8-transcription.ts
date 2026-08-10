import { log } from '../utils';
import { isHallucination } from './hallucination-filter';

/**
 * Per-speaker transcription via the RESON8 managed realtime API
 * (wss://api.reson8.dev). The service segments and finalizes server-side:
 * finals arrive as timestamped `transcript` messages, interims (is_final
 * false) feed the pending stream. No primer (language is an API parameter),
 * no commit cadence and no context guard — the managed service owns session
 * internals; we only keep the idle-close so quiet speakers do not hold
 * connections open.
 *
 * Exposes the same surface as RealtimeSpeakerStreamManager so index.ts can
 * hold either implementation.
 */

export interface Reson8TranscriptionConfig {
  /** wss:// endpoint. Default: wss://api.reson8.dev/v1/speech-to-text/realtime */
  serviceUrl?: string;
  /** RESON8 API key (Authorization: ApiKey <key>). */
  apiKey: string;
  /** Meeting language (2-letter code) passed as the `language` query param. */
  language?: string;
  /** Sample rate of input audio. Default 16000. */
  sampleRate?: number;
  /** Close an idle speaker session after this many seconds without audio. Default 20. */
  idleTimeoutSec?: number;
}

interface SpeakerSession {
  speakerId: string;
  speakerName: string;
  ws: any | null;
  wsReady: boolean;
  /** Audio queued while the socket is connecting. */
  pendingAudio: Buffer[];
  /** Wall-clock ms when this WS session opened — start_ms offsets are relative to it. */
  sessionStartWallMs: number;
  lastAudioMs: number;
  sequenceNumber: number;
  generation: number;
  closed: boolean;
}

const DEFAULT_URL = 'wss://api.reson8.dev/v1/speech-to-text/realtime';

export class Reson8SpeakerStreamManager {
  private sessions: Map<string, SpeakerSession> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private cfg: Required<Reson8TranscriptionConfig>;

  /** Confirmed segment — same signature as RealtimeSpeakerStreamManager.onSegmentConfirmed. */
  onSegmentConfirmed:
    | ((speakerId: string, speakerName: string, transcript: string, bufferStartMs: number, bufferEndMs: number, segmentId: string) => void)
    | null = null;

  /** Interim (still-mutable) text, for pending publication. */
  onPending: ((speakerId: string, speakerName: string, text: string, segmentStartMs: number) => void) | null = null;

  constructor(config: Reson8TranscriptionConfig) {
    this.cfg = {
      serviceUrl: (config.serviceUrl || DEFAULT_URL).replace(/\/+$/, ''),
      apiKey: config.apiKey,
      language: config.language ?? '',
      sampleRate: config.sampleRate ?? 16000,
      idleTimeoutSec: config.idleTimeoutSec ?? 20,
    };
    this.sweepTimer = setInterval(() => this.sweep(), 1000);
  }

  addSpeaker(speakerId: string, speakerName: string): void {
    if (this.sessions.has(speakerId)) return;
    this.sessions.set(speakerId, {
      speakerId, speakerName,
      ws: null, wsReady: false, pendingAudio: [],
      sessionStartWallMs: 0, lastAudioMs: Date.now(),
      sequenceNumber: 0, generation: 0, closed: false,
    });
    log(`[Reson8] Added speaker "${speakerName}" (${speakerId})`);
  }

  hasSpeaker(speakerId: string): boolean { return this.sessions.has(speakerId); }
  getSpeakerName(speakerId: string): string | undefined { return this.sessions.get(speakerId)?.speakerName; }
  getActiveSpeakers(): string[] { return [...this.sessions.keys()]; }
  getBufferStartMs(speakerId: string): number { return this.sessions.get(speakerId)?.sessionStartWallMs || Date.now(); }
  getLastConfirmedText(_speakerId: string): string { return ''; }
  getSegmentId(speakerId: string): string { return `${speakerId}:${this.sessions.get(speakerId)?.sequenceNumber ?? 0}`; }
  /** Whisper-path compat no-op — RESON8 has no submit/confirm loop. */
  handleTranscriptionResult(_speakerId: string, _transcript: string, _segmentEndSec?: number, _segments?: unknown[]): void {}

  updateSpeakerName(speakerId: string, newName: string): boolean {
    const s = this.sessions.get(speakerId);
    if (!s) return false;
    log(`[Reson8] Updated speaker name "${s.speakerName}" → "${newName}" (${speakerId})`);
    s.speakerName = newName;
    return true;
  }

  feedAudio(speakerId: string, audioData: Float32Array): void {
    const s = this.sessions.get(speakerId);
    if (!s || s.closed) return;
    s.lastAudioMs = Date.now();
    const pcm = this.float32ToPcm16(audioData);
    if (s.ws && s.wsReady) {
      try { s.ws.send(pcm); } catch (err: any) {
        log(`[Reson8] send failed ("${s.speakerName}"): ${err?.message}`);
      }
    } else {
      s.pendingAudio.push(pcm);
      if (!s.ws) this.connect(s);
    }
  }

  async flushSpeaker(_speakerId: string): Promise<void> {
    // Finalization is server-side; nothing buffered client-side to flush.
  }

  removeSpeaker(speakerId: string): void {
    const s = this.sessions.get(speakerId);
    if (!s) return;
    this.closeSession(s);
    this.sessions.delete(speakerId);
  }

  removeAll(): void {
    for (const id of [...this.sessions.keys()]) this.removeSpeaker(id);
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private buildUrl(): string {
    const p = new URLSearchParams({
      encoding: 'pcm_s16le',
      sample_rate: String(this.cfg.sampleRate),
      channels: '1',
      include_timestamps: 'true',
      include_interim: 'true',
    });
    if (this.cfg.language) p.set('language', this.cfg.language.toLowerCase().slice(0, 2));
    return `${this.cfg.serviceUrl}?${p.toString()}`;
  }

  private connect(s: SpeakerSession): void {
    const generation = s.generation;
    let WS: any = (globalThis as any).WebSocket;
    let headerCapable = false;
    try { WS = require('ws'); headerCapable = true; } catch {
      if (!WS) { log('[Reson8] No WebSocket implementation available'); return; }
    }
    log(`[Reson8] Connecting session for "${s.speakerName}"`);
    // Node `ws` supports auth headers; the browser API does not — the bot
    // runs the Node side here, so header auth is the expected path.
    const ws = headerCapable
      ? new WS(this.buildUrl(), { headers: { Authorization: `ApiKey ${this.cfg.apiKey}` } })
      : new WS(this.buildUrl());
    s.ws = ws;
    s.wsReady = false;

    const onOpen = () => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      s.wsReady = true;
      s.sessionStartWallMs = Date.now();
      for (const pcm of s.pendingAudio.splice(0)) {
        try { ws.send(pcm); } catch {}
      }
    };

    const onMessage = (data: any) => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      if (typeof data !== 'string' && !(data instanceof Buffer)) return;
      let msg: any;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
      if (msg.type === 'transcript' && typeof msg.text === 'string' && msg.text) {
        this.handleTranscript(s, msg);
      } else if (msg.type === 'error') {
        log(`[Reson8] Server error for "${s.speakerName}": ${JSON.stringify(msg)}`);
      }
    };

    const onClose = () => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      s.ws = null;
      s.wsReady = false;
      // Reconnect lazily: the next feedAudio() reopens.
    };

    if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', (err: any) => { log(`[Reson8] WS error ("${s.speakerName}"): ${err?.message || err}`); onClose(); });
    } else {
      ws.onopen = onOpen;
      ws.onmessage = (ev: any) => onMessage(ev.data);
      ws.onclose = onClose;
      ws.onerror = (ev: any) => { log(`[Reson8] WS error ("${s.speakerName}"): ${ev?.message || 'unknown'}`); };
    }
  }

  private handleTranscript(s: SpeakerSession, msg: any): void {
    const text = String(msg.text).trim();
    if (!text) return;
    const hasTiming = typeof msg.start_ms === 'number' && typeof msg.duration_ms === 'number';
    const startMs = hasTiming ? s.sessionStartWallMs + msg.start_ms : s.sessionStartWallMs;
    const endMs = hasTiming ? startMs + msg.duration_ms : Date.now();
    if (msg.is_final === false) {
      if (this.onPending) this.onPending(s.speakerId, s.speakerName, text, startMs);
      return;
    }
    if (isHallucination(text)) {
      log(`[Reson8] [FILTERED] Hallucination for "${s.speakerName}": "${text.substring(0, 60)}"`);
      return;
    }
    const segmentId = `${s.speakerId}:${s.sequenceNumber++}`;
    log(`[Reson8] CONFIRMED ${s.speakerName} | "${text.substring(0, 60)}"`);
    if (this.onSegmentConfirmed) this.onSegmentConfirmed(s.speakerId, s.speakerName, text, startMs, endMs, segmentId);
  }

  private closeSession(s: SpeakerSession): void {
    s.closed = true;
    s.generation++;
    if (s.ws) {
      try { s.ws.send(JSON.stringify({ type: 'flush_request', id: s.speakerId })); } catch {}
      try { s.ws.close(); } catch {}
    }
    s.ws = null;
    s.wsReady = false;
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Long idle → close the socket (reopens on next audio).
      if (s.ws && now - s.lastAudioMs > this.cfg.idleTimeoutSec * 1000) {
        log(`[Reson8] Idle close for "${s.speakerName}"`);
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
