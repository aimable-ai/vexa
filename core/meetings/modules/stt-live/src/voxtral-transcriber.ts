/**
 * VoxtralTranscriber — the STREAMING transcription core for the mixed lane.
 * Drop-in for ChunkedTranscriber at the bot's MixedTranscriberFactory seam
 * (feedAudio / recordHint / dispose + the same publish callbacks); the internals
 * are the opposite of the chunked design:
 *
 *   PCM frames ──► ONE live session (WS realtime or HTTP-live) ──► delta events
 *
 * The model streams COMMITTED transcript deltas itself — there is no ring, no
 * resubmission, no LocalAgreement. A segment accumulates deltas and finalizes on
 * a sentence boundary, an audio-silence gap, or a size cap. Because deltas are
 * model-committed, every pending publish is STABLE text (append-only): consumers
 * may act on drafts before finalization — the property wake-word dispatch needs.
 *
 * Cadence rules (all empirically derived on vLLM Voxtral Mini 4B Realtime —
 * see PORTING.md "Tuning constants"):
 *   - the server only transcribes committed audio → commit every 750 ms;
 *   - segment boundaries gate on AUDIO silence (deltas arrive in bursts per
 *     commit — a delta-only gap fires between every commit and chops sentences);
 *   - delay conditioning (~960 ms) withholds an utterance's final words until it
 *     sees audio AFTER them → on speech pause push 1200 ms synthetic silence;
 *   - the server never bounds its own context (~8k tokens ≈ 11 min audio) →
 *     recycle the session at the first pause past the audio budget, forced past
 *     an extra margin even mid-speech.
 *
 * WHO: the shared ClusterNameBinder (hints by time window). Every turn gets a
 * provisional `seg_N` cluster id; a turn with no overlapping hint publishes
 * provisionally and is repainted in place (same segment ids) via rename when a
 * later hint resolves the cluster — identical contract to the chunked lane.
 */
import { ClusterNameBinder, type HintKind } from '@vexa/mixed-pipeline/binder';
import { openLiveTransport, type LiveTransport, type TransportFactory } from './live-transport.js';
import { PrimerGate } from './primer.js';
import { isJunk } from './junk-filter.js';

const SAMPLE_RATE = 16000;
/** The server only transcribes committed audio — commit cadence. */
const COMMIT_INTERVAL_MS = 750;
/** Audio-silence gap that closes the open segment. */
const SEGMENT_GAP_MS = 800;
/** Speech-pause threshold that triggers the tail flush. */
const TAIL_FLUSH_AFTER_MS = 700;
/** Synthetic silence pushed on speech pause — must exceed the 960 ms delay conditioning. */
const TAIL_SILENCE_MS = 1200;
/** Force-finalize a segment at this many characters. */
const MAX_SEGMENT_CHARS = 600;
/** A sentence end finalizes mid-speech only past this length (abbreviation guard) —
 *  shorter sentences finalize once the audio has gone quiet. */
const SENTENCE_MIN_CHARS = 40;
const SENTENCE_QUIET_MS = 700;
/** Close an idle transport after this long without audio (reopens on next frame). */
const IDLE_TIMEOUT_MS = 20_000;
/** Recycle the session once it has heard this much audio (context guard)... */
const SESSION_MAX_AUDIO_SEC = 240;
/** ...waiting for a pause; force it after this much extra audio — a mid-speech
 *  recycle costs a word or two once, context overflow costs everything. */
const SESSION_FORCE_EXTRA_SEC = 160;
/** Speech sent with nothing decoded back before the session is called starved. */
const STARVATION_WARN_SEC = 8;
/** Unresolved (provisionally-named) turns kept for late hint renames. */
const MAX_UNRESOLVED = 100;
/** dispose(): wait this long for in-flight deltas after the final flush. */
const DRAIN_MS = 1500;

