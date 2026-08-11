/**
 * Reson8Transcriber — the managed-service live engine for the mixed lane.
 * Same MixedTranscriberFactory surface as VoxtralTranscriber; opposite division
 * of labor: RESON8 segments and finalizes SERVER-SIDE. Finals arrive as
 * timestamped `transcript` messages (start_ms relative to session open),
 * interims (is_final:false) feed the pending stream. No primer (language is an
 * API parameter), no commit cadence, no context guard — the managed service
 * owns session internals. What we own:
 *
 *   - the bounded SILENCE TAIL: capture VAD-gates pauses away, so the server
 *     never hears silence, never endpoints, and withholds each turn's last
 *     words in the interim stream. After 700 ms of quiet we feed 200 ms
 *     silence frames up to a 5 s ceiling — the tail stops the moment the turn
 *     finalizes (billing is per minute of audio SENT, the ceiling only pays
 *     out on the slowest endpoints, measured 1.8–3.8 s).
 *   - flush-on-close: the server answers flush_request with the turn's final
 *     ~200 ms later — closing in the same breath loses the last words, so we
 *     wait for the final (or FLUSH_GRACE_MS).
 *   - naming: the shared ClusterNameBinder, same provisional/rename contract
 *     as every mixed-lane engine.
 */
import { ClusterNameBinder, type HintKind } from '@vexa/mixed-pipeline/binder';
import WebSocket from 'ws';
import { isJunk } from './junk-filter.js';
import type { VoxtralSegment, VoxtralTranscriberCallbacks } from './voxtral-transcriber.js';

const SAMPLE_RATE = 16000;
const DEFAULT_URL = 'wss://api.reson8.dev/v1/speech-to-text/realtime';
/** Cadence of the tail ticker, and the size of each silence frame it sends. */
const TAIL_FRAME_MS = 200;
/** Quiet time before the tail starts — must clear the capture cadence (~256 ms
 *  frames + VAD jitter) so silence is never spliced BETWEEN a speaker's chunks. */
const TAIL_START_MS = 700;
/** Silence-tail ceiling; the slowest measured server endpoint needs up to ~3.8 s. */
const TAIL_BUDGET_MS = 5000;
/** How long to wait for the final after a flush_request before closing. */
const FLUSH_GRACE_MS = 1500;
const IDLE_TIMEOUT_MS = 20_000;
const MAX_UNRESOLVED = 100;

export interface Reson8TranscriberConfig {
  /** wss:// endpoint; query params (encoding, language, interim) are appended here. */
  url?: string;
  /** RESON8 API key (Authorization: ApiKey <key>). */
  apiKey: string;
  /** Injection seams for tests. */
  socketFactory?: (url: string, headers: Record<string, string>) => Reson8Socket;
  now?: () => number;
  /** 0 disables the internal timer (tests drive sweep() directly). Default 200. */
  sweepIntervalMs?: number;
}

/** The slice of a WebSocket this engine uses — injectable for tests. */
export interface Reson8Socket {
  send(data: Buffer | string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', fn: (arg?: unknown) => void): void;
}

interface TurnRecord { clusterId: string; speaker: string; segments: VoxtralSegment[] }

export class Reson8Transcriber {
  private ws: Reson8Socket | null = null;
  private wsReady = false;
  private pendingAudio: Buffer[] = [];
  private readonly binder: ClusterNameBinder;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private generation = 0;

  private sessionStartWallMs = 0;
  private lastAudioWallMs = 0;
  private lastAudioTsMs = 0;
  /** Capture-clock epoch at session open — maps server-relative start_ms to epoch. */
  private sessionStartTsMs = 0;
  private tailSentMs = TAIL_BUDGET_MS;
  private seq = 0;
  private turnCounter = 0;
  private unresolved: TurnRecord[] = [];
  private pendingSpeaker: string | null = null;
  private readonly silenceFrame = Buffer.alloc(Math.floor((SAMPLE_RATE * TAIL_FRAME_MS) / 1000) * 2);

  constructor(private cfg: Reson8TranscriberConfig, private cb: VoxtralTranscriberCallbacks) {
    this.now = cfg.now ?? Date.now;
    this.binder = new ClusterNameBinder({
      onLateResolve: (clusterId, name) => this.applyLateResolve(clusterId, name),
    });
    const interval = cfg.sweepIntervalMs ?? TAIL_FRAME_MS;
    if (interval > 0) this.sweepTimer = setInterval(() => this.sweep(), interval);
  }

