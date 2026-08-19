/**
 * junk-filter — the live lane's deliberately minimal filter: no length floor (single words
 * are real here), but decode loops (single-token AND 3–6-word phrase loops) and the shared
 * hallucination phrase DB (exact + trailing-punctuation-normalised) are dropped.
 */
import assert from 'node:assert/strict';
import { isJunk } from './junk-filter.js';

const phrases = new Set(['ondertiteling ingeschakeld', 'bedankt voor het kijken.', 'thank you for watching']);

assert.equal(isJunk('Ja.'), false, 'single short word survives');
assert.equal(isJunk(''), true, 'empty is junk');
assert.equal(isJunk('nee nee nee nee'), true, 'single-token loop');
assert.equal(isJunk('en dan gaan we en dan gaan we en dan gaan we'), true, '3-word phrase × 3 is a decode loop');
assert.equal(isJunk('en dan gaan we naar huis en dan eten we en dan slapen we'), false, 'varied speech is not a loop');
assert.equal(isJunk('Ondertiteling ingeschakeld', phrases), true, 'known phrase, case-insensitive');
assert.equal(isJunk('Bedankt voor het kijken', phrases), true, 'phrase listed WITH trailing dot matches bare text');
assert.equal(isJunk('Thank you for watching...', phrases), true, 'trailing punctuation normalised');
assert.equal(isJunk('Thank you for watching', undefined), false, 'no phrase set → no phrase drops');

console.log('junk-filter.test: OK');
