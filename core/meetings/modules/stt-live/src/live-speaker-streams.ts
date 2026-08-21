/**
 * LiveSpeakerStreams — per-CHANNEL live sessions for the gmeet lane.
 *
 * The mixed lane runs ONE live session over one summed stream (names from
 * hints); Google Meet's lane is per-participant: each capture channel is one
 * speaker's clean audio, named page-side by the glow. So a live engine on the
 * gmeet lane is one engine instance PER CHANNEL, lazily created on the
 * channel's first frame, with the glow name fed as that channel's hint stream
 * (the engines' shared binder then names turns and repaints late upgrades —
 * `ch-N` provisional → real name — through the same rename contract).
 *
 * Engine instances are the SAME VoxtralTranscriber / Reson8Transcriber used by
 * the mixed lane: sessions lazy-connect on first audio, idle-close after 20 s,
 * and (voxtral) recycle at the context budget — so quiet channels cost nothing.
 * Note the audio.cpp HTTP-live server decodes one stream per model: concurrent
 * Meet speakers on that transport queue on the server and the starvation
 * warning fires; the vLLM realtime WS serves sessions concurrently.
 */
import type { HintKind } from '@vexa/mixed-pipeline/binder';
import { VoxtralTranscriber, type VoxtralTranscriberCallbacks, type VoxtralTranscriberConfig } from './voxtral-transcriber.js';
import { Reson8Transcriber, type Reson8TranscriberConfig } from './reson8-transcriber.js';

/** The per-channel engine surface LiveSpeakerStreams drives. */
interface ChannelEngine {
  feedAudio(pcm: Float32Array, tsMs: number): void;
  recordHint(name: string, kind: HintKind, tMs: number, isEnd?: boolean): void;
  dispose(): Promise<void>;
}

export type LiveEngineKind = 'voxtral' | 'reson8';

export interface LiveSpeakerStreamsConfig {
  engine: LiveEngineKind;
  url: string;
  apiToken?: string;
  model?: string;
  /** Test seams, forwarded to each channel engine. */
  voxtral?: Partial<VoxtralTranscriberConfig>;
  reson8?: Partial<Reson8TranscriberConfig>;
}

/** Callbacks are the engines' own shape, extended with the channel index so
 *  the host can key segment ids per channel. */
export interface LiveSpeakerStreamsCallbacks extends Omit<VoxtralTranscriberCallbacks, 'publish' | 'publishPending' | 'clearPending' | 'rename'> {
  publish: (channel: number, speaker: string, confirmed: import('./voxtral-transcriber.js').VoxtralSegment[], pending: import('./voxtral-transcriber.js').VoxtralSegment[]) => void;
  publishPending: (channel: number, speaker: string, segments: import('./voxtral-transcriber.js').VoxtralSegment[]) => void;
  clearPending: (channel: number, speaker: string) => void;
  rename: (channel: number, oldSpeaker: string, newSpeaker: string, segments: import('./voxtral-transcriber.js').VoxtralSegment[]) => void;
}

/** The glow is the gmeet lane's native hint stream — page-side, per frame. */
const GLOW_HINT_KIND: HintKind = 'dom-active';

/** A glow that stays away this long ends its hint turn (frames are ~256 ms apart). */
const GLOW_END_GAP_MS = 700;

interface GlowState { name: string; lastMs: number }

/** One transport edge from the capture bridge: a contributing source became (in)audible on a
 *  capture channel. Meet forwards three static slots and stamps the speaking participant as CSRC. */
export interface LiveTransportEvent { csrc: number; active: boolean; tMs: number; channel?: number }

