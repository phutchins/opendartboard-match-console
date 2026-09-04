import type { ParsedHit } from './game-engine';

export const BOARD_NUMBERS = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
] as const;

export const BOARD_CENTER = 220;

export type BoardPoint = {
  x: number;
  y: number;
  angle: number;
  radius: number;
};

const toRadians = (degrees: number) => degrees * Math.PI / 180;

export function polarPoint(radius: number, angle: number) {
  const radians = toRadians(angle);
  return {
    x: BOARD_CENTER + Math.cos(radians) * radius,
    y: BOARD_CENTER + Math.sin(radians) * radius,
  };
}

export function annularSegmentPath(
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
) {
  const outerStart = polarPoint(outerRadius, startAngle);
  const outerEnd = polarPoint(outerRadius, endAngle);
  const innerEnd = polarPoint(innerRadius, endAngle);
  const innerStart = polarPoint(innerRadius, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

function seededUnit(hit: ParsedHit, dartIndex: number, salt: number) {
  const x = hit.cameraPosition?.x ?? hit.value * 13.7;
  const y = hit.cameraPosition?.y ?? (dartIndex + 1) * 91.3;
  const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

export function dartPoint(hit: ParsedHit, dartIndex: number): BoardPoint {
  if (
    hit.boardPosition
    && Number.isFinite(hit.boardPosition.x)
    && Number.isFinite(hit.boardPosition.y)
  ) {
    const normalizedX = Math.max(-1, Math.min(1, hit.boardPosition.x));
    const normalizedY = Math.max(-1, Math.min(1, hit.boardPosition.y));
    const x = BOARD_CENTER + normalizedX * 170;
    const y = BOARD_CENTER + normalizedY * 170;
    const dx = x - BOARD_CENTER;
    const dy = y - BOARD_CENTER;
    return {
      x,
      y,
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
      radius: Math.hypot(dx, dy),
    };
  }

  if (hit.label === 'BULL') {
    const angle = seededUnit(hit, dartIndex, 1) * 360;
    const radius = seededUnit(hit, dartIndex, 2) * 5;
    return { ...polarPoint(radius, angle), angle, radius };
  }

  if (hit.label === 'OUTER') {
    const angle = seededUnit(hit, dartIndex, 3) * 360;
    const radius = 8 + seededUnit(hit, dartIndex, 4) * 7;
    return { ...polarPoint(radius, angle), angle, radius };
  }

  if (hit.label === 'MISS' || hit.target === null) {
    const angle = -90 + seededUnit(hit, dartIndex, 5) * 360;
    const radius = 181 + seededUnit(hit, dartIndex, 6) * 14;
    return { ...polarPoint(radius, angle), angle, radius };
  }

  const segmentIndex = BOARD_NUMBERS.indexOf(hit.target as (typeof BOARD_NUMBERS)[number]);
  const segmentCenter = -90 + Math.max(0, segmentIndex) * 18;
  const angle = segmentCenter + (seededUnit(hit, dartIndex, 7) - 0.5) * 10;
  let radius: number;

  if (hit.multiplier === 3) {
    radius = 96 + seededUnit(hit, dartIndex, 8) * 8;
  } else if (hit.multiplier === 2) {
    radius = 160 + seededUnit(hit, dartIndex, 9) * 8;
  } else {
    const innerSingle = seededUnit(hit, dartIndex, 10) > 0.5;
    radius = innerSingle
      ? 42 + seededUnit(hit, dartIndex, 11) * 42
      : 115 + seededUnit(hit, dartIndex, 12) * 34;
  }

  return { ...polarPoint(radius, angle), angle, radius };
}