  static async create(cfg: Reson8TranscriberConfig, cb: VoxtralTranscriberCallbacks): Promise<Reson8Transcriber> {
    return new Reson8Transcriber(cfg, cb);
  }

  // ── MixedTranscriber surface ─────────────────────────────────────────────

  feedAudio(pcm: Float32Array, tsMs: number): void {
    if (this.disposed) return;
    this.lastAudioWallMs = this.now();
    this.lastAudioTsMs = tsMs;
    this.tailSentMs = 0;   // real speech — this turn gets a fresh tail
    const pcm16 = float32ToPcm16(pcm);
    if (this.ws && this.wsReady) {
      try { this.ws.send(pcm16); } catch (e) { this.cb.onError?.(e); }
    } else {
      this.pendingAudio.push(pcm16);
      if (!this.ws) this.connect(tsMs);
    }
  }

  recordHint(name: string, kind: HintKind, tMs: number, isEnd?: boolean): void {
    if (this.disposed) return;
    this.binder.recordHint({ name, kind, tMs, isEnd });
    const open = this.lastAudioTsMs > 0;
    this.cb.onHintOutcome?.({ name, kind, tMs, outcome: open ? 'matched' : 'missed' });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws && this.wsReady) await this.requestFinal(ws);
    else ws?.close();
  }

  // ── session ──────────────────────────────────────────────────────────────

  private buildUrl(): string {
    const base = (this.cfg.url || DEFAULT_URL).replace(/\/+$/, '');
    const p = new URLSearchParams({
      encoding: 'pcm_s16le',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      include_timestamps: 'true',
      include_interim: 'true',
    });
    const lang = (this.cb.language ?? '').toLowerCase().slice(0, 2);
    if (lang) p.set('language', lang);
    return `${base}?${p.toString()}`;
  }

