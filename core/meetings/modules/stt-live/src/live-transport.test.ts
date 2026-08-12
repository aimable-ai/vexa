/**
 * parseLiveDelta — the HTTP-live line parser. The one rule that matters:
 * `transcript.text.done` carries the WHOLE utterance again — its `text` must
 * never surface as a delta (doubling every utterance was a live bug).
 */
import assert from 'node:assert/strict';
import { parseLiveDelta } from './live-transport.js';

// SSE data lines with JSON deltas
assert.equal(parseLiveDelta('data: {"type":"transcript.text.delta","delta":"hallo "}'), 'hallo ');
assert.equal(parseLiveDelta('{"delta":"wereld"}'), 'wereld');
assert.equal(parseLiveDelta('data: {"partial_text":"tot zo"}'), 'tot zo');
// CLI-style lines
assert.equal(parseLiveDelta('partial_text=dag allemaal'), 'dag allemaal');
// done events are terminal, never deltas
assert.equal(parseLiveDelta('data: {"type":"transcript.text.done","text":"hallo wereld"}'), null);
assert.equal(parseLiveDelta('{"type":"transcription.done","text":"hallo wereld"}'), null);
// noise
assert.equal(parseLiveDelta(''), null);
assert.equal(parseLiveDelta(': keepalive'), null);
assert.equal(parseLiveDelta('audio_input=stdin'), null);
assert.equal(parseLiveDelta('data:'), null);
// bare non-JSON text line passes through (some builds emit raw text)
assert.equal(parseLiveDelta('plain text line'), 'plain text line');

console.log('live-transport.test: OK');

// withLiveQuery — audio.cpp live contract riders (model/sample_rate/channels/format)
import { withLiveQuery } from './live-transport.js';
assert.equal(
  withLiveQuery('http://h:8091/v1/audio/transcriptions/live'),
  'http://h:8091/v1/audio/transcriptions/live?model=voxtral-realtime&sample_rate=16000&channels=1&sample_format=s16le');
assert.ok(withLiveQuery('http://h:8091/live?model=custom').includes('model=custom'), 'explicit model preserved');
assert.equal(withLiveQuery('http://h:8091/live', 'my-model').includes('model=my-model'), true);
console.log('withLiveQuery: OK');
