'use client';

import {
  Activity,
  BarChart3,
  Check,
  CircleDot,
  Crosshair,
  Database,
  LoaderCircle,
  Minus,
  Plus,
  Radio,
  RotateCcw,
  Settings2,
  Trophy,
  Undo2,
  Users,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { BoardAdmin } from '@/components/board-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MatchDartboard } from '@/components/match-dartboard';
import { StatsDashboard } from '@/components/stats-dashboard';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  applyHit,
  checkoutSuggestion,
  createMatch,
  CRICKET_TARGETS,
  endVisit,
  GameMode,
  markGlyph,
  MatchState,
  parseScore,
  playerAverage,
  X01Rule,
} from '@/lib/game-engine';
import {
  encodeMatchSession,
  MATCH_SESSION_STORAGE_KEY,
  parseMatchSession,
} from '@/lib/match-session';

type SetupState = {
  mode: GameMode;
  players: string[];
  inRule: X01Rule;
  outRule: X01Rule;
};

type SocketStatus = 'connecting' | 'connected' | 'offline' | 'blocked';
type HistoryStatus = 'checking' | 'saving' | 'saved' | 'offline';
type AppView = 'play' | 'stats' | 'board';

const initialSetup: SetupState = {
  mode: '501',
  players: ['Player 1', 'Player 2'],
  inRule: 'straight',
  outRule: 'double',
};

const modeDescriptions: Record<GameMode, string> = {
  '501': 'Classic',
  '301': 'Quick leg',
  cricket: '15–Bull',
};

const throwTimestamp = (value?: number | string) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
};

const isLocalBoardHost = (host: string) => (
  host === 'localhost'
  || host === '127.0.0.1'
  || host.endsWith('.local')
  || /^10\./.test(host)
  || /^192\.168\./.test(host)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
);