  private connect(tsMs: number): void {
    const generation = this.generation;
    const factory = this.cfg.socketFactory
      ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as Reson8Socket);
    const ws = factory(this.buildUrl(), { Authorization: `ApiKey ${this.cfg.apiKey}` });
    this.ws = ws;
    this.wsReady = false;
    ws.on('open', () => {
      if (this.ws !== ws || this.generation !== generation) return;
      this.wsReady = true;
      this.sessionStartWallMs = this.now();
      this.sessionStartTsMs = tsMs;
      for (const pcm of this.pendingAudio.splice(0)) {
        try { ws.send(pcm); } catch { /* close event follows */ }
      }
    });
    ws.on('message', (data) => {
      if (this.ws !== ws || this.generation !== generation) return;
      const msg = parseMessage(data);
      if (!msg) return;
      if (msg.type === 'transcript' && typeof msg.text === 'string' && msg.text) {
        this.handleTranscript(msg);
      } else if (msg.type === 'error') {
        this.cb.log?.(`[reson8] server error: ${JSON.stringify(msg)}`);
        this.cb.onError?.(new Error(`reson8 server error: ${JSON.stringify(msg)}`));
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws || this.generation !== generation) return;
      this.ws = null;
      this.wsReady = false;   // lazy reconnect on next feedAudio
    });
    ws.on('error', (err) => {
      this.cb.log?.(`[reson8] WS error: ${(err as Error | undefined)?.message ?? String(err)}`);
    });
  }

  // ── transcripts ──────────────────────────────────────────────────────────

  private handleTranscript(msg: Reson8Message): void {
    const text = String(msg.text).trim();
    if (!text) return;
    const hasTiming = typeof msg.start_ms === 'number' && typeof msg.duration_ms === 'number';
    // Server times are relative to session open; map onto the CAPTURE clock so
    // binder matching and transcript timestamps stay in the epoch domain.
    const startMs = hasTiming ? this.sessionStartTsMs + (msg.start_ms as number) : this.sessionStartTsMs;
    const endMs = hasTiming ? startMs + (msg.duration_ms as number) : (this.lastAudioTsMs || startMs + 1);
    if (msg.is_final === false) {
      const speaker = this.resolveName(startMs, Math.max(endMs, startMs + 1), false);
      if (this.pendingSpeaker && this.pendingSpeaker !== speaker) this.cb.clearPending(this.pendingSpeaker);
      this.pendingSpeaker = speaker;
      this.cb.publishPending(speaker, [{
        text, startMs, endMs, language: this.cb.language ?? '',
        segmentId: `seg_${this.turnCounter}:interim`,
      }]);
      return;
    }
    if (isJunk(text)) {
      this.cb.log?.(`[reson8] [FILTERED] junk: "${text.slice(0, 60)}"`);
      return;
    }
    // Turn is closed — stop feeding silence (the tail budget only pays out on
    // the slowest endpoints).
    this.tailSentMs = TAIL_BUDGET_MS;
    const clusterId = `seg_${this.turnCounter++}`;
    const seg: VoxtralSegment = {
      text, startMs, endMs, language: this.cb.language ?? '',
      segmentId: `${clusterId}:${this.seq++}`,
    };
    const res = this.binder.resolve({ clusterId, tStartMs: startMs, tEndMs: endMs });
    this.rememberTurn(clusterId, res.speakerName, seg);
    this.cb.log?.(`[reson8] CONFIRMED ${res.speakerName} | "${text.slice(0, 60)}"`);
    this.cb.publish(res.speakerName, [seg], []);
    this.pendingSpeaker = null;
  }

  private resolveName(tStartMs: number, tEndMs: number, recordVote: boolean): string {
    return this.binder.resolve(
      { clusterId: `seg_${this.turnCounter}`, tStartMs, tEndMs },
      { recordVote },
    ).speakerName;
  }

  private rememberTurn(clusterId: string, speaker: string, seg: VoxtralSegment): void {
    let rec = this.unresolved.find((t) => t.clusterId === clusterId);
    if (!rec) {
      rec = { clusterId, speaker, segments: [] };
      this.unresolved.push(rec);
      if (this.unresolved.length > MAX_UNRESOLVED) this.unresolved.shift();
    }
    rec.speaker = speaker;
    rec.segments.push(seg);
  }

  private applyLateResolve(clusterId: string, name: string): void {
    const rec = this.unresolved.find((t) => t.clusterId === clusterId);
    if (!rec || rec.speaker === name) return;
    const old = rec.speaker;
    rec.speaker = name;
    this.cb.rename(old, name, rec.segments);
  }

  /** Ask the server to finalize now; resolve once the final lands (the normal
   *  message handler is still armed and emits it) or FLUSH_GRACE_MS elapses. */
  private requestFinal(ws: Reson8Socket): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already down */ }
        resolve();
      };
      const timer = setTimeout(finish, this.cfg.sweepIntervalMs === 0 ? 0 : FLUSH_GRACE_MS);
      ws.on('message', (data) => {
        const msg = parseMessage(data);
        if (msg?.type === 'flush_confirmation') finish();
      });
      try { ws.send(JSON.stringify({ type: 'flush_request' })); } catch { finish(); }
    });
  }

  // ── cadence (public so tests can drive it without timers) ────────────────

  sweep(): void {
    if (this.disposed || !this.ws) return;
    const now = this.now();
    const quietMs = now - this.lastAudioWallMs;
    // Long idle → close the socket (reopens on next audio).
    if (this.lastAudioWallMs > 0 && quietMs > IDLE_TIMEOUT_MS) {
      this.cb.log?.('[reson8] idle close');
      const ws = this.ws;
      this.ws = null;
      this.wsReady = false;
      this.generation++;
      void this.requestFinal(ws);
      return;
    }
    // Post-speech silence, bounded: enough for the server to endpoint the turn.
    if (this.wsReady && this.lastAudioWallMs > 0 && quietMs >= TAIL_START_MS && this.tailSentMs < TAIL_BUDGET_MS) {
      try { this.ws.send(this.silenceFrame); this.tailSentMs += TAIL_FRAME_MS; } catch { /* close event follows */ }
    }
  }
}

interface Reson8Message {
  type?: string;
  text?: unknown;
  is_final?: boolean;
  start_ms?: unknown;
  duration_ms?: unknown;
}

function parseMessage(data: unknown): Reson8Message | null {
  try {
    const raw = typeof data === 'string' ? data : (data as Buffer).toString();
    return JSON.parse(raw) as Reson8Message;
  } catch { return null; }
}

function float32ToPcm16(audio: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    const v = Math.max(-1, Math.min(1, audio[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  return buf;
}
