'use client';

import { useId, type ReactNode } from 'react';

import {
  annularSegmentPath,
  BOARD_CENTER,
  BOARD_NUMBERS,
  polarPoint,
} from '@/lib/dartboard-geometry';

const segmentColors = {
  dark: '#171b1c',
  light: '#e7ddc4',
  orange: '#ec6035',
  lime: '#a8cb35',
};

type DartboardFaceProps = {
  ariaLabel: string;
  description: string;
  children?: (ids: { glow: string }) => ReactNode;
};

export function DartboardFace({ ariaLabel, description, children }: DartboardFaceProps) {
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const surroundId = `board-surround-${prefix}`;
  const glowId = `dart-glow-${prefix}`;

  return (
    <svg aria-label={ariaLabel} className="visual-dartboard" role="img" viewBox="0 0 440 440">
      <title>{ariaLabel}</title>
      <desc>{description}</desc>
      <defs>
        <filter id={glowId} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <radialGradient id={surroundId} cx="50%" cy="44%" r="60%">
          <stop offset="0" stopColor="#303638" />
          <stop offset=".72" stopColor="#151a1c" />
          <stop offset="1" stopColor="#090c0d" />
        </radialGradient>
      </defs>

      <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="211" fill="#080b0c" stroke="#343c3f" strokeWidth="2" />
      <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="202" fill={`url(#${surroundId})`} stroke="#0a0d0e" strokeWidth="10" />

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
            <text className="board-number" dominantBaseline="middle" textAnchor="middle" x={numberPoint.x} y={numberPoint.y}>
              {number}
            </text>
          </g>
        );
      })}

      <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="16" fill={segmentColors.lime} stroke="#0b0e0f" strokeWidth="1.5" />
      <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="7" fill={segmentColors.orange} stroke="#0b0e0f" strokeWidth="1.5" />
      <circle cx={BOARD_CENTER} cy={BOARD_CENTER} r="171" fill="none" stroke="#798084" strokeOpacity=".45" />
      {children?.({ glow: glowId })}
    </svg>
  );
}
