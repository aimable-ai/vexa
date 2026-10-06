/**
 * In-meeting chat for Google Meet + Teams (AIM-2283): SEND (acts.v1 `chat_send`) and WATCH.
 *
 * Ported from the 0.10 MeetingChatService (services/vexa-bot/core/src/services/chat.ts). The core
 * (send queue, seen-set, own-message detection, redis publish) is offline-testable via injected
 * page ops + redis; `pageChatOps` holds the browser legs (L4, selectors tuned against live DOM).
 *
 * Wire (unchanged from 0.10):
 *   PUBLISH va:meeting:{id}:chat  {type:'chat.new_message', meeting:{id}, payload:{sender,text,timestamp,is_from_bot}}
 *   RPUSH   meeting:{id}:chat_messages  <payload>   (capped + TTL; read by GET /bots/{p}/{n}/chat)
 */
import type { Page } from '@vexa/remote-browser';

export interface ChatPayload { sender: string; text: string; timestamp: number; is_from_bot: boolean }
/** One message as scraped from the panel. `key` is stable per message (dedupe). */
export interface ScrapedMessage { key: string; sender: string; text: string }

/** Browser legs. `scrape` returns every message currently rendered in the chat panel. */
export interface ChatPageOps {
  open(): Promise<boolean>;
  scrape(): Promise<ScrapedMessage[]>;
  type(text: string): Promise<boolean>;
}

/** The redis surface the chat needs (the bot's writer client satisfies it). */
export interface ChatRedis {
  publish(channel: string, message: string): Promise<unknown>;
  appendCapped(key: string, value: string, max: number, ttlSeconds: number): Promise<unknown>;
}

export const chatChannel = (meetingId: string | number): string => `va:meeting:${meetingId}:chat`;
export const chatListKey = (meetingId: string | number): string => `meeting:${meetingId}:chat_messages`;
export const CHAT_LIST_MAX = 500;
export const CHAT_LIST_TTL_S = 24 * 60 * 60;
const OWN_TEXT_WINDOW_MS = 60_000;
/** Google Meet rejects chat messages over 500 chars, so longer text goes out in parts. */
const MEET_MAX_CHARS = 500;

export const chatSupported = (platform: string): boolean => platform === 'google_meet' || platform === 'teams';

/** Newlines → spaces (Enter sends early on Teams); runs of whitespace collapse. */
export const collapseChatText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Split at word boundaries into parts of at most `max` chars. */
export function splitChatText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export interface MeetingChat {
  /** Queue `text` for the meeting chat. Never rejects. */
  send(text: string): Promise<void>;
  /** Start watching (call once the bot is in the meeting). Messages already shown are skipped. */
  start(): Promise<void>;
  stop(): void;
}

export interface MeetingChatOptions {
  platform: string;
  botName: string;
  meetingId: string | number;
  redis: ChatRedis;
  ops: ChatPageOps;
  pollMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export function createMeetingChat(opts: MeetingChatOptions): MeetingChat {
  const { platform, botName, meetingId, redis, ops } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(`[bot] chat: ${m}`));
  const seen = new Set<string>();
  const sent: Array<{ text: string; at: number }> = [];
  let queue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let stopped = false;
  let polling = false;
  let seeded = false;

  const sentRecently = (text: string): boolean => {
    const cutoff = now() - OWN_TEXT_WINDOW_MS;
    while (sent.length && sent[0].at < cutoff) sent.shift();
    const t = collapseChatText(text);
    return sent.some((s) => s.text === t);
  };

  const publish = async (m: ScrapedMessage): Promise<void> => {
    const fromBot = m.sender === botName || sentRecently(m.text);
    const payload: ChatPayload = {
      sender: fromBot ? botName : m.sender,
      text: m.text,
      timestamp: now(),
      is_from_bot: fromBot,
    };
    log(`${fromBot ? '→' : '←'} ${payload.sender}: ${payload.text.slice(0, 80)}`);
    try {
      await redis.appendCapped(chatListKey(meetingId), JSON.stringify(payload), CHAT_LIST_MAX, CHAT_LIST_TTL_S);
      await redis.publish(chatChannel(meetingId), JSON.stringify({ type: 'chat.new_message', meeting: { id: meetingId }, payload }));
    } catch (e) {
      log(`publish failed: ${String(e)}`);
    }
  };

