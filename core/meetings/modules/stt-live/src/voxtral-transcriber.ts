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
 *     sees audio AFTER them → the capture keeps ~1.5 s of the speaker's real trailing
 *     audio flowing (hangover); synthetic silence is NOT pushed (see TAIL_SILENCE_MS);
 *   - every session (re)open is a cold start — primer replay, language re-lock,
 *     delay warm-up — and the first utterance after one is the one that gets
 *     mangled, so a session lives for the whole meeting: audio.cpp bounds its own
 *     decoder context (KV ring, wraps in place), idle only closes after minutes,
 *     and the context-guard recycle is opt-in (vLLM-era servers without a ring).
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
import { LanguageRepair, type LanguageRepairConfig } from './language-repair.js';

const SAMPLE_RATE = 16000;
/** The server only transcribes committed audio — commit cadence. */
const COMMIT_INTERVAL_MS = 750;
/** Audio-silence gap that closes the open segment. */
const SEGMENT_GAP_MS = 800;
/** Speech-pause threshold that triggers the tail flush. */
const TAIL_FLUSH_AFTER_MS = 700;
/** Synthetic silence pushed on speech pause. 0 = NONE (default since 2026-08-19): a 1.2 s block of
 *  fabricated silence dropped mid-utterance (the 700 ms threshold fires on ordinary intra-sentence
 *  pauses) locks audio.cpp's Voxtral decoder into a pad-only state for 10–25 s of real speech —
 *  meeting 14 lost 71 words; replaying its capture: silence on → hole in 3/3 runs, off → 0/2.
 *  The ~1 s delay conditioning is instead satisfied by the capture's hangover of the speaker's REAL
 *  trailing audio (gmeet-capture `hangoverMs`). `tailSilenceMs` remains as an experiment knob. */
const TAIL_SILENCE_MS = 0;
/** Force-finalize a segment at this many characters. */
const MAX_SEGMENT_CHARS = 600;
/** A sentence end finalizes mid-speech only past this length (abbreviation guard) —
 *  shorter sentences finalize once the audio has gone quiet. */
const SENTENCE_MIN_CHARS = 40;
const SENTENCE_QUIET_MS = 700;
/** Close an idle transport after this long without audio (reopens on next frame). */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** Recycle the session once it has heard this much audio (context guard); 0 = never. */
const DEFAULT_SESSION_MAX_AUDIO_SEC = 0;
/** ...waiting for a pause; force it after this much extra audio — a mid-speech
 *  recycle costs a word or two once, context overflow costs everything. */
const SESSION_FORCE_EXTRA_SEC = 160;
/** Speech sent with nothing decoded back before the session is called starved. audio.cpp's
 *  Voxtral decoder can fall into a STREAMING_PAD-only state mid-session (seen 2026-08-19: 18 s
 *  of loud speech decoded as pads, a fresh session transcribes the same bytes fine), so a
 *  starved session is recycled and the unanswered audio re-sent into the new one. */
const STARVATION_WARN_SEC = 8;
/** Unanswered audio kept for that re-send (bounded so a dead server can't grow it). */
const STARVATION_REPLAY_MAX_SEC = 30;
/** Consecutive starved recycles with no delta in between before we stop re-sending audio
 *  (a server that is down, not stuck, must not be hammered with the same 30 s forever). */
const STARVATION_MAX_RECYCLES = 3;
/** Unresolved (provisionally-named) turns kept for late hint renames. */
const MAX_UNRESOLVED = 100;
/** dispose(): wait this long for in-flight deltas after the final flush. */
const DRAIN_MS = 1500;

