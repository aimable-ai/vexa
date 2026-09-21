/**
 * Speaker ids — the platform participant id behind a segment's display name.
 *
 * The page reports roster snapshots (id + name of each remote participant present). A name
 * resolves to the id it last had in a snapshot where it was unique: a rejoin (new id, old tile
 * gone) moves the name to the new id, and while two participants in the latest snapshot share a
 * name, that name has no id — never a guess. Segments are stamped when published.
 */
import type { TranscriptSegment } from './contracts.js';
import type { SpeakerEvent, TranscriptSink } from './ports.js';

export interface SpeakerIds {
  recordRoster(participants: { id: string; name: string }[]): void;
  idFor(name: string): string | undefined;
}

export function createSpeakerIds(): SpeakerIds {
  const idByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  return {
    recordRoster(participants) {
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
    idFor(name) {
      return ambiguous.has(name) ? undefined : idByName.get(name);
    },
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