interface CsrcInterval { start: number; end: number | null }
interface CsrcState {
  /** Per channel: this source's audible intervals (pruned to CSRC_HISTORY_MS). */
  onChannel: Map<number, CsrcInterval[]>;
  /** Glow co-activity while audible, per name (ms). */
  support: Map<string, number>;
  /** Bound name once the evidence clears the bars. */
  name?: string;
  /** Last transport event of any kind for this source — a lost `active:false` must not let an
   *  open interval hold a name for the rest of the meeting. */
  lastSeenMs: number;
  /** Accounting for the marker test: ms audible on some slot, and ms audible ALONE on its slot.
   *  Meet stamps a constant (42 so far) on whichever slot carries the dominant speaker — it is on
   *  exactly one slot at a time, for the whole meeting, and NEVER alone; a person is alone on a
   *  slot a good share of their time. (Two-slots-at-once and co-occurrence rules both failed on a
   *  4-person call: Meet reshuffles people across its three slots ~10×/s.) */
  activeMs: number;
  soloMs: number;
  /** The current marker verdict (re-evaluated as time is charged; may flip back). */
  ambient: boolean;
  /** Confirmed rows already published under this source, for the late-name repaint. */
  published: Array<{ channel: number; speaker: string; seg: import('./voxtral-transcriber.js').VoxtralSegment }>;
}

const CSRC_HISTORY_MS = 10 * 60_000;
/** The marker test needs this much audible time before a verdict, and a solo share below this. */
const AMBIENT_MIN_ACTIVE_MS = 20_000;
const AMBIENT_MAX_SOLO_SHARE = 0.03;
const CSRC_MIN_SUPPORT_MS = 1500;
const CSRC_MIN_SHARE = 0.6;
const CSRC_MIN_MARGIN = 0.1;
const REBIND_MIN_SHARE = 0.75;
const REBIND_MIN_MARGIN = 0.25;
const NAME_HOLDER_QUIET_MS = 30_000;
/** A source must cover this much of a segment (fraction, or absolute ms) to own it. */
const CSRC_MIN_COVER_FRACTION = 0.3;
const CSRC_MIN_COVER_MS = 300;
const CSRC_PUBLISHED_KEEP = 300;

export class LiveSpeakerStreams {
  private channels = new Map<number, ChannelEngine>();
  private creating = new Map<number, Promise<ChannelEngine>>();
  private glow = new Map<number, GlowState>();
  private csrcs = new Map<number, CsrcState>();
  /** Per channel: the sources currently open there, and when that set last changed. */
  private openOn = new Map<number, { set: Set<number>; sinceMs: number }>();
  private disposed = false;

  constructor(private cfg: LiveSpeakerStreamsConfig, private cb: LiveSpeakerStreamsCallbacks) {}

  /** One gmeet capture frame: channel index + optional glow name. */
  feedAudio(channel: number, glowName: string | undefined, pcm: Float32Array, tsMs: number): void {
    if (this.disposed) return;
    if (glowName) this.learn(channel, glowName, tsMs, pcm.length / 16);   // 16 kHz ⇒ samples/16 = ms
    const hints = this.glowHints(channel, glowName, tsMs);
    const engine = this.channels.get(channel);
    if (engine) {
      engine.feedAudio(pcm, tsMs);
      for (const h of hints) engine.recordHint(h.name, GLOW_HINT_KIND, h.tMs, h.isEnd);
      return;
    }
    void this.ensure(channel).then((e) => {
      if (this.disposed) return;
      e.feedAudio(pcm, tsMs);
      for (const h of hints) e.recordHint(h.name, GLOW_HINT_KIND, h.tMs, h.isEnd);
    });
  }

  /** The glow rides EVERY frame; a same-name hint per frame EXTENDS the binder's open turn.
   *  What the frames never carry is an END — so emit one when the glow switches to another
   *  name or stays away longer than GLOW_END_GAP_MS, instead of leaving the turn to the
   *  binder's open-turn grace. */
  private glowHints(channel: number, glowName: string | undefined, tsMs: number): Array<{ name: string; tMs: number; isEnd?: boolean }> {
    const cur = this.glow.get(channel);
    const out: Array<{ name: string; tMs: number; isEnd?: boolean }> = [];
    if (cur && glowName !== cur.name && (glowName || tsMs - cur.lastMs > GLOW_END_GAP_MS)) {
      out.push({ name: cur.name, tMs: cur.lastMs, isEnd: true });
      this.glow.delete(channel);
    }
    if (glowName) {
      const same = this.glow.get(channel);
      if (same) same.lastMs = tsMs; else this.glow.set(channel, { name: glowName, lastMs: tsMs });
      out.push({ name: glowName, tMs: tsMs });
    }
    return out;
  }

