'use client';

import {
  BarChart3,
  CalendarDays,
  CircleDot,
  Crown,
  Database,
  Flame,
  Gauge,
  History,
  RefreshCw,
  Sparkles,
  Target,
  Trophy,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DartHeatmap } from '@/components/dart-heatmap';
import { Skeleton } from '@/components/ui/skeleton';
import type { HeatmapData } from '@/lib/heatmap';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type PlayerStats = {
  id: number;
  name: string;
  games: number;
  wins: number;
  winRate: number;
  x01Average: number | null;
  bestX01Average: number | null;
  highestVisit: number | null;
  cricketMpr: number | null;
  darts: number;
  lastPlayed: string | null;
};

type HistoricalMatch = {
  id: string;
  mode: '301' | '501' | 'cricket';
  inRule: 'straight' | 'double';
  outRule: 'straight' | 'double';
  startedAt: string;
  completedAt: string;
  players: Array<{
    name: string;
    finalScore: number;
    darts: number;
    visits: number;
    highestVisit: number;
    outcome: 'win' | 'loss';
    rate: number | null;
  }>;
};

type StatsData = {
  overview: { games: number; players: number; darts: number; visits: number };
  players: PlayerStats[];
  matches: HistoricalMatch[];
  generatedAt: string;
};

type HeatmapPeriod = '7d' | '30d' | '90d' | '1y' | 'all';
type HistoricalHeatmap = HeatmapData & {
  schemaVersion: number;
  period: HeatmapPeriod;
  rangeStart: string | null;
  player: { id: number; name: string };
  generatedAt: string;
};

const periods: Array<{ value: HeatmapPeriod; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];

const formatDate = (value: string | null) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
};

const formatRate = (value: number | null) => value === null ? '—' : value.toFixed(1);

