'use client';

import {
  Activity,
  Bug,
  Camera,
  CheckCircle2,
  CircleAlert,
  Gauge,
  LoaderCircle,
  Move,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCog,
  ShieldCheck,
  SquarePower,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type PointerEvent } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type BoardStatus,
  type CalibrationCamera,
  type CalibrationLandmarks,
  type CalibrationPoint,
  calibrationStateLabel,
  cameraContribution,
} from '@/lib/board-status';

type BoardAction =
  | 'calibrate'
  | 'restart'
  | 'enable_debug'
  | 'disable_debug'
  | 'use_modified'
  | 'use_stable'
  | 'use_autodarts'
  | 'use_opendartboard'
  | 'manual_alignment'
  | 'clear_alignment';

type ActionDefinition = {
  action: BoardAction;
  label: string;
  title: string;
  description: string;
  destructive?: boolean;
};

type PreparedAction = {
  confirmationId: string;
  summary: string;
  consequences: string[];
  requiredAcknowledgements: string[];
};

type ActionRequest = { action: string; parameters: Record<string, unknown> };
type LandmarkName = keyof CalibrationLandmarks;

const landmarkNames: LandmarkName[] = ['center', 'north', 'east', 'south', 'west'];
const ringRadii = [6.35, 15.9, 99, 107, 162, 170];

function defaultLandmarks(): CalibrationLandmarks {
  return {
    center: { x: 640, y: 360 },
    north: { x: 640, y: 100 },
    east: { x: 1020, y: 360 },
    south: { x: 640, y: 620 },
    west: { x: 260, y: 360 },
  };
}

function solveLinearSystem(matrix: number[][], values: number[]) {
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < values.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < values.length; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-8) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= values.length; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < values.length; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= values.length; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[values.length]);
}

function calibrationHomography(landmarks: CalibrationLandmarks) {
  const correspondences: Array<[number, number, CalibrationPoint]> = [
    [0, 0, landmarks.center],
    [0, -1, landmarks.north],
    [1, 0, landmarks.east],
    [0, 1, landmarks.south],
    [-1, 0, landmarks.west],
  ];
  const rows: number[][] = [];
  const values: number[] = [];
  for (const [x, y, point] of correspondences) {
    rows.push([x, y, 1, 0, 0, 0, -point.x * x, -point.x * y]);
    values.push(point.x);
    rows.push([0, 0, 0, x, y, 1, -point.y * x, -point.y * y]);
    values.push(point.y);
  }
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0) as number[]);
  const right = Array(8).fill(0) as number[];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      right[column] += rows[row][column] * values[row];
      for (let inner = 0; inner < 8; inner += 1) {
        normal[column][inner] += rows[row][column] * rows[row][inner];
      }
    }
  }
  const solved = solveLinearSystem(normal, right);
  return solved ? [...solved, 1] : null;
}

function projectCalibrationPoint(matrix: number[] | null, x: number, y: number): CalibrationPoint | null {
  if (!matrix) return null;
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(denominator) < 1e-8) return null;
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator,
  };
}

