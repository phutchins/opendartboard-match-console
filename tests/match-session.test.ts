import assert from 'node:assert/strict';
import test from 'node:test';

import { createMatch } from '../lib/game-engine.ts';
import { encodeMatchSession, parseMatchSession } from '../lib/match-session.ts';

test('restores an active match and undo history after a page refresh', () => {
  const match = createMatch({
    mode: '501', players: ['Ada', 'Grace'], inRule: 'straight', outRule: 'double',
  });
  const restored = parseMatchSession(encodeMatchSession(match, [match]));

  assert.deepEqual(restored?.match, match);
  assert.deepEqual(restored?.history, [match]);
  assert.equal(restored?.version, 1);
});

test('ignores corrupt or abandoned saved matches', () => {
  assert.equal(parseMatchSession('{not json'), null);
  assert.equal(parseMatchSession(JSON.stringify({ version: 1, match: { id: 'broken' } })), null);

  const abandoned = { ...createMatch({
    mode: '301', players: ['Ada'], inRule: 'straight', outRule: 'double',
  }), status: 'abandoned' };
  assert.equal(parseMatchSession(JSON.stringify({ version: 1, match: abandoned })), null);
});
