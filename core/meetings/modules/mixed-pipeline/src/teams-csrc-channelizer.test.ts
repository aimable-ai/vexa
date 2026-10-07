import { TeamsCsrcChannelizer, type TeamsCsrcVirtualFrame } from './teams-csrc-channelizer.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

const pcm = (marker: number): Float32Array => new Float32Array([marker]);
const out: TeamsCsrcVirtualFrame[] = [];
const channelizer = new TeamsCsrcChannelizer({ lookbackMs: 600, flickerHoldMs: 0, floorHoldMaxMs: 0, onFrame: (frame) => out.push(frame) });

channelizer.feedAudio(pcm(9), 900);
channelizer.recordTransportEvent({ csrc: 201, active: true, tMs: 1000 });
channelizer.feedAudio(pcm(11), 1100);
channelizer.recordTransportEvent({ csrc: 414, active: true, tMs: 1050 });
channelizer.feedAudio(pcm(12), 1200);
channelizer.recordTransportEvent({ csrc: 201, active: false, tMs: 1300 });
channelizer.feedAudio(pcm(14), 1400);
channelizer.recordTransportEvent({ csrc: 201, active: true, tMs: 1500 });
channelizer.feedAudio(pcm(16), 1600);

const routed = out.map((f) => `${f.csrc}:${f.pcm[0]}:${f.backfilled ? 'b' : 'l'}`);
const expected = [
  '201:9:b',
  '201:11:l',
  '414:9:b', '414:11:b',
  '201:12:l', '414:12:l',
  '414:14:l',
  '201:14:b',
  '414:16:l', '201:16:l',
];
check('late activation backfills, overlap fans out, inactive stops, reactivation resumes',
  JSON.stringify(routed) === JSON.stringify(expected), JSON.stringify(routed));

const keys = out.map((f) => `${f.csrc}:${f.pcm[0]}`);
check('no (CSRC, frame) pair is emitted twice', new Set(keys).size === keys.length, keys.join(','));
check('overlap routes the original immutable PCM reference to both lanes',
  out.find((f) => f.csrc === 201 && f.pcm[0] === 12)?.pcm === out.find((f) => f.csrc === 414 && f.pcm[0] === 12)?.pcm);

const health = channelizer.health();
check('health exposes the bounded routing surface',
  health.tracks === 2 && health.transitions === 4 && health.inputFrames === 5
    && health.emittedFrames === expected.length && health.backfilledFrames === 4
    && health.maxConcurrency === 2 && health.provisional === 0
    && health.suppressedFlickers === 0 && health.promotedAfterHold === 0,
  JSON.stringify(health));

const smoothed: TeamsCsrcVirtualFrame[] = [];
const smoother = new TeamsCsrcChannelizer({
  lookbackMs: 600,
  floorHoldMaxMs: 0,
  flickerHoldMs: 1500,
  onFrame: (frame) => smoothed.push(frame),
});
smoother.recordTransportEvent({ csrc: 840, active: true, tMs: 0 });
smoother.feedAudio(pcm(0), 0);
smoother.feedAudio(pcm(5), 500);
smoother.recordTransportEvent({ csrc: 414, active: true, tMs: 1000 });
smoother.feedAudio(pcm(10), 1000);
smoother.feedAudio(pcm(15), 1500);
smoother.recordTransportEvent({ csrc: 414, active: false, tMs: 1842 });
smoother.feedAudio(pcm(19), 1900);
check('a short nested CSRC flicker receives no audio while the established owner continues',
  smoothed.every((frame) => frame.csrc === 840), JSON.stringify(smoothed));

