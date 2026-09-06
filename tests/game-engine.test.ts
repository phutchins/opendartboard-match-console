import assert from 'node:assert/strict';
import test from 'node:test';

import { BOARD_CENTER, dartPoint } from '../lib/dartboard-geometry.ts';
import {
  applyHit,
  checkoutSuggestion,
  createMatch,
  endVisit,
  parseScore,
  playerAverage,
} from '../lib/game-engine.ts';

const hit = (token: string) => {
  const parsed = parseScore(token);
  assert.ok(parsed, `Expected ${token} to parse`);
  return parsed;
};

test('parses board score labels', () => {
  assert.deepEqual(parseScore('T20'), {
    label: 'T20', value: 60, target: 20, multiplier: 3, isDouble: false,
  });
  assert.equal(parseScore('BULL')?.value, 50);
  assert.equal(parseScore('OUTER')?.value, 25);
  assert.equal(parseScore('END'), null);
});

test('scores an x01 visit and rotates players when darts are removed', () => {
  let match = createMatch({
    mode: '301', players: ['Ada', 'Grace'], inRule: 'straight', outRule: 'double',
  });
  match = applyHit(match, hit('T20'));
  match = applyHit(match, hit('S20'));
  match = applyHit(match, hit('D10'));

  assert.equal(match.players[0].score, 201);
  assert.equal(match.visitScore, 100);
  assert.equal(match.awaitingClear, true);

  match = endVisit(match);
  assert.equal(match.activePlayer, 1);
  assert.equal(match.players[0].totalScored, 100);
  assert.equal(match.players[0].lastVisit, 100);
  assert.equal(match.darts.length, 0);
  assert.equal(match.visits.length, 1);
  assert.deepEqual(match.visits[0].darts, ['T20', 'S20', 'D10']);
  assert.deepEqual(match.visits[0].dartDetails.map((dart) => dart.label), ['T20', 'S20', 'D10']);
});

test('enforces double-in and double-out bust rules', () => {
  let match = createMatch({
    mode: '301', players: ['Ada'], inRule: 'double', outRule: 'double',
  });
  match = applyHit(match, hit('S20'));
  assert.equal(match.players[0].score, 301);
  assert.equal(match.players[0].opened, false);

  match = applyHit(match, hit('D20'));
  assert.equal(match.players[0].score, 261);
  assert.equal(match.players[0].opened, true);

  match = endVisit(match);
  match = {
    ...match,
    visitStartScore: 20,
    players: match.players.map((player) => ({ ...player, score: 20 })),
  };
  match = applyHit(match, hit('S20'));
  assert.equal(match.bust, true);
  assert.equal(match.players[0].score, 20);
});

test('tracks cricket closures and points', () => {
  let match = createMatch({
    mode: 'cricket', players: ['Ada', 'Grace'], inRule: 'straight', outRule: 'double',
  });
  match = applyHit(match, hit('T20'));
  match = applyHit(match, hit('T20'));

  assert.equal(match.players[0].marks[20], 3);
  assert.equal(match.players[0].score, 60);
  assert.equal(match.players[0].marksThrown, 6);
});

test('marks a checkout as a completed historical match', () => {
  let match = createMatch({
    mode: '501', players: ['Ada'], inRule: 'straight', outRule: 'double',
  });
  match = {
    ...match,
    visitStartScore: 40,
    players: match.players.map((player) => ({ ...player, score: 40 })),
  };
  match = applyHit(match, hit('D20'));

  assert.equal(match.status, 'completed');
  assert.equal(match.winner, 0);
  assert.equal(match.visits.length, 1);
  assert.equal(match.visits[0].remaining, 0);
  assert.ok(match.completedAt);
});

test('provides a standard 170 checkout', () => {
  assert.equal(checkoutSuggestion(170, 3, 'double'), 'T20 · T20 · BULL');
  assert.equal(checkoutSuggestion(169, 3, 'double'), null);
});

test('includes the live visit in the displayed average', () => {
  let match = createMatch({
    mode: '501', players: ['Ada'], inRule: 'straight', outRule: 'double',
  });
  match = applyHit(match, hit('T20'));
  assert.equal(playerAverage(match.players[0], match.visitScore), 180);
});

test('places visual darts inside the scored board bed', () => {
  const treble20 = dartPoint(hit('T20'), 0);
  assert.ok(treble20.radius >= 96 && treble20.radius <= 104);
  assert.ok(treble20.y < BOARD_CENTER);

  const double6 = dartPoint(hit('D6'), 1);
  assert.ok(double6.radius >= 160 && double6.radius <= 168);
  assert.ok(double6.x > BOARD_CENTER);

  const bull = dartPoint(hit('BULL'), 2);
  assert.ok(bull.radius <= 5);
});

test('uses canonical board coordinates when the scorer supplies them', () => {
  const parsed = { ...hit('S6'), boardPosition: { x: 0.5, y: -0.25 } };
  const point = dartPoint(parsed, 0);

  assert.equal(point.x, BOARD_CENTER + 85);
  assert.equal(point.y, BOARD_CENTER - 42.5);
});

test('preserves canonical position and throw metadata after a visit completes', () => {
  let match = createMatch({
    mode: '501', players: ['Ada'], inRule: 'straight', outRule: 'double',
  });
  match = applyHit(match, {
    ...hit('T20'),
    boardPosition: { x: 0.02, y: -0.6 },
    boardEventId: 'event-1788622930123-1',
    inputSource: 'board',
    thrownAt: '2026-09-05T15:42:10.123Z',
  });
  match = endVisit(match);

  assert.deepEqual(match.visits[0].dartDetails[0], {
    ...hit('T20'),
    boardPosition: { x: 0.02, y: -0.6 },
    boardEventId: 'event-1788622930123-1',
    inputSource: 'board',
    thrownAt: '2026-09-05T15:42:10.123Z',
  });
});
