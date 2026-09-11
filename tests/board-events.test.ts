import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyBoardScoreEvent,
  parseDiagnosticBoardEvent,
  parseLiveBoardEvent,
} from '../lib/board-events.ts';
import { createMatch } from '../lib/game-engine.ts';

const start = Date.parse('2026-09-11T19:53:00.000Z');

test('parses live and persisted scorer events into the same shape', () => {
  const live = parseLiveBoardEvent({
    event_id: 'event-1789156392756-5',
    score: 'S20',
    timestamp: 1789156392756,
    position: { x: 611, y: 362 },
    board_position: { x: -0.04, y: -0.43 },
  });
  const persisted = parseDiagnosticBoardEvent({
    event_id: 'event-1789156392756-5',
    captured_at_epoch_ms: 1789156392756,
    result: {
      valid: true,
      score: 'S20',
      pixel_position: { x: 611, y: 362 },
      board_position: { x: -0.04, y: -0.43 },
    },
  });

  assert.deepEqual(persisted, live);
});

test('replays missed darts and pull events once in chronological order', () => {
  let match = {
    ...createMatch({
      mode: '501', players: ['Philip'], inRule: 'straight', outRule: 'double',
    }),
    startedAt: new Date(start).toISOString(),
  };
  const events = [
    { eventId: 'event-1789156392756-5', timestamp: start + 1000, score: 'S20' },
    { eventId: 'event-1789156394657-6', timestamp: start + 2000, score: 'S20' },
    { eventId: 'event-1789156396356-7', timestamp: start + 3000, score: 'S20' },
  ];

  for (const event of events) match = applyBoardScoreEvent(match, event);
  assert.equal(match.players[0].score, 441);
  assert.equal(match.awaitingClear, true);
  assert.equal(match.darts.length, 3);

  const duplicate = applyBoardScoreEvent(match, events[2]);
  assert.equal(duplicate, match);

  match = applyBoardScoreEvent(match, {
    eventId: 'event-1789156398000-8', timestamp: start + 4000, score: 'END',
  });
  assert.equal(match.darts.length, 0);
  assert.equal(match.visits.length, 1);
  assert.equal(match.boardEventCursor?.eventId, 'event-1789156398000-8');
});

test('does not replay events from before the match or before its cursor', () => {
  const match = {
    ...createMatch({
      mode: '301', players: ['Ada'], inRule: 'straight', outRule: 'double',
    }),
    startedAt: new Date(start).toISOString(),
    boardEventCursor: { eventId: 'event-1789156393000-2', timestamp: start + 3000 },
  };

  assert.equal(applyBoardScoreEvent(match, {
    eventId: 'event-1789156389000-1', timestamp: start - 1000, score: 'T20',
  }), match);
  assert.equal(applyBoardScoreEvent(match, {
    eventId: 'event-1789156392000-1', timestamp: start + 2000, score: 'T20',
  }), match);
});
