'use client';

import {
  Activity,
  BarChart3,
  Camera,
  CircleAlert,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Settings2,
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
import {
  type BoardStatus,
  calibrationStateLabel,
  cameraContribution,
} from '@/lib/board-status';

type PreparedCalibration = {
  confirmationId: string;
  summary: string;
  consequences: string[];
  requiredAcknowledgements: string[];
};

function createActionKey() {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  return `action_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function LobbyBoardOverview({
  boardHost,
  onOpenBoard,
  onOpenStats,
}: {
  boardHost: string;
  onOpenBoard: () => void;
  onOpenStats: () => void;
}) {
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<PreparedCalibration | null>(null);
  const [boardEmpty, setBoardEmpty] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch('/api/control/v1/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('Board controls unavailable');
      const payload = await response.json() as BoardStatus;
      setStatus(payload);
      setError(null);
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read board status');
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const cameraCount = status?.calibration.cameras.length || 0;
  const contributingCameras = useMemo(() => (
    status?.calibration.cameras.filter(
      (camera) => cameraContribution(camera) !== 'unavailable',
    ).length || 0
  ), [status]);
  const healthy = Boolean(
    status?.mode === 'opendartboard'
    && status.opendartboard.running
    && cameraCount > 0
    && contributingCameras === cameraCount,
  );
  const headline = loading && !status
    ? 'Reading the board…'
    : error
      ? 'Board status needs attention'
      : status?.mode === 'autodarts'
        ? 'Autodarts has the cameras'
        : healthy
          ? 'Ready for the next game'
          : status?.calibration.state === 'calibrating'
            ? 'Calibration in progress'
            : 'Check the board before playing';
  const summary = error
    || status?.calibration.message
    || `Waiting for ${boardHost || 'the board'} to report its camera health.`;

  const prepareCalibration = async () => {
    setDialogOpen(true);
    setPreparing(true);
    setPrepared(null);
    setBoardEmpty(false);
    setNotice(null);
    try {
      const response = await fetch('/api/control/v1/actions/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenDartboard-Action': '1' },
        body: JSON.stringify({ action: 'calibrate', parameters: {} }),
      });
      const payload = await response.json() as PreparedCalibration & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not prepare calibration');
      setPrepared(payload);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not prepare calibration');
      setDialogOpen(false);
    } finally {
      setPreparing(false);
    }
  };

  const runCalibration = async () => {
    if (!prepared || !boardEmpty) return;
    setDialogOpen(false);
    setCalibrating(true);
    setNotice('Calibration started. Keep the board clear.');
    try {
      const response = await fetch(
        `/api/control/v1/actions/${encodeURIComponent(prepared.confirmationId)}/execute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-OpenDartboard-Action': '1' },
          body: JSON.stringify({
            acknowledgements: { boardEmpty: true },
            idempotencyKey: createActionKey(),
          }),
        },
      );
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || 'Calibration failed to start');
      setNotice(payload.message || 'Calibration started. Keep the board clear.');
      window.setTimeout(async () => {
        const refreshed = await refresh(true);
        if (refreshed) setNotice(`Calibration finished. ${refreshed.calibration.message}`);
        setCalibrating(false);
      }, 10_000);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Calibration failed to start');
      setCalibrating(false);
    }
  };

  const calibrationDisabled = Boolean(
    calibrating
    || loading
    || error
    || status?.mode !== 'opendartboard'
    || !status.opendartboard.running,
  );

  return (
    <>
      <section className={`lobby-board-overview ${healthy ? 'is-healthy' : 'needs-attention'}`} aria-label="Board overview">
        <div className="lobby-board-summary">
          <span className="board-overview-icon">{healthy ? <Activity /> : <CircleAlert />}</span>
          <div>
            <div className="board-overview-kicker">
              <span>Board snapshot</span>
              <Badge variant={healthy ? 'default' : 'outline'}>{healthy ? 'Live' : 'Check'}</Badge>
            </div>
            <h2>{headline}</h2>
            <p>{summary}</p>
          </div>
        </div>

        <div className="board-insight-grid" aria-label="Board insights">
          <div><Gauge /><span>Scorer</span><strong>{status?.opendartboard.running ? status.opendartboard.release : 'Offline'}</strong></div>
          <div><Camera /><span>Cameras</span><strong>{cameraCount ? `${contributingCameras} / ${cameraCount}` : '—'}</strong></div>
          <div><Activity /><span>Calibration</span><strong>{status ? calibrationStateLabel(status.calibration.state) : '—'}</strong></div>
        </div>

        <div className="board-quick-actions" aria-label="Quick actions">
          <Button disabled={calibrationDisabled} onClick={() => void prepareCalibration()}>
            {calibrating ? <LoaderCircle className="is-spinning" /> : <Camera />} Recalibrate
          </Button>
          <Button onClick={onOpenBoard} variant="outline"><Settings2 /> Board controls</Button>
          <Button onClick={onOpenStats} variant="ghost"><BarChart3 /> Player stats</Button>
          <Button aria-label="Refresh board snapshot" disabled={loading} onClick={() => void refresh()} size="icon" variant="ghost">
            <RefreshCw className={loading ? 'is-spinning' : ''} />
          </Button>
        </div>
        {notice && <output className="board-overview-notice">{notice}</output>}
      </section>

      <AlertDialog onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) {
          setPrepared(null);
          setBoardEmpty(false);
        }
      }} open={dialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><Camera /></AlertDialogMedia>
            <AlertDialogTitle>Recalibrate the cameras?</AlertDialogTitle>
            <AlertDialogDescription>
              {prepared?.summary || 'OpenDartboard will restart and capture a new clean-board reference.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preparing && <div className="dialog-preparing"><LoaderCircle className="is-spinning" /> Preparing safely…</div>}
          {!!prepared?.consequences.length && (
            <ul className="dialog-consequences">
              {prepared.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
            </ul>
          )}
          {prepared?.requiredAcknowledgements.includes('boardEmpty') && (
            <label className="dialog-acknowledgement" htmlFor="lobby-board-empty-acknowledgement">
              <Checkbox checked={boardEmpty} id="lobby-board-empty-acknowledgement" onCheckedChange={setBoardEmpty} />
              <span>I removed every dart and cleared the board.</span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!prepared || (prepared.requiredAcknowledgements.includes('boardEmpty') && !boardEmpty)}
              onClick={() => void runCalibration()}
            >
              Recalibrate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