export default function Home() {
  const [setup, setSetup] = useState<SetupState>(initialSetup);
  const [match, setMatch] = useState<MatchState | null>(null);
  const [view, setView] = useState<AppView>('play');
  const [history, setHistory] = useState<MatchState[]>([]);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');
  const [boardHost, setBoardHost] = useState('');
  const [lastSignal, setLastSignal] = useState('Waiting for board');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualMultiplier, setManualMultiplier] = useState<'S' | 'D' | 'T'>('S');
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('checking');
  const [sessionReady, setSessionReady] = useState(false);
  const [restoredMatch, setRestoredMatch] = useState(false);
  const [secureScoringBlocked, setSecureScoringBlocked] = useState(false);
  const matchRef = useRef<MatchState | null>(null);
  const lastMessageRef = useRef({ key: '', receivedAt: 0 });

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  useEffect(() => {
    const restored = parseMatchSession(window.localStorage.getItem(MATCH_SESSION_STORAGE_KEY));
    if (restored) {
      matchRef.current = restored.match;
      setMatch(restored.match);
      setHistory(restored.history);
      setSetup(restored.match.config);
      setView('play');
      setRestoredMatch(true);
      setLastSignal('Match restored after refresh');
    }
    setSessionReady(true);
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    if (match && match.status !== 'abandoned') {
      window.localStorage.setItem(MATCH_SESSION_STORAGE_KEY, encodeMatchSession(match, history));
    } else {
      window.localStorage.removeItem(MATCH_SESSION_STORAGE_KEY);
    }
  }, [history, match, sessionReady]);

  useEffect(() => {
    const savedHost = window.localStorage.getItem('opendartboard-host')?.trim();
    const pageHost = window.location.hostname;
    setBoardHost(savedHost || (pageHost === 'localhost' || pageHost === '127.0.0.1' ? 'opendartboard.local' : pageHost));
  }, []);

  const updateBoardHost = useCallback((host: string) => {
    if (!host) return;
    window.localStorage.setItem('opendartboard-host', host);
    setBoardHost(host);
    setLastSignal(`Scoring host changed to ${host}`);
  }, []);

  const persistMatch = useCallback(async (state: MatchState, keepalive = false) => {
    setHistoryStatus('saving');
    try {
      const response = await fetch('/api/matches/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
        keepalive,
      });
      if (!response.ok) throw new Error('Save failed');
      setHistoryStatus('saved');
    } catch {
      setHistoryStatus('offline');
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/health', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Offline');
        if (active) setHistoryStatus('saved');
      })
      .catch(() => {
        if (active) setHistoryStatus('offline');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!match) return;
    const timer = setTimeout(() => {
      void persistMatch(match);
    }, 220);
    return () => clearTimeout(timer);
  }, [match, persistMatch]);

  const commit = useCallback((transform: (current: MatchState) => MatchState) => {
    const current = matchRef.current;
    if (!current) return;
    const next = transform(current);
    if (next === current) return;
    setHistory((items) => [...items.slice(-49), current]);
    matchRef.current = next;
    setMatch(next);
  }, []);

  const scoreToken = useCallback((
    token: string,
    source = 'Manual',
    cameraPosition?: { x: number; y: number },
    boardPosition?: { x: number; y: number },
    occurredAt?: number | string,
  ) => {
    if (token === 'END') {
      commit(endVisit);
      setLastSignal(`${source}: darts cleared`);
      return;
    }
    const parsedHit = parseScore(token);
    if (!parsedHit) return;
    const hit = {
      ...parsedHit,
      inputSource: source.toLowerCase() === 'board' ? 'board' as const : 'manual' as const,
      thrownAt: throwTimestamp(occurredAt),
      ...(cameraPosition
        && Number.isFinite(cameraPosition.x)
        && Number.isFinite(cameraPosition.y) ? { cameraPosition } : {}),
      ...(boardPosition
        && Number.isFinite(boardPosition.x)
        && Number.isFinite(boardPosition.y) ? { boardPosition } : {}),
    };
    commit((current) => applyHit(current, hit));
    setLastSignal(`${source}: ${hit.label}`);
  }, [commit]);

  useEffect(() => {
    if (!boardHost) return;
    let websocket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    const resolvedHost = boardHost;

    if (window.location.protocol === 'https:') {
      setSecureScoringBlocked(true);
      setSocketStatus('blocked');
      setLastSignal('Open the LAN console for live scoring');
      return;
    }

    setSecureScoringBlocked(false);

    const connect = () => {
      if (!active) return;
      setSocketStatus('connecting');
      try {
        websocket = new WebSocket(`ws://${resolvedHost}:13520/scores`);
      } catch {
        setSocketStatus('offline');
        setLastSignal('Could not open the board connection');
        retryTimer = setTimeout(connect, 2000);
        return;
      }

      websocket.onopen = () => {
        if (!active) return;
        setSocketStatus('connected');
        setLastSignal('Board connected');
      };
      websocket.onmessage = (event) => {
        if (!active) return;
        try {
          const payload = JSON.parse(event.data) as {
            score?: string;
            timestamp?: number | string;
            position?: { x: number; y: number };
            boardPosition?: { x: number; y: number };
            board_position?: { x: number; y: number };
            normalizedPosition?: { x: number; y: number };
          };
          if (!payload.score) return;
          const now = Date.now();
          const key = `${payload.timestamp ?? ''}:${payload.score}`;
          if (key === lastMessageRef.current.key && now - lastMessageRef.current.receivedAt < 500) {
            return;
          }
          lastMessageRef.current = { key, receivedAt: now };
          const normalizedPosition = payload.boardPosition
            || payload.board_position
            || payload.normalizedPosition;
          scoreToken(payload.score.toUpperCase(), 'Board', payload.position, normalizedPosition, payload.timestamp);
        } catch {
          setLastSignal('Ignored an unreadable board message');
        }
      };
      websocket.onerror = () => websocket?.close();
      websocket.onclose = () => {
        if (!active) return;
        setSocketStatus('offline');
        retryTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      websocket?.close();
    };
  }, [boardHost, scoreToken]);

  const startMatch = () => {
    const next = createMatch(setup);
    matchRef.current = next;
    setMatch(next);
    setHistory([]);
    setRestoredMatch(false);
    setManualOpen(false);
    setView('play');
  };

  const returnToSetup = () => {
    const current = matchRef.current;
    if (current?.status === 'active') {
      void persistMatch({ ...current, status: 'abandoned' }, true);
    }
    setMatch(null);
    matchRef.current = null;
    setHistory([]);
    setRestoredMatch(false);
    window.localStorage.removeItem(MATCH_SESSION_STORAGE_KEY);
    setManualOpen(false);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((items) => items.slice(0, -1));
    matchRef.current = previous;
    setMatch(previous);
    setLastSignal('Last board action undone');
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <CircleDot className="size-5" />
          </div>
          <div>
            <p className="brand-kicker">OpenDartboard</p>
            <p className="brand-title">Match Console</p>
          </div>
        </div>
        <nav className="app-nav" aria-label="Primary navigation">
          <button className={view === 'play' ? 'is-active' : ''} onClick={() => setView('play')} type="button">
            <CircleDot /> Play
          </button>
          <button className={view === 'stats' ? 'is-active' : ''} onClick={() => setView('stats')} type="button">
            <BarChart3 /> Stats
          </button>
          <button className={view === 'board' ? 'is-active' : ''} onClick={() => setView('board')} type="button">
            <Wrench /> Board
          </button>
        </nav>
        <div className="header-status">
          <div className={`history-status history-${historyStatus}`}>
            {historyStatus === 'saving' || historyStatus === 'checking' ? <LoaderCircle /> : historyStatus === 'offline' ? <Database /> : <Check />}
            <span>{historyStatus === 'saving' ? 'Saving' : historyStatus === 'checking' ? 'History' : historyStatus === 'offline' ? 'History offline' : 'History saved'}</span>
          </div>
          <span className="last-signal">{lastSignal}</span>
          <Badge className={`status-pill status-${socketStatus}`} variant="outline">
            {socketStatus === 'offline' || socketStatus === 'blocked' ? <WifiOff className="size-3.5" /> : <Radio className="size-3.5" />}
            {socketStatus === 'connected' ? 'Live' : socketStatus === 'connecting' ? 'Connecting' : socketStatus === 'blocked' ? 'Use LAN app' : 'Board offline'}
          </Badge>
        </div>
      </header>

      {secureScoringBlocked && boardHost && (
        <aside className="secure-scoring-alert" role="alert">
          <WifiOff />
          <div>
            <strong>Live scoring needs the local console</strong>
            <span>This hosted HTTPS copy cannot open the Nano&apos;s local WebSocket.</span>
          </div>
          {isLocalBoardHost(boardHost) ? (
            <a href={`http://${boardHost}:8090/`}>Open {boardHost}:8090</a>
          ) : (
            <button onClick={() => setView('board')} type="button">Set board address</button>
          )}
        </aside>
      )}

      {view === 'board' ? (
        <BoardAdmin boardHost={boardHost} onBoardHost={updateBoardHost} />
      ) : view === 'stats' ? (
        <StatsDashboard onPlay={() => setView('play')} />
      ) : !match ? (
        <SetupScreen
          boardHost={boardHost}
          setup={setup}
          setSetup={setSetup}
          startMatch={startMatch}
        />
      ) : (
        <MatchScreen
          boardHost={boardHost}
          historyCount={history.length}
          manualMultiplier={manualMultiplier}
          manualOpen={manualOpen}
          match={match}
          restored={restoredMatch}
          onManualMultiplier={setManualMultiplier}
          onManualOpen={() => setManualOpen((open) => !open)}
          onNewMatch={returnToSetup}
          onScore={scoreToken}
          onUndo={undo}
        />
      )}
    </main>
  );
}

