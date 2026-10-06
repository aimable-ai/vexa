/**
 * L3 — meeting chat core (AIM-2283). OFFLINE: fake page ops + fake redis.
 *   • chat_send collapses newlines, serializes sends, is ignored before the bot is in the meeting;
 *   • Meet text over 500 chars goes out in parts;
 *   • the watcher seeds on start (no replay), retries a panel that did not open every 10 s,
 *     publishes each NEW message once with the exact wire shape, RPUSHes the payload capped + TTL'd, and flags the bot's own messages.
 * Run: npx tsx src/meeting-chat.test.ts
 */
import {
  createMeetingChat, chatChannel, chatListKey, CHAT_LIST_MAX, CHAT_LIST_TTL_S,
  type ChatPageOps, type ChatRedis, type ScrapedMessage,
} from './meeting-chat.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

function fakes() {
  const panel: ScrapedMessage[] = [];
  const typed: string[] = [];
  const published: Array<[string, string]> = [];
  const pushed: Array<[string, string, number, number]> = [];
  let typing = 0, overlap = false;
  const ops: ChatPageOps = {
    async open() { return true; },
    async scrape() { return [...panel]; },
    async type(text) {
      if (typing) overlap = true;
      typing++;
      await new Promise((r) => setTimeout(r, 5));
      typed.push(text);
      typing--;
      return true;
    },
  };
  const redis: ChatRedis = {
    async publish(ch, msg) { published.push([ch, msg]); },
    async appendCapped(key, value, max, ttl) { pushed.push([key, value, max, ttl]); },
  };
  return { panel, typed, published, pushed, ops, redis, get overlap() { return overlap; } };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

async function main(): Promise<void> {
  // ── send: ignored before start; newlines collapsed; serialized ──
  {
    const f = fakes();
    const chat = createMeetingChat({ platform: 'teams', botName: 'Aimable', meetingId: 42, redis: f.redis, ops: f.ops, pollMs: 10, log: () => {} });
    await chat.send('too early');
    check('send before start is ignored', f.typed.length === 0, JSON.stringify(f.typed));
    await chat.start();
    await Promise.all([chat.send('line one\nline two\r\n  three'), chat.send('second')]);
    check('newlines collapsed to spaces', f.typed[0] === 'line one line two three', f.typed[0]);
    check('sends are serialized in order', f.typed[1] === 'second' && !f.overlap, JSON.stringify(f.typed));
    await chat.send('  \n ');
    check('blank text is not typed', f.typed.length === 2, JSON.stringify(f.typed));
    chat.stop();
  }

  // ── Meet: long text split into ≤500-char parts ──
  {
    const f = fakes();
    const chat = createMeetingChat({ platform: 'google_meet', botName: 'Aimable', meetingId: 1, redis: f.redis, ops: f.ops, pollMs: 10, log: () => {} });
    await chat.start();
    await chat.send(Array.from({ length: 120 }, (_, i) => `word${i}`).join(' '));
    check('meet: long text split into parts', f.typed.length > 1 && f.typed.every((p) => p.length <= 500), String(f.typed.map((p) => p.length)));
    chat.stop();
  }

  // ── unsupported platform: no-op ──
  {
    const f = fakes();
    const chat = createMeetingChat({ platform: 'zoom', botName: 'Aimable', meetingId: 1, redis: f.redis, ops: f.ops, pollMs: 10, log: () => {} });
    await chat.start();
    await chat.send('hi');
    check('zoom: chat_send ignored', f.typed.length === 0);
  }

  // ── watcher: seed, publish new once, wire shape, own-message detection ──
  {
    const f = fakes();
    let t = 1_000_000;
    f.panel.push({ key: 'old', sender: 'Alice', text: 'before the bot joined' });
    const chat = createMeetingChat({ platform: 'google_meet', botName: 'Aimable', meetingId: 42, redis: f.redis, ops: f.ops, pollMs: 10, now: () => t, log: () => {} });
    await chat.start();
    f.panel.push({ key: 'm1', sender: 'Bob', text: '@Aimable what is the budget?' });
    await tick();
    check('seeded message is not published', !f.published.some(([, m]) => m.includes('before the bot joined')));
    check('new message published exactly once', f.published.length === 1, String(f.published.length));
    const [ch, raw] = f.published[0] ?? ['', '{}'];
    check('channel = va:meeting:42:chat', ch === chatChannel(42) && ch === 'va:meeting:42:chat', ch);
    const ev = JSON.parse(raw);
    check('event shape', JSON.stringify(ev) === JSON.stringify({
      type: 'chat.new_message', meeting: { id: 42 },
      payload: { sender: 'Bob', text: '@Aimable what is the budget?', timestamp: t, is_from_bot: false },
    }), raw);
    const [key, value, max, ttl] = f.pushed[0] ?? ['', '', 0, 0];
    check('list push: key, payload, cap, ttl', key === chatListKey(42) && key === 'meeting:42:chat_messages'
      && value === JSON.stringify(ev.payload) && max === CHAT_LIST_MAX && ttl === CHAT_LIST_TTL_S, `${key} ${value} ${max} ${ttl}`);

    // own message: shown as "You" on the bot's side → matched by recent text
    await chat.send('The budget is 40k.\nSee the doc.');
    f.panel.push({ key: 'm2', sender: 'You', text: 'The budget is 40k. See the doc.' });
    f.panel.push({ key: 'm3', sender: 'Aimable', text: 'older bot line' });
    await tick();
    const evs = f.published.map(([, m]) => JSON.parse(m).payload);
    const own = evs.find((p) => p.text.startsWith('The budget'));
    check('own message by recent text → is_from_bot, sender = bot name', own?.is_from_bot === true && own?.sender === 'Aimable', JSON.stringify(own));
    check('sender = bot name → is_from_bot', evs.find((p) => p.text === 'older bot line')?.is_from_bot === true);

    // after 60 s the same text from a human is not the bot's
    t += 61_000;
    f.panel.push({ key: 'm4', sender: 'Carol', text: 'The budget is 40k. See the doc.' });
    await tick();
    const last = JSON.parse(f.published[f.published.length - 1][1]).payload;
    check('text match expires after 60 s', last.sender === 'Carol' && last.is_from_bot === false, JSON.stringify(last));
    check('no duplicates', f.published.length === 4, String(f.published.length));
    chat.stop();
  }

  // ── panel blocked at start (popup over the button): retried every 10 s, then publishes ──
  {
    const f = fakes();
    let t = 1_000_000;
    let opens = 0, canOpen = false;
    f.ops.open = async () => { opens++; if (!canOpen) throw new Error('click intercepted'); return true; };
    const chat = createMeetingChat({ platform: 'google_meet', botName: 'Aimable', meetingId: 9, redis: f.redis, ops: f.ops, pollMs: 10, now: () => t, log: () => {} });
    await chat.start();
    f.panel.push({ key: 'q1', sender: 'Ludger', text: '@aimable wie is Google?' });
    await tick();
    check('blocked panel: not retried within 10 s', opens === 1, String(opens));
    check('blocked panel: nothing published', f.published.length === 0, String(f.published.length));
    canOpen = true;
    t += 10_000;
    await tick();
    check('blocked panel: retried after 10 s', opens === 2, String(opens));
    check('message sent while blocked is published once', f.published.length === 1
      && JSON.parse(f.published[0][1]).payload.text === '@aimable wie is Google?', String(f.published.length));
    chat.stop();
  }

  // ── a failing scrape never throws out of the watcher ──
  {
    const f = fakes();
    let calls = 0;
    f.ops.scrape = async () => { if (calls++ > 0) throw new Error('page gone'); return []; };
    const chat = createMeetingChat({ platform: 'teams', botName: 'Aimable', meetingId: 7, redis: f.redis, ops: f.ops, pollMs: 10, log: () => {} });
    await chat.start();
    await tick();
    check('scrape failure is contained', calls > 1);
    chat.stop();
  }

  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ meeting-chat: all checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