  /**
   * A transport edge (RTP contributing source on a capture channel). This is the gmeet lane's
   * speaker IDENTITY: the CSRC is per participant for the session, the glow only says who is lit.
   * Names are learned channel-locally — a source audible on channel c while name N glows supports
   * (source ↔ N) — and a source seen on two channels at once is ambient (Meet stamps a constant
   * marker beside the participant) and never attributes anything.
   */
  recordTransport(ev: LiveTransportEvent): void {
    if (this.disposed || typeof ev.channel !== 'number') return;
    const st = this.csrcState(ev.csrc);
    st.lastSeenMs = Math.max(st.lastSeenMs, ev.tMs);
    const list = st.onChannel.get(ev.channel) ?? [];
    st.onChannel.set(ev.channel, list);
    const open = list.length ? list[list.length - 1] : undefined;
    if (ev.active && open && open.end === null) return;         // already open on this channel
    if (!ev.active && !(open && open.end === null)) return;     // already closed
    this.account(ev.channel, ev.tMs);
    const slot = this.openOn.get(ev.channel)!;
    if (ev.active) { list.push({ start: ev.tMs, end: null }); slot.set.add(ev.csrc); }
    else { open!.end = ev.tMs; slot.set.delete(ev.csrc); }
    this.prune(st, ev.tMs);
  }

  /** Charge the elapsed time on a channel to every source open there (solo when it was alone),
   *  then re-test the marker verdicts. */
  private account(channel: number, nowMs: number): void {
    let slot = this.openOn.get(channel);
    if (!slot) { slot = { set: new Set(), sinceMs: nowMs }; this.openOn.set(channel, slot); return; }
    const dt = Math.max(0, nowMs - slot.sinceMs);
    slot.sinceMs = nowMs;
    if (!dt) return;
    for (const c of slot.set) {
      const st = this.csrcs.get(c);
      if (!st) continue;
      st.activeMs += dt;
      if (slot.set.size === 1) st.soloMs += dt;
      const verdict = st.activeMs >= AMBIENT_MIN_ACTIVE_MS && st.soloMs / st.activeMs < AMBIENT_MAX_SOLO_SHARE;
      if (verdict !== st.ambient) {
        st.ambient = verdict;
        this.cb.log?.(`[csrc] ${c} ${verdict ? 'is' : 'is no longer'} the slot marker (solo ${Math.round(st.soloMs / 1000)} s of ${Math.round(st.activeMs / 1000)} s)`);
      }
    }
  }

  private csrcState(csrc: number): CsrcState {
    let st = this.csrcs.get(csrc);
    if (!st) { st = { onChannel: new Map(), support: new Map(), ambient: false, activeMs: 0, soloMs: 0, published: [], lastSeenMs: 0 }; this.csrcs.set(csrc, st); }
    return st;
  }

  private prune(st: CsrcState, nowMs: number): void {
    for (const [ch, ivs] of st.onChannel) {
      const keep = ivs.filter((iv) => iv.end === null || nowMs - iv.end < CSRC_HISTORY_MS);
      if (keep.length !== ivs.length) st.onChannel.set(ch, keep);
    }
  }

  /** Glow co-activity: every source audible on this channel right now supports (source ↔ name). */
  private learn(channel: number, name: string, tsMs: number, frameMs: number): void {
    for (const [csrc, st] of this.csrcs) {
      if (st.ambient) continue;
      const ivs = st.onChannel.get(channel);
      if (!ivs || !ivs.length) continue;
      const last = ivs[ivs.length - 1];
      if (last.end !== null && tsMs > last.end) continue;
      if (tsMs < last.start) continue;
      st.support.set(name, (st.support.get(name) ?? 0) + frameMs);
      this.rebind(csrc, st, tsMs);
    }
  }

