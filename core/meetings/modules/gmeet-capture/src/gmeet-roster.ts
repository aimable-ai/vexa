/**
 * Google Meet roster from Meet's own protocol — who is in the meeting (device id + name) and which
 * RTP contributing source (CSRC) each participant's audio rides on.
 *
 * Two protobuf sources, both Meet-internal and undocumented:
 *  - the SyncMeetingSpaceCollections RPC response (base64 text): the full participant list,
 *    re-synced by Meet periodically (most responses are empty: nothing changed) — a non-empty one
 *    is also how leaves show up;
 *  - the `collections` data channel (deflate-compressed): joins and each device's outputs.
 * Only the fields below are read; everything else is skipped. A layout change therefore yields an
 * empty roster (never a wrong one) and the capture falls back to the DOM tiles.
 *
 * Pure browser code. Installed at document start: the data channel opens during the join.
 */

// Participant: 1 device id · 2 full name · 4 status (1 = in the meeting) · 21 parent device id
// (a screen-share pseudo-device) · 29 display name. The bot itself may appear in the roster; it
// never receives its own audio, so it never matches a CSRC or a segment speaker.
// Device output: 2 kind (1 = audio) · 4 stream id (= the RTP CSRC) · 6 device id.
const SYNC_RPC = 'MeetingSpaceService/SyncMeetingSpaceCollections';
const IN_MEETING = 1;
const AUDIO = 1;

export interface MeetParticipant { id: string; name: string; inMeeting: boolean; screenShare: boolean }
export interface MeetAudioOutput { csrc: string; deviceId: string }
export interface RosterParticipant { id: string; name: string }

type Fields = Map<number, (number | Uint8Array)[]>;

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  for (let shift = 1; pos < buf.length; shift *= 128) {
    const b = buf[pos++];
    value += (b & 0x7f) * shift;
    if (b < 0x80) return [value, pos];
  }
  throw new Error('truncated varint');
}

export function parseFields(buf: Uint8Array): Fields {
  const out: Fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const [tag, next] = readVarint(buf, pos);
    pos = next;
    const field = Math.floor(tag / 8);
    let value: number | Uint8Array;
    switch (tag % 8) {
      case 0: [value, pos] = readVarint(buf, pos); break;
      case 2: {
        const [len, start] = readVarint(buf, pos);
        if (start + len > buf.length) throw new Error('truncated field');
        value = buf.subarray(start, start + len);
        pos = start + len;
        break;
      }
      case 1: pos += 8; continue;
      case 5: pos += 4; continue;
      default: throw new Error(`unsupported wire type ${tag % 8}`);
    }
    if (!out.has(field)) out.set(field, []);
    out.get(field)!.push(value);
  }
  return out;
}

