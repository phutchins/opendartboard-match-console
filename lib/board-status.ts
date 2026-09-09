export type CalibrationCamera = {
  camera: number;
  orientation?: string;
  ready: boolean;
  geometryValid?: boolean;
  orientationValid?: boolean;
  contribution?: 'full' | 'ring' | 'unavailable';
  wedge20WireIndex?: number;
  modelSource?: 'auto' | 'manual';
  modelValid?: boolean;
  ringResidualMeanPixels?: number | null;
  ringResidualP90Pixels?: number | null;
  residualSamples?: number;
  landmarks?: CalibrationLandmarks | null;
};

export type CalibrationPoint = { x: number; y: number };

export type CalibrationLandmarks = {
  center: CalibrationPoint;
  north: CalibrationPoint;
  east: CalibrationPoint;
  south: CalibrationPoint;
  west: CalibrationPoint;
};

export type BoardStatus = {
  mode: 'opendartboard' | 'autodarts' | 'offline';
  opendartboard: {
    exists: boolean;
    running: boolean;
    image: string | null;
    release: 'modified' | 'stable' | 'custom' | 'unknown';
    debug: boolean;
  };
  autodarts: { active: boolean };
  calibration: {
    state: 'ready' | 'degraded' | 'calibrating' | 'unknown';
    message: string;
    cameras: CalibrationCamera[];
  };
  updatedAt: string;
};

export function calibrationStateLabel(state: BoardStatus['calibration']['state']) {
  if (state === 'ready') return 'Ready';
  if (state === 'degraded') return 'Limited';
  if (state === 'calibrating') return 'Calibrating';
  return 'Unknown';
}

export function cameraContribution(camera: CalibrationCamera) {
  if (camera.contribution) return camera.contribution;
  if (camera.ready) return 'full';
  return camera.geometryValid ? 'ring' : 'unavailable';
}