const SENTENCE_END = /[.!?…]["')\]]?\s*$/;
const TAIL_SILENCE = Buffer.alloc(Math.floor((TAIL_SILENCE_MS / 1000) * SAMPLE_RATE) * 2);

/** Structurally @vexa/mixed-pipeline's ChunkSegment (kept local so this module's
 *  front door needs no type dependency on the chunked lane). */
export interface VoxtralSegment {
  text: string;
  startMs: number;
  endMs: number;
  language: string;
  segmentId: string;
}

/** The subset of ChunkedTranscriberCallbacks this engine drives. `transcribe` is
 *  deliberately absent — there is no batch round-trip on this path. */
export interface VoxtralTranscriberCallbacks {
  publish: (speaker: string, confirmed: VoxtralSegment[], pending: VoxtralSegment[]) => void;
  publishPending: (speaker: string, segments: VoxtralSegment[]) => void;
  clearPending: (speaker: string) => void;
  rename: (oldSpeaker: string, newSpeaker: string, segments: VoxtralSegment[]) => void;
  language?: string;
  log?: (msg: string) => void;
  onError?: (fault: unknown) => void;
  onHintOutcome?: (o: { name: string; kind: HintKind; tMs: number; outcome: 'matched' | 'missed' }) => void;
}

export interface VoxtralTranscriberConfig {
  /** ws(s):// (vLLM realtime) or http(s):// (audio.cpp HTTP-live). */
  url: string;
  apiToken?: string;
  model?: string;
  /** Injection seams for tests. */
  transportFactory?: TransportFactory;
  now?: () => number;
  /** 0 disables the internal timer (tests drive sweep() directly). Default 250. */
  sweepIntervalMs?: number;
  /** Extra junk phrases (lowercased). */
  junkPhrases?: ReadonlySet<string>;
}

interface TurnRecord {
  clusterId: string;
  speaker: string;             // current published name (cluster id while provisional)
  segments: VoxtralSegment[];
}

export class VoxtralTranscriber {
  private transport: LiveTransport | null = null;
  private pendingAudio: Buffer[] = [];
  private readonly binder: ClusterNameBinder;
  private readonly primer: PrimerGate;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // Open-segment state. Times are the CAPTURE clock (epoch ms from feedAudio's
  // tsMs) — the same domain as hints, which is what makes binder matching work.
  private segText = '';
  private turnStartMs = 0;
  private lastAudioTsMs = 0;
  // Wall-clock bookkeeping (cadence/sweep timing).
  private lastAudioWallMs = 0;
  private lastDeltaWallMs = 0;
  private lastCommitWallMs = 0;
  private audioSinceCommit = false;
  private tailFlushed = true;
  private sessionAudioSec = 0;
  private starvedAudioSec = 0;
  private starvedWarned = false;
  private seq = 0;
  private turnCounter = 0;
  private openClusterId = '';
  /** Recent turns retained for late hint renames (provisional → real name). */
  private unresolved: TurnRecord[] = [];
  private pendingSpeaker: string | null = null;

  constructor(private cfg: VoxtralTranscriberConfig, private cb: VoxtralTranscriberCallbacks) {
    this.now = cfg.now ?? Date.now;
    this.primer = new PrimerGate(cb.language, this.now);
    this.binder = new ClusterNameBinder({
      onLateResolve: (clusterId, name) => this.applyLateResolve(clusterId, name),
    });
    const interval = cfg.sweepIntervalMs ?? 250;
    if (interval > 0) this.sweepTimer = setInterval(() => this.sweep(), interval);
  }

  static async create(cfg: VoxtralTranscriberConfig, cb: VoxtralTranscriberCallbacks): Promise<VoxtralTranscriber> {
    return new VoxtralTranscriber(cfg, cb);
  }

  // ── MixedTranscriber surface ─────────────────────────────────────────────

  feedAudio(pcm: Float32Array, tsMs: number): void {
    if (this.disposed) return;
    const wall = this.now();
    if (!this.segText && this.lastAudioTsMs && tsMs - this.lastAudioTsMs > SEGMENT_GAP_MS) {
      // Fresh audio after a quiet stretch with nothing pending — new turn.
      this.beginTurn(tsMs);
    }
    if (!this.turnStartMs) this.beginTurn(tsMs);
    this.lastAudioTsMs = tsMs;
    this.lastAudioWallMs = wall;
    this.tailFlushed = false;
    this.sessionAudioSec += pcm.length / SAMPLE_RATE;
    this.starvedAudioSec += pcm.length / SAMPLE_RATE;
    const pcm16 = float32ToPcm16(pcm);
    if (this.transport?.ready) {
      this.transport.sendAudio(pcm16);
      this.audioSinceCommit = true;
    } else {
      this.pendingAudio.push(pcm16);
      if (!this.transport) this.connect();
    }
  }

  recordHint(name: string, kind: HintKind, tMs: number, isEnd?: boolean): void {
    if (this.disposed) return;
    this.binder.recordHint({ name, kind, tMs, isEnd });
    // Immediate outcome + open-turn re-resolve: a hint overlapping the open turn
    // renames its pending text right away (matched); otherwise it may still
    // window-match a later commit (missed = the hop's immediate fate only).
    const open = this.openTurnWindow();
    const matched = !!open && tMs >= open.tStartMs - 2500 && tMs <= open.tEndMs + 2500;
    this.cb.onHintOutcome?.({ name, kind, tMs, outcome: matched ? 'matched' : 'missed' });
    if (matched && this.segText) this.publishPendingNow();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    // Flush-and-drain: release the delay-conditioned tail, give in-flight deltas
    // a bounded window to arrive, then finalize whatever is open.
    if (this.transport?.ready) {
      try {
        this.transport.sendAudio(TAIL_SILENCE);
        this.transport.commit();
        await new Promise((r) => setTimeout(r, this.cfg.sweepIntervalMs === 0 ? 0 : DRAIN_MS));
      } catch (e) { this.cb.onError?.(e); }
    }
    this.finalizeSegment('dispose');
    this.transport?.close();
    this.transport = null;
  }

  // ── session ──────────────────────────────────────────────────────────────

  private connect(): void {
    this.sessionAudioSec = 0;
    const factory = this.cfg.transportFactory ?? openLiveTransport;
    const t = factory(
      { url: this.cfg.url, apiToken: this.cfg.apiToken, model: this.cfg.model },
      {
        onOpen: () => {
          if (this.transport !== t) return;
          this.starvedAudioSec = 0;
          this.starvedWarned = false;
          this.lastCommitWallMs = this.now();
          // Language primer FIRST — the model locks onto the first audio it hears.
          if (this.primer.pcm) {
            this.primer.armed();
            t.sendAudio(this.primer.pcm);
            t.commit();
          }
          const queued = this.pendingAudio.splice(0);
          for (const pcm of queued) t.sendAudio(pcm);
          if (queued.length > 0) this.audioSinceCommit = true;
        },
        onDelta: (text) => { if (this.transport === t) this.handleDelta(text); },
        onClose: (reason) => {
          if (this.transport !== t) return;
          this.cb.log?.(`[voxtral] transport closed: ${reason} (lazy reconnect on next audio)`);
          this.transport = null;
        },
        log: this.cb.log,
      },
    );
    this.transport = t;
  }

  private recycleSession(reason: string): void {
    this.cb.log?.(`[voxtral] session recycle (${reason}, ${Math.round(this.sessionAudioSec)}s audio)`);
    this.finalizeSegment('recycle');
    this.transport?.close();
    this.transport = null;
    // Reconnect eagerly so the primer locks the language before speech resumes.
    this.connect();
  }

  // ── deltas → segments ────────────────────────────────────────────────────

  private handleDelta(delta: string): void {
    if (!delta) return;
    if (this.starvedWarned) {
      this.cb.log?.(`[voxtral] recovered — decoding resumed after ${this.starvedAudioSec.toFixed(1)}s of unanswered audio`);
    }
    this.starvedAudioSec = 0;
    this.starvedWarned = false;
    if (this.primer.consume(delta)) return;
    if (!this.segText && !this.turnStartMs) this.beginTurn(this.lastAudioTsMs || this.now());
    this.segText += delta;
    this.lastDeltaWallMs = this.now();
    this.publishPendingNow();
    // Sentence end finalizes long segments mid-speech, and ANY segment once the
    // audio has gone quiet (short utterances must not wait out the gap timer
    // after the tail flush already released their last words).
    if (this.segText.length >= MAX_SEGMENT_CHARS ||
        (SENTENCE_END.test(this.segText) &&
         (this.segText.trim().length > SENTENCE_MIN_CHARS ||
          this.now() - this.lastAudioWallMs > SENTENCE_QUIET_MS))) {
      this.finalizeSegment('boundary');
    }
  }

  private publishPendingNow(): void {
    const text = this.segText.trim();
    if (!text || this.primer.isResidue(text)) return;
    const speaker = this.resolveOpenName();
    if (this.pendingSpeaker && this.pendingSpeaker !== speaker) {
      this.cb.clearPending(this.pendingSpeaker);
    }
    this.pendingSpeaker = speaker;
    this.cb.publishPending(speaker, [this.openSegment(text)]);
  }

  private finalizeSegment(reason: string): void {
    const text = this.segText.trim();
    this.segText = '';
    if (!text) { this.endTurn(); return; }
    if (this.primer.isResidue(text)) {
      this.cb.log?.(`[voxtral] [FILTERED] primer residue: "${text}"`);
      this.clearPendingDraft();
      this.endTurn();
      return;
    }
    if (isJunk(text, this.cfg.junkPhrases)) {
      this.cb.log?.(`[voxtral] [FILTERED] junk: "${text.slice(0, 60)}"`);
      this.clearPendingDraft();
      this.endTurn();
      return;
    }
    const seg = this.openSegment(text);
    this.seq++;
    const clusterId = this.openClusterId;
    const window = { clusterId, tStartMs: seg.startMs, tEndMs: seg.endMs };
    // resolve() records the cluster vote itself on a window match.
    const res = this.binder.resolve(window);
    const speaker = res.speakerName;
    this.rememberTurn(clusterId, speaker, seg);
    this.cb.log?.(`[voxtral] CONFIRMED (${reason}) ${speaker} | "${text.slice(0, 60)}"`);
    // ONE atomic bundle: confirmed + (empty) surviving pending tail.
    this.cb.publish(speaker, [seg], []);
    this.pendingSpeaker = null;
    this.endTurn();
  }

  private clearPendingDraft(): void {
    if (this.pendingSpeaker) { this.cb.clearPending(this.pendingSpeaker); this.pendingSpeaker = null; }
  }

  private beginTurn(tsMs: number): void {
    this.turnStartMs = tsMs;
    this.openClusterId = `seg_${this.turnCounter++}`;
  }

  private endTurn(): void {
    // Next audio (or delta) opens a fresh turn; end timestamp already consumed.
    this.turnStartMs = 0;
  }

  private openSegment(text: string): VoxtralSegment {
    const startMs = this.turnStartMs || this.lastAudioTsMs || this.now();
    const endMs = Math.max(this.lastAudioTsMs, startMs + 1);
    return {
      text,
      startMs,
      endMs,
      language: this.cb.language ?? '',
      segmentId: `${this.openClusterId}:${this.seq}`,
    };
  }

  private openTurnWindow(): { tStartMs: number; tEndMs: number } | null {
    if (!this.turnStartMs) return null;
    return { tStartMs: this.turnStartMs, tEndMs: Math.max(this.lastAudioTsMs, this.turnStartMs) };
  }

  private resolveOpenName(): string {
    const open = this.openTurnWindow();
    if (!open) return this.openClusterId || 'seg_0';
    // Pending resolution must not accumulate votes — only the finalize does.
    const res = this.binder.resolve(
      { clusterId: this.openClusterId, tStartMs: open.tStartMs, tEndMs: open.tEndMs },
      { recordVote: false },
    );
    return res.speakerName;
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
    // Republish the SAME segment ids under the new name — repaint in place.
    this.cb.rename(old, name, rec.segments);
  }

  // ── cadence (public so tests can drive it without timers) ────────────────

  sweep(): void {
    if (this.disposed) return;
    const now = this.now();
    const t = this.transport;
    // Commit cadence — the model only transcribes committed audio.
    if (t?.ready && this.audioSinceCommit && now - this.lastCommitWallMs >= COMMIT_INTERVAL_MS) {
      t.commit();
      this.audioSinceCommit = false;
      this.lastCommitWallMs = now;
    }
    // Tail flush — delay conditioning withholds the final words until the model
    // sees audio AFTER them; the capture sends nothing during a pause.
    if (!this.tailFlushed && t?.ready &&
        now - this.lastAudioWallMs > TAIL_FLUSH_AFTER_MS &&
        now - this.lastAudioWallMs < IDLE_TIMEOUT_MS) {
      t.sendAudio(TAIL_SILENCE);
      t.commit();
      this.lastCommitWallMs = now;
      this.audioSinceCommit = false;
      this.tailFlushed = true;
    }
    // Silence gap → the open segment is done. Gate on AUDIO silence, not delta
    // silence (deltas arrive in bursts per commit).
    if (this.segText && this.lastDeltaWallMs &&
        now - this.lastDeltaWallMs > SEGMENT_GAP_MS &&
        now - this.lastAudioWallMs > SEGMENT_GAP_MS) {
      this.finalizeSegment('gap');
    }
    // Context guard — recycle at the first pause past the audio budget, forced
    // past the extra margin even mid-speech.
    if (t?.ready && this.sessionAudioSec >= SESSION_MAX_AUDIO_SEC &&
        ((this.tailFlushed && now - this.lastAudioWallMs > TAIL_FLUSH_AFTER_MS) ||
         this.sessionAudioSec >= SESSION_MAX_AUDIO_SEC + SESSION_FORCE_EXTRA_SEC)) {
      this.recycleSession('context guard');
      return;
    }
    if (t?.ready && !this.starvedWarned && this.starvedAudioSec >= STARVATION_WARN_SEC) {
      this.starvedWarned = true;
      this.cb.log?.(`[voxtral] ⚠️ starved — ${this.starvedAudioSec.toFixed(1)}s of audio sent, 0 decoded back` +
        ` (the server may be serving another stream)`);
      this.cb.onError?.(new Error(`voxtral starved: ${this.starvedAudioSec.toFixed(1)}s audio unanswered`));
    }
    // Long idle → close the transport (reopens on next audio).
    if (t && now - this.lastAudioWallMs > IDLE_TIMEOUT_MS && this.lastAudioWallMs > 0) {
      this.cb.log?.('[voxtral] idle close');
      this.finalizeSegment('idle');
      t.close();
      this.transport = null;
    }
  }
}

function float32ToPcm16(audio: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    const v = Math.max(-1, Math.min(1, audio[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  return buf;
}
