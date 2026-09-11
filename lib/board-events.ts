import { applyHit, endVisit, parseScore } from './game-engine.ts';
import type { MatchState } from './game-engine.ts';

export type BoardScoreEvent = {
  eventId: string;
  score: string;
  timestamp: number;
  cameraPosition?: { x: number; y: number };
  boardPosition?: { x: number; y: number };
  state?: { previous: string; current: string };
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const point = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
};

const textValue = (value: unknown) => typeof value === 'string' ? value : '';

const boardState = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const previous = textValue(value.previous).toUpperCase();
  const current = textValue(value.current).toUpperCase();
  return previous && current ? { previous, current } : undefined;
};

const eventTimestampFromId = (eventId: string) => {
  const match = eventId.match(/^event-(\d+)-/);
  return match ? Number(match[1]) : 0;
};

const normalizedTimestamp = (value: unknown, eventId: string) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  return eventTimestampFromId(eventId);
};

export function parseLiveBoardEvent(value: unknown): BoardScoreEvent | null {
  if (!isRecord(value)) return null;
  const eventId = textValue(value.event_id) || textValue(value.eventId);
  const score = textValue(value.score).toUpperCase();
  const timestamp = normalizedTimestamp(value.timestamp, eventId);
  if (!eventId || !score || !timestamp) return null;
  return {
    eventId,
    score,
    timestamp,
    cameraPosition: point(value.position),
    boardPosition: point(value.boardPosition || value.board_position || value.normalizedPosition),
    state: boardState(value.state),
  };
}

export function parseDiagnosticBoardEvent(value: unknown): BoardScoreEvent | null {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  const eventId = textValue(value.event_id);
  const score = textValue(value.result.score).toUpperCase();
  const timestamp = normalizedTimestamp(value.captured_at_epoch_ms, eventId);
  if (!eventId || !score || !timestamp || value.result.valid !== true) return null;
  return {
    eventId,
    score,
    timestamp,
    cameraPosition: point(value.result.pixel_position),
    boardPosition: point(value.result.board_position),
    state: boardState(value.state),
  };
}

export function compareBoardEvents(left: BoardScoreEvent, right: BoardScoreEvent) {
  return left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId);
}

function recordedBoardEventIds(match: MatchState) {
  const ids = new Set<string>();
  for (const dart of match.darts) {
    if (dart.boardEventId) ids.add(dart.boardEventId);
  }
  for (const visit of match.visits) {
    for (const dart of visit.dartDetails || []) {
      if (dart.boardEventId) ids.add(dart.boardEventId);
    }
  }
  return ids;
}

export function inferredBoardEventCursor(match: MatchState) {
  if (match.boardEventCursor) return match.boardEventCursor;
  let cursor: MatchState['boardEventCursor'];
  for (const eventId of recordedBoardEventIds(match)) {
    const timestamp = eventTimestampFromId(eventId);
    if (!timestamp) continue;
    if (!cursor || timestamp > cursor.timestamp
      || (timestamp === cursor.timestamp && eventId > cursor.eventId)) {
      cursor = { eventId, timestamp };
    }
  }
  return cursor;
}

export function applyBoardScoreEvent(match: MatchState, event: BoardScoreEvent): MatchState {
  if (match.status !== 'active') return match;
  const startedAt = Date.parse(match.startedAt);
  if (Number.isFinite(startedAt) && event.timestamp < startedAt) return match;

  const knownIds = recordedBoardEventIds(match);
  if (knownIds.has(event.eventId)) return match;
  const cursor = inferredBoardEventCursor(match);
  if (cursor && compareBoardEvents(event, {
    eventId: cursor.eventId,
    timestamp: cursor.timestamp,
    score: '',
  }) <= 0) return match;

  let scoringMatch = match;
  if (event.score !== 'END' && match.awaitingClear) {
    const startsFreshScorerVisit = event.state?.previous === 'CLEAN'
      && event.state.current === 'DART_1';
    if (!startsFreshScorerVisit) return match;
    scoringMatch = endVisit(match);
  }

  let next = scoringMatch;
  if (event.score === 'END') {
    next = endVisit(match);
  } else {
    const parsed = parseScore(event.score);
    if (!parsed) return match;
    next = applyHit(scoringMatch, {
      ...parsed,
      inputSource: 'board',
      boardEventId: event.eventId,
      thrownAt: new Date(event.timestamp).toISOString(),
      ...(event.cameraPosition ? { cameraPosition: event.cameraPosition } : {}),
      ...(event.boardPosition ? { boardPosition: event.boardPosition } : {}),
    });
  }

  return {
    ...next,
    boardEventCursor: { eventId: event.eventId, timestamp: event.timestamp },
  };
}