  private rebind(csrc: number, st: CsrcState, nowMs: number): void {
    let total = 0; let best: [string, number] | undefined; let second = 0;
    for (const [n, ms] of st.support) {
      total += ms;
      if (!best || ms > best[1]) { second = best?.[1] ?? 0; best = [n, ms]; }
      else if (ms > second) second = ms;
    }
    if (!best || best[1] < CSRC_MIN_SUPPORT_MS) return;
    const share = best[1] / total, margin = (best[1] - second) / total;
    if (share < CSRC_MIN_SHARE || margin < CSRC_MIN_MARGIN) return;
    if (st.name === best[0]) return;
    if (st.name && (share < REBIND_MIN_SHARE || margin < REBIND_MIN_MARGIN)) return;
    if (this.heldBy(best[0], csrc, nowMs) !== undefined) return;
    const prev = st.name;
    st.name = best[0];
    this.cb.log?.(`[csrc] ${csrc} → "${best[0]}" (${Math.round(best[1])} ms, share ${(best[1] / total).toFixed(2)}${prev ? `, was "${prev}"` : ''})`);
    // Late-name repaint: rows already out under a provisional/other name are re-issued.
    const byChannel = new Map<number, Map<string, import('./voxtral-transcriber.js').VoxtralSegment[]>>();
    for (const row of st.published) {
      if (row.speaker === st.name) continue;
      const m = byChannel.get(row.channel) ?? new Map(); byChannel.set(row.channel, m);
      const arr = m.get(row.speaker) ?? []; m.set(row.speaker, arr); arr.push(row.seg);
      row.speaker = st.name;
    }
    for (const [ch, m] of byChannel) for (const [old, segs] of m) this.cb.rename(ch, old, st.name, segs);
  }

  /** Another non-ambient source bound to this name and audible within NAME_HOLDER_QUIET_MS.
   *  An interval still open counts only while the source keeps reporting (Meet repeats the
   *  active event every few hundred ms) — a lost close must not hold the name forever. */
  private heldBy(name: string, except: number, nowMs: number): number | undefined {
    for (const [c, st] of this.csrcs) {
      if (c === except || st.ambient || st.name !== name) continue;
      for (const ivs of st.onChannel.values()) {
        for (const iv of ivs) {
          const lastAudible = iv.end === null ? st.lastSeenMs : iv.end;
          if (nowMs - lastAudible < NAME_HOLDER_QUIET_MS) return c;
        }
      }
    }
    return undefined;
  }

  /** The source that owns a segment on a channel: the non-ambient CSRC covering most of its window. */
  private ownerOf(channel: number, seg: { startMs: number; endMs: number }): { csrc: number; st: CsrcState } | undefined {
    const dur = Math.max(1, seg.endMs - seg.startMs);
    let best: { csrc: number; st: CsrcState; cover: number } | undefined;
    for (const [csrc, st] of this.csrcs) {
      if (st.ambient) continue;
      const ivs = st.onChannel.get(channel);
      if (!ivs) continue;
      let cover = 0;
      for (const iv of ivs) {
        const lo = Math.max(iv.start, seg.startMs);
        const hi = Math.min(iv.end ?? Number.POSITIVE_INFINITY, seg.endMs);
        if (hi > lo) cover += hi - lo;
      }
      if (cover < Math.min(CSRC_MIN_COVER_MS, dur) && cover / dur < CSRC_MIN_COVER_FRACTION) continue;
      // Tie-break: named beats unnamed; then the larger id (Meet participant ids are large random
      // 31-bit values; the small constants seen so far were ambient markers).
      if (!best || cover > best.cover + 1
        || (Math.abs(cover - best.cover) <= 1 && ((!!st.name && !best.st.name) || (!!st.name === !!best.st.name && csrc > best.csrc)))) {
        best = { csrc, st, cover };
      }
    }
    return best ? { csrc: best.csrc, st: best.st } : undefined;
  }

