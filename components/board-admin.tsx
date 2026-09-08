'use client';

import {
  Activity,
  Bug,
  Camera,
  CheckCircle2,
  CircleAlert,
  Gauge,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  SquarePower,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
  type BoardStatus,
  type CalibrationCamera,
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
  | 'use_opendartboard';

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
  const [preparedAction, setPreparedAction] = useState<PreparedAction | null>(null);
  const [preparingAction, setPreparingAction] = useState(false);
  const [boardEmpty, setBoardEmpty] = useState(false);
  const [runningAction, setRunningAction] = useState<BoardAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overlayVersion, setOverlayVersion] = useState(() => Date.now());
  const [overlayErrors, setOverlayErrors] = useState<Record<number, boolean>>({});

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

  const actionRequest = (definition: ActionDefinition) => {
    if (definition.action === 'restart') return { action: 'scorer.restart', parameters: {} };
    if (definition.action === 'enable_debug') return { action: 'debug.set', parameters: { enabled: true } };
    if (definition.action === 'disable_debug') return { action: 'debug.set', parameters: { enabled: false } };
    if (definition.action === 'use_modified') return { action: 'scorer.version', parameters: { target: 'modified' } };
    if (definition.action === 'use_stable') return { action: 'scorer.version', parameters: { target: 'stable' } };
    if (definition.action === 'use_autodarts') return { action: 'mode.set', parameters: { target: 'autodarts' } };
    if (definition.action === 'use_opendartboard') return { action: 'mode.set', parameters: { target: 'opendartboard' } };
    return { action: 'calibrate', parameters: {} };
  };

  const prepareAction = async (definition: ActionDefinition) => {
    setPendingAction(definition);
    setPreparedAction(null);
    setBoardEmpty(false);
    setPreparingAction(true);
    try {
      const response = await fetch('/api/control/v1/actions/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenDartboard-Action': '1' },
        body: JSON.stringify(actionRequest(definition)),
      });
      const payload = await response.json() as PreparedAction & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not prepare the board action');
      setPreparedAction(payload);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not prepare the board action');
      setPendingAction(null);
    } finally {
      setPreparingAction(false);
    }
  };

  const runAction = async () => {
    if (!pendingAction || !preparedAction) return;
    const requested = pendingAction;
    setPendingAction(null);
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
      if (requested.action === 'calibrate') {
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
                    <span>Camera {camera.camera + 1}</span>
                    <strong>{cameraRole(camera)}</strong>
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

      <AlertDialog onOpenChange={(open) => { if (!open) { setPendingAction(null); setPreparedAction(null); } }} open={pendingAction !== null}>
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
