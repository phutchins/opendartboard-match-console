'use client';

import { useMemo, useState } from 'react';

import { DartHeatmap } from '@/components/dart-heatmap';
import { VisualDartboard } from '@/components/visual-dartboard';
import type { MatchState } from '@/lib/game-engine';
import { heatmapForPlayer } from '@/lib/heatmap';

export function MatchDartboard({ match }: { match: MatchState }) {
  const [view, setView] = useState<'live' | 'heatmap'>('live');
  const [playerIndex, setPlayerIndex] = useState(match.activePlayer);
  const data = useMemo(() => heatmapForPlayer(match, playerIndex), [match, playerIndex]);

  const showHeatmap = () => {
    setPlayerIndex(match.activePlayer);
    setView('heatmap');
  };

  return (
    <section className="visual-board-shell match-board-shell" aria-label="Match dartboard views">
      <div className="visual-board-heading match-board-heading">
        <div>
          <p className="eyebrow">Board view</p>
          <h3>{view === 'live' ? 'Darts in play' : `${match.players[playerIndex].name}'s game heat`}</h3>
        </div>
        <span>{view === 'live' ? `${match.darts.length}/3` : data.totals.darts}</span>
      </div>
      <div className="board-view-controls">
        <div className="board-view-toggle" role="group" aria-label="Board visualization">
          <button aria-pressed={view === 'live'} className={view === 'live' ? 'is-active' : ''} onClick={() => setView('live')} type="button">Live visit</button>
          <button aria-pressed={view === 'heatmap'} className={view === 'heatmap' ? 'is-active' : ''} onClick={showHeatmap} type="button">Game heatmap</button>
        </div>
        {view === 'heatmap' && (
          <label className="heatmap-player-select">
            <span>Player</span>
            <select onChange={(event) => setPlayerIndex(Number(event.target.value))} value={playerIndex}>
              {match.players.map((player, index) => <option key={player.id} value={index}>{player.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {view === 'live'
        ? <VisualDartboard darts={match.darts} embedded />
        : <DartHeatmap compact data={data} />}
    </section>
  );
}