const SENTENCE_END = /[.!?…]["')\]]?\s*$/;
const silenceBuffer = (ms: number): Buffer => Buffer.alloc(Math.floor((ms / 1000) * SAMPLE_RATE) * 2);
const TAIL_SILENCE = silenceBuffer(TAIL_SILENCE_MS);

/** Structurally @vexa/mixed-pipeline's ChunkSegment (kept local so this module's
 *  front door needs no type dependency on the chunked lane). */
export interface VoxtralSegment {
  text: string;
  startMs: number;
  endMs: number;
  language: string;
  segmentId: string;
  /** Stable transport identity of the speaker when the lane has one (gmeet: `csrc:N`). Set by
   *  LiveSpeakerStreams; absent on the mixed lane and when no source covered the segment. */
  speakerKey?: string;
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
  /** Close an idle transport after this long without audio. Default 300 000. */
  idleTimeoutMs?: number;
  /** Recycle the session once it has heard this much audio (seconds); 0 = never. Default 0. */
  sessionMaxAudioSec?: number;
  /** Extra junk phrases (lowercased). */
  junkPhrases?: ReadonlySet<string>;
  /** Re-transcribe segments that drift out of the session language (see LanguageRepair). */
  languageRepair?: Omit<LanguageRepairConfig, 'language'>;
  /** Speech-pause threshold for the tail flush (default 700); synthetic silence pushed on it (default 1200, 0 = none). */
  tailFlushAfterMs?: number;
  tailSilenceMs?: number;
  /** Fill the tail with ±`tailNoiseLsb` LSB of white noise instead of exact digital zero. */
  tailNoiseLsb?: number;
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
  private readonly repair: LanguageRepair | null;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly sessionMaxAudioSec: number;
  private readonly tailFlushAfterMs: number;
  private readonly tailSilence: Buffer;
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
  /** Wall clock of the last delta (or session open) — a re-sent backlog must be given real
   *  time to be answered before the session is called starved again. */
  private answeredWallMs = 0;
  /** PCM sent since the last delta — what a starved session gets re-fed after recycle. */
  private starvedPcm: Buffer[] = [];
  private starvedPcmSec = 0;
  private starvedRecycles = 0;
  private seq = 0;
  private turnCounter = 0;
  private openClusterId = '';
  /** Recent turns retained for late hint renames (provisional → real name). */
  private unresolved: TurnRecord[] = [];
  private pendingSpeaker: string | null = null;

  constructor(private cfg: VoxtralTranscriberConfig, private cb: VoxtralTranscriberCallbacks) {
    this.now = cfg.now ?? Date.now;
    this.idleTimeoutMs = cfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sessionMaxAudioSec = cfg.sessionMaxAudioSec ?? DEFAULT_SESSION_MAX_AUDIO_SEC;
    this.tailFlushAfterMs = cfg.tailFlushAfterMs ?? TAIL_FLUSH_AFTER_MS;
    this.tailSilence = cfg.tailSilenceMs === undefined ? TAIL_SILENCE : silenceBuffer(cfg.tailSilenceMs);
    if (cfg.tailNoiseLsb) {
      const b = Buffer.from(this.tailSilence);
      for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * cfg.tailNoiseLsb), i);
      this.tailSilence = b;
    }
    this.primer = new PrimerGate(cb.language, this.now);
    this.repair = cfg.languageRepair ? new LanguageRepair({ ...cfg.languageRepair, language: cb.language }) : null;
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
    this.repair?.remember(tsMs, pcm16);
    if (this.transport?.ready) {
      this.transport.sendAudio(pcm16);
      this.audioSinceCommit = true;
      this.rememberUnanswered(pcm16, pcm.length / SAMPLE_RATE);
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
        if (this.tailSilence.length) this.transport.sendAudio(this.tailSilence);
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
          this.answeredWallMs = this.now();
          this.lastCommitWallMs = this.now();
          // Language primer FIRST — the model locks onto the first audio it hears.
          if (this.primer.pcm) {
            this.primer.armed();
            t.sendAudio(this.primer.pcm);
            t.commit();
          }
          const queued = this.pendingAudio.splice(0);
          for (const pcm of queued) {
            t.sendAudio(pcm);
            // Queued audio is as unanswered as live audio: a session that never answers a
            // re-sent backlog must still read as starved.
            const sec = pcm.length / 2 / SAMPLE_RATE;
            this.starvedAudioSec += sec;
            this.rememberUnanswered(pcm, sec);
          }
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

  private recycleSession(reason: string, replay: Buffer[] = []): void {
    this.cb.log?.(`[voxtral] session recycle (${reason}, ${Math.round(this.sessionAudioSec)}s audio)`);
    this.finalizeSegment('recycle');
    this.transport?.close();
    this.transport = null;
    // Audio the dead session never answered goes first into the new one (after the primer).
    this.pendingAudio.unshift(...replay);
    // Reconnect eagerly so the primer locks the language before speech resumes.
    this.connect();
  }

  private rememberUnanswered(pcm16: Buffer, sec: number): void {
    this.starvedPcm.push(pcm16);
    this.starvedPcmSec += sec;
    while (this.starvedPcmSec > STARVATION_REPLAY_MAX_SEC && this.starvedPcm.length > 1) {
      const dropped = this.starvedPcm.shift()!;
      this.starvedPcmSec -= dropped.length / 2 / SAMPLE_RATE;
    }
  }

  private clearUnanswered(): void {
    this.starvedPcm = [];
    this.starvedPcmSec = 0;
  }

  // ── deltas → segments ────────────────────────────────────────────────────

  private handleDelta(delta: string): void {
    if (!delta) return;
    if (this.starvedWarned) {
      this.cb.log?.(`[voxtral] recovered — decoding resumed after ${this.starvedAudioSec.toFixed(1)}s of unanswered audio`);
    }
    this.starvedAudioSec = 0;
    this.starvedWarned = false;
    this.starvedRecycles = 0;
    this.answeredWallMs = this.now();
    this.clearUnanswered();
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
    this.pendingSpeaker = null;
    this.endTurn();
    // Language drift (a Dutch turn rendered in EN/DE) → re-transcribe this segment's own audio
    // with the language pinned, then publish; the round-trip only delays the flagged segment.
    if (this.repair?.observe(text)) {
      this.cb.log?.(`[voxtral] [REPAIR] ${this.repair.language} drift: "${text.slice(0, 60)}"`);
      void this.repair.repair(seg.startMs, seg.endMs).then((fixed) => {
        if (fixed) { this.cb.log?.(`[voxtral] [REPAIRED] "${fixed.slice(0, 60)}"`); seg.text = fixed; }
        this.cb.publish(speaker, [seg], []);
      });
      return;
    }
    // ONE atomic bundle: confirmed + (empty) surviving pending tail.
    this.cb.publish(speaker, [seg], []);
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
        now - this.lastAudioWallMs > this.tailFlushAfterMs &&
        now - this.lastAudioWallMs < this.idleTimeoutMs) {
      if (this.tailSilence.length) t.sendAudio(this.tailSilence);
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
    if (t?.ready && this.sessionMaxAudioSec > 0 && this.sessionAudioSec >= this.sessionMaxAudioSec &&
        ((this.tailFlushed && now - this.lastAudioWallMs > this.tailFlushAfterMs) ||
         this.sessionAudioSec >= this.sessionMaxAudioSec + SESSION_FORCE_EXTRA_SEC)) {
      this.recycleSession('context guard');
      return;
    }
    if (t?.ready && !this.starvedWarned && this.starvedAudioSec >= STARVATION_WARN_SEC &&
        now - this.answeredWallMs >= STARVATION_WARN_SEC * 1000) {
      this.starvedWarned = true;
      const sec = this.starvedAudioSec.toFixed(1);
      this.cb.onError?.(new Error(`voxtral starved: ${sec}s audio unanswered`));
      if (this.starvedRecycles < STARVATION_MAX_RECYCLES) {
        this.starvedRecycles++;
        const replay = this.starvedPcm;
        this.clearUnanswered();
        this.cb.log?.(`[voxtral] ⚠️ starved — ${sec}s of audio sent, 0 decoded back; recycling the session` +
          ` and re-sending ${replay.length} frame(s) (${this.starvedRecycles}/${STARVATION_MAX_RECYCLES})`);
        this.recycleSession('starved', replay);
        return;
      }
      this.cb.log?.(`[voxtral] ⚠️ starved — ${sec}s of audio sent, 0 decoded back` +
        ` (${STARVATION_MAX_RECYCLES} recycles did not help — the server may be down or serving another stream)`);
    }
    // Long idle → close the transport (reopens on next audio).
    if (t && now - this.lastAudioWallMs > this.idleTimeoutMs && this.lastAudioWallMs > 0) {
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