  /** Stamp speakerKey and (when bound) the transport-derived name onto each segment; regroup by
   *  resulting speaker so the host's per-call speaker stays truthful. */
  private attribute(
    channel: number, speaker: string, segments: import('./voxtral-transcriber.js').VoxtralSegment[], remember: boolean,
  ): Array<{ speaker: string; segments: import('./voxtral-transcriber.js').VoxtralSegment[] }> {
    const groups = new Map<string, import('./voxtral-transcriber.js').VoxtralSegment[]>();
    for (const seg of segments) {
      const owner = this.ownerOf(channel, seg);
      let sp = speaker;
      if (owner) {
        seg.speakerKey = `csrc:${owner.csrc}`;
        if (owner.st.name) sp = owner.st.name;
        if (remember) {
          owner.st.published.push({ channel, speaker: sp, seg });
          if (owner.st.published.length > CSRC_PUBLISHED_KEEP) owner.st.published.splice(0, owner.st.published.length - CSRC_PUBLISHED_KEEP);
        }
      }
      const arr = groups.get(sp) ?? []; groups.set(sp, arr); arr.push(seg);
    }
    return [...groups].map(([sp, segs]) => ({ speaker: sp, segments: segs }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const engines = [...this.channels.values()];
    this.channels.clear();
    await Promise.all(engines.map((e) => e.dispose().catch(() => { /* best-effort drain */ })));
  }

  private ensure(channel: number): Promise<ChannelEngine> {
    let p = this.creating.get(channel);
    if (!p) {
      p = this.create(channel).then((e) => { this.channels.set(channel, e); return e; });
      this.creating.set(channel, p);
    }
    return p;
  }

  private create(channel: number): Promise<ChannelEngine> {
    const cb: VoxtralTranscriberCallbacks = {
      language: this.cb.language,
      log: this.cb.log ? (m) => this.cb.log?.(`[ch${channel}]${m}`) : undefined,
      onError: this.cb.onError,
      onHintOutcome: this.cb.onHintOutcome,
      publish: (speaker, confirmed, pending) => {
        const c = this.attribute(channel, speaker, confirmed, true);
        const p = this.attribute(channel, speaker, pending, false);
        // Confirmed rows go out per resulting speaker; pending ride the first call, else their own.
        if (!c.length && !p.length) { this.cb.publish(channel, speaker, confirmed, pending); return; }
        c.forEach((g, i) => this.cb.publish(channel, g.speaker, g.segments, i === 0 && p.length === 1 && p[0].speaker === g.speaker ? p[0].segments : []));
        for (const g of p) {
          if (c.length === 1 && c[0].speaker === g.speaker) continue;
          this.cb.publish(channel, g.speaker, [], g.segments);
        }
      },
      publishPending: (speaker, segments) => {
        for (const g of this.attribute(channel, speaker, segments, false)) this.cb.publishPending(channel, g.speaker, g.segments);
      },
      clearPending: (speaker) => this.cb.clearPending(channel, speaker),
      rename: (oldS, newS, segments) => {
        // The engine's own binder repaint: the transport name, when bound, still wins.
        for (const g of this.attribute(channel, newS, segments, false)) this.cb.rename(channel, oldS, g.speaker, g.segments);
      },
    };
    if (this.cfg.engine === 'reson8') {
      return Reson8Transcriber.create(
        { url: this.cfg.url, apiKey: this.cfg.apiToken ?? '', ...this.cfg.reson8 }, cb,
      );
    }
    return VoxtralTranscriber.create(
      { url: this.cfg.url, apiToken: this.cfg.apiToken, model: this.cfg.model, ...this.cfg.voxtral }, cb,
    );
  }
}
