import type { ParsedHit } from '@/lib/game-engine';
import {
  annularSegmentPath,
  BOARD_CENTER,
  BOARD_NUMBERS,
  dartPoint,
  polarPoint,
} from '@/lib/dartboard-geometry';

const segmentColors = {
  dark: '#171b1c',
  light: '#e7ddc4',
  orange: '#ec6035',
  lime: '#a8cb35',
};

export function VisualDartboard({ darts }: { darts: ParsedHit[] }) {
  return (
    <section className="visual-board-shell" aria-label="Darts currently in the board">
      <div className="visual-board-heading">
        <div>
          <p className="eyebrow">Board view</p>
          <h3>Darts in play</h3>
        </div>
        <span>{darts.length}/3</span>
      </div>

      <div className="visual-board-wrap">
        <svg
          aria-label={darts.length ? `${darts.length} darts shown on the dartboard` : 'Empty dartboard'}
          className="visual-dartboard"
          role="img"
          viewBox="0 0 440 440"
        >
          <defs>
            <filter id="dart-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <radialGradient id="board-surround" cx="50%" cy="44%" r="60%">
              <stop offset="0" stopColor="#303638" />
              <stop offset=".72" stopColor="#151a1c" />
              <stop offset="1" stopColor="#090c0d" />
            </radialGradient>
          </defs>

          <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="211" fill="#080b0c" stroke="#343c3f" strokeWidth="2" />
          <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="202" fill="url(#board-surround)" stroke="#0a0d0e" strokeWidth="10" />

          {BOARD_NUMBERS.map((number, index) => {
            const start = -99 + index * 18;
            const end = start + 18;
            const single = index % 2 === 0 ? segmentColors.dark : segmentColors.light;
            const ring = index % 2 === 0 ? segmentColors.orange : segmentColors.lime;
            const numberPoint = polarPoint(187, -90 + index * 18);
            return (
              <g key={number}>
                <path d={annularSegmentPath(106, 157, start, end)} fill={single} className="board-bed" />
                <path d={annularSegmentPath(31, 93, start, end)} fill={single} className="board-bed" />
                <path d={annularSegmentPath(158, 170, start, end)} fill={ring} className="board-bed" />
                <path d={annularSegmentPath(94, 105, start, end)} fill={ring} className="board-bed" />
                <text
                  className="board-number"
                  dominantBaseline="middle"
                  textAnchor="middle"
                  x={numberPoint.x}
                  y={numberPoint.y}
                >
                  {number}
                </text>
              </g>
            );
          })}

          <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="16" fill={segmentColors.lime} stroke="#0b0e0f" strokeWidth="1.5" />
          <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="7" fill={segmentColors.orange} stroke="#0b0e0f" strokeWidth="1.5" />
          <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="171" fill="none" stroke="#798084" strokeOpacity=".45" />

          {darts.map((dart, index) => {
            const point = dartPoint(dart, index);
            const shaftEnd = polarPoint(point.radius + 20, point.angle);
            const newest = index === darts.length - 1;
            return (
              <g className={`dart-marker ${newest ? 'is-newest' : ''}`} key={`${dart.label}-${index}`}>
                <line x1={point.x} y1={point.y} x2={shaftEnd.x} y2={shaftEnd.y} />
                <circle className="dart-marker-halo" cx={point.x} cy={point.y} r="11" />
                <circle className="dart-marker-pin" cx={point.x} cy={point.y} r="7.5" />
                <text dominantBaseline="middle" textAnchor="middle" x={point.x} y={point.y + .5}>{index + 1}</text>
              </g>
            );
          })}
        </svg>
        {!darts.length && (
          <div className="empty-board-callout">
            <span>Ready</span>
            <small>First dart will appear here</small>
          </div>
        )}
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
