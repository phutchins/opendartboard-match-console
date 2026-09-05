import { useMemo } from 'react';

import { DartboardFace } from '@/components/dartboard-face';
import {
  annularSegmentPath,
  BOARD_CENTER,
  BOARD_NUMBERS,
} from '@/lib/dartboard-geometry';
import type { HeatmapData } from '@/lib/heatmap';

const intensity = (count: number, maximum: number) => (
  count > 0 ? 0.16 + Math.sqrt(count / Math.max(1, maximum)) * 0.62 : 0
);

export function DartHeatmap({ data, compact = false }: { data: HeatmapData; compact?: boolean }) {
  const counts = useMemo(() => new Map(data.estimatedBeds.map((bed) => [bed.label, bed.count])), [data]);
  const maximum = Math.max(1, ...data.estimatedBeds.map((bed) => bed.count));
  const topBeds = useMemo(() => {
    const combined = new Map<string, number>();
    data.estimatedBeds.forEach(({ label, count }) => combined.set(label, count));
    data.exactPoints.forEach(({ label }) => combined.set(label, (combined.get(label) ?? 0) + 1));
    return [...combined.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5);
  }, [data]);

  const bedOpacity = (label: string) => intensity(counts.get(label) ?? 0, maximum);

  return (
    <div className={`heatmap-view ${compact ? 'is-compact' : ''}`}>
      <div className="visual-board-wrap heatmap-board-wrap">
        <DartboardFace
          ariaLabel={`Throw heat map based on ${data.totals.darts} darts`}
          description="Glowing dots are exact calibrated locations. Shaded scoring beds are estimates from darts whose score was saved without a location."
        >
          {() => (
            <g className="heatmap-layer">
              {BOARD_NUMBERS.map((number, index) => {
                const start = -99 + index * 18;
                const end = start + 18;
                return (
                  <g key={number}>
                    <path className="heat-bed" d={annularSegmentPath(31, 93, start, end)} opacity={bedOpacity(`S${number}`)} />
                    <path className="heat-bed" d={annularSegmentPath(106, 157, start, end)} opacity={bedOpacity(`S${number}`)} />
                    <path className="heat-bed" d={annularSegmentPath(94, 105, start, end)} opacity={bedOpacity(`T${number}`)} />
                    <path className="heat-bed" d={annularSegmentPath(158, 170, start, end)} opacity={bedOpacity(`D${number}`)} />
                  </g>
                );
              })}
              <circle className="heat-bed" cx={BOARD_CENTER} cy={BOARD_CENTER} r="16" opacity={bedOpacity('OUTER')} />
              <circle className="heat-bed" cx={BOARD_CENTER} cy={BOARD_CENTER} r="7" opacity={bedOpacity('BULL')} />
              {data.exactPoints.map((point, index) => (
                <g className="heat-point" key={`${point.thrownAt ?? point.label}-${index}`}>
                  <circle cx={BOARD_CENTER + point.x * 170} cy={BOARD_CENTER + point.y * 170} r="18" />
                  <circle className="heat-point-core" cx={BOARD_CENTER + point.x * 170} cy={BOARD_CENTER + point.y * 170} r="4" />
                </g>
              ))}
            </g>
          )}
        </DartboardFace>
        {data.totals.darts === 0 && (
          <div className="empty-board-callout">
            <span>No darts yet</span>
            <small>This view fills as the player throws</small>
          </div>
        )}
      </div>

      <div className="heatmap-legend" aria-label="Heat map legend">
        <span><i className="is-exact" /> Exact location</span>
        <span><i className="is-estimated" /> Score-bed estimate</span>
        <span className="heatmap-scale"><small>Less</small><i /><i /><i /><i /><small>More</small></span>
      </div>

      <div className="heatmap-metrics">
        <div><span>Total darts</span><strong>{data.totals.darts}</strong></div>
        <div><span>Exact</span><strong>{data.totals.exact}</strong></div>
        <div><span>Bed only</span><strong>{data.totals.estimated}</strong></div>
        <div><span>Unplottable</span><strong>{data.totals.unplottable}</strong></div>
      </div>

      {!compact && (
        <div className="heatmap-details">
          <p>
            Exact dots use calibrated board coordinates. Bed shading is used when an older or manual score has no location;
            single scores shade both possible single beds.
          </p>
          <div aria-label="Most frequently hit scoring beds">
            <span>Top beds</span>
            {topBeds.length
              ? topBeds.map(([label, count]) => <strong key={label}>{label} <em>{count}</em></strong>)
              : <strong>—</strong>}
          </div>
        </div>
      )}
    </div>
  );
}