  const poll = async (): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      // The panel only renders messages while open; a failed open is retried on the next poll.
      if (!(await ops.open())) return;
      const messages = await ops.scrape();
      // Seed on the first open: only messages that appear after it are published (no history replay).
      if (!seeded) { for (const m of messages) seen.add(m.key); seeded = true; return; }
      for (const m of messages) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        await publish(m);
      }
    } catch (e) {
      log(`scrape failed: ${String(e)}`);
    } finally {
      polling = false;
    }
  };

  const deliver = async (text: string): Promise<void> => {
    const t = collapseChatText(text);
    if (!t) return;
    const parts = platform === 'google_meet' ? splitChatText(t, MEET_MAX_CHARS) : [t];
    for (const part of parts) {
      sent.push({ text: part, at: now() });
      if (!(await ops.type(part))) { log(`send failed: ${part.slice(0, 60)}`); return; }
      log(`sent: ${part.slice(0, 60)}`);
    }
  };

  return {
    send(text: string): Promise<void> {
      if (!chatSupported(platform)) { log(`chat_send ignored: unsupported on ${platform}`); return Promise.resolve(); }
      if (!started || stopped) { log('chat_send ignored: not in the meeting'); return Promise.resolve(); }
      // Serialized: two sends never interleave their typing.
      queue = queue.then(() => deliver(text)).catch((e) => log(`send failed: ${String(e)}`));
      return queue;
    },
    async start(): Promise<void> {
      if (started || !chatSupported(platform)) return;
      started = true;
      await poll();
      if (stopped) return;
      timer = setInterval(() => { void poll(); }, opts.pollMs ?? 2000);
      timer.unref?.();
      log(`watching ${platform} chat`);
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// ── browser legs (L4) ─────────────────────────────────────────────────────────────────────────────
// Bodies passed to page.evaluate run IN THE BROWSER; reach the DOM via globalThis (Node-typed file).

const SELECTORS = {
  google_meet: {
    button: ['button[aria-label*="Chat with everyone"]', 'button[aria-label*="chat" i]', 'button[data-tooltip*="Chat"]'],
    input: ['textarea[aria-label*="Send a message"]', 'textarea[aria-label*="message" i]', 'textarea[aria-label*="chat" i]', '[contenteditable="true"][aria-label*="message" i]'],
  },
  teams: {
    button: ['#chat-button', 'button[data-tid*="chat-button"]', 'button[aria-label*="Chat"]:not([disabled])'],
    input: ['[data-tid="ckeditor"][contenteditable="true"]', '[contenteditable="true"][aria-label*="message" i]', '[contenteditable="true"][data-tid*="message"]', 'div[role="textbox"][contenteditable="true"]'],
  },
} as const;

/** Info popups that cover the meeting after the join (Meet: "Others may see your video differently"). */
const POPUP_DISMISS = '[role="dialog"] button:has-text("Got it"), [role="dialog"] button:has-text("Dismiss"), [role="dialog"] button:has-text("Close")';

/** Google Meet: messages carry data-message-id; sender sits in a sibling header (.poVWob). */
function scrapeMeet(): ScrapedMessage[] {
  const doc = (globalThis as any).document;
  const out: ScrapedMessage[] = [];
  doc.querySelectorAll('[data-message-id]').forEach((el: any) => {
    const key = el.getAttribute('data-message-id') || '';
    // Pin buttons also carry data-message-id.
    if (!key || el.classList.contains('VYBDae-Bz112c-LgbsSe') || el.closest('.Sd72u')) return;
    const textEl = el.querySelector('.jO4O1') || el.querySelector('.oIy2qc') || el.querySelector('[data-message-text]');
    if (!textEl) return;
    const clone = textEl.cloneNode(true);
    clone.querySelectorAll('.Sd72u, .VYBDae-Bz112c-LgbsSe, .ne2Ple-oshW8e-V67aGc, .UaaITe').forEach((n: any) => n.remove());
    const text = (clone.textContent || '').trim();
    if (!text) return;
    let sender = '';
    let cur: any = el;
    for (let depth = 0; depth < 6 && !sender && cur?.parentElement; depth++) {
      for (const sib of Array.from(cur.parentElement.children) as any[]) {
        if (sib === cur) continue;
        const s = sib.querySelector('.poVWob, [data-sender-name]');
        if (s) { sender = s.getAttribute('data-sender-name') || (s.textContent || '').trim(); break; }
      }
      cur = cur.parentElement;
    }
    out.push({ key, sender: sender || 'Unknown', text });
  });
  return out;
}

/** Teams: candidate selectors mirror @vexa/teams-capture teams-chat.ts. Key = Teams message id
 *  (data-mid / content-<id>) when present, else sender+text+occurrence. */
function scrapeTeams(): ScrapedMessage[] {
  const doc = (globalThis as any).document;
  const MESSAGE = ['[data-tid="chat-pane-message"]', 'div[data-tid^="chat-pane-message"]', 'div[data-mid]', '[data-tid="message"]'];
  const SENDER = ['[data-tid="message-author-name"]', '[data-tid*="author"]', '[class*="author-name"]', '[class*="authorName"]'];
  const TEXT = ['[data-tid="messageBodyContent"]', '[id^="content-"]', '[class*="messageBody"]', '[class*="message-body"]'];
  const first = (root: any, sels: string[]): string => {
    for (const s of sels) { const t = (root.querySelector(s)?.textContent || '').trim(); if (t) return t; }
    return '';
  };
  let nodes: any[] = [];
  for (const sel of MESSAGE) { nodes = Array.from(doc.querySelectorAll(sel)); if (nodes.length) break; }
  const counts: Record<string, number> = {};
  const out: ScrapedMessage[] = [];
  for (const node of nodes) {
    const text = first(node, TEXT);
    if (!text) continue;
    let sender = first(node, SENDER);
    // Teams shows one header per run of messages: try the row's aria-label ("Name, 10:42 AM, …"),
    // then the nearest PRECEDING author header.
    for (let i = 0, cur = node; i < 4 && cur && !sender; i++, cur = cur.parentElement) {
      const m = (cur.getAttribute?.('aria-label') || '').match(/^(.+?)\s*,\s*\d{1,2}:\d{2}/);
      if (m) sender = m[1].trim();
    }
    for (let i = 0, cur = node; i < 4 && cur && !sender; i++, cur = cur.parentElement) {
      for (let sib = cur.previousElementSibling; sib && !sender; sib = sib.previousElementSibling) {
        const hits = sib.querySelectorAll(SENDER.join(', '));
        sender = (hits.length ? hits[hits.length - 1].textContent || '' : '').trim();
      }
    }
    sender = sender.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, '').trim() || 'Unknown';
    const mid = node.getAttribute('data-mid') || node.closest('[data-mid]')?.getAttribute('data-mid')
      || (node.querySelector('[id^="content-"]')?.id || '');
    let key = mid;
    if (!key) {
      const base = `${sender}\u0000${text}`;
      counts[base] = (counts[base] || 0) + 1;
      key = `${base}#${counts[base]}`;
    }
    out.push({ key, sender, text });
  }
  return out;
}

export function pageChatOps(page: Page, platform: string): ChatPageOps {
  const sel = platform === 'teams' ? SELECTORS.teams : SELECTORS.google_meet;
  const input = () => page.locator(sel.input.join(', ')).first();
  const inputVisible = () => input().isVisible().catch(() => false);

  const chatButton = async () => {
    for (const s of sel.button) {
      const btn = page.locator(s).first();
      if (await btn.isVisible().catch(() => false)) return btn;
    }
    return null;
  };

  const dismissPopup = async (): Promise<void> => {
    const btn = page.locator(POPUP_DISMISS).first();
    if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
  };

  const openPanel = async (): Promise<boolean> => {
    if (page.isClosed()) return false;
    // The chat button toggles: only click when the input is not already showing.
    if (await inputVisible()) return true;
    const btn = await chatButton();
    if (!btn) return false;
    if (!(await btn.click({ timeout: 3000 }).then(() => true, () => false))) {
      // Something covers the button (a popup after the join): close it, click again.
      await dismissPopup();
      await btn.click({ timeout: 3000 }).catch(() => {});
    }
    return input().waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  };

  // The watcher and a send can open at the same time; a second click would close the panel again.
  let opening: Promise<boolean> | null = null;
  const open = (): Promise<boolean> => (opening ??= openPanel().finally(() => { opening = null; }));

  return {
    open,
    async scrape() {
      if (page.isClosed()) return [];
      return page.evaluate(platform === 'teams' ? scrapeTeams : scrapeMeet);
    },
    async type(text: string) {
      if (!(await open())) return false;
      const box = input();
      await box.click({ timeout: 3000 });
      if (platform === 'teams') {
        // Real key events so Teams' editor registers the text (proven in 0.10).
        await page.keyboard.type(text, { delay: 10 });
      } else {
        await box.fill(text);
      }
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      return true;
    },
  };
}
