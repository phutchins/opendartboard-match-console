import { parseScore, type MatchState, type ParsedHit } from './game-engine.ts';

export type HeatPoint = {
  label: string;
  x: number;
  y: number;
  thrownAt?: string;
};

export type EstimatedBed = { label: string; count: number };

export type HeatmapData = {
  exactPoints: HeatPoint[];
  estimatedBeds: EstimatedBed[];
  totals: {
    darts: number;
    exact: number;
    estimated: number;
    unplottable: number;
  };
};

function isCanonical(hit: ParsedHit) {
  return Boolean(
    hit.boardPosition
    && Number.isFinite(hit.boardPosition.x)
    && Number.isFinite(hit.boardPosition.y),
  );
}

export function buildHeatmap(darts: ParsedHit[]): HeatmapData {
  const exactPoints: HeatPoint[] = [];
  const estimated = new Map<string, number>();
  let unplottable = 0;

  darts.forEach((dart) => {
    if (isCanonical(dart)) {
      exactPoints.push({
        label: dart.label,
        x: dart.boardPosition!.x,
        y: dart.boardPosition!.y,
        ...(dart.thrownAt ? { thrownAt: dart.thrownAt } : {}),
      });
    } else if (dart.label !== 'MISS' && parseScore(dart.label)) {
      estimated.set(dart.label, (estimated.get(dart.label) ?? 0) + 1);
    } else {
      unplottable += 1;
    }
  });

  const estimatedBeds = [...estimated.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    exactPoints,
    estimatedBeds,
    totals: {
      darts: darts.length,
      exact: exactPoints.length,
      estimated: estimatedBeds.reduce((total, bed) => total + bed.count, 0),
      unplottable,
    },
  };
}

export function heatmapForPlayer(match: MatchState, playerIndex: number) {
  const darts: ParsedHit[] = [];
  match.visits.forEach((visit) => {
    if (visit.playerIndex !== playerIndex) return;
    if (visit.dartDetails?.length) {
      darts.push(...visit.dartDetails);
      return;
    }
    visit.darts.forEach((label) => {
      const parsed = parseScore(label);
      if (parsed) darts.push(parsed);
    });
  });

  if (match.status === 'active' && match.activePlayer === playerIndex) {
    darts.push(...match.darts);
  }
  return buildHeatmap(darts);
}
