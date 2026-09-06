import type { CSSProperties } from 'react';

import type { ParsedHit } from '@/lib/game-engine';
import { dartPoint, polarPoint } from '@/lib/dartboard-geometry';
import { DartboardFace } from '@/components/dartboard-face';

export function VisualDartboard({ darts, embedded = false }: { darts: ParsedHit[]; embedded?: boolean }) {
  return (
    <section className={`visual-board-shell ${embedded ? 'is-embedded' : ''}`} aria-label="Darts currently in the board">
      {!embedded && <div className="visual-board-heading">
        <div>
          <p className="eyebrow">Board view</p>
          <h3>Darts in play</h3>
        </div>
        <span>{darts.length}/3</span>
      </div>}

      <div className="visual-board-wrap">
        <DartboardFace
          ariaLabel={darts.length ? `${darts.length} darts shown on the dartboard` : 'Empty dartboard'}
          description="A regulation dartboard with the current visit marked in throw order."
        >
          {({ glow }) => (
            <>
          {darts.map((dart, index) => {
            const point = dartPoint(dart, index);
            const shaftEnd = polarPoint(point.radius + 20, point.angle);
            const newest = index === darts.length - 1;
            return (
              <g className={`dart-marker ${newest ? 'is-newest' : ''}`} key={`${dart.label}-${index}`} style={{ '--dart-glow': `url(#${glow})` } as CSSProperties}>
                <line x1={point.x} y1={point.y} x2={shaftEnd.x} y2={shaftEnd.y} />
                <circle className="dart-marker-halo" cx={point.x} cy={point.y} r="11" />
                <circle className="dart-marker-pin" cx={point.x} cy={point.y} r="7.5" />
                <text dominantBaseline="middle" textAnchor="middle" x={point.x} y={point.y + .5}>{index + 1}</text>
              </g>
            );
          })}
            </>
          )}
        </DartboardFace>
      </div>

      <div className="board-dart-legend" aria-label="Current dart list">
        {[0, 1, 2].map((index) => (
          <div className={darts[index] ? 'has-dart' : ''} key={index}>
            <span>{index + 1}</span>
            <strong>{darts[index]?.label ?? '—'}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