smoother.recordTransportEvent({ csrc: 201, active: true, tMs: 2000 });
smoother.feedAudio(pcm(20), 2000);
smoother.feedAudio(pcm(25), 2500);
smoother.feedAudio(pcm(30), 3000);
smoother.feedAudio(pcm(35), 3501);
const promoted201 = smoothed.filter((frame) => frame.csrc === 201).map((frame) => frame.pcm[0]);
check('a surviving nested CSRC is promoted with its complete held onset',
  JSON.stringify(promoted201) === JSON.stringify([15, 19, 20, 25, 30, 35]), JSON.stringify(promoted201));
const smoothedHealth = smoother.health();
check('flicker decisions are observable',
  smoothedHealth.suppressedFlickers === 1 && smoothedHealth.promotedAfterHold === 1
    && smoothedHealth.provisional === 0,
  JSON.stringify(smoothedHealth));

// m26123 05:19 regression: an established source and its short nested flicker both ended at the
// exact same timestamp. Processing the established false edge first used to promote and backfill
// the flicker before its own false edge was seen.
const sameTimestampFrames: TeamsCsrcVirtualFrame[] = [];
const sameTimestamp = new TeamsCsrcChannelizer({
  lookbackMs: 600,
  floorHoldMaxMs: 0,
  flickerHoldMs: 1500,
  onFrame: (frame) => sameTimestampFrames.push(frame),
});
sameTimestamp.recordTransportEvent({ csrc: 201, active: true, tMs: 0 });
sameTimestamp.feedAudio(pcm(1), 100);
sameTimestamp.recordTransportEvent({ csrc: 840, active: true, tMs: 1000 });
sameTimestamp.feedAudio(pcm(11), 1100);
sameTimestamp.recordTransportEvent({ csrc: 201, active: false, tMs: 2108 });
sameTimestamp.recordTransportEvent({ csrc: 840, active: false, tMs: 2108 });
sameTimestamp.feedAudio(pcm(22), 2200);
check('same-timestamp owner/flicker false edges cannot backfill the flicker by callback order',
  !sameTimestampFrames.some((frame) => frame.csrc === 840), JSON.stringify(sameTimestampFrames));

const handoffFrames: TeamsCsrcVirtualFrame[] = [];
const handoff = new TeamsCsrcChannelizer({
  lookbackMs: 600,
  floorHoldMaxMs: 0,
  flickerHoldMs: 1500,
  onFrame: (frame) => handoffFrames.push(frame),
});
handoff.recordTransportEvent({ csrc: 201, active: true, tMs: 0 });
handoff.feedAudio(pcm(1), 100);
handoff.recordTransportEvent({ csrc: 840, active: true, tMs: 1000 });
handoff.feedAudio(pcm(11), 1100);
handoff.recordTransportEvent({ csrc: 201, active: false, tMs: 1200 });
handoff.feedAudio(pcm(13), 1300);
check('a surviving handoff promotes on the next PCM frame with its held onset',
  handoffFrames.some((frame) => frame.csrc === 840 && frame.tsMs === 1100 && frame.backfilled),
  JSON.stringify(handoffFrames));

