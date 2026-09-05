import assert from 'node:assert/strict';
import test from 'node:test';

import { applyHit, createMatch, endVisit, parseScore } from '../lib/game-engine.ts';
import { buildHeatmap, heatmapForPlayer } from '../lib/heatmap.ts';

const hit = (label: string) => {
  const parsed = parseScore(label);
  assert.ok(parsed);
  return parsed;
};

test('keeps exact positions separate from score-bed estimates and unlocated misses', () => {
  const data = buildHeatmap([
    { ...hit('T20'), boardPosition: { x: 0.02, y: -0.6 } },
    hit('T20'),
    hit('S16'),
    hit('MISS'),
  ]);

  assert.deepEqual(data.exactPoints, [{ label: 'T20', x: 0.02, y: -0.6 }]);
  assert.deepEqual(data.estimatedBeds, [
    { label: 'S16', count: 1 },
    { label: 'T20', count: 1 },
  ]);
  assert.deepEqual(data.totals, { darts: 4, exact: 1, estimated: 2, unplottable: 1 });
});

test('builds a current-game heat map for each player without leaking active darts', () => {
  let match = createMatch({
    mode: '501', players: ['Ada', 'Grace'], inRule: 'straight', outRule: 'double',
  });
  match = applyHit(match, { ...hit('S16'), boardPosition: { x: -0.7, y: 0.2 } });
  match = endVisit(match);
  match = applyHit(match, hit('T20'));

  const ada = heatmapForPlayer(match, 0);
  const grace = heatmapForPlayer(match, 1);
  assert.equal(ada.totals.exact, 1);
  assert.equal(ada.totals.darts, 1);
  assert.deepEqual(grace.estimatedBeds, [{ label: 'T20', count: 1 }]);
});
