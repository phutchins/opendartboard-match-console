'use client';

import {
  BarChart3,
  Bug,
  Check,
  CircleDot,
  Crosshair,
  Database,
  LoaderCircle,
  Radio,
  RotateCcw,
  Settings2,
  Trophy,
  Undo2,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { BoardAdmin } from '@/components/board-admin';
import { Button } from '@/components/ui/button';
import { GameDetails, GameLobby } from '@/components/game-lobby';
import { MatchDartboard } from '@/components/match-dartboard';
import { StatsDashboard } from '@/components/stats-dashboard';
import { BOARD_OPERATION_EVENT, type BoardOperation } from '@/lib/board-operation';
import {
  applyBoardScoreEvent,
  compareBoardEvents,
  parseDiagnosticBoardEvent,
  parseLiveBoardEvent,
  type BoardScoreEvent,
} from '@/lib/board-events';
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
  parseMatchSnapshot,
  parseMatchSession,
} from '@/lib/match-session';
import {
  parsePlayerSelection,
  PLAYER_SELECTION_STORAGE_KEY,
  PlayerProfile,
  reconcilePlayerSelection,
} from '@/lib/player-profiles';

type SetupState = {
  mode: GameMode;
  inRule: X01Rule;
  outRule: X01Rule;
};

type SocketStatus = 'connecting' | 'connected' | 'offline' | 'blocked';
type HistoryStatus = 'checking' | 'saving' | 'saved' | 'offline';
type AppView = 'play' | 'stats' | 'board';
type BoardDetection = {
  eventId: string;
  detectedScore: string;
};

