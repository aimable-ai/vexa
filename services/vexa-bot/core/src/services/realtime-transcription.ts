import { log } from '../utils';
import { isHallucination } from './hallucination-filter';
import { PRIMER_PCM16_NL_BASE64, PRIMER_PCM16_EN_BASE64 } from './primer-audio';

/** Spoken language primers, played as the first audio of every WS session so
 * the model locks onto the meeting language (it has no language parameter —
 * it locks on whatever it hears first). Keyed by 2-letter language code. */
const PRIMERS: Record<string, Buffer> = {
  nl: Buffer.from(PRIMER_PCM16_NL_BASE64, 'base64'),
  en: Buffer.from(PRIMER_PCM16_EN_BASE64, 'base64'),
};
/** What the model is expected to transcribe for each primer — the discard
 * runs until a sentence end AND ~this much text has been seen, so a period
 * emitted early (e.g. "…an English." + " meeting.") can't end it prematurely. */
const PRIMER_TEXTS: Record<string, string> = {
  nl: 'Dit is een Nederlandse vergadering.',
  en: 'This is an English meeting.',
};
/** Give up discarding primer transcript this long after sending it. */
const PRIMER_TIMEOUT_MS = 6000;

function normalizeForPrimerMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/** 800ms of 16 kHz pcm16 zeros — pushed once when a speaker goes quiet so the
 * delay-conditioned model emits its withheld final words (tail flush). */
// Sized for the 960ms delay conditioning (12 delay tokens): the model releases
// an utterance's final words only after ~delay worth of subsequent audio.
const TAIL_SILENCE = Buffer.alloc(Math.floor(1.2 * 16000) * 2);

/**
 * Realtime per-speaker transcription via a vLLM /v1/realtime WebSocket
 * (Voxtral Mini 4B Realtime). Replaces the Whisper HTTP + LocalAgreement
 * loop: the model streams committed transcript deltas itself, so there is
 * no submit/confirm cycle — deltas accumulate into a segment that is
 * finalized on a sentence boundary, a silence gap, or a size cap.
 *
 * Exposes the same speaker-facing surface as SpeakerStreamManager
 * (addSpeaker / feedAudio / updateSpeakerName / removeAll / ...) so the
 * bot pipeline can hold either implementation.
 */

export interface RealtimeTranscriptionConfig {
  /** ws:// or wss:// URL of the vLLM realtime endpoint, e.g. ws://host:8085/v1/realtime */
  realtimeUrl: string;
  /** Model name sent in session.update. */
  model?: string;
  /** Sample rate of input audio. Default 16000. */
  sampleRate?: number;
  /** Finalize the open segment after this many ms without new deltas. Default 800. */
  segmentGapMs?: number;
  /** Force-finalize a segment at this many characters. Default 600. */
  maxSegmentChars?: number;
  /** Close an idle speaker session after this many seconds without audio. Default 20. */
  idleTimeoutSec?: number;
  /** Recycle a session once it has heard this much audio (seconds). The server
   * never guards its own context (~8k tokens ≈ 11 min of audio); a session that
   * never idles overflows it and generation degenerates permanently. Default 240. */
  sessionMaxAudioSec?: number;
  /** Meeting language (2-letter code). Selects the spoken primer that locks the
   * model's language on every session open; no primer when unset/unknown. */
  language?: string;
}

interface SpeakerSession {
  speakerId: string;
  speakerName: string;
  ws: any | null;
  wsReady: boolean;
  /** Audio queued while the socket is connecting. */
  pendingAudio: Buffer[];
  /** Text of the segment currently being built from deltas. */
  segmentText: string;
  /** Wall-clock ms when the current segment started (first audio after last finalize). */
  segmentStartMs: number;
  lastDeltaMs: number;
  lastAudioMs: number;
  sequenceNumber: number;
  generation: number;
  closed: boolean;
  /** Primer transcript not yet fully received/discarded on this connection. */
  primerPending: boolean;
  primerText: string;
  primerSentMs: number;
  /** Audio appended since the last input_audio_buffer.commit. */
  audioSinceCommit: boolean;
  /** Synthetic-silence tail flush already sent for the current pause. */
  tailFlushed: boolean;
  lastCommitMs: number;
  /** Audio fed to the current WS session (seconds), for the context guard. */
  sessionAudioSec: number;
}

