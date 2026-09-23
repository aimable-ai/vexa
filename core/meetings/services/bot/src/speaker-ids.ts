/**
 * Speaker ids — the platform participant id behind a segment's display name.
 *
 * The page reports roster snapshots (id + name of each remote participant present). A name
 * resolves to the id it last had in a snapshot where it was unique: a rejoin (new id, old tile
 * gone) moves the name to the new id, and while two participants in the latest snapshot share a
 * name, that name has no id — never a guess. Segments are stamped when published.
 *
 * Every roster name (Meet snapshots, Teams tiles) is also kept as the meeting's participant list:
 * Whisper hint words while live, and the terminal lifecycle event's `participants`.
 */
import type { TranscriptSegment } from './contracts.js';
import type { Participant, SpeakerEvent, TranscriptSink } from './ports.js';

export interface SpeakerIds {
  recordRoster(participants: { id: string; name: string }[]): void;
  /** A roster name without a platform id (Teams tiles). */
  recordName(name: string): void;
  idFor(name: string): string | undefined;
  /** Everyone seen in the meeting, first-seen order; the bot and placeholder names excluded. */
  participants(): Participant[];
}

/** Platform labels for a participant with no usable name. */
const PLACEHOLDER_NAME = /^(?:(?:teams|google) participant \(|unknown\b|speaker\b)/i;

/** The name without an organisation suffix: "Joost van Bruggen | MavenBlue" → "Joost van Bruggen". */
export const bareName = (name: string): string => name.split(/ \| | \(/)[0].trim();

export function createSpeakerIds(selfName?: string): SpeakerIds {
  const idByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  const seen = new Map<string, Participant>();
  const self = bareName(selfName ?? '').toLowerCase();
  const see = (raw: unknown, id?: string): void => {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || PLACEHOLDER_NAME.test(name) || (self && bareName(name).toLowerCase() === self)) return;
    const p = seen.get(name) ?? { name };
    if (id) p.id = id;
    seen.set(name, p);
  };
  return {
    recordRoster(participants) {
      for (const { id, name } of participants) see(name, id);
      const idsByName = new Map<string, Set<string>>();
      for (const { id, name } of participants) {
        if (!idsByName.has(name)) idsByName.set(name, new Set());
        idsByName.get(name)!.add(id);
      }
      ambiguous.clear();
      for (const [name, ids] of idsByName) {
        if (ids.size > 1) ambiguous.add(name);
        else idByName.set(name, [...ids][0]);
      }
    },
    recordName: (name) => see(name),
    idFor(name) {
      return ambiguous.has(name) ? undefined : idByName.get(name);
    },
    participants: () => [...seen.values()].map((p) => ({ ...p })),
  };
}

/** Stamps `speaker_id` on each published segment whose speaker name resolves to one id. */
/** Stamps `speaker_id` on each speaker turn whose name resolves to one id. */
export function turnsWithSpeakerIds(turns: SpeakerEvent[], ids: SpeakerIds): SpeakerEvent[] {
  return turns.map((t) => {
    const id = ids.idFor(t.speaker);
    return id ? { ...t, speaker_id: id } : t;
  });
}

export function withSpeakerIds(sink: TranscriptSink, ids: SpeakerIds): TranscriptSink {
  return {
    publish(segment: TranscriptSegment) {
      const id = segment.speaker ? ids.idFor(segment.speaker) : undefined;
      return sink.publish(id ? { ...segment, speaker_id: id } : segment);
    },
    ...(sink.retract ? { retract: (segmentIds: string[]) => sink.retract!(segmentIds) } : {}),
  };
}
