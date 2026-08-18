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

export class LiveSpeakerStreams {
  private channels = new Map<number, ChannelEngine>();
  private creating = new Map<number, Promise<ChannelEngine>>();
  private glow = new Map<number, GlowState>();
  private disposed = false;

  constructor(private cfg: LiveSpeakerStreamsConfig, private cb: LiveSpeakerStreamsCallbacks) {}

  /** One gmeet capture frame: channel index + optional glow name. */
  feedAudio(channel: number, glowName: string | undefined, pcm: Float32Array, tsMs: number): void {
    if (this.disposed) return;
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
      publish: (speaker, confirmed, pending) => this.cb.publish(channel, speaker, confirmed, pending),
      publishPending: (speaker, segments) => this.cb.publishPending(channel, speaker, segments),
      clearPending: (speaker) => this.cb.clearPending(channel, speaker),
      rename: (oldS, newS, segments) => this.cb.rename(channel, oldS, newS, segments),
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