function modelPolyline(matrix: number[] | null, radius: number, samples = 120) {
  const points: string[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const angle = index / samples * Math.PI * 2;
    const point = projectCalibrationPoint(matrix, radius * Math.cos(angle), radius * Math.sin(angle));
    if (point) points.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`);
  }
  return points.join(' ');
}

const actions: Record<BoardAction, ActionDefinition> = {
  calibrate: {
    action: 'calibrate',
    label: 'Recalibrate cameras',
    title: 'Recalibrate the board?',
    description: 'Remove every dart and keep the board clear. Scoring will restart while all three cameras are calibrated.',
  },
  restart: {
    action: 'restart',
    label: 'Restart scorer',
    title: 'Restart OpenDartboard?',
    description: 'The live score connection will briefly disconnect and reconnect automatically.',
  },
  enable_debug: {
    action: 'enable_debug',
    label: 'Enable debug',
    title: 'Enable diagnostic streams?',
    description: 'OpenDartboard will restart with camera diagnostics available on ports 8081–8088.',
  },
  disable_debug: {
    action: 'disable_debug',
    label: 'Disable debug',
    title: 'Disable diagnostic streams?',
    description: 'OpenDartboard will restart without the additional camera debug streams.',
  },
  use_modified: {
    action: 'use_modified',
    label: 'Use modified scorer',
    title: 'Switch to the modified scorer?',
    description: 'The scorer will restart using our locally built OpenDartboard image.',
  },
  use_stable: {
    action: 'use_stable',
    label: 'Use stable v0.1.4',
    title: 'Roll back to stable v0.1.4?',
    description: 'The scorer will restart with the untouched upstream v0.1.4 image.',
  },
  use_autodarts: {
    action: 'use_autodarts',
    label: 'Switch to Autodarts',
    title: 'Return the cameras to Autodarts?',
    description: 'OpenDartboard will stop and the Autodarts service will start. This ends live scoring in this client.',
    destructive: true,
  },
  use_opendartboard: {
    action: 'use_opendartboard',
    label: 'Start OpenDartboard',
    title: 'Give the cameras to OpenDartboard?',
    description: 'Autodarts will stop before OpenDartboard starts so the camera devices are not shared.',
  },
  manual_alignment: {
    action: 'manual_alignment',
    label: 'Save fine-tune',
    title: 'Apply this camera alignment?',
    description: 'The scorer will restart and use these five physical board landmarks for this camera.',
  },
  clear_alignment: {
    action: 'clear_alignment',
    label: 'Use automatic alignment',
    title: 'Remove the manual alignment?',
    description: 'This camera will return to automatic pixel-based calibration when the scorer restarts.',
  },
};

function cameraRole(camera: CalibrationCamera) {
  const contribution = cameraContribution(camera);
  if (contribution === 'full') return 'Full scorer';
  if (contribution === 'ring') return 'Ring voter';
  return 'Unavailable';
}

function cameraDetail(camera: CalibrationCamera) {
  const contribution = cameraContribution(camera);
  const position = camera.orientation && camera.orientation !== 'UNKNOWN'
    ? camera.orientation.toLowerCase()
    : 'mount unknown';
  if (contribution === 'full') return `Wedge map ready · ${position}`;
  if (contribution === 'ring') return `Ring geometry ready · ${position}`;
  return 'Recalibration needed';
}

function createActionKey() {
  if (typeof window.crypto?.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `action_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function BoardAdmin({
  boardHost,
  onBoardHost,
}: {
  boardHost: string;
  onBoardHost: (host: string) => void;
}) {
  const [draftHost, setDraftHost] = useState(boardHost);
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionDefinition | null>(null);
  const [pendingRequest, setPendingRequest] = useState<ActionRequest | null>(null);
  const [preparedAction, setPreparedAction] = useState<PreparedAction | null>(null);
  const [preparingAction, setPreparingAction] = useState(false);
  const [boardEmpty, setBoardEmpty] = useState(false);
  const [runningAction, setRunningAction] = useState<BoardAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overlayVersion, setOverlayVersion] = useState(() => Date.now());
  const [overlayErrors, setOverlayErrors] = useState<Record<number, boolean>>({});
  const [adjustingCamera, setAdjustingCamera] = useState<CalibrationCamera | null>(null);
  const [draftLandmarks, setDraftLandmarks] = useState<CalibrationLandmarks>(defaultLandmarks);

  useEffect(() => setDraftHost(boardHost), [boardHost]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch('/api/control/v1/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('Board controls are not installed on this host');
      const payload = await response.json() as BoardStatus;
      setStatus(payload);
      setError(null);
      return payload;
    } catch (caught) {
      setStatus(null);
      setError(caught instanceof Error ? caught.message : 'Could not reach board controls');
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const actionRequest = (definition: ActionDefinition): ActionRequest => {
    if (definition.action === 'restart') return { action: 'scorer.restart', parameters: {} };
    if (definition.action === 'enable_debug') return { action: 'debug.set', parameters: { enabled: true } };
    if (definition.action === 'disable_debug') return { action: 'debug.set', parameters: { enabled: false } };
    if (definition.action === 'use_modified') return { action: 'scorer.version', parameters: { target: 'modified' } };
    if (definition.action === 'use_stable') return { action: 'scorer.version', parameters: { target: 'stable' } };
    if (definition.action === 'use_autodarts') return { action: 'mode.set', parameters: { target: 'autodarts' } };
    if (definition.action === 'use_opendartboard') return { action: 'mode.set', parameters: { target: 'opendartboard' } };
    return { action: 'calibrate', parameters: {} };
  };

  const prepareAction = async (definition: ActionDefinition, override?: ActionRequest) => {
    const request = override || actionRequest(definition);
    setPendingAction(definition);
    setPendingRequest(request);
    setPreparedAction(null);
    setBoardEmpty(false);
    setPreparingAction(true);
    try {
      const response = await fetch('/api/control/v1/actions/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenDartboard-Action': '1' },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as PreparedAction & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not prepare the board action');
      setPreparedAction(payload);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not prepare the board action');
      setPendingAction(null);
      setPendingRequest(null);
    } finally {
      setPreparingAction(false);
    }
  };

  const runAction = async () => {
    if (!pendingAction || !pendingRequest || !preparedAction) return;
    const requested = pendingAction;
      setPendingAction(null);
      setPendingRequest(null);
    setRunningAction(requested.action);
    setNotice(null);
    try {
      const response = await fetch(`/api/control/v1/actions/${encodeURIComponent(preparedAction.confirmationId)}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenDartboard-Action': '1',
        },
        body: JSON.stringify({
          acknowledgements: { boardEmpty },
          idempotencyKey: createActionKey(),
        }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || 'The board action failed');
      setNotice(payload.message || `${requested.label} complete`);
      window.setTimeout(() => {
        setOverlayErrors({});
        setOverlayVersion(Date.now());
        void refresh(true);
      }, 1200);
      if (requested.action === 'calibrate' || requested.action === 'manual_alignment' || requested.action === 'clear_alignment') {
        window.setTimeout(async () => {
          const refreshed = await refresh(true);
          setOverlayErrors({});
          setOverlayVersion(Date.now());
          if (refreshed) {
            setNotice(`Calibration finished. ${refreshed.calibration.message}`);
          }
        }, 10_000);
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The board action failed');
    } finally {
      setRunningAction(null);
    }
  };

  const openFineTune = (camera: CalibrationCamera) => {
    setDraftLandmarks(camera.landmarks && camera.orientationValid
      ? camera.landmarks
      : defaultLandmarks());
    setAdjustingCamera(camera);
  };

  const moveLandmark = (name: LandmarkName, event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const surface = event.currentTarget.parentElement;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    const x = Math.max(0, Math.min(1279, (event.clientX - bounds.left) / bounds.width * 1280));
    const y = Math.max(0, Math.min(719, (event.clientY - bounds.top) / bounds.height * 720));
    setDraftLandmarks((current) => ({ ...current, [name]: { x, y } }));
  };

  const nudgeLandmark = (name: LandmarkName, deltaX: number, deltaY: number) => {
    setDraftLandmarks((current) => ({
      ...current,
      [name]: {
        x: Math.max(0, Math.min(1279, current[name].x + deltaX)),
        y: Math.max(0, Math.min(719, current[name].y + deltaY)),
      },
    }));
  };

  const saveFineTune = () => {
    if (!adjustingCamera) return;
    const camera = adjustingCamera.camera;
    setAdjustingCamera(null);
    void prepareAction(actions.manual_alignment, {
      action: 'calibration.override.set',
      parameters: { camera, landmarks: draftLandmarks },
    });
  };

  const clearFineTune = (camera: CalibrationCamera) => {
    setAdjustingCamera(null);
    void prepareAction(actions.clear_alignment, {
      action: 'calibration.override.clear',
      parameters: { camera: camera.camera },
    });
  };

  const debugAction = status?.opendartboard.debug ? actions.disable_debug : actions.enable_debug;
  const modeText = status?.mode === 'autodarts'
    ? 'Autodarts owns the cameras'
    : status?.mode === 'opendartboard'
      ? 'OpenDartboard owns the cameras'
      : 'No scorer is running';
  const cameraSummary = useMemo(() => {
    if (!status?.calibration.cameras.length) return 'Camera details unavailable';
    const contributing = status.calibration.cameras.filter(
      (camera) => cameraContribution(camera) !== 'unavailable',
    ).length;
    return `${contributing} of ${status.calibration.cameras.length} cameras contributing`;
  }, [status]);
  const displayedCameras: CalibrationCamera[] = status?.calibration.cameras.length
    ? status.calibration.cameras
    : [0, 1, 2].map((camera) => ({ camera, ready: false, contribution: 'unavailable' }));
  const previewHomography = useMemo(() => calibrationHomography(draftLandmarks), [draftLandmarks]);

  return (
    <section className="board-admin-page">
      <section className="board-admin-hero">
        <div>
          <p className="eyebrow">Board operations</p>
          <h1>Keep every camera honest.</h1>
          <p>Calibrate, inspect, restart, and move safely between OpenDartboard and Autodarts.</p>
        </div>
        <div className="board-mode-chip">
          <Activity />
          <div><span>Current owner</span><strong>{modeText}</strong></div>
        </div>
      </section>

      <section className="board-admin-grid">
        <article className="board-admin-card board-health-card">
          <div className="board-card-heading">
            <span className="board-card-icon"><Gauge /></span>
            <div><p className="eyebrow">System health</p><h2>Scorer status</h2></div>
            <Button aria-label="Refresh board status" disabled={loading} onClick={() => void refresh()} size="icon" variant="ghost">
              <RefreshCw className={loading ? 'is-spinning' : ''} />
            </Button>
          </div>

          {loading && !status ? (
            <div className="board-admin-empty"><LoaderCircle className="is-spinning" /> Reading board status…</div>
          ) : error ? (
            <div className="board-admin-empty is-error"><CircleAlert /> {error}</div>
          ) : status && (
            <div className="health-list">
              <div>
                <span>OpenDartboard</span>
                <strong>{status.opendartboard.running ? 'Running' : 'Stopped'}</strong>
                <Badge variant={status.opendartboard.running ? 'default' : 'outline'}>{status.opendartboard.release}</Badge>
              </div>
              <div>
                <span>Calibration</span>
                <strong>{calibrationStateLabel(status.calibration.state)}</strong>
                <Badge variant={status.calibration.state === 'ready' ? 'default' : 'destructive'}>{cameraSummary}</Badge>
              </div>
              <div>
                <span>Diagnostics</span>
                <strong>{status.opendartboard.debug ? 'Enabled' : 'Off'}</strong>
                <Badge variant="outline">{status.opendartboard.debug ? '8081–8088' : 'quiet mode'}</Badge>
              </div>
              <div>
                <span>Autodarts</span>
                <strong>{status.autodarts.active ? 'Running' : 'Stopped'}</strong>
                <Badge variant="outline">service</Badge>
              </div>
            </div>
          )}
          {status?.calibration.message && <p className="calibration-message">{status.calibration.message}</p>}
          {notice && <output className="board-action-notice">{notice}</output>}
        </article>

        <article className="board-admin-card calibration-overlay-card">
          <div className="board-card-heading">
            <span className="board-card-icon"><Camera /></span>
            <div><p className="eyebrow">Visual verification</p><h2>Calibration overlays</h2></div>
            <Button
              aria-label="Reload calibration overlays"
              onClick={() => {
                setOverlayErrors({});
                setOverlayVersion(Date.now());
              }}
              size="icon"
              variant="ghost"
            >
              <RefreshCw />
            </Button>
          </div>
          <p className="board-card-copy">The detected rings and radial wires should follow the physical board in every image. Click a camera to inspect it at full size.</p>
          <div className="calibration-overlay-grid">
            {displayedCameras.map((camera) => {
              const contribution = cameraContribution(camera);
              const source = `/api/control/v1/calibration/overlays/${camera.camera}?v=${overlayVersion}`;
              return (
                <figure className={`calibration-overlay is-${contribution}`} key={camera.camera}>
                  <a href={source} rel="noreferrer" target="_blank">
                    {!overlayErrors[camera.camera] ? (
                      // These are live, same-origin diagnostic files rather than build-time assets.
                      // oxlint-disable-next-line next/no-img-element
                      <img
                        alt={`Camera ${camera.camera + 1} calibration overlay`}
                        onError={() => setOverlayErrors((current) => ({ ...current, [camera.camera]: true }))}
                        src={source}
                      />
                    ) : (
                      <span className="calibration-overlay-missing"><Camera /> Overlay unavailable</span>
                    )}
                  </a>
                  <figcaption>
                    <div>
                      <span>Camera {camera.camera + 1}</span>
                      <strong>{cameraRole(camera)}</strong>
                      {camera.ringResidualP90Pixels != null && (
                        <small>Pixel fit {camera.ringResidualMeanPixels?.toFixed(1)} avg · {camera.ringResidualP90Pixels.toFixed(1)} p90</small>
                      )}
                    </div>
                    <Button
                      aria-label={`Fine-tune camera ${camera.camera + 1}`}
                      disabled={status?.mode !== 'opendartboard' || !!runningAction}
                      onClick={() => openFineTune(camera)}
                      size="sm"
                      variant="outline"
                    >
                      <Move /> Fine-tune
                    </Button>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </article>

        <article className="board-admin-card">
          <div className="board-card-heading">
            <span className="board-card-icon"><Camera /></span>
            <div><p className="eyebrow">Calibration</p><h2>Camera alignment</h2></div>
          </div>
          <p className="board-card-copy">Every camera contributes ring geometry. One wedge-mapping camera supplies the number while the other views strengthen ring detection.</p>
          <div className="camera-status-list">
            {displayedCameras.map((camera) => {
              const contribution = cameraContribution(camera);
              const contributes = contribution !== 'unavailable';
              return (
                <div key={camera.camera}>
                  <span className="camera-name"><Camera /> Camera {camera.camera + 1}</span>
                  <div className={`camera-capability is-${contribution}`}>
                    <strong>{contributes ? <CheckCircle2 /> : <CircleAlert />}{cameraRole(camera)}</strong>
                    <small>{cameraDetail(camera)}</small>
                  </div>
                </div>
              );
            })}
          </div>
            <Button disabled={!!runningAction || status?.mode === 'autodarts'} onClick={() => void prepareAction(actions.calibrate)} size="lg">
            {runningAction === 'calibrate' ? <LoaderCircle className="is-spinning" /> : <CrosshairIcon />} Recalibrate cameras
          </Button>
        </article>

        <article className="board-admin-card">
          <div className="board-card-heading">
            <span className="board-card-icon"><ServerCog /></span>
            <div><p className="eyebrow">Scorer build</p><h2>Version & diagnostics</h2></div>
          </div>
          <p className="board-card-copy">Test our fixes while retaining the untouched upstream image as an immediate rollback.</p>
          <div className="board-action-stack">
            <Button disabled={!!runningAction || status?.opendartboard.release === 'modified'} onClick={() => void prepareAction(actions.use_modified)} variant="outline"><Wrench /> Use modified scorer</Button>
            <Button disabled={!!runningAction || status?.opendartboard.release === 'stable'} onClick={() => void prepareAction(actions.use_stable)} variant="outline"><ShieldCheck /> Use stable v0.1.4</Button>
            <Button disabled={!!runningAction || !status?.opendartboard.exists} onClick={() => void prepareAction(debugAction)} variant="outline"><Bug /> {debugAction.label}</Button>
            <Button disabled={!!runningAction || !status?.opendartboard.exists} onClick={() => void prepareAction(actions.restart)} variant="ghost"><RotateCcw /> Restart scorer</Button>
          </div>
        </article>

        <article className="board-admin-card">
          <div className="board-card-heading">
            <span className="board-card-icon"><SquarePower /></span>
            <div><p className="eyebrow">Camera ownership</p><h2>Choose the scorer</h2></div>
          </div>
          <p className="board-card-copy">Only one scorer can use the three USB cameras at a time. Switching services is automatic.</p>
          <div className="board-action-stack">
            <Button disabled={!!runningAction || status?.mode === 'opendartboard'} onClick={() => void prepareAction(actions.use_opendartboard)}><Activity /> Start OpenDartboard</Button>
            <Button disabled={!!runningAction || status?.mode === 'autodarts'} onClick={() => void prepareAction(actions.use_autodarts)} variant="destructive"><SquarePower /> Switch to Autodarts</Button>
          </div>
          <div className="board-host-setting">
            <label htmlFor="board-host">Scoring host</label>
            <div>
              <Input id="board-host" onChange={(event) => setDraftHost(event.target.value)} value={draftHost} />
              <Button onClick={() => onBoardHost(draftHost.trim())} variant="outline">Save</Button>
            </div>
            <small>WebSocket scoring uses {boardHost || 'the saved host'}:13520.</small>
          </div>
        </article>
      </section>

      <Dialog onOpenChange={(open) => { if (!open) setAdjustingCamera(null); }} open={adjustingCamera !== null}>
        <DialogContent className="calibration-editor-dialog">
          <DialogHeader>
            <DialogTitle>Fine-tune camera {(adjustingCamera?.camera ?? 0) + 1}</DialogTitle>
            <DialogDescription>
              Drag the center marker onto the bull and the four edge markers onto the outside wire of the named double segment. The model lines update immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="calibration-landmark-key" aria-label="Calibration landmark instructions">
            <span><i className="is-center" /> Center: bull</span>
            <span><i className="is-north" /> Top: D20</span>
            <span><i className="is-east" /> Right: D6</span>
            <span><i className="is-south" /> Bottom: D3</span>
            <span><i className="is-west" /> Left: D11</span>
          </div>
          <div className="calibration-editor-surface">
            {adjustingCamera && (
              // This is a live, same-origin camera background rather than a build-time asset.
              // oxlint-disable-next-line next/no-img-element
              <img
                alt={`Empty-board reference from camera ${adjustingCamera.camera + 1}`}
                src={`/api/control/v1/calibration/backgrounds/${adjustingCamera.camera}?v=${overlayVersion}`}
              />
            )}
            <svg aria-hidden="true" className="calibration-model-preview" viewBox="0 0 1280 720">
              {ringRadii.map((radius) => (
                <polyline
                  className={radius >= 162 ? 'is-double' : radius >= 99 ? 'is-triple' : 'is-bull'}
                  key={radius}
                  points={modelPolyline(previewHomography, radius / 170)}
                />
              ))}
              {Array.from({ length: 20 }, (_, index) => {
                const center = projectCalibrationPoint(previewHomography, 0, 0);
                const angle = (-99 + index * 18) * Math.PI / 180;
                const edge = projectCalibrationPoint(previewHomography, Math.cos(angle), Math.sin(angle));
                return center && edge ? (
                  <line key={index} x1={center.x} x2={edge.x} y1={center.y} y2={edge.y} />
                ) : null;
              })}
            </svg>
            {landmarkNames.map((name) => {
              const point = draftLandmarks[name];
              return (
                <button
                  aria-label={`Move ${name} calibration marker. Use arrow keys for one-pixel adjustments.`}
                  className={`calibration-handle is-${name}`}
                  key={name}
                  onKeyDown={(event) => {
                    const step = event.shiftKey ? 5 : 1;
                    if (event.key === 'ArrowLeft') nudgeLandmark(name, -step, 0);
                    else if (event.key === 'ArrowRight') nudgeLandmark(name, step, 0);
                    else if (event.key === 'ArrowUp') nudgeLandmark(name, 0, -step);
                    else if (event.key === 'ArrowDown') nudgeLandmark(name, 0, step);
                    else return;
                    event.preventDefault();
                  }}
                  onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                  onPointerMove={(event) => moveLandmark(name, event)}
                  style={{ left: `${point.x / 12.8}%`, top: `${point.y / 7.2}%` }}
                  type="button"
                >
                  <span>{name === 'center' ? 'Bull' : name === 'north' ? 'D20' : name === 'east' ? 'D6' : name === 'south' ? 'D3' : 'D11'}</span>
                </button>
              );
            })}
          </div>
          <p className="calibration-editor-note">Zoom the page if needed. Arrow keys move the selected marker one pixel; hold Shift for five.</p>
          <DialogFooter>
            {adjustingCamera?.modelSource === 'manual' && (
              <Button onClick={() => adjustingCamera && clearFineTune(adjustingCamera)} variant="ghost"><Trash2 /> Use automatic</Button>
            )}
            <Button onClick={() => setAdjustingCamera(null)} variant="outline">Cancel</Button>
            <Button onClick={saveFineTune}><Save /> Review & save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={(open) => { if (!open) { setPendingAction(null); setPendingRequest(null); setPreparedAction(null); } }} open={pendingAction !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>{pendingAction?.destructive ? <CircleAlert /> : <ServerCog />}</AlertDialogMedia>
            <AlertDialogTitle>{pendingAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>{preparedAction?.summary || pendingAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {preparingAction && <div className="dialog-preparing"><LoaderCircle className="is-spinning" /> Preparing safely…</div>}
          {!!preparedAction?.consequences.length && (
            <ul className="dialog-consequences">
              {preparedAction.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
            </ul>
          )}
          {preparedAction?.requiredAcknowledgements.includes('boardEmpty') && (
            <label className="dialog-acknowledgement" htmlFor="board-empty-acknowledgement">
              <Checkbox checked={boardEmpty} id="board-empty-acknowledgement" onCheckedChange={setBoardEmpty} />
              <span>I removed every dart and cleared the board.</span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!preparedAction || (preparedAction.requiredAcknowledgements.includes('boardEmpty') && !boardEmpty)}
              onClick={() => void runAction()}
              variant={pendingAction?.destructive ? 'destructive' : 'default'}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CrosshairIcon() {
  return <Camera aria-hidden="true" />;
}
