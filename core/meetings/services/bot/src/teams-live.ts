/**
 * Teams CSRC lane over a LIVE engine (Voxtral / reson8) — the fork's per-source counterpart of
 * upstream's whisper-window `TeamsCsrcGmeetPipeline`. Same transport spine (`TeamsCsrcChannelizer`
 * fans the server mix out into one virtual channel per contributing source; `TrackNamer` earns
 * each source's display name from hint/caption/roster evidence), but every virtual channel drives
 * its OWN live session through `LiveSpeakerStreams` (channel index = CSRC), exactly like the
 * gmeet-live lane. No whisper windows, no LocalAgreement: the engine's committed drafts publish
 * as `stable` under the source's current label and repaint in place when the namer proves a name.
 */
import { TeamsCsrcChannelizer, TrackNamer } from '@vexa/mixed-pipeline';
import type {
  TeamsCsrcGmeetPipelineOptions,
  TeamsCsrcTranscriptSegment,
  TransportEvent,
} from '@vexa/mixed-pipeline';
import { LiveSpeakerStreams } from '@vexa/stt-live';
import type { LiveSpeakerStreamsConfig, VoxtralSegment } from '@vexa/stt-live';

/** Live-lane rows carry `stable`; upstream's segment type has no such notion (whisper drafts move). */
export type TeamsLiveSegment = TeamsCsrcTranscriptSegment & { stable?: boolean };

export interface TeamsCsrcLiveOptions {
  streams: LiveSpeakerStreamsConfig;
  language?: string;
  selfName?: string;
  onSegment: (segment: TeamsLiveSegment) => void;
  onError?: (e: unknown) => void;
  log?: (m: string) => void;
}

export class TeamsCsrcLiveTranscriber {
  private readonly channelizer: TeamsCsrcChannelizer;
  private readonly namer: TrackNamer;
  private readonly streams: LiveSpeakerStreams;
  /** Latest row per id, kept only so a late-proven name can repaint the source's rows. */
  private readonly rows = new Map<string, TeamsLiveSegment>();

  constructor(private readonly opts: TeamsCsrcLiveOptions) {
    this.namer = new TrackNamer({
      selfName: opts.selfName,
      requireCanonicalDisplayName: true,
      onNamed: (trackId) => this.repaint(Number(trackId)),
    });
    this.streams = new LiveSpeakerStreams(opts.streams, {
      language: opts.language,
      onError: opts.onError,
      log: opts.log,
      publish: (csrc, _speaker, confirmed, pending) => { this.emit(csrc, confirmed, true); this.emit(csrc, pending, false); },
      publishPending: (csrc, _speaker, segs) => this.emit(csrc, segs, false),
      clearPending: () => { /* transcript.v1 egress is append-only; drafts self-replace by id */ },
      // The engine's own binder never sees a hint on this lane (names come from the namer), so its
      // rename is only a re-publish of the same rows under our label.
      rename: (csrc, _o, _n, segs) => this.emit(csrc, segs, true),
    });
    this.channelizer = new TeamsCsrcChannelizer({
      onFrame: (f) => this.streams.feedAudio(f.csrc, undefined, f.pcm, f.tsMs),
    });
  }

  feedMixedAudio(pcm: Float32Array, tsMs: number): void {
    this.channelizer.feedAudio(pcm, tsMs);
    this.namer.tick(tsMs + (pcm.length / 16_000) * 1000);
  }

  recordTransportEvent(ev: TransportEvent): void {
    this.namer.setTrackActive(String(ev.csrc), ev.active, ev.tMs);
    this.channelizer.recordTransportEvent(ev);
  }

  recordHint(name: string, tMs: number, isEnd = false): void { this.namer.recordHint(name, tMs, isEnd); }
  recordCaption(name: string, tMs: number): void { this.namer.recordCaption(name, tMs); }
  recordRosterName(name: string, tMs?: number): void { this.namer.recordRosterName(name, tMs); }
  recordRosterCoverage(named: number, participants: number, tMs?: number): void {
    this.namer.recordRosterCoverage(named, participants, tMs);
  }

  async dispose(): Promise<void> {
    await this.streams.dispose();
    this.namer.finish();
  }

  private emit(csrc: number, segs: VoxtralSegment[], completed: boolean): void {
    const speaker = this.namer.labelFor(String(csrc));
    for (const s of segs) {
      const row: TeamsLiveSegment = {
        csrc, speaker, sourceKey: `csrc:${csrc}`, segmentId: `csrc${csrc}:${s.segmentId}`,
        text: s.text, startMs: s.startMs, endMs: s.endMs, completed, language: s.language,
        ...(completed ? {} : { stable: true }),
      };
      this.rows.set(row.segmentId, row);
      this.opts.onSegment(row);
    }
  }

  private repaint(csrc: number): void {
    if (!Number.isFinite(csrc)) return;
    const speaker = this.namer.labelFor(String(csrc));
    for (const row of this.rows.values()) {
      if (row.csrc !== csrc || row.speaker === speaker) continue;
      const next = { ...row, speaker };
      this.rows.set(next.segmentId, next);
      this.opts.onSegment(next);
    }
  }
}

/** The `TeamsTranscriberFactory` the bot hands `createTeamsBotPipeline` when the meeting's STT URL
 *  selects a live engine: upstream's whisper `transcribe` in the options is ignored by design. */
export function teamsLiveTranscriberFactory(
  streams: LiveSpeakerStreamsConfig,
  language: string | undefined,
  log?: (m: string) => void,
): (options: TeamsCsrcGmeetPipelineOptions) => TeamsCsrcLiveTranscriber {
  return (options) => new TeamsCsrcLiveTranscriber({
    streams, language, selfName: options.selfName, onSegment: options.onSegment, onError: options.onError, log,
  });
}
