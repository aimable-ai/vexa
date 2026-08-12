/**
 * Live STT transports — the wire layer under the Voxtral transcriber.
 *
 * Two protocols behind one interface, selected by URL scheme:
 *   ws(s)://   — OpenAI-realtime-style WebSocket (vLLM /v1/realtime):
 *                input_audio_buffer.append (base64 PCM16) + input_audio_buffer.commit
 *                up; transcription.delta events down. The server only generates on
 *                COMMIT — the transcriber owns the commit cadence.
 *   http(s):// — audio.cpp HTTP-live: one long-lived chunked POST per session, raw
 *                s16le PCM written as captured; deltas read back as SSE `data:` /
 *                `partial_text=` / bare-JSON lines. No commit protocol — the server
 *                decodes continuously, so commit() is bookkeeping only.
 *
 * `transcript.text.done` / `transcription.done` carry the WHOLE utterance again —
 * they are terminal markers, never deltas; treating them as deltas doubles every
 * utterance. Only `delta` / `partial_text` payloads surface as text.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';

export interface LiveTransportEvents {
  /** One incremental transcript delta (model-committed text). */
  onDelta: (text: string) => void;
  /** Transport became writable (session accepted; primer may be sent now). */
  onOpen: () => void;
  /** Transport ended (any reason). The owner reconnects lazily on next audio. */
  onClose: (reason: string) => void;
  log?: (msg: string) => void;
}

export interface LiveTransportConfig {
  url: string;
  /** Bearer token for the upgrade / request. */
  apiToken?: string;
  /** Model name sent in session.update (WS transport only). */
  model?: string;
}

export interface LiveTransport {
  readonly ready: boolean;
  /** Raw s16le PCM. */
  sendAudio(pcm16: Buffer): void;
  /** Ask the server to transcribe everything appended so far (WS only; no-op on HTTP-live). */
  commit(final?: boolean): void;
  close(): void;
}

/** One line of the HTTP-live response → delta text, or null for noise. */
export function parseLiveDelta(line: string): string | null {
  if (!line || line.startsWith(':')) return null;
  let payload = line;
  if (payload.startsWith('data:')) payload = payload.slice(5).trim();
  if (payload.startsWith('partial_text=')) return payload.slice('partial_text='.length);
  if (payload.startsWith('{')) {
    try {
      const obj = JSON.parse(payload) as { delta?: unknown; partial_text?: unknown };
      const t = obj.delta ?? obj.partial_text;
      return typeof t === 'string' && t ? t : null;
    } catch { return null; }
  }
  // Non-JSON `key=value` status noise (audio_input=stdin) is dropped.
  return payload.includes('=') ? null : payload || null;
}

class WsTransport implements LiveTransport {
  ready = false;
  private ws: WebSocket;
  private closed = false;

  constructor(private cfg: LiveTransportConfig, private ev: LiveTransportEvents) {
    this.ws = new WebSocket(cfg.url, cfg.apiToken
      ? { headers: { Authorization: `Bearer ${cfg.apiToken}` } }
      : undefined);
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('close', () => this.end('socket closed'));
    this.ws.on('error', (err) => this.end(`socket error: ${err.message}`));
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { type?: string; delta?: unknown; error?: unknown };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'session.created') {
      try { this.ws.send(JSON.stringify({ type: 'session.update', model: this.cfg.model })); } catch { /* close event follows */ }
      this.ready = true;
      this.ev.onOpen();
    } else if (msg.type === 'transcription.delta' && typeof msg.delta === 'string') {
      this.ev.onDelta(msg.delta);
    } else if (msg.type === 'error') {
      this.ev.log?.(`[voxtral] server error: ${JSON.stringify(msg.error ?? msg)}`);
    }
    // transcription.done: terminal marker per commit — not a boundary, not a delta.
  }

  sendAudio(pcm16: Buffer): void {
    // ~4KB raw audio per append message.
    for (let off = 0; off < pcm16.length; off += 4096) {
      const chunk = pcm16.subarray(off, Math.min(off + 4096, pcm16.length));
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
    }
  }

  commit(final?: boolean): void {
    this.ws.send(JSON.stringify(final
      ? { type: 'input_audio_buffer.commit', final: true }
      : { type: 'input_audio_buffer.commit' }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.commit(true); } catch { /* best-effort final flush */ }
    try { this.ws.close(); } catch { /* already down */ }
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.ev.onClose(reason);
  }
}

/** audio.cpp's live endpoint requires the stream contract in the query string;
 *  fill any missing key so a bare backend URL still speaks it correctly. */
export function withLiveQuery(rawUrl: string, model?: string): string {
  const url = new URL(rawUrl);
  const defaults: Record<string, string> = {
    model: model || 'voxtral-realtime',
    sample_rate: '16000',
    channels: '1',
    sample_format: 's16le',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  return url.toString();
}

class HttpLiveTransport implements LiveTransport {
  ready = false;
  private req: ReturnType<typeof httpRequest>;
  private closed = false;

  constructor(cfg: LiveTransportConfig, private ev: LiveTransportEvents) {
    const url = new URL(withLiveQuery(cfg.url, cfg.model));
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Accept': 'text/event-stream',
        ...(cfg.apiToken ? { Authorization: `Bearer ${cfg.apiToken}` } : {}),
      },
    });
    this.req = req;
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        this.end(res.statusCode === 503
          ? 'HTTP 503 — server busy (model lock held by another stream)'
          : `HTTP ${res.statusCode}`);
        req.destroy();
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const delta = parseLiveDelta(buf.slice(0, nl).trim());
          buf = buf.slice(nl + 1);
          if (delta) this.ev.onDelta(delta);
        }
      });
      res.on('end', () => this.end('response ended'));
      res.on('error', (err) => this.end(err.message));
    });
    req.on('error', (err) => this.end(err.message));
    // The request body is writable immediately.
    this.ready = true;
    queueMicrotask(() => this.ev.onOpen());
  }

  sendAudio(pcm16: Buffer): void { this.req.write(pcm16); }
  commit(): void { /* audio.cpp decodes continuously — no commit protocol */ }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.req.end(); } catch { /* already down */ }
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.ev.onClose(reason);
  }
}

export type TransportFactory = (cfg: LiveTransportConfig, ev: LiveTransportEvents) => LiveTransport;

export const openLiveTransport: TransportFactory = (cfg, ev) =>
  /^https?:\/\//i.test(cfg.url) ? new HttpLiveTransport(cfg, ev) : new WsTransport(cfg, ev);