function SetupScreen({
  boardHost,
  setup,
  setSetup,
  startMatch,
}: {
  boardHost: string;
  setup: SetupState;
  setSetup: React.Dispatch<React.SetStateAction<SetupState>>;
  startMatch: () => void;
}) {
  const updatePlayer = (index: number, name: string) => {
    setSetup((current) => ({
      ...current,
      players: current.players.map((player, playerIndex) => playerIndex === index ? name : player),
    }));
  };

  return (
    <section className="app-grid setup-grid">
      <section className="control-panel">
        <div className="section-heading">
          <span className="section-icon"><Activity /></span>
          <div>
            <p className="eyebrow">New match</p>
            <h1>Set the oche.</h1>
          </div>
        </div>

        <div className="field-block">
          <p className="field-label">Game</p>
          <div className="mode-grid" role="group" aria-label="Game mode">
            {(['501', '301', 'cricket'] as GameMode[]).map((mode) => (
              <button
                className={`mode-button ${setup.mode === mode ? 'is-active' : ''}`}
                key={mode}
                onClick={() => setSetup((current) => ({ ...current, mode }))}
                type="button"
              >
                <strong>{mode === 'cricket' ? 'Cricket' : mode}</strong>
                <span>{modeDescriptions[mode]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field-block">
          <div className="field-label-row">
            <p className="field-label">Players</p>
            <span>{setup.players.length} of 4 local</span>
          </div>
          <div className="player-list">
            {setup.players.map((player, index) => (
              <div className="player-inputs" key={index}>
                <div className="player-number">{String(index + 1).padStart(2, '0')}</div>
                <Input
                  aria-label={`Player ${index + 1} name`}
                  onChange={(event) => updatePlayer(index, event.target.value)}
                  value={player}
                />
                <Button
                  aria-label={`Remove player ${index + 1}`}
                  disabled={setup.players.length === 1}
                  onClick={() => setSetup((current) => ({
                    ...current,
                    players: current.players.filter((_, playerIndex) => playerIndex !== index),
                  }))}
                  size="icon"
                  type="button"
                  variant="outline"
                >
                  <Minus />
                </Button>
              </div>
            ))}
          </div>
          {setup.players.length < 4 && (
            <Button
              className="add-player-button"
              onClick={() => setSetup((current) => ({
                ...current,
                players: [...current.players, `Player ${current.players.length + 1}`],
              }))}
              type="button"
              variant="ghost"
            >
              <Plus /> Add player
            </Button>
          )}
        </div>

        {setup.mode !== 'cricket' && (
          <div className="settings-row">
            <div>
              <label htmlFor="in-rule">Start</label>
              <NativeSelect
                id="in-rule"
                onChange={(event) => setSetup((current) => ({
                  ...current,
                  inRule: event.target.value as X01Rule,
                }))}
                value={setup.inRule}
              >
                <NativeSelectOption value="straight">Straight in</NativeSelectOption>
                <NativeSelectOption value="double">Double in</NativeSelectOption>
              </NativeSelect>
            </div>
            <div>
              <label htmlFor="out-rule">Finish</label>
              <NativeSelect
                id="out-rule"
                onChange={(event) => setSetup((current) => ({
                  ...current,
                  outRule: event.target.value as X01Rule,
                }))}
                value={setup.outRule}
              >
                <NativeSelectOption value="double">Double out</NativeSelectOption>
                <NativeSelectOption value="straight">Straight out</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        )}

        <Button className="start-button" onClick={startMatch} size="lg">
          <Users /> Start match
        </Button>
      </section>

      <section className="score-panel setup-preview" aria-label="Game preview">
        <div className="score-panel-top">
          <div>
            <p className="eyebrow">Local automatic scoring</p>
            <h2>Your board. Your game.</h2>
          </div>
          <div className="board-address">{boardHost}:13520</div>
        </div>
        <div className="preview-stage">
          <div className="preview-target" aria-hidden="true">
            <CircleDot />
          </div>
          <p className="preview-kicker">Ready at the oche</p>
          <h2>{setup.mode === 'cricket' ? 'Cricket' : setup.mode}</h2>
          <p>Choose your players, start the match, and throws will score here as OpenDartboard sees them.</p>
          <div className="preview-tags">
            <span>Live throws</span><span>Undo</span><span>Manual correction</span>
          </div>
        </div>
      </section>
    </section>
  );
}

function MatchScreen({
  boardHost,
  historyCount,
  manualMultiplier,
  manualOpen,
  match,
  restored,
  onManualMultiplier,
  onManualOpen,
  onNewMatch,
  onScore,
  onUndo,
}: {
  boardHost: string;
  historyCount: number;
  manualMultiplier: 'S' | 'D' | 'T';
  manualOpen: boolean;
  match: MatchState;
  restored: boolean;
  onManualMultiplier: (multiplier: 'S' | 'D' | 'T') => void;
  onManualOpen: () => void;
  onNewMatch: () => void;
  onScore: (token: string, source?: string, cameraPosition?: { x: number; y: number }) => void;
  onUndo: () => void;
}) {
  const player = match.players[match.activePlayer];
  const average = playerAverage(player, match.visitScore);
  const checkout = match.config.mode !== 'cricket' && player.opened
    ? checkoutSuggestion(player.score, 3 - match.darts.length, match.config.outRule)
    : null;

  return (
    <section className="app-grid match-grid">
      <aside className="match-rail">
        <div className="rail-heading">
          <div>
            <p className="eyebrow">Current game</p>
            <h1>{match.config.mode === 'cricket' ? 'Cricket' : match.config.mode}</h1>
          </div>
          <Badge variant="outline">Leg 1</Badge>
        </div>

        {restored && (
          <div className="match-restored" role="status">
            <RotateCcw />
            <div><strong>Match restored</strong><span>Your game was recovered after refresh.</span></div>
          </div>
        )}

        <div className="player-stack">
          {match.players.map((entry, index) => (
            <div className={`rail-player ${index === match.activePlayer ? 'is-active' : ''}`} key={entry.id}>
              <div className="rail-player-index">{String(index + 1).padStart(2, '0')}</div>
              <div className="rail-player-name">
                <strong>{entry.name}</strong>
                <span>{index === match.activePlayer ? 'At the oche' : `${entry.dartsThrown} darts`}</span>
              </div>
              <div className="rail-player-score">{entry.score}</div>
            </div>
          ))}
        </div>

        <div className="rail-actions">
          <Button disabled={!historyCount} onClick={onUndo} variant="outline">
            <Undo2 /> Undo
          </Button>
          <Button onClick={onManualOpen} variant={manualOpen ? 'secondary' : 'outline'}>
            {manualOpen ? <X /> : <Settings2 />}{manualOpen ? 'Close pad' : 'Correct score'}
          </Button>
          <Button onClick={onNewMatch} variant="ghost">
            <RotateCcw /> New match
          </Button>
        </div>

        <div className="connection-note">
          <Radio className="size-3.5" /> Scoring from {boardHost}:13520
        </div>
      </aside>

      <section className="score-panel live-score-panel" aria-label="Live scoreboard">
        <div className="score-panel-top">
          <div>
            <p className="eyebrow">{match.winner !== null ? 'Match complete' : 'Live leg'}</p>
            <h2>{match.message}</h2>
          </div>
          <div className="board-address">{boardHost}</div>
        </div>

        {match.config.mode === 'cricket' ? (
          <CricketBoard match={match} />
        ) : (
          <X01Board average={average} checkout={checkout} match={match} />
        )}

        <VisitStrip match={match} />

        {match.winner !== null && (
          <div className="winner-banner">
            <span><Trophy /></span>
            <div><p>Winner</p><strong>{match.players[match.winner].name}</strong></div>
            <Button onClick={onNewMatch}>Play again</Button>
          </div>
        )}

        {manualOpen && match.winner === null && (
          <ManualPad
            multiplier={manualMultiplier}
            onMultiplier={onManualMultiplier}
            onScore={onScore}
          />
        )}
      </section>
    </section>
  );
}

function X01Board({
  average,
  checkout,
  match,
}: {
  average: number | null;
  checkout: string | null;
  match: MatchState;
}) {
  const player = match.players[match.activePlayer];
  return (
    <div className="x01-live-stage">
      <MatchDartboard match={match} />
      <div className="x01-score-stack">
        <div className={`active-player-card ${match.bust ? 'is-bust' : ''}`}>
          <div className="player-meta">
            <span className="turn-marker">{match.bust ? 'BUST' : match.winner !== null ? 'WINNER' : 'THROWING'}</span>
            <p>{player.name}</p>
            <small>{match.awaitingClear ? 'Remove darts to continue' : `${Math.max(0, 3 - match.darts.length)} darts remaining`}</small>
          </div>
          <div className="hero-score">{player.score}</div>
        </div>
        <div className="score-footer">
          <div><span>3-dart avg</span><strong>{average === null ? '—' : average.toFixed(1)}</strong></div>
          <div><span>Last visit</span><strong>{player.lastVisit ?? '—'}</strong></div>
          <div><span>Checkout</span><strong>{checkout ?? '—'}</strong></div>
        </div>
      </div>
    </div>
  );
}

function CricketBoard({ match }: { match: MatchState }) {
  return (
    <div className="cricket-live-stage">
      <MatchDartboard match={match} />
      <div className={`cricket-board cricket-players-${match.players.length}`}>
        <div className="cricket-row cricket-header-row">
          <span>Target</span>
          {match.players.map((player) => <strong key={player.id}>{player.name}</strong>)}
        </div>
        {CRICKET_TARGETS.map((target) => (
          <div className="cricket-row" key={target}>
            <span>{target === 25 ? 'Bull' : target}</span>
            {match.players.map((player, index) => (
              <strong className={index === match.activePlayer ? 'is-current' : ''} key={player.id}>
                {markGlyph(player.marks[target])}
              </strong>
            ))}
          </div>
        ))}
        <div className="cricket-row cricket-points-row">
          <span>Points</span>
          {match.players.map((player, index) => (
            <strong className={index === match.activePlayer ? 'is-current' : ''} key={player.id}>{player.score}</strong>
          ))}
        </div>
      </div>
    </div>
  );
}

function VisitStrip({ match }: { match: MatchState }) {
  return (
    <div className="visit-grid" aria-label="Current visit">
      {[0, 1, 2].map((dart) => (
        <div className="dart-slot" key={dart}>
          <span>Dart {dart + 1}</span>
          <strong>{match.darts[dart]?.label ?? '—'}</strong>
        </div>
      ))}
      <div className="visit-total">
        <span>{match.config.mode === 'cricket' ? 'Points' : 'Visit'}</span>
        <strong>{match.visitScore}</strong>
      </div>
    </div>
  );
}

function ManualPad({
  multiplier,
  onMultiplier,
  onScore,
}: {
  multiplier: 'S' | 'D' | 'T';
  onMultiplier: (multiplier: 'S' | 'D' | 'T') => void;
  onScore: (token: string, source?: string, cameraPosition?: { x: number; y: number }) => void;
}) {
  return (
    <div className="manual-pad">
      <div className="manual-pad-heading">
        <div>
          <p className="eyebrow">Manual correction</p>
          <h3>Enter the throw the board should have seen.</h3>
        </div>
        <div className="multiplier-toggle" role="group" aria-label="Multiplier">
          {(['S', 'D', 'T'] as const).map((entry) => (
            <button
              className={multiplier === entry ? 'is-active' : ''}
              key={entry}
              onClick={() => onMultiplier(entry)}
              type="button"
            >
              {entry === 'S' ? 'Single' : entry === 'D' ? 'Double' : 'Treble'}
            </button>
          ))}
        </div>
      </div>
      <div className="manual-numbers">
        {Array.from({ length: 20 }, (_, index) => index + 1).map((number) => (
          <button key={number} onClick={() => onScore(`${multiplier}${number}`, 'Manual')} type="button">
            {number}
          </button>
        ))}
      </div>
      <div className="manual-specials">
        <button onClick={() => onScore('OUTER', 'Manual')} type="button"><Crosshair /> Outer 25</button>
        <button onClick={() => onScore('BULL', 'Manual')} type="button"><CircleDot /> Bull 50</button>
        <button onClick={() => onScore('MISS', 'Manual')} type="button"><X /> Miss</button>
        <button className="end-visit-button" onClick={() => onScore('END', 'Manual')} type="button">End visit</button>
      </div>
    </div>
  );
}
