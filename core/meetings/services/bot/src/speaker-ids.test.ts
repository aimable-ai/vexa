/**
 * speaker-ids — roster snapshots resolve a segment's speaker name to one participant id.
 * Run: npx tsx src/speaker-ids.test.ts
 */
import { createSpeakerIds, turnsWithSpeakerIds, withSpeakerIds } from './speaker-ids.js';
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
  const turns = turnsWithSpeakerIds([{ speaker: 'Alice', start: 1, end: 2 }, { speaker: 'Carol', start: 2, end: 3 }], ids);
  check('a speaker turn with a resolvable name is stamped', turns[0].speaker_id === 'p1');
  check('an unresolvable speaker turn is not stamped', !('speaker_id' in turns[1]));
}

{
  // AIM-2073: the participant list — first-seen order, full names as seen, bot + placeholders out.
  const ids = createSpeakerIds('Aimable Notetaker');
  ids.recordRoster([
    { id: 'p1', name: 'Joost van Bruggen | MavenBlue' },
    { id: 'p0', name: 'Aimable Notetaker' },
    { id: 'p2', name: 'Google Participant (spaces/abc/devices/2)' },
  ]);
  ids.recordName('Aimable Notetaker (Guest)');
  ids.recordName('Teams Participant (8a1f)');
  ids.recordName('Unknown');
  ids.recordName('Speaker 2');
  ids.recordName('  ');
  ids.recordName('Anna de Vries (Bolsius)');
  ids.recordRoster([{ id: 'p3', name: 'Joost van Bruggen | MavenBlue' }]);
  const list = ids.participants();
  check('participants: bot and placeholders excluded, suffix kept, deduped, first-seen order',
    JSON.stringify(list) === JSON.stringify(['Joost van Bruggen | MavenBlue', 'Anna de Vries (Bolsius)']));
  check('the roster still resolves speaker ids', ids.idFor('Joost van Bruggen | MavenBlue') === 'p3');
  const noBot = createSpeakerIds();
  noBot.recordName('Aimable Notetaker');
  check('no bot name → nobody excluded as the bot', noBot.participants().length === 1);
}

if (failed) { console.error(`\n❌ speaker-ids: ${failed} checks FAILED.`); process.exit(1); }
console.log('\n✅ speaker-ids: roster → id resolution and segment stamping pass.');