const bytesAt = (f: Fields, n: number) => (f.get(n) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
const numAt = (f: Fields, n: number) => (f.get(n) ?? []).find((v): v is number => typeof v === 'number');
const strAt = (f: Fields, n: number) => { const b = bytesAt(f, n)[0]; return b ? new TextDecoder().decode(b) : ''; };

/** Descend through first-occurrence sub-messages, then return every occurrence of the last field. */
function repeatedAt(buf: Uint8Array, path: number[]): Fields[] {
  let f = parseFields(buf);
  for (const n of path.slice(0, -1)) {
    const sub = bytesAt(f, n)[0];
    if (!sub) return [];
    f = parseFields(sub);
  }
  return bytesAt(f, path[path.length - 1]).map(parseFields);
}

function toParticipant(f: Fields): MeetParticipant {
  return {
    id: strAt(f, 1),
    name: strAt(f, 2) || strAt(f, 29),
    inMeeting: numAt(f, 4) === IN_MEETING,
    screenShare: f.has(21),
  };
}

/** The full participant list in a SyncMeetingSpaceCollections response (already base64-decoded). */
export function decodeSyncResponse(buf: Uint8Array): MeetParticipant[] {
  return repeatedAt(buf, [2, 2, 2]).map(toParticipant).filter(p => p.id);
}

/** Participants and audio outputs carried by one (inflated) `collections` data-channel message. */
export function decodeCollectionsMessage(buf: Uint8Array): { participants: MeetParticipant[]; audio: MeetAudioOutput[] } {
  const participants = repeatedAt(buf, [1, 2, 13, 1, 2]).map(toParticipant).filter(p => p.id);
  const audio = repeatedAt(buf, [1, 2, 3, 2])
    .filter(o => numAt(o, 2) === AUDIO)
    .map(o => ({ csrc: strAt(o, 4), deviceId: strAt(o, 6) }))
    .filter(o => o.csrc && o.deviceId);
  return { participants, audio };
}

/** Roster state, fed by the decoders; separate from the page hooks so it is testable offline. */
export function createRosterState() {
  let devices = new Map<string, MeetParticipant>();
  const deviceByCsrc = new Map<string, string>();
  const listeners: ((p: RosterParticipant[]) => void)[] = [];
  let lastKey = '';
  let syncs = 0;
  let updates = 0;

  const participants = (): RosterParticipant[] =>
    [...devices.values()]
      .filter(p => p.inMeeting && !p.screenShare && p.name)
      .map(p => ({ id: p.id, name: p.name }));

  const changed = () => {
    const now = participants();
    const key = JSON.stringify(now);
    if (key === lastKey) return;
    lastKey = key;
    for (const l of listeners) { try { l(now); } catch { /* listener error */ } }
  };

  return {
    participants,
    /** The in-meeting participant whose audio currently rides `csrc`, if known. */
    participantForCsrc(csrc: number): RosterParticipant | undefined {
      const p = devices.get(deviceByCsrc.get(String(csrc)) ?? '');
      return p && p.inMeeting && !p.screenShare && p.name ? { id: p.id, name: p.name } : undefined;
    },
    /** A non-empty sync is the full list; an empty one means nothing changed. */
    applySync(list: MeetParticipant[]) {
      syncs++;
      if (!list.length) return;
      devices = new Map(list.map(p => [p.id, p]));
      changed();
    },
    applyCollections({ participants: list, audio }: ReturnType<typeof decodeCollectionsMessage>) {
      updates++;
      for (const p of list) devices.set(p.id, p);
      for (const o of audio) deviceByCsrc.set(o.csrc, o.deviceId);
      changed();
    },
    /** Diagnostics for the capture's periodic log line. */
    stats() {
      return { participants: participants().length, csrcs: deviceByCsrc.size, syncs, updates };
    },
    /** Called now with the current roster (if any) and again on every change. */
    subscribe(listener: (p: RosterParticipant[]) => void) {
      listeners.push(listener);
      if (lastKey) listener(participants());
    },
  };
}

const decompress = async (bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer());

/** A `collections` message: gzip and zlib announce themselves by header; anything else is tried as
 *  raw deflate, then taken as plain protobuf. */
export async function unpackCollections(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return decompress(bytes, 'gzip');
  if ((bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) return decompress(bytes, 'deflate');
  try { return await decompress(bytes, 'deflate-raw'); } catch { return bytes; }
}

export const isSyncRpc = (url: string) => url.includes(SYNC_RPC);

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

/** A sync response body: base64 text of the protobuf, or the protobuf itself. */
export function syncBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  return BASE64.test(text) ? Uint8Array.from(atob(text.trim()), c => c.charCodeAt(0)) : bytes;
}

export type GmeetRoster = ReturnType<typeof createGmeetRoster>;

/** Install the fetch/XHR hooks now; the host passes each new RTCPeerConnection to `watchPeerConnection`. */
export function createGmeetRoster(opts: { log?: (m: string) => void } = {}) {
  const log = (m: string) => { try { opts.log?.('[GmeetRoster] ' + m); } catch { /* ignore */ } };
  const state = createRosterState();
  const failed = new Set<string>();
  const fail = (source: string) => (e: unknown) => {
    if (failed.has(source)) return;
    failed.add(source);
    log(`${source} decode failed, DOM fallback stays in charge: ${(e as Error)?.message || e}`);
  };

  const seenRpc = new Set<string>();
  const onResponse = (url: string, body: () => Promise<Uint8Array>) => {
    const rpc = url.match(/\$rpc\/([^?]+)/)?.[1];
    if (rpc && !seenRpc.has(rpc) && seenRpc.size < 20) { seenRpc.add(rpc); log(`rpc seen: ${rpc}`); }
    if (!isSyncRpc(url)) return;
    body().then((bytes) => {
      const list = decodeSyncResponse(syncBytes(bytes));
      state.applySync(list);
      if (list.length) log(`sync: ${state.participants().length} remote participant(s)`);
    }).catch(fail('sync'));
  };

  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await originalFetch.apply(this, args);
    try { onResponse(res.url, async () => new Uint8Array(await res.clone().arrayBuffer())); } catch (e) { fail('sync')(e); }
    return res;
  } as typeof fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    this.addEventListener('load', () => {
      try {
        onResponse(this.responseURL || String(args[1]), async () =>
          typeof this.response === 'string' ? new TextEncoder().encode(this.response) : new Uint8Array(this.response));
      } catch (e) { fail('sync')(e); }
    });
    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  const onCollections = async (data: ArrayBuffer | Blob) => {
    const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
    try {
      state.applyCollections(decodeCollectionsMessage(await unpackCollections(bytes)));
    } catch (e) {
      const head = [...bytes.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ');
      fail('collections')(`${(e as Error)?.message || e} (${bytes.length} bytes, head ${head})`);
    }
  };

  return {
    ...state,
    watchPeerConnection(pc: RTCPeerConnection) {
      pc.addEventListener('datachannel', (ev: RTCDataChannelEvent) => {
        if (ev.channel.label !== 'collections') return;
        ev.channel.addEventListener('message', (m: MessageEvent) => {
          void onCollections(m.data);
        });
      });
    },
  };
}