// ── the floor: during overlap only the source that spoke first receives the mixed audio ──
{
  const frames: TeamsCsrcVirtualFrame[] = [];
  const floor = new TeamsCsrcChannelizer({ lookbackMs: 0, flickerHoldMs: 0, floorHoldMaxMs: 30_000, onFrame: (frame) => frames.push(frame) });
  floor.recordTransportEvent({ csrc: 201, active: true, tMs: 0 });
  floor.feedAudio(pcm(1), 0);
  floor.recordTransportEvent({ csrc: 414, active: true, tMs: 1000 });
  floor.feedAudio(pcm(2), 1000);
  floor.feedAudio(pcm(9), 1300);   // older than the 700 ms catch-up when the floor passes at 2000
  floor.recordTransportEvent({ csrc: 201, active: false, tMs: 2000 });
  floor.feedAudio(pcm(3), 2000);
  const got = frames.map((f) => `${f.csrc}:${f.pcm[0]}:${f.backfilled ? 'b' : 'l'}`);
  check('during overlap only the floor holder gets the audio; on handover the other speaker catches up 700 ms',
    JSON.stringify(got) === JSON.stringify(['201:1:l', '201:2:l', '201:9:l', '414:9:b', '414:3:l']), JSON.stringify(got));
}
{
  // A noisy microphone keeps its source active without a break: it stops holding the floor.
  const frames: TeamsCsrcVirtualFrame[] = [];
  const noisy = new TeamsCsrcChannelizer({ lookbackMs: 0, flickerHoldMs: 0, floorHoldMaxMs: 30_000, onFrame: (frame) => frames.push(frame) });
  noisy.recordTransportEvent({ csrc: 840, active: true, tMs: 0 });
  noisy.feedAudio(pcm(1), 0);
  noisy.recordTransportEvent({ csrc: 201, active: true, tMs: 40_000 });
  noisy.feedAudio(pcm(2), 40_000);
  const got = frames.filter((f) => f.pcm[0] === 2).map((f) => f.csrc).sort();
  check('a source active for longer than floorHoldMaxMs does not hold the floor',
    JSON.stringify(got) === JSON.stringify([201, 840]), JSON.stringify(got));
}

// ── the floor with production timing (600 ms lookback, 1500 ms flicker hold, 700 ms catch-up) ──
const run = (events: Array<[number, number, boolean]>, untilMs: number) => {
  const frames: TeamsCsrcVirtualFrame[] = [];
  const ch = new TeamsCsrcChannelizer({ onFrame: (frame) => frames.push(frame) });
  const queue = events.slice().sort((x, y) => x[0] - y[0]);
  for (let t = 0; t <= untilMs; t += 100) {
    while (queue.length && queue[0][0] <= t) {
      const [tMs, csrc, active] = queue.shift()!;
      ch.recordTransportEvent({ csrc, active, tMs });
    }
    ch.feedAudio(pcm(t), t);
  }
  return (csrc: number) => frames.filter((f) => f.csrc === csrc).map((f) => f.tsMs);
};
{
  // A talks from 0, B joins at 2000 (promoted after the hold), A stops at 5000.
  const got = run([[0, 201, true], [2000, 414, true], [5000, 201, false]], 6000);
  check('a joiner held behind the floor gets nothing until the holder stops',
    !got(414).some((t) => t < 4300) && got(201).includes(4900), JSON.stringify(got(414).slice(0, 3)));
  check('then it catches up the last 700 ms and continues live',
    got(414)[0] === 4300 && got(414).includes(5000) && got(414).includes(6000), JSON.stringify(got(414).slice(0, 10)));
}
{
  // B's activation arrives after A's but is stamped earlier: A keeps the floor.
  const frames: TeamsCsrcVirtualFrame[] = [];
  const ch = new TeamsCsrcChannelizer({ flickerHoldMs: 0, onFrame: (frame) => frames.push(frame) });
  ch.recordTransportEvent({ csrc: 201, active: true, tMs: 1000 });
  ch.feedAudio(pcm(1), 1000);
  ch.recordTransportEvent({ csrc: 414, active: true, tMs: 980 });
  ch.feedAudio(pcm(2), 1100);
  ch.feedAudio(pcm(3), 1200);
  const b = frames.filter((f) => f.csrc === 414).length;
  check('a late activation stamped earlier does not take the floor', b === 0
    && frames.filter((f) => f.csrc === 201).length === 3, JSON.stringify(frames.map((f) => `${f.csrc}:${f.pcm[0]}`)));
}
{
  const got = run([[0, 201, true], [500, 414, true], [800, 840, true]], 4000);
  check('with three active sources only the first gets the overlap',
    got(201).includes(4000) && !got(414).includes(4000) && !got(840).includes(4000),
    JSON.stringify([got(414).length, got(840).length]));
}

if (failed > 0) process.exit(1);
console.log('\n✅ Teams CSRC channelizer routes the active set exactly once.');