const initialSetup: SetupState = {
  mode: '501',
  inRule: 'straight',
  outRule: 'double',
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

const manualBoardCursor = () => {
  const timestamp = Date.now();
  return { eventId: `manual-${timestamp}`, timestamp };
};

const isLocalBoardHost = (host: string) => (
  host === 'localhost'
  || host === '127.0.0.1'
  || host.endsWith('.local')
  || host.startsWith('10.')
  || host.startsWith('192.168.')
  || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
);

export default function Home() {
  const [setup, setSetup] = useState<SetupState>(initialSetup);
  const [playStep, setPlayStep] = useState<'lobby' | 'details'>('lobby');
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchState | null>(null);
  const [view, setView] = useState<AppView>('play');
  const [history, setHistory] = useState<MatchState[]>([]);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');
  const [boardHost, setBoardHost] = useState('');
  const [lastSignal, setLastSignal] = useState('Waiting for board');
  const [manualOpen, setManualOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [lastBoardDetection, setLastBoardDetection] = useState<BoardDetection | null>(null);
  const [reportStatus, setReportStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [manualMultiplier, setManualMultiplier] = useState<'S' | 'D' | 'T'>('S');
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('checking');
  const [sessionReady, setSessionReady] = useState(false);
  const [restoredMatch, setRestoredMatch] = useState(false);
  const [secureScoringBlocked, setSecureScoringBlocked] = useState(false);
  const [boardOperation, setBoardOperation] = useState<BoardOperation | null>(null);
  const matchRef = useRef<MatchState | null>(null);
  const boardOperationRef = useRef<BoardOperation | null>(null);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  useEffect(() => {
    const onBoardOperation = (event: Event) => {
      const detail = (event as CustomEvent<BoardOperation>).detail;
      const operation = detail?.active ? detail : null;
      boardOperationRef.current = operation;
      setBoardOperation(operation);
    };
    window.addEventListener(BOARD_OPERATION_EVENT, onBoardOperation);
    return () => window.removeEventListener(BOARD_OPERATION_EVENT, onBoardOperation);
  }, []);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const local = parseMatchSession(window.localStorage.getItem(MATCH_SESSION_STORAGE_KEY));
      let restoredMatchState = local?.match || null;
      let restoredHistory = local?.history || [];
      let source = local ? 'this browser' : '';
      try {
        const response = await fetch('/api/matches/active', { cache: 'no-store' });
        const payload = await response.json() as { match?: unknown };
        const shared = response.ok ? parseMatchSnapshot(payload.match) : null;
        if (shared) {
          restoredMatchState = shared;
          restoredHistory = [];
          source = 'the board';
        }
      } catch {
        // The browser snapshot remains an offline fallback.
      }
      if (!active) return;
      if (restoredMatchState) {
        matchRef.current = restoredMatchState;
        setMatch(restoredMatchState);
        setHistory(restoredHistory);
        setSetup({
          mode: restoredMatchState.config.mode,
          inRule: restoredMatchState.config.inRule,
          outRule: restoredMatchState.config.outRule,
        });
        setView('play');
        setRestoredMatch(true);
        setLastSignal(`Match restored from ${source}`);
      }
      setSessionReady(true);
    };
    void restore();
    return () => { active = false; };
  }, []);

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      const response = await fetch('/api/players', { cache: 'no-store' });
      const payload = await response.json() as { players?: PlayerProfile[]; error?: string };
      if (!response.ok || !Array.isArray(payload.players)) {
        throw new Error(payload.error || 'Player profiles are unavailable');
      }
      setProfiles(payload.players);
      const savedIds = parsePlayerSelection(window.localStorage.getItem(PLAYER_SELECTION_STORAGE_KEY));
      setSelectedPlayerIds(reconcilePlayerSelection(savedIds, payload.players));
      setProfileError(null);
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : 'Could not load player profiles');
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (profilesLoading) return;
    window.localStorage.setItem(PLAYER_SELECTION_STORAGE_KEY, JSON.stringify(selectedPlayerIds));
  }, [profilesLoading, selectedPlayerIds]);

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
      const payload = await response.json() as {
        accepted?: boolean;
        match?: unknown;
        revision?: number;
      };
      if (payload.accepted === false) {
        const shared = parseMatchSnapshot(payload.match);
        const current = matchRef.current;
        if (shared && current?.id === shared.id
          && (shared.syncRevision || 0) >= (current.syncRevision || 0)) {
          matchRef.current = shared;
          setMatch(shared);
          setHistory([]);
          setLastSignal('Game synchronized with the board');
        }
      }
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

  useEffect(() => {
    if (!sessionReady) return;
    let active = true;
    const refreshSharedMatch = async () => {
      try {
        const response = await fetch('/api/matches/active', { cache: 'no-store' });
        if (!response.ok || !active) return;
        const payload = await response.json() as { match?: unknown };
        const shared = parseMatchSnapshot(payload.match);
        const current = matchRef.current;
        if (!shared) return;
        if (!current) {
          matchRef.current = shared;
          setMatch(shared);
          setHistory([]);
          setView('play');
          setRestoredMatch(true);
          setLastSignal('Active game opened from the board');
          return;
        }
        const sharedRevision = shared.syncRevision || 0;
        const currentRevision = current.syncRevision || 0;
        const sharedIsNewerMatch = shared.id !== current.id
          && Date.parse(shared.startedAt) > Date.parse(current.startedAt);
        if ((shared.id === current.id && sharedRevision > currentRevision) || sharedIsNewerMatch) {
          matchRef.current = shared;
          setMatch(shared);
          setHistory([]);
          setSetup({
            mode: shared.config.mode,
            inRule: shared.config.inRule,
            outRule: shared.config.outRule,
          });
          setView('play');
          setRestoredMatch(true);
          setLastSignal('Game updated from another screen');
        }
      } catch {
        // Keep playing from the local copy until the shared service returns.
      }
    };
    const timer = window.setInterval(() => { void refreshSharedMatch(); }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionReady]);

  const commit = useCallback((transform: (current: MatchState) => MatchState) => {
    const current = matchRef.current;
    if (!current) return;
    const transformed = transform(current);
    const next = transformed === current ? current : {
      ...transformed,
      syncRevision: (current.syncRevision || 0) + 1,
    };
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
    boardEventId?: string,
  ) => {
    if (token === 'END') {
      commit((current) => ({
        ...endVisit(current),
        ...(source.toLowerCase() === 'board'
          ? {}
          : { boardEventCursor: manualBoardCursor() }),
      }));
      setLastSignal(`${source}: darts cleared`);
      return;
    }
    const parsedHit = parseScore(token);
    if (!parsedHit) return;
    const hit = {
      ...parsedHit,
      inputSource: source.toLowerCase() === 'board' ? 'board' as const : 'manual' as const,
      ...(boardEventId ? { boardEventId } : {}),
      thrownAt: throwTimestamp(occurredAt),
      ...(cameraPosition
        && Number.isFinite(cameraPosition.x)
        && Number.isFinite(cameraPosition.y) ? { cameraPosition } : {}),
      ...(boardPosition
        && Number.isFinite(boardPosition.x)
        && Number.isFinite(boardPosition.y) ? { boardPosition } : {}),
    };
    commit((current) => ({
      ...applyHit(current, hit),
      ...(source.toLowerCase() === 'board'
        ? {}
        : { boardEventCursor: manualBoardCursor() }),
    }));
    setLastSignal(`${source}: ${hit.label}`);
  }, [commit]);

  const applyBoardEvent = useCallback((event: BoardScoreEvent) => {
    let applied = false;
    commit((current) => {
      const next = applyBoardScoreEvent(current, event);
      applied = next !== current;
      return next;
    });
    if (!applied) return false;
    if (event.score !== 'END') {
      setLastBoardDetection({ eventId: event.eventId, detectedScore: event.score });
      setReportStatus('idle');
      setReportOpen(false);
    }
    setLastSignal(event.score === 'END' ? 'Board: darts cleared' : `Board: ${event.score}`);
    return true;
  }, [commit]);

  const activeMatchId = match?.id;

  useEffect(() => {
    if (!boardHost) return;
    let websocket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    let recovering = false;
    let pendingEvents: BoardScoreEvent[] = [];
    let active = true;

    const resolvedHost = boardHost;

    if (window.location.protocol === 'https:') {
      setSecureScoringBlocked(true);
      setSocketStatus('blocked');
      setLastSignal('Open the LAN console for live scoring');
      return;
    }

    setSecureScoringBlocked(false);

    const recoverMissedEvents = async () => {
      if (!active || recovering) return;
      recovering = true;
      let recordedEvents: BoardScoreEvent[] = [];
      try {
        const response = await fetch(`http://${resolvedHost}:13520/debug/events?limit=250&summary=1`, {
          cache: 'no-store',
        });
        if (response.ok) {
          const payload = await response.json() as unknown;
          if (Array.isArray(payload)) {
            recordedEvents = payload
              .map(parseDiagnosticBoardEvent)
              .filter((item): item is BoardScoreEvent => Boolean(item));
          }
        }
      } catch {
        // Live delivery continues even if historical diagnostics are temporarily unavailable.
      }

      const merged = new Map<string, BoardScoreEvent>();
      // Prefer the persisted manifest because it includes scorer state metadata
      // that older live WebSocket payloads do not carry.
      for (const event of [...pendingEvents, ...recordedEvents]) merged.set(event.eventId, event);
      pendingEvents = [];
      let applied = 0;
      for (const event of [...merged.values()].sort(compareBoardEvents)) {
        if (applyBoardEvent(event)) applied += 1;
      }
      recovering = false;

      if (pendingEvents.length) {
        const queued = pendingEvents.sort(compareBoardEvents);
        pendingEvents = [];
        for (const event of queued) {
          if (applyBoardEvent(event)) applied += 1;
        }
      }
      if (applied > 0 && !boardOperationRef.current) {
        setLastSignal(`Caught up ${applied} missed board event${applied === 1 ? '' : 's'}`);
      } else if (!boardOperationRef.current) {
        setLastSignal('Board connected');
      }
    };

    const connect = () => {
      if (!active) return;
      if (!offlineTimer) setSocketStatus('connecting');
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
        if (offlineTimer) {
          clearTimeout(offlineTimer);
          offlineTimer = null;
        }
        setSocketStatus('connected');
        if (!boardOperationRef.current) setLastSignal('Board connected · checking for missed darts');
        void recoverMissedEvents();
      };
      websocket.onmessage = (event) => {
        if (!active) return;
        try {
          const parsed = parseLiveBoardEvent(JSON.parse(event.data));
          if (!parsed) return;
          if (recovering) pendingEvents.push(parsed);
          else if (!applyBoardEvent(parsed) && matchRef.current?.awaitingClear) {
            // A scorer restart can reset its board state to CLEAN without emitting
            // END. Enrich the first new dart from its persisted manifest and use
            // CLEAN -> DART_1 to close the previous visit safely.
            pendingEvents.push(parsed);
            void recoverMissedEvents();
          }
        } catch {
          setLastSignal('Ignored an unreadable board message');
        }
      };
      websocket.onerror = () => websocket?.close();
      websocket.onclose = () => {
        if (!active) return;
        if (!offlineTimer) {
          setSocketStatus('connecting');
          if (!boardOperationRef.current) setLastSignal('Reconnecting to board…');
          offlineTimer = setTimeout(() => {
            if (!active || websocket?.readyState === WebSocket.OPEN) return;
            setSocketStatus('offline');
            if (!boardOperationRef.current) setLastSignal('Board connection unavailable');
          }, 12_000);
        }
        retryTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (offlineTimer) clearTimeout(offlineTimer);
      websocket?.close();
    };
  }, [activeMatchId, applyBoardEvent, boardHost]);

  const reportDetection = useCallback(async (actualScore: string) => {
    if (!lastBoardDetection || !boardHost) return;
    const parsedHit = parseScore(actualScore);
    if (!parsedHit) return;

    const current = matchRef.current;
    const previous = history.at(-1);
    const latest = current?.darts.at(-1);
    const canCorrectLatest = Boolean(
      current
      && previous
      && latest?.boardEventId === lastBoardDetection.eventId
      && latest.label !== parsedHit.label,
    );

    if (canCorrectLatest && current && previous && latest) {
      const correctedHit = {
        ...parsedHit,
        inputSource: 'manual' as const,
        boardEventId: lastBoardDetection.eventId,
        thrownAt: latest.thrownAt || new Date().toISOString(),
      };
      const corrected = {
        ...applyHit(previous, correctedHit),
        boardEventCursor: current.boardEventCursor,
        syncRevision: (current.syncRevision || 0) + 1,
      };
      matchRef.current = corrected;
      setMatch(corrected);
    }

    setReportStatus('saving');
    try {
      const response = await fetch(`http://${boardHost}:13520/debug/events/${encodeURIComponent(lastBoardDetection.eventId)}/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actual_score: parsedHit.label,
          note: `Reported from match console; detector returned ${lastBoardDetection.detectedScore}`,
        }),
      });
      if (!response.ok) throw new Error('Label save failed');
      setReportStatus('saved');
      setLastSignal(canCorrectLatest
        ? `Corrected to ${parsedHit.label}; diagnostic saved`
        : `Diagnostic labeled ${parsedHit.label}`);
      setReportOpen(false);
    } catch {
      setReportStatus('failed');
      setLastSignal(canCorrectLatest
        ? `Corrected to ${parsedHit.label}; diagnostic label failed`
        : 'Could not label the diagnostic capture');
    }
  }, [boardHost, history, lastBoardDetection]);

  const selectedPlayers = selectedPlayerIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is PlayerProfile => Boolean(profile));

  const togglePlayer = (id: string) => {
    setSelectedPlayerIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 4) return current;
      return [...current, id];
    });
  };

  const saveProfile = useCallback(async (profile: { id?: string; name: string; email: string }) => {
    setProfileError(null);
    const response = await fetch('/api/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    const payload = await response.json() as { player?: PlayerProfile; error?: string };
    if (!response.ok || !payload.player) {
      const message = payload.error || 'Could not save player';
      setProfileError(message);
      throw new Error(message);
    }
    setProfiles((current) => {
      const remaining = current.filter((item) => item.id !== payload.player!.id);
      return [payload.player!, ...remaining];
    });
    setSelectedPlayerIds((current) => (
      current.includes(payload.player!.id) || current.length >= 4
        ? current
        : [...current, payload.player!.id]
    ));
  }, []);

  const chooseGame = (mode: GameMode) => {
    setSetup((current) => ({ ...current, mode }));
    setPlayStep('details');
  };

  const startMatch = () => {
    if (!selectedPlayers.length) return;
    const next = createMatch({
      ...setup,
      players: selectedPlayers.map((player) => player.name),
      playerProfiles: selectedPlayers.map((player) => ({
        id: player.id,
        name: player.name,
        email: player.email,
      })),
    });
    matchRef.current = next;
    setMatch(next);
    setHistory([]);
    setRestoredMatch(false);
    setManualOpen(false);
    setReportOpen(false);
    setLastBoardDetection(null);
    setReportStatus('idle');
    setView('play');
  };

  const returnToLobby = () => {
    const current = matchRef.current;
    if (current?.status === 'active') {
      void persistMatch({
        ...current,
        status: 'abandoned',
        syncRevision: (current.syncRevision || 0) + 1,
      }, true);
    }
    setMatch(null);
    matchRef.current = null;
    setHistory([]);
    setRestoredMatch(false);
    window.localStorage.removeItem(MATCH_SESSION_STORAGE_KEY);
    setManualOpen(false);
    setReportOpen(false);
    setLastBoardDetection(null);
    setReportStatus('idle');
    setPlayStep('lobby');
    void loadProfiles();
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    const current = matchRef.current;
    const restored = {
      ...previous,
      boardEventCursor: manualBoardCursor(),
      syncRevision: (current?.syncRevision || 0) + 1,
    };
    setHistory((items) => items.slice(0, -1));
    matchRef.current = restored;
    setMatch(restored);
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
            <CircleDot /> {match?.status === 'active' && view !== 'play' ? 'Resume' : 'Play'}
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
          <span className="last-signal">{boardOperation?.message || lastSignal}</span>
          <Badge className={`status-pill status-${boardOperation ? 'operation' : socketStatus}`} variant="outline">
            {boardOperation ? <LoaderCircle className="size-3.5 is-spinning" /> : socketStatus === 'offline' || socketStatus === 'blocked' ? <WifiOff className="size-3.5" /> : <Radio className="size-3.5" />}
            {boardOperation?.title || (socketStatus === 'connected' ? 'Live' : socketStatus === 'connecting' ? 'Reconnecting' : socketStatus === 'blocked' ? 'Use LAN app' : 'Board offline')}
          </Badge>
        </div>
      </header>

      {boardOperation && (
        <aside className="board-operation-banner" role="status">
          <LoaderCircle className="is-spinning" />
          <div><strong>{boardOperation.title}</strong><span>{boardOperation.message}</span></div>
        </aside>
      )}

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
      ) : match ? (
        <MatchScreen
          boardHost={boardHost}
          historyCount={history.length}
          manualMultiplier={manualMultiplier}
          manualOpen={manualOpen}
          match={match}
          lastBoardDetection={lastBoardDetection}
          reportOpen={reportOpen}
          reportStatus={reportStatus}
          restored={restoredMatch}
          onManualMultiplier={setManualMultiplier}
          onManualOpen={() => {
            setReportOpen(false);
            setManualOpen((open) => !open);
          }}
          onNewMatch={returnToLobby}
          onScore={scoreToken}
          onReportOpen={() => {
            setManualOpen(false);
            setReportOpen((open) => !open);
          }}
          onReportScore={reportDetection}
          onUndo={undo}
        />
      ) : playStep === 'details' ? (
        <GameDetails
          boardHost={boardHost}
          onBack={() => setPlayStep('lobby')}
          onChange={(change) => setSetup((current) => ({ ...current, ...change }))}
          onStart={startMatch}
          selectedPlayers={selectedPlayers}
          setup={setup}
        />
      ) : (
        <GameLobby
          boardHost={boardHost}
          onChooseGame={chooseGame}
          onOpenBoard={() => setView('board')}
          onOpenStats={() => setView('stats')}
          onSaveProfile={saveProfile}
          onTogglePlayer={togglePlayer}
          profileError={profileError}
          profiles={profiles}
          profilesLoading={profilesLoading}
          selectedIds={selectedPlayerIds}
        />
      )}
    </main>
  );
}

function MatchScreen({
  boardHost,
  historyCount,
  manualMultiplier,
  manualOpen,
  match,
  lastBoardDetection,
  reportOpen,
  reportStatus,
  restored,
  onManualMultiplier,
  onManualOpen,
  onNewMatch,
  onScore,
  onReportOpen,
  onReportScore,
  onUndo,
}: {
  boardHost: string;
  historyCount: number;
  manualMultiplier: 'S' | 'D' | 'T';
  manualOpen: boolean;
  match: MatchState;
  lastBoardDetection: BoardDetection | null;
  reportOpen: boolean;
  reportStatus: 'idle' | 'saving' | 'saved' | 'failed';
  restored: boolean;
  onManualMultiplier: (multiplier: 'S' | 'D' | 'T') => void;
  onManualOpen: () => void;
  onNewMatch: () => void;
  onScore: (token: string, source?: string, cameraPosition?: { x: number; y: number }) => void;
  onReportOpen: () => void;
  onReportScore: (token: string) => void;
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
          <Button
            disabled={!lastBoardDetection || reportStatus === 'saving'}
            onClick={onReportOpen}
            variant={reportOpen ? 'secondary' : 'outline'}
          >
            <Bug /> {reportStatus === 'saving' ? 'Saving…' : reportOpen ? 'Close report' : 'Report detection'}
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
          <div className="score-panel-actions">
            <div className="board-address">{boardHost}</div>
            {match.awaitingClear && match.winner === null && (
              <Button onClick={() => onScore('END', 'Manual')} size="sm">
                <Check /> Darts removed
              </Button>
            )}
          </div>
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
            eyebrow="Manual correction"
            multiplier={manualMultiplier}
            onMultiplier={onManualMultiplier}
            onScore={onScore}
            title="Enter a throw the board did not send."
          />
        )}

        {reportOpen && lastBoardDetection && (
          <ManualPad
            eyebrow={`Detected ${lastBoardDetection.detectedScore}`}
            multiplier={manualMultiplier}
            onMultiplier={onManualMultiplier}
            onScore={onReportScore}
            title="What did this dart actually hit?"
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
  eyebrow,
  multiplier,
  onMultiplier,
  onScore,
  title,
}: {
  eyebrow: string;
  multiplier: 'S' | 'D' | 'T';
  onMultiplier: (multiplier: 'S' | 'D' | 'T') => void;
  onScore: (token: string, source?: string, cameraPosition?: { x: number; y: number }) => void;
  title: string;
}) {
  return (
    <div className="manual-pad">
      <div className="manual-pad-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
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