/** Past sessionMaxAudioSec, wait for a pause to recycle; force it after this
 * much extra audio — a mid-speech recycle costs a word or two once, context
 * overflow costs everything until the next idle. */
const SESSION_FORCE_EXTRA_SEC = 160;

const SENTENCE_END = /[.!?…]["')\]]?\s*$/;

export class RealtimeSpeakerStreamManager {
  private sessions: Map<string, SpeakerSession> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private cfg: Required<Omit<RealtimeTranscriptionConfig, 'model'>> & { model: string };

  /** Confirmed segment — same signature as SpeakerStreamManager.onSegmentConfirmed. */
  onSegmentConfirmed:
    | ((speakerId: string, speakerName: string, transcript: string, bufferStartMs: number, bufferEndMs: number, segmentId: string) => void)
    | null = null;

  /** Draft (still-growing) segment text, for pending publication. */
  onPending: ((speakerId: string, speakerName: string, text: string, segmentStartMs: number) => void) | null = null;

  private primer: Buffer | null;
  private primerMinChars = 0;
  /** Normalized primer sentence — segments matching a suffix of it are primer
   * residue (delay conditioning can release the primer's withheld tail after
   * the discard window closed) and must never reach the transcript. */
  private primerNorm = '';
  /** http(s):// realtimeUrl selects the audio.cpp HTTP-live transport (chunked
   * raw-PCM request body up, SSE/line deltas down) instead of the OpenAI-style
   * realtime WebSocket. Everything above the transport is shared. */
  private httpLive: boolean;

  constructor(config: RealtimeTranscriptionConfig) {
    this.cfg = {
      realtimeUrl: config.realtimeUrl.replace(/\/+$/, ''),
      model: config.model || 'mistralai/Voxtral-Mini-4B-Realtime-2602',
      sampleRate: config.sampleRate ?? 16000,
      segmentGapMs: config.segmentGapMs ?? 800,
      maxSegmentChars: config.maxSegmentChars ?? 600,
      idleTimeoutSec: config.idleTimeoutSec ?? 20,
      sessionMaxAudioSec: config.sessionMaxAudioSec ?? 240,
      language: config.language ?? '',
    };
    this.httpLive = /^https?:\/\//i.test(this.cfg.realtimeUrl);
    const langKey = this.cfg.language.toLowerCase().slice(0, 2);
    this.primer = PRIMERS[langKey] ?? null;
    this.primerMinChars = Math.floor((PRIMER_TEXTS[langKey]?.length ?? 0) * 0.85);
    this.primerNorm = normalizeForPrimerMatch(PRIMER_TEXTS[langKey] ?? '');
    if (this.cfg.language && !this.primer) {
      log(`[Realtime] No language primer for "${this.cfg.language}" — sessions rely on auto-detection`);
    }
    this.sweepTimer = setInterval(() => this.sweep(), 500);
  }

  addSpeaker(speakerId: string, speakerName: string): void {
    if (this.sessions.has(speakerId)) return;
    const now = Date.now();
    this.sessions.set(speakerId, {
      speakerId, speakerName,
      ws: null, wsReady: false, pendingAudio: [],
      segmentText: '', segmentStartMs: now, lastDeltaMs: 0, lastAudioMs: now,
      sequenceNumber: 0, generation: 0, closed: false,
      primerPending: false, primerText: '', primerSentMs: 0,
      audioSinceCommit: false, lastCommitMs: 0, tailFlushed: true,
      sessionAudioSec: 0,
    });
    log(`[Realtime] Added speaker "${speakerName}" (${speakerId})`);
  }

  hasSpeaker(speakerId: string): boolean { return this.sessions.has(speakerId); }
  getSpeakerName(speakerId: string): string | undefined { return this.sessions.get(speakerId)?.speakerName; }
  getActiveSpeakers(): string[] { return [...this.sessions.keys()]; }
  getBufferStartMs(speakerId: string): number { return this.sessions.get(speakerId)?.segmentStartMs ?? Date.now(); }
  getLastConfirmedText(_speakerId: string): string { return ''; }
  getSegmentId(speakerId: string): string { return `${speakerId}:${this.sessions.get(speakerId)?.sequenceNumber ?? 0}`; }
  /** Whisper-path compat no-op — the realtime pipeline has no submit/confirm loop. */
  handleTranscriptionResult(_speakerId: string, _transcript: string, _segmentEndSec?: number, _segments?: unknown[]): void {}

  updateSpeakerName(speakerId: string, newName: string): boolean {
    const s = this.sessions.get(speakerId);
    if (!s) return false;
    log(`[Realtime] Updated speaker name "${s.speakerName}" → "${newName}" (${speakerId})`);
    s.speakerName = newName;
    return true;
  }

  feedAudio(speakerId: string, audioData: Float32Array): void {
    const s = this.sessions.get(speakerId);
    if (!s || s.closed) return;
    const now = Date.now();
    if (!s.segmentText && s.lastAudioMs < now - this.cfg.segmentGapMs) {
      // Fresh audio after a quiet stretch with nothing pending — restart timing.
      s.segmentStartMs = now;
    }
    s.lastAudioMs = now;
    s.tailFlushed = false;
    s.sessionAudioSec += audioData.length / this.cfg.sampleRate;
    const pcm = this.float32ToPcm16(audioData);
    if (s.ws && s.wsReady) {
      this.sendAudio(s, pcm);
    } else {
      s.pendingAudio.push(pcm);
      if (!s.ws) this.connect(s);
    }
  }

  async flushSpeaker(speakerId: string): Promise<void> {
    const s = this.sessions.get(speakerId);
    if (!s) return;
    this.finalizeSegment(s, 'flush');
  }

  removeSpeaker(speakerId: string): void {
    const s = this.sessions.get(speakerId);
    if (!s) return;
    this.finalizeSegment(s, 'remove');
    this.closeSession(s);
    this.sessions.delete(speakerId);
  }

  removeAll(): void {
    for (const id of [...this.sessions.keys()]) this.removeSpeaker(id);
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private connect(s: SpeakerSession): void {
    s.sessionAudioSec = 0;
    if (this.httpLive) { this.connectHttpLive(s); return; }
    const generation = s.generation;
    let WS: any = (globalThis as any).WebSocket;
    if (!WS) {
      try { WS = require('ws'); } catch { log('[Realtime] No WebSocket implementation available'); return; }
    }
    log(`[Realtime] Connecting session for "${s.speakerName}" → ${this.cfg.realtimeUrl}`);
    const ws = new WS(this.cfg.realtimeUrl);
    s.ws = ws;
    s.wsReady = false;

    const onMessage = (data: any) => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      let msg: any;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
      if (msg.type === 'session.created') {
        try { ws.send(JSON.stringify({ type: 'session.update', model: this.cfg.model })); } catch {}
        s.wsReady = true;
        // Language primer FIRST — the model locks onto the language of the
        // first audio it hears. Its transcript is discarded in handleDelta.
        if (this.primer) {
          s.primerPending = true;
          s.primerText = '';
          s.primerSentMs = Date.now();
          this.sendAudio(s, this.primer);
          this.sendCommit(s); // flush the primer promptly → language locks first
        }
        for (const pcm of s.pendingAudio.splice(0)) this.sendAudio(s, pcm);
      } else if (msg.type === 'transcription.delta' && typeof msg.delta === 'string') {
        this.handleDelta(s, msg.delta);
      } else if (msg.type === 'transcription.done') {
        // Emitted after every commit's generation — NOT a segment boundary.
        // Segments finalize on sentence boundary, audio-silence gap or size
        // cap; session teardown flushes via removeSpeaker/idle close.
      } else if (msg.type === 'error') {
        log(`[Realtime] Server error for "${s.speakerName}": ${JSON.stringify(msg.error ?? msg)}`);
      }
    };

    const onClose = () => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      s.ws = null;
      s.wsReady = false;
      // Reconnect lazily: the next feedAudio() reopens.
    };

    if (typeof ws.on === 'function') {
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', (err: any) => { log(`[Realtime] WS error ("${s.speakerName}"): ${err?.message || err}`); onClose(); });
    } else {
      ws.onmessage = (ev: any) => onMessage(ev.data);
      ws.onclose = onClose;
      ws.onerror = (ev: any) => { log(`[Realtime] WS error ("${s.speakerName}"): ${ev?.message || 'unknown'}`); };
    }
  }

  /** audio.cpp HTTP-live: one long-lived chunked POST per speaker session —
   * raw s16le PCM written to the request body as it is captured, transcript
   * deltas read back from the streamed response (SSE `data:` lines or
   * `partial_text=` lines). No commit protocol: the server decodes as audio
   * arrives, so sendCommit becomes a no-op on this transport. */
  private connectHttpLive(s: SpeakerSession): void {
    const generation = s.generation;
    let url: URL;
    try { url = new URL(this.cfg.realtimeUrl); } catch { log(`[Realtime] Bad HTTP-live URL: ${this.cfg.realtimeUrl}`); return; }
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    log(`[Realtime] Opening HTTP-live session for "${s.speakerName}" → ${this.cfg.realtimeUrl}`);
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'text/event-stream' },
    });
    s.ws = req;
    s.wsReady = false;

    const fail = (why: string) => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      log(`[Realtime] HTTP-live ended ("${s.speakerName}"): ${why}`);
      s.ws = null;
      s.wsReady = false; // lazy reconnect on next feedAudio
    };

    req.on('response', (res: any) => {
      if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
      if (res.statusCode !== 200) { fail(`HTTP ${res.statusCode}`); try { req.destroy(); } catch {} return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (this.sessions.get(s.speakerId) !== s || s.generation !== generation) return;
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          const delta = this.parseLiveDelta(line);
          if (delta) this.handleDelta(s, delta);
        }
      });
      res.on('end', () => fail('response ended'));
      res.on('error', (err: any) => fail(err?.message || 'response error'));
    });
    req.on('error', (err: any) => fail(err?.message || 'request error'));

    // The request body is writable immediately — mark ready, prime, flush.
    s.wsReady = true;
    if (this.primer) {
      s.primerPending = true;
      s.primerText = '';
      s.primerSentMs = Date.now();
      this.sendAudio(s, this.primer);
    }
    for (const pcm of s.pendingAudio.splice(0)) this.sendAudio(s, pcm);
  }

  /** One line of the HTTP-live response → delta text, or null for noise.
   * Tolerates SSE (`data: {...}` / `data: text`), bare JSON and
   * `partial_text=` CLI-style lines. */
  private parseLiveDelta(line: string): string | null {
    if (!line || line.startsWith(':')) return null;
    let payload = line;
    if (payload.startsWith('data:')) payload = payload.slice(5).trim();
    if (payload.startsWith('partial_text=')) return payload.slice('partial_text='.length);
    if (payload.startsWith('{')) {
      try {
        const obj = JSON.parse(payload);
        // Deltas only — transcript.text.done carries the WHOLE utterance
        // again, so treating its `text` as a delta doubles every utterance.
        const t = obj.delta ?? obj.partial_text;
        return typeof t === 'string' && t ? t : null;
      } catch { return null; }
    }
    // Non-JSON, non-labelled lines (status noise like audio_input=stdin) are dropped.
    return payload.includes('=') ? null : payload || null;
  }

  private sendAudio(s: SpeakerSession, pcm: Buffer): void {
    try {
      if (this.httpLive) {
        s.ws.write(pcm);
      } else {
        // ~4KB raw audio per append message.
        for (let off = 0; off < pcm.length; off += 4096) {
          const chunk = pcm.subarray(off, Math.min(off + 4096, pcm.length));
          s.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
        }
      }
      s.audioSinceCommit = true;
    } catch (err: any) {
      log(`[Realtime] send failed ("${s.speakerName}"): ${err?.message}`);
    }
  }

  /** vLLM's realtime endpoint only generates text on commit — without a
   * commit cadence the model buffers audio forever and emits nothing.
   * (Commits during active generation are ignored server-side, so a fixed
   * cadence is safe.) */
  private sendCommit(s: SpeakerSession): void {
    if (!s.ws || !s.wsReady) return;
    if (this.httpLive) {
      // audio.cpp decodes continuously — there is no commit. Keep the
      // bookkeeping so the sweep's cadence logic stays quiet.
      s.audioSinceCommit = false;
      s.lastCommitMs = Date.now();
      return;
    }
    try {
      s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      s.audioSinceCommit = false;
      s.lastCommitMs = Date.now();
    } catch (err: any) {
      log(`[Realtime] commit failed ("${s.speakerName}"): ${err?.message}`);
    }
  }

  private handleDelta(s: SpeakerSession, delta: string): void {
    if (!delta) return;
    if (s.primerPending) {
      if (Date.now() - s.primerSentMs > PRIMER_TIMEOUT_MS) {
        // Primer transcript never fully arrived — stop discarding and treat
        // this delta as real text.
        s.primerPending = false;
        s.primerText = '';
        s.segmentStartMs = Date.now();
      } else {
        // Discard the primer's own transcript. The primer sentence ends with
        // a period, so a sentence boundary marks it fully received.
        s.primerText += delta;
        if (SENTENCE_END.test(s.primerText) && s.primerText.trim().length >= this.primerMinChars) {
          s.primerPending = false;
          s.primerText = '';
          s.segmentStartMs = Date.now();
        }
        return;
      }
    }
    if (!s.segmentText) s.segmentStartMs = Math.min(s.segmentStartMs, Date.now());
    s.segmentText += delta;
    s.lastDeltaMs = Date.now();
    const text = s.segmentText.trim();
    // Pending is consumed as stable text downstream — never surface primer residue.
    if (text && this.onPending &&
        !(this.primerNorm && this.primerNorm.endsWith(normalizeForPrimerMatch(text)))) {
      this.onPending(s.speakerId, s.speakerName, text, s.segmentStartMs);
    }
    // A sentence end finalizes long segments mid-speech (>40 chars guards
    // against abbreviation periods), and ANY segment once the audio has gone
    // quiet — short utterances ("Nee, dat is niet waar.") must not wait out
    // the gap timer after the tail flush already released their last words.
    if (s.segmentText.length >= this.cfg.maxSegmentChars ||
        (SENTENCE_END.test(s.segmentText) &&
         (s.segmentText.trim().length > 40 || Date.now() - s.lastAudioMs > 700))) {
      this.finalizeSegment(s, 'boundary');
    }
  }

  private finalizeSegment(s: SpeakerSession, reason: string): void {
    const text = s.segmentText.trim();
    s.segmentText = '';
    const startMs = s.segmentStartMs;
    const endMs = Date.now();
    s.segmentStartMs = endMs;
    if (!text) return;
    if (this.primerNorm && this.primerNorm.endsWith(normalizeForPrimerMatch(text))) {
      log(`[Realtime] [FILTERED] Primer residue for "${s.speakerName}": "${text}"`);
      return;
    }
    if (isHallucination(text)) {
      log(`[Realtime] [FILTERED] Hallucination for "${s.speakerName}": "${text.substring(0, 60)}"`);
      return;
    }
    const segmentId = `${s.speakerId}:${s.sequenceNumber++}`;
    log(`[Realtime] CONFIRMED (${reason}) ${s.speakerName} | "${text.substring(0, 60)}"`);
    if (this.onSegmentConfirmed) this.onSegmentConfirmed(s.speakerId, s.speakerName, text, startMs, endMs, segmentId);
  }

  private closeSession(s: SpeakerSession): void {
    s.closed = true;
    s.generation++;
    if (s.ws) {
      if (this.httpLive) {
        try { s.ws.end(); } catch {}
      } else {
        try { s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: true })); } catch {}
        try { s.ws.close(); } catch {}
      }
    }
    s.ws = null;
    s.wsReady = false;
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Commit cadence — the model only transcribes committed audio.
      if (s.audioSinceCommit && now - s.lastCommitMs >= 750) {
        this.sendCommit(s);
      }
      // Tail flush — the model's delay conditioning withholds the last
      // ~0.5s of words until it sees audio AFTER them. The VAD sends
      // nothing during a pause, so on speech end push a short synthetic
      // silence + commit once, or the final words of an utterance only
      // appear when the speaker starts their NEXT utterance.
      if (!s.tailFlushed && s.ws && s.wsReady &&
          now - s.lastAudioMs > 700 && now - s.lastAudioMs < this.cfg.idleTimeoutSec * 1000) {
        this.sendAudio(s, TAIL_SILENCE);
        this.sendCommit(s);
        s.tailFlushed = true;
      }
      // Silence gap → the open segment is done. Gate on AUDIO silence (VAD
      // only feeds real speech), not just delta silence: deltas arrive in
      // bursts per commit, so a delta-only gap fires between every commit
      // and chops sentences mid-flow.
      if (s.segmentText && s.lastDeltaMs &&
          now - s.lastDeltaMs > this.cfg.segmentGapMs &&
          now - s.lastAudioMs > this.cfg.segmentGapMs) {
        this.finalizeSegment(s, 'gap');
      }
      // Context guard — the server never bounds its own context (~8k tokens
      // ≈ 11 min of audio); a session that never idles (monologue, noisy
      // mic) overflows it and generation degenerates permanently. Recycle at
      // the first pause after the audio budget is spent (tail flush has
      // already released the withheld words by then), forced past the extra
      // margin even mid-speech. Reconnect eagerly so the primer locks the
      // language before speech resumes.
      if (s.ws && s.wsReady && s.sessionAudioSec >= this.cfg.sessionMaxAudioSec &&
          ((s.tailFlushed && now - s.lastAudioMs > 700) ||
           s.sessionAudioSec >= this.cfg.sessionMaxAudioSec + SESSION_FORCE_EXTRA_SEC)) {
        log(`[Realtime] Session recycle for "${s.speakerName}" (${Math.round(s.sessionAudioSec)}s audio)`);
        this.finalizeSegment(s, 'recycle');
        const gen = s.generation;
        this.closeSession(s);
        s.closed = false;
        s.generation = gen + 1;
        this.connect(s);
        continue;
      }
      // Long idle → close the socket (reopens on next audio).
      if (s.ws && now - s.lastAudioMs > this.cfg.idleTimeoutSec * 1000) {
        log(`[Realtime] Idle close for "${s.speakerName}"`);
        this.finalizeSegment(s, 'idle');
        const gen = s.generation;
        this.closeSession(s);
        s.closed = false;          // speaker stays known; next audio reconnects
        s.generation = gen + 1;
      }
    }
  }

  private float32ToPcm16(audio: Float32Array): Buffer {
    const buf = Buffer.allocUnsafe(audio.length * 2);
    for (let i = 0; i < audio.length; i++) {
      const v = Math.max(-1, Math.min(1, audio[i]));
      buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
    }
    return buf;
  }
}
