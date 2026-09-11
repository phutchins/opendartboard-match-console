import type { MatchState } from './game-engine';

export const MATCH_SESSION_STORAGE_KEY = 'opendartboard-match-session-v1';

export type StoredMatchSession = {
  version: 1;
  savedAt: string;
  match: MatchState;
  history: MatchState[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export function isRecoverableMatch(value: unknown): value is MatchState {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (value.status !== 'active' && value.status !== 'completed') return false;
  if (!isRecord(value.config)) return false;
  if (!['301', '501', 'cricket'].includes(String(value.config.mode))) return false;
  if (!Array.isArray(value.players) || value.players.length < 1 || value.players.length > 4) return false;
  if (!value.players.every((player) => (
    isRecord(player)
    && typeof player.name === 'string'
    && typeof player.score === 'number'
  ))) return false;
  if (!Number.isInteger(value.activePlayer)
    || Number(value.activePlayer) < 0
    || Number(value.activePlayer) >= value.players.length) return false;
  return Array.isArray(value.darts)
    && Array.isArray(value.visits)
    && typeof value.awaitingClear === 'boolean'
    && typeof value.visitScore === 'number';
}

export function parseMatchSnapshot(value: unknown): MatchState | null {
  return isRecoverableMatch(value) ? value : null;
}

export function encodeMatchSession(match: MatchState, history: MatchState[]) {
  const session: StoredMatchSession = {
    version: 1,
    savedAt: new Date().toISOString(),
    match,
    history: history.filter(isRecoverableMatch).slice(-50),
  };
  return JSON.stringify(session);
}

export function parseMatchSession(value: string | null): StoredMatchSession | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecoverableMatch(parsed.match)) return null;
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter(isRecoverableMatch).slice(-50)
      : [];
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : parsed.match.startedAt,
      match: parsed.match,
      history,
    };
  } catch {
    return null;
  }
}
