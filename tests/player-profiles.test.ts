import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlayerSelection, reconcilePlayerSelection } from '../lib/player-profiles.ts';

const profiles = [
  { id: 'a', name: 'Alice', email: null, games: 2, lastPlayed: null },
  { id: 'b', name: 'Bob', email: 'bob@example.com', games: 1, lastPlayed: null },
];

test('parses only a bounded string player selection', () => {
  assert.deepEqual(parsePlayerSelection(JSON.stringify(['a', 2, 'b'])), ['a', 'b']);
  assert.deepEqual(parsePlayerSelection('not-json'), []);
});

test('drops profiles that no longer exist on this board', () => {
  assert.deepEqual(reconcilePlayerSelection(['missing', 'b', 'a'], profiles), ['b', 'a']);
});