export function StatsDashboard({ onPlay }: { onPlay: () => void }) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [period, setPeriod] = useState<HeatmapPeriod>('30d');
  const [heatmap, setHeatmap] = useState<HistoricalHeatmap | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [heatmapRefresh, setHeatmapRefresh] = useState(0);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error('Stats service did not respond');
      const next = await response.json() as StatsData;
      setData(next);
      setSelectedPlayerId((current) => (
        current !== null && next.players.some((player) => player.id === current)
          ? current
          : next.players[0]?.id ?? null
      ));
      setHeatmapRefresh((value) => value + 1);
    } catch {
      setError('The local history service is offline. Your current match still works.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    if (selectedPlayerId === null) {
      setHeatmap(null);
      return;
    }
    const controller = new AbortController();
    setHeatmapLoading(true);
    setHeatmapError(null);
    fetch(`/api/heatmap?playerId=${selectedPlayerId}&period=${period}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Heat map service did not respond');
        return response.json() as Promise<HistoricalHeatmap>;
      })
      .then(setHeatmap)
      .catch((requestError: unknown) => {
        if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) {
          setHeatmapError('Could not load this player’s throw map.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setHeatmapLoading(false);
      });
    return () => controller.abort();
  }, [heatmapRefresh, period, selectedPlayerId]);

  const insights = useMemo(() => {
    if (!data?.players.length) return [];
    const byWins = [...data.players].sort((a, b) => b.wins - a.wins)[0];
    const byAverage = [...data.players]
      .filter((player) => player.x01Average !== null)
      .sort((a, b) => (b.x01Average ?? 0) - (a.x01Average ?? 0))[0];
    const byVisit = [...data.players]
      .filter((player) => player.highestVisit !== null)
      .sort((a, b) => (b.highestVisit ?? 0) - (a.highestVisit ?? 0))[0];
    return [
      byWins && { icon: Crown, label: 'Table leader', name: byWins.name, value: `${byWins.wins} wins` },
      byAverage && { icon: Gauge, label: 'Scoring leader', name: byAverage.name, value: `${formatRate(byAverage.x01Average)} avg` },
      byVisit && { icon: Target, label: 'Biggest visit', name: byVisit.name, value: String(byVisit.highestVisit) },
    ].filter(Boolean) as Array<{ icon: typeof Crown; label: string; name: string; value: string }>;
  }, [data]);

  return (
    <section className="stats-page">
      <div className="stats-hero">
        <div>
          <p className="eyebrow">Lifetime performance</p>
          <h1>Your darts, remembered.</h1>
          <p>Every completed game rolls into player averages, records, and a permanent match history on this board.</p>
        </div>
        <div className="stats-hero-actions">
          <Button onClick={() => void loadStats()} variant="outline"><RefreshCw /> Refresh</Button>
          <Button onClick={onPlay}><CircleDot /> Play a match</Button>
        </div>
      </div>

      {error && (
        <div className="stats-error"><Database /><span>{error}</span></div>
      )}

      <div className="stat-kpi-grid">
        <KpiCard icon={Trophy} label="Completed games" loading={loading} value={data?.overview.games ?? 0} />
        <KpiCard icon={Users} label="Player profiles" loading={loading} value={data?.overview.players ?? 0} />
        <KpiCard icon={Target} label="Darts tracked" loading={loading} value={data?.overview.darts ?? 0} />
        <KpiCard icon={BarChart3} label="Visits recorded" loading={loading} value={data?.overview.visits ?? 0} />
      </div>

      {!loading && data?.overview.games === 0 ? (
        <div className="stats-empty">
          <div className="stats-empty-icon"><Sparkles /></div>
          <p className="eyebrow">The record book is open</p>
          <h2>Finish your first match.</h2>
          <p>Player profiles and lifetime averages will appear here automatically when someone checks out or wins Cricket.</p>
          <Button onClick={onPlay}><CircleDot /> Start the first game</Button>
        </div>
      ) : (
        <>
          {!!insights.length && (
            <section className="insight-grid" aria-label="Performance highlights">
              {insights.map((insight) => (
                <article className="insight-card" key={insight.label}>
                  <span><insight.icon /></span>
                  <div><p>{insight.label}</p><strong>{insight.name}</strong></div>
                  <em>{insight.value}</em>
                </article>
              ))}
            </section>
          )}

          <section className="stats-panel stats-heatmap-panel">
            <div className="stats-panel-heading heatmap-panel-heading">
              <div className="heatmap-title-lockup">
                <span><Flame /></span>
                <div><p className="eyebrow">Throw tendencies</p><h2>Player heat map</h2></div>
              </div>
              <div className="historical-heatmap-controls">
                <label>
                  <span>Player</span>
                  <select
                    aria-label="Heat map player"
                    onChange={(event) => setSelectedPlayerId(Number(event.target.value))}
                    value={selectedPlayerId ?? ''}
                  >
                    {data?.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
                  </select>
                </label>
                <div className="period-toggle" role="group" aria-label="Heat map period">
                  {periods.map((option) => (
                    <button
                      aria-pressed={period === option.value}
                      className={period === option.value ? 'is-active' : ''}
                      key={option.value}
                      onClick={() => setPeriod(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="stats-heatmap-body">
              {heatmapLoading ? (
                <div className="heatmap-loading"><Skeleton className="aspect-square w-full max-w-md rounded-full" /><Skeleton className="h-28 w-full" /></div>
              ) : heatmapError ? (
                <div className="heatmap-error"><Database /><span>{heatmapError}</span></div>
              ) : heatmap ? (
                <DartHeatmap data={heatmap} />
              ) : null}
            </div>
          </section>

          <div className="stats-content-grid">
            <section className="stats-panel player-records-panel">
              <div className="stats-panel-heading">
                <div><p className="eyebrow">Career board</p><h2>Player records</h2></div>
                <Badge variant="outline">All time</Badge>
              </div>
              {loading ? <StatsTableSkeleton /> : (
                <Table className="player-stats-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Player</TableHead>
                      <TableHead>W–G</TableHead>
                      <TableHead>Win %</TableHead>
                      <TableHead>3-dart avg</TableHead>
                      <TableHead>Best avg</TableHead>
                      <TableHead>High visit</TableHead>
                      <TableHead>Cricket MPR</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.players.map((player, index) => (
                      <TableRow key={player.id}>
                        <TableCell>
                          <div className="ranked-player"><span>{index + 1}</span><strong>{player.name}</strong></div>
                        </TableCell>
                        <TableCell>{player.wins}–{player.games}</TableCell>
                        <TableCell>{player.winRate.toFixed(0)}%</TableCell>
                        <TableCell className="metric-cell">{formatRate(player.x01Average)}</TableCell>
                        <TableCell>{formatRate(player.bestX01Average)}</TableCell>
                        <TableCell>{player.highestVisit ?? '—'}</TableCell>
                        <TableCell>{player.cricketMpr === null ? '—' : player.cricketMpr.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="stats-panel recent-matches-panel">
              <div className="stats-panel-heading">
                <div><p className="eyebrow">Scorebook</p><h2>Recent matches</h2></div>
                <History />
              </div>
              {loading ? (
                <div className="match-history-list"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
              ) : (
                <div className="match-history-list">
                  {data?.matches.map((match) => {
                    const winner = match.players.find((player) => player.outcome === 'win');
                    return (
                      <article className="history-match" key={match.id}>
                        <div className="history-match-top">
                          <Badge>{match.mode === 'cricket' ? 'Cricket' : match.mode}</Badge>
                          <span><CalendarDays /> {formatDate(match.completedAt)}</span>
                        </div>
                        <div className="history-winner"><Trophy /><strong>{winner?.name ?? 'Completed match'}</strong><span>won</span></div>
                        <div className="history-player-list">
                          {match.players.map((player) => (
                            <div key={player.name}>
                              <span>{player.name}</span>
                              <strong>{match.mode === 'cricket' ? `${player.finalScore} pts` : `${formatRate(player.rate)} avg`}</strong>
                            </div>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function KpiCard({
  icon: Icon,
  label,
  loading,
  value,
}: {
  icon: typeof Trophy;
  label: string;
  loading: boolean;
  value: number;
}) {
  return (
    <article className="stat-kpi-card">
      <span><Icon /></span>
      <div><p>{label}</p>{loading ? <Skeleton className="mt-2 h-8 w-20" /> : <strong>{value.toLocaleString()}</strong>}</div>
    </article>
  );
}

function StatsTableSkeleton() {
  return (
    <div className="stats-table-skeleton">
      {[0, 1, 2].map((row) => <Skeleton className="h-14" key={row} />)}
    </div>
  );
}
