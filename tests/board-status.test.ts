import assert from 'node:assert/strict';
import test from 'node:test';

import { calibrationStateLabel, cameraContribution } from '../lib/board-status.ts';

test('summarizes calibration state for the dashboard', () => {
  assert.equal(calibrationStateLabel('ready'), 'Ready');
  assert.equal(calibrationStateLabel('degraded'), 'Limited');
  assert.equal(calibrationStateLabel('calibrating'), 'Calibrating');
  assert.equal(calibrationStateLabel('unknown'), 'Unknown');
});

test('uses explicit camera contribution with legacy-safe fallbacks', () => {
  assert.equal(cameraContribution({ camera: 0, ready: false, contribution: 'ring' }), 'ring');
  assert.equal(cameraContribution({ camera: 1, ready: true }), 'full');
  assert.equal(cameraContribution({ camera: 2, ready: false, geometryValid: true }), 'ring');
  assert.equal(cameraContribution({ camera: 2, ready: false, geometryValid: false }), 'unavailable');
});
