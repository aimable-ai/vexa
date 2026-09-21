/**
 * gmeet-roster — decoding Meet's protocol roster (sync response + `collections` messages) and the
 * roster state built from it. Fixtures are encoded here with the same field layout Meet sends.
 * Run: npx tsx src/gmeet-roster.test.ts
 */
import { createRosterState, decodeCollectionsMessage, decodeSyncResponse, parseFields, isSyncRpc, syncBytes, unpackCollections } from './gmeet-roster.js';

let failed = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? '✅' : '❌'} ${name}`); if (!cond) failed++; };

// ── minimal protobuf encoder for fixtures ──
const varint = (n: number): number[] => { const out: number[] = []; while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); } out.push(n); return out; };
type F = [number, number | string | Uint8Array];
const msg = (...fields: F[]): Uint8Array => {
  const out: number[] = [];
  for (const [n, v] of fields) {
    if (typeof v === 'number') { out.push(...varint(n * 8), ...varint(v)); continue; }
    const b = typeof v === 'string' ? new TextEncoder().encode(v) : v;
    out.push(...varint(n * 8 + 2), ...varint(b.length), ...b);
  }
  return Uint8Array.from(out);
};
const person = (id: string, name: string, extra: F[] = []) => msg([1, id], [2, name], [4, 1], [29, name.split(' ')[0]], [99, 'unknown field'], ...extra);
const output = (kind: number, csrc: string, deviceId: string) => msg([2, kind], [4, csrc], [6, deviceId]);

{
  const sync = msg([2, msg([2, msg([1, msg([1, 7])],
    [2, person('d/1', 'Alice Smith')],
    [2, person('d/2', 'Signed In', [[7, 'account-uuid']])],
    [2, person('d/3', 'Alice', [[21, 'd/1']])],
    [2, msg([1, 'd/4'], [29, 'Gone'], [4, 6])],
  )])]);
  const list = decodeSyncResponse(sync);
  check('sync decodes every participant', list.length === 4);
  check('full name wins over display name', list[0].name === 'Alice Smith');
  check('field 7 does not hide a participant', list[1].inMeeting && list[1].name === 'Signed In');
  check('screen share is marked', list[2].screenShare);
  check('status other than 1 is not in the meeting', !list[3].inMeeting);
  check('a varint above 2^31 decodes', (parseFields(msg([1, 2 ** 40])).get(1) ?? [])[0] === 2 ** 40);
}
{
  const body = msg([2, msg(
    [3, msg([2, output(1, '111', 'd/1')], [2, output(2, '222', 'd/1')], [2, output(1, '333', 'd/5')])],
    [13, msg([1, msg([2, person('d/5', 'Bob')])])],
  )]);
  const { participants, audio } = decodeCollectionsMessage(msg([1, body]));
  check('collections carries the joining participant', participants.length === 1 && participants[0].name === 'Bob');
  check('only audio outputs are kept', JSON.stringify(audio) === JSON.stringify([{ csrc: '111', deviceId: 'd/1' }, { csrc: '333', deviceId: 'd/5' }]));
  check('a message without roster fields decodes to nothing', decodeCollectionsMessage(msg([1, msg([7, 'x'])])).participants.length === 0);
}
{
  let threw = false;
  try { decodeSyncResponse(Uint8Array.from([0x12, 0x40, 0x01])); } catch { threw = true; }
  check('a truncated message throws instead of yielding a roster', threw);
}
{
  const state = createRosterState();
  const seen: string[] = [];
  state.applySync([
    { id: 'd/1', name: 'Alice', inMeeting: true, screenShare: false },
    { id: 'd/3', name: 'Alice', inMeeting: true, screenShare: true },
  ]);
  state.subscribe(p => seen.push(p.map(x => x.name).join(',')));
  check('roster keeps remote, in-meeting, non-screen-share participants', JSON.stringify(state.participants()) === JSON.stringify([{ id: 'd/1', name: 'Alice' }]));
  check('subscribe fires at once with the current roster', seen.join('|') === 'Alice');
  state.applyCollections({ participants: [{ id: 'd/5', name: 'Bob', inMeeting: true, screenShare: false }], audio: [{ csrc: '333', deviceId: 'd/5' }] });
  check('a join updates the roster', seen.at(-1) === 'Alice,Bob');
  check('a CSRC resolves to its participant', state.participantForCsrc(333)?.name === 'Bob');
  check('an unknown CSRC resolves to nobody', state.participantForCsrc(444) === undefined);
  state.applyCollections({ participants: [], audio: [{ csrc: '444', deviceId: 'd/3' }] });
  check('a screen-share device is never a CSRC match', state.participantForCsrc(444) === undefined);
  const before = seen.length;
  state.applyCollections({ participants: [], audio: [] });
  check('no change, no notification', seen.length === before);
  state.applySync([{ id: 'd/5', name: 'Bob', inMeeting: true, screenShare: false }]);
  check('a sync replaces the roster (leaves)', seen.at(-1) === 'Bob');
  state.applySync([]);
  check('an empty sync keeps the roster', JSON.stringify(state.participants()) === JSON.stringify([{ id: 'd/5', name: 'Bob' }]));
}
{
  const payload = msg([1, msg([2, msg([13, msg([1, msg([2, person('d/9', 'Zoe')])])])])]);
  const compress = async (format: CompressionFormat) =>
    new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream(format))).arrayBuffer());
  for (const format of ['gzip', 'deflate', 'deflate-raw'] as CompressionFormat[]) {
    const out = decodeCollectionsMessage(await unpackCollections(await compress(format)));
    check(`collections unpacks ${format}`, out.participants[0]?.name === 'Zoe');
  }
  check('uncompressed collections pass through', decodeCollectionsMessage(await unpackCollections(payload)).participants[0]?.name === 'Zoe');
  const sync = msg([2, msg([2, msg([2, person('d/1', 'Alice')])])]);
  check('sync body as base64 text', decodeSyncResponse(syncBytes(new TextEncoder().encode(Buffer.from(sync).toString('base64'))))[0]?.name === 'Alice');
  check('the live sync URL is recognised', isSyncRpc('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections'));
  check('sync body as raw protobuf', decodeSyncResponse(syncBytes(sync))[0]?.name === 'Alice');
}

if (failed) { console.error(`\n❌ gmeet-roster: ${failed} checks FAILED.`); process.exit(1); }
console.log('\n✅ gmeet-roster: protocol decode, CSRC → participant, roster state pass.');
