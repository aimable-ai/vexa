/**
 * speaker-ids — roster snapshots resolve a segment's speaker name to one participant id.
 * Run: npx tsx src/speaker-ids.test.ts
 */
import { createSpeakerIds, withSpeakerIds } from './speaker-ids.js';
import type { TranscriptSegment } from './contracts.js';
import type { TranscriptSink } from './ports.js';

let failed = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? '✅' : '❌'} ${name}`); if (!cond) failed++; };

{
  const ids = createSpeakerIds();
  ids.recordRoster([{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }]);
  check('a unique name resolves to its id', ids.idFor('Alice') === 'p1');
  check('an unknown name has no id', ids.idFor('Carol') === undefined);
  ids.recordRoster([{ id: 'p2', name: 'Bob' }]);
  check('a name keeps its id after leaving', ids.idFor('Alice') === 'p1');
  ids.recordRoster([{ id: 'p2', name: 'Bob' }, { id: 'p3', name: 'Alice' }]);
  check('a rejoin moves the name to the new id', ids.idFor('Alice') === 'p3');
  ids.recordRoster([{ id: 'p2', name: 'Bob' }, { id: 'p4', name: 'Bob' }]);
  check('two participants sharing a name leave it without an id', ids.idFor('Bob') === undefined);
  ids.recordRoster([{ id: 'p2', name: 'Bob' }]);
  check('once the name is unique again it resolves', ids.idFor('Bob') === 'p2');
}
{
  const published: TranscriptSegment[] = [];
  const retracted: string[][] = [];
  const inner: TranscriptSink = {
    publish: async (s) => { published.push(s); },
    retract: async (idsToRetract) => { retracted.push(idsToRetract); },
  };
  const ids = createSpeakerIds();
  ids.recordRoster([{ id: 'p1', name: 'Alice' }]);
  const sink = withSpeakerIds(inner, ids);
  const seg = (speaker: string): TranscriptSegment => ({ segment_id: `s-${speaker}`, speaker, text: 'hi', start: 0, end: 1, completed: true });
  await sink.publish(seg('Alice'));
  await sink.publish(seg(''));
  await sink.publish(seg('Carol'));
  check('a resolvable speaker is stamped', published[0].speaker_id === 'p1');
  check('an unnamed segment is not stamped', !('speaker_id' in published[1]));
  check('an unresolvable speaker is not stamped', !('speaker_id' in published[2]));
  await sink.retract?.(['s-Alice']);
  check('retract passes through', JSON.stringify(retracted) === JSON.stringify([['s-Alice']]));
  check('a sink without retract stays without one', withSpeakerIds({ publish: async () => {} }, ids).retract === undefined);
}

if (failed) { console.error(`\n❌ speaker-ids: ${failed} checks FAILED.`); process.exit(1); }
console.log('\n✅ speaker-ids: roster → id resolution and segment stamping pass.');
