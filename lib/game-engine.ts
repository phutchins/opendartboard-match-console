export type GameMode = '501' | '301' | 'cricket';
export type X01Rule = 'straight' | 'double';
export type ConnectionState = 'connecting' | 'connected' | 'offline';

export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25] as const;
export type CricketTarget = (typeof CRICKET_TARGETS)[number];

export type ParsedHit = {
  label: string;
  value: number;
  target: number | null;
  multiplier: number;
  isDouble: boolean;
  cameraPosition?: { x: number; y: number };
  /** Canonical board coordinates in the range -1..1, with +x right and +y down. */
  boardPosition?: { x: number; y: number };
};

export type PlayerState = {
  id: string;
  name: string;
  score: number;
  opened: boolean;
  marks: Record<CricketTarget, number>;
  dartsThrown: number;
  totalScored: number;
  marksThrown: number;
  completedVisits: number;
  lastVisit: number | null;
};

export type VisitRecord = {
  playerIndex: number;
  playerName: string;
  darts: string[];
  score: number;
  bust: boolean;
  remaining: number;
  createdAt: string;
};

export type MatchConfig = {
  mode: GameMode;
  players: string[];
  inRule: X01Rule;
  outRule: X01Rule;
};

export type MatchState = {
  id: string;
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt: string | null;
  config: MatchConfig;
  players: PlayerState[];
  activePlayer: number;
  darts: ParsedHit[];
  visitScore: number;
  visitStartScore: number;
  awaitingClear: boolean;
  bust: boolean;
  winner: number | null;
  message: string;
  visits: VisitRecord[];
};

const emptyMarks = (): Record<CricketTarget, number> => ({
  20: 0,
  19: 0,
  18: 0,
  17: 0,
  16: 0,
  15: 0,
  25: 0,
});

