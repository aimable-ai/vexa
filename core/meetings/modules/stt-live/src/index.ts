/**
 * @vexa/stt-live — streaming live STT engines for the mixed lane.
 *
 *   mixed-capture.v1 (audio + hints) ─► VoxtralTranscriber
 *        ├─ live-transport            ONE session: vLLM realtime WS or audio.cpp HTTP-live
 *        ├─ primer                    spoken language lock + residue guards
 *        └─ ClusterNameBinder         the shared namer (@vexa/mixed-pipeline/binder)
 *   ─► transcript segments via the same publish/pending/rename callbacks as the
 *      chunked lane. Deltas are model-committed → every pending draft is stable.
 *
 * Selected at the bot's MixedTranscriberFactory seam when the transcription URL
 * is a live endpoint (ws:// or an audio.cpp http:// live URL); the chunked
 * whisper lane remains the default.
 */
export { VoxtralTranscriber } from './voxtral-transcriber.js';
export { Reson8Transcriber } from './reson8-transcriber.js';
export type { Reson8TranscriberConfig, Reson8Socket } from './reson8-transcriber.js';
export type {
  VoxtralTranscriberCallbacks,
  VoxtralTranscriberConfig,
  VoxtralSegment,
} from './voxtral-transcriber.js';
export { LiveSpeakerStreams } from './live-speaker-streams.js';
export type { LiveSpeakerStreamsConfig, LiveSpeakerStreamsCallbacks, LiveEngineKind } from './live-speaker-streams.js';
export { openLiveTransport, parseLiveDelta } from './live-transport.js';
export type { LiveTransport, LiveTransportConfig, LiveTransportEvents, TransportFactory } from './live-transport.js';