export function createMatch(config: MatchConfig): MatchState {
  const startingScore = config.mode === '301' ? 301 : config.mode === '501' ? 501 : 0;
  const names = config.players
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 4);

  const players = (names.length ? names : ['Player 1']).map((name, index) => ({
    id: `player-${index + 1}`,
    name,
    score: startingScore,
    opened: config.mode === 'cricket' || config.inRule === 'straight',
    marks: emptyMarks(),
    dartsThrown: 0,
    totalScored: 0,
    marksThrown: 0,
    completedVisits: 0,
    lastVisit: null,
  }));

  return {
    id: `match_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    status: 'active',
    startedAt: new Date().toISOString(),
    completedAt: null,
    config: { ...config, players: players.map((player) => player.name) },
    players,
    activePlayer: 0,
    darts: [],
    visitScore: 0,
    visitStartScore: startingScore,
    awaitingClear: false,
    bust: false,
    winner: null,
    message: `${players[0].name} to throw`,
    visits: [],
  };
}

function completedVisit(
  state: MatchState,
  darts: ParsedHit[],
  score: number,
  bust: boolean,
  remaining: number,
): VisitRecord {
  return {
    playerIndex: state.activePlayer,
    playerName: state.players[state.activePlayer].name,
    darts: darts.map((dart) => dart.label),
    score,
    bust,
    remaining,
    createdAt: new Date().toISOString(),
  };
}

export function parseScore(input: string): ParsedHit | null {
  const token = input.trim().toUpperCase();
  if (token === 'MISS') {
    return { label: 'MISS', value: 0, target: null, multiplier: 0, isDouble: false };
  }
  if (token === 'BULL' || token === 'DBULL') {
    return { label: 'BULL', value: 50, target: 25, multiplier: 2, isDouble: true };
  }
  if (token === 'OUTER' || token === 'SBULL' || token === '25') {
    return { label: 'OUTER', value: 25, target: 25, multiplier: 1, isDouble: false };
  }

  const match = token.match(/^([SDT])([1-9]|1\d|20)$/);
  if (!match) return null;

  const multiplier = match[1] === 'T' ? 3 : match[1] === 'D' ? 2 : 1;
  const target = Number(match[2]);
  return {
    label: `${match[1]}${target}`,
    value: target * multiplier,
    target,
    multiplier,
    isDouble: multiplier === 2,
  };
}

function updatePlayer(
  players: PlayerState[],
  index: number,
  updater: (player: PlayerState) => PlayerState,
) {
  return players.map((player, playerIndex) =>
    playerIndex === index ? updater(player) : player,
  );
}

function finishWinningVisit(state: MatchState, players: PlayerState[], visitScore: number) {
  const active = state.activePlayer;
  return updatePlayer(players, active, (player) => ({
    ...player,
    totalScored: player.totalScored + visitScore,
    completedVisits: player.completedVisits + 1,
    lastVisit: visitScore,
  }));
}

function applyX01Hit(state: MatchState, hit: ParsedHit): MatchState {
  const active = state.activePlayer;
  const player = state.players[active];
  const openedNow = player.opened || state.config.inRule === 'straight' || hit.isDouble;
  const effectiveValue = openedNow && (player.opened || state.config.inRule === 'straight' || hit.isDouble)
    ? hit.value
    : 0;
  const nextScore = player.score - effectiveValue;
  const bust = nextScore < 0
    || (state.config.outRule === 'double' && nextScore === 1)
    || (nextScore === 0 && state.config.outRule === 'double' && !hit.isDouble);
  const darts = [...state.darts, hit];

  if (bust) {
    const players = updatePlayer(state.players, active, (current) => ({
      ...current,
      score: state.visitStartScore,
      opened: openedNow,
      dartsThrown: current.dartsThrown + 1,
    }));
    return {
      ...state,
      players,
      darts,
      visitScore: 0,
      awaitingClear: true,
      bust: true,
      message: 'Bust — remove darts',
    };
  }

  const visitScore = state.visitScore + effectiveValue;
  let players = updatePlayer(state.players, active, (current) => ({
    ...current,
    score: nextScore,
    opened: openedNow,
    dartsThrown: current.dartsThrown + 1,
  }));

  if (nextScore === 0) {
    players = finishWinningVisit(state, players, visitScore);
    return {
      ...state,
      status: 'completed',
      completedAt: new Date().toISOString(),
      players,
      darts,
      visitScore,
      awaitingClear: false,
      winner: active,
      message: `${player.name} wins the leg`,
      visits: [...state.visits, completedVisit(state, darts, visitScore, false, 0)],
    };
  }

  const awaitingClear = darts.length >= 3;
  return {
    ...state,
    players,
    darts,
    visitScore,
    awaitingClear,
    bust: false,
    message: awaitingClear ? 'Visit complete — remove darts' : `${3 - darts.length} darts remaining`,
  };
}

function applyCricketHit(state: MatchState, hit: ParsedHit): MatchState {
  const active = state.activePlayer;
  const player = state.players[active];
  const darts = [...state.darts, hit];
  const isTarget = hit.target !== null && CRICKET_TARGETS.includes(hit.target as CricketTarget);
  let points = 0;
  let nextMarks = player.marks;

  if (isTarget) {
    const target = hit.target as CricketTarget;
    const oldMarks = player.marks[target];
    const totalMarks = oldMarks + hit.multiplier;
    const extraMarks = Math.max(0, totalMarks - 3);
    const anOpponentIsOpen = state.players.some(
      (other, index) => index !== active && other.marks[target] < 3,
    );
    points = anOpponentIsOpen ? extraMarks * target : 0;
    nextMarks = { ...player.marks, [target]: Math.min(3, totalMarks) };
  }

  let players = updatePlayer(state.players, active, (current) => ({
    ...current,
    marks: nextMarks,
    score: current.score + points,
    dartsThrown: current.dartsThrown + 1,
    totalScored: current.totalScored + points,
    marksThrown: current.marksThrown + (isTarget ? hit.multiplier : 0),
  }));

  const updated = players[active];
  const allClosed = CRICKET_TARGETS.every((target) => updated.marks[target] >= 3);
  const hasScoreLead = players.every(
    (other, index) => index === active || updated.score >= other.score,
  );
  const visitScore = state.visitScore + points;

  if (allClosed && hasScoreLead) {
    players = updatePlayer(players, active, (current) => ({
      ...current,
      completedVisits: current.completedVisits + 1,
      lastVisit: visitScore,
    }));
    return {
      ...state,
      status: 'completed',
      completedAt: new Date().toISOString(),
      players,
      darts,
      visitScore,
      winner: active,
      awaitingClear: false,
      message: `${player.name} wins the match`,
      visits: [...state.visits, completedVisit(state, darts, visitScore, false, updated.score)],
    };
  }

  const awaitingClear = darts.length >= 3;
  return {
    ...state,
    players,
    darts,
    visitScore,
    awaitingClear,
    message: awaitingClear ? 'Visit complete — remove darts' : `${3 - darts.length} darts remaining`,
  };
}

export function applyHit(state: MatchState, hit: ParsedHit): MatchState {
  if (state.winner !== null || state.awaitingClear) return state;
  return state.config.mode === 'cricket'
    ? applyCricketHit(state, hit)
    : applyX01Hit(state, hit);
}

export function endVisit(state: MatchState): MatchState {
  if (state.winner !== null || state.darts.length === 0) return state;

  const active = state.activePlayer;
  const nextPlayer = (active + 1) % state.players.length;
  let players = state.players;

  if (state.config.mode !== 'cricket') {
    players = updatePlayer(players, active, (player) => ({
      ...player,
      totalScored: player.totalScored + state.visitScore,
      completedVisits: player.completedVisits + 1,
      lastVisit: state.visitScore,
    }));
  } else {
    players = updatePlayer(players, active, (player) => ({
      ...player,
      completedVisits: player.completedVisits + 1,
      lastVisit: state.visitScore,
    }));
  }

  return {
    ...state,
    players,
    activePlayer: nextPlayer,
    darts: [],
    visitScore: 0,
    visitStartScore: players[nextPlayer].score,
    awaitingClear: false,
    bust: false,
    message: `${players[nextPlayer].name} to throw`,
    visits: [
      ...state.visits,
      completedVisit(
        state,
        state.darts,
        state.visitScore,
        state.bust,
        players[active].score,
      ),
    ],
  };
}

export function playerAverage(player: PlayerState, pendingScore = 0) {
  if (!player.dartsThrown) return null;
  return ((player.totalScored + pendingScore) / player.dartsThrown) * 3;
}

type CheckoutOption = { label: string; value: number };

const setupOptions: CheckoutOption[] = [
  ...Array.from({ length: 20 }, (_, index) => 20 - index).map((n) => ({ label: `T${n}`, value: n * 3 })),
  { label: 'BULL', value: 50 },
  ...Array.from({ length: 20 }, (_, index) => 20 - index).map((n) => ({ label: `D${n}`, value: n * 2 })),
  ...Array.from({ length: 20 }, (_, index) => 20 - index).map((n) => ({ label: `S${n}`, value: n })),
  { label: 'OUTER', value: 25 },
];

const doubleOptions: CheckoutOption[] = [
  ...Array.from({ length: 20 }, (_, index) => 20 - index).map((n) => ({ label: `D${n}`, value: n * 2 })),
  { label: 'BULL', value: 50 },
];

export function checkoutSuggestion(score: number, dartsRemaining: number, outRule: X01Rule) {
  if (score <= 0 || dartsRemaining <= 0) return null;
  const finishers = outRule === 'double' ? doubleOptions : setupOptions;

  for (let count = 1; count <= Math.min(3, dartsRemaining); count += 1) {
    if (count === 1) {
      const finish = finishers.find((option) => option.value === score);
      if (finish) return finish.label;
    }
    if (count === 2) {
      for (const first of setupOptions) {
        const finish = finishers.find((option) => option.value === score - first.value);
        if (finish) return `${first.label} · ${finish.label}`;
      }
    }
    if (count === 3) {
      for (const first of setupOptions) {
        for (const second of setupOptions) {
          const finish = finishers.find(
            (option) => option.value === score - first.value - second.value,
          );
          if (finish) return `${first.label} · ${second.label} · ${finish.label}`;
        }
      }
    }
  }
  return null;
}

export function markGlyph(marks: number) {
  if (marks <= 0) return '—';
  if (marks === 1) return '/';
  if (marks === 2) return '×';
  return '⊗';
}
