#!/usr/bin/env python3
"""Narrow host-control API for a locally hosted OpenDartboard client.

This service intentionally listens on a Unix socket. It accepts a fixed action
enum and never executes browser-supplied commands, paths, image names, or
service names.
"""

import http.cookies
import json
import math
import os
import re
import secrets
import socketserver
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse


SOCKET_PATH = os.environ.get("CONTROL_SOCKET", "/run/opendartboard-control/control.sock")
STATE_PATH = os.environ.get("CONTROL_STATE", "/var/lib/opendartboard-control/state.json")
STABLE_IMAGE = os.environ.get("OPENDARTBOARD_STABLE_IMAGE", "opendartboard:0.1.4")
MODIFIED_IMAGE = os.environ.get("OPENDARTBOARD_MODIFIED_IMAGE", "opendartboard:local")
DATA_DIR = os.environ.get("OPENDARTBOARD_DATA_DIR", "/var/lib/opendartboard")
CONTAINER_NAME = "opendartboard"
AUTODARTS_SERVICE = "autodarts"
DOCKER = os.environ.get("DOCKER_BIN", "/usr/bin/docker")
SYSTEMCTL = os.environ.get("SYSTEMCTL_BIN", "/bin/systemctl")
ANSI_PATTERN = re.compile(r"\x1b\[[0-9;]*m")
SESSION_TTL = 3600
CONFIRMATION_TTL = 60
CAMERAS = ("/dev/video0", "/dev/video1", "/dev/video2")


def configured_number(name, default, minimum, maximum, integer=False):
    raw_value = os.environ.get(name, str(default))
    try:
        value = int(raw_value) if integer else float(raw_value)
    except ValueError:
        raise RuntimeError("{} must be numeric".format(name))
    if not math.isfinite(float(value)) or value < minimum or value > maximum:
        raise RuntimeError("{} must be between {} and {}".format(name, minimum, maximum))
    return str(value)


MOTION_SPIKE_THRESHOLD = configured_number("OPENDARTBOARD_MOTION_SPIKE_THRESHOLD", 0.08, 0.0001, 1.0)
MOTION_LOW_THRESHOLD = configured_number("OPENDARTBOARD_MOTION_LOW_THRESHOLD", 0.001, 0.0, 0.9999)
MOTION_MIN_CAMERAS = configured_number("OPENDARTBOARD_MOTION_MIN_CAMERAS", 2, 1, len(CAMERAS), integer=True)
MOTION_PRETRIGGER_ACTIVITY_RATIO = configured_number(
    "OPENDARTBOARD_MOTION_PRETRIGGER_ACTIVITY_RATIO", 0.005, 0.000001, 1.0
)
if float(MOTION_LOW_THRESHOLD) >= float(MOTION_SPIKE_THRESHOLD):
    raise RuntimeError("OPENDARTBOARD_MOTION_LOW_THRESHOLD must be lower than OPENDARTBOARD_MOTION_SPIKE_THRESHOLD")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def run_fixed(arguments, timeout=25, check=True):
    completed = subprocess.run(
        arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=timeout,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "command failed").strip()
        raise RuntimeError(detail[-500:])
    return completed


def docker(*arguments, **kwargs):
    return run_fixed([DOCKER] + list(arguments), **kwargs)


def systemctl(*arguments, **kwargs):
    return run_fixed([SYSTEMCTL] + list(arguments), **kwargs)


def load_state():
    default = {"release": "modified", "debug": True}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as state_file:
            state = json.load(state_file)
    except (OSError, ValueError):
        return default
    if state.get("release") not in {"stable", "modified"}:
        state["release"] = default["release"]
    state["debug"] = bool(state.get("debug", default["debug"]))
    return state


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), mode=0o750, exist_ok=True)
    temporary_path = STATE_PATH + ".tmp"
    with open(temporary_path, "w", encoding="utf-8") as state_file:
        json.dump(state, state_file, separators=(",", ":"))
        state_file.write("\n")
    os.chmod(temporary_path, 0o600)
    os.replace(temporary_path, STATE_PATH)


def inspect_container():
    result = docker("inspect", CONTAINER_NAME, check=False)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)[0]
    except (ValueError, IndexError, TypeError):
        return None


def container_release(image):
    if image == MODIFIED_IMAGE:
        return "modified"
    if image == STABLE_IMAGE:
        return "stable"
    return "custom" if image else "unknown"


def calibration_from_logs(running):
    if not running:
        return {"state": "unknown", "message": "OpenDartboard is not running.", "cameras": []}
    result = docker("logs", "--tail", "2500", CONTAINER_NAME, check=False, timeout=10)
    logs = ANSI_PATTERN.sub("", (result.stdout or "") + "\n" + (result.stderr or ""))
    cameras = {}
    for camera, orientation in re.findall(r"Camera\s+(\d+)\s+Position:\s+([A-Z]+)", logs):
        cameras.setdefault(int(camera), {})["orientation"] = orientation
    for camera, wedge_index in re.findall(r"Camera\s+(\d+)\s+Wedge 20 Wire Index:\s+(-?\d+)", logs):
        cameras.setdefault(int(camera), {})["wedge20WireIndex"] = int(wedge_index)
    for camera, health, geometry, orientation_health, orientation, wedge_index in re.findall(
        r"CALIBRATION_STATUS\s+camera=(\d+)\s+status=(READY|DEGRADED|INVALID)"
        r"\s+geometry=(valid|invalid)\s+orientation=(valid|invalid)"
        r"\s+camera_position=([A-Z]+)\s+wedge20_wire=(-?\d+)",
        logs,
    ):
        entry = cameras.setdefault(int(camera), {})
        entry.update({
            "orientation": orientation,
            "wedge20WireIndex": int(wedge_index),
            "reportedHealth": health.lower(),
            "geometryValid": geometry == "valid",
            "orientationValid": orientation_health == "valid",
        })

    camera_status = []
    for index in sorted(cameras):
        entry = cameras[index]
        wedge_index = entry.get("wedge20WireIndex", -1)
        orientation = entry.get("orientation", "UNKNOWN")
        reported_health = entry.get("reportedHealth")
        geometry_valid = entry.get("geometryValid")
        orientation_valid = entry.get("orientationValid")
        ready = (
            orientation != "UNKNOWN"
            and wedge_index >= 0
            and reported_health in {None, "ready"}
            and geometry_valid is not False
            and orientation_valid is not False
        )
        # Older releases do not emit explicit health fields. Only infer ring
        # geometry from a complete legacy calibration; never claim that an
        # unknown legacy camera can participate in ring consensus.
        if geometry_valid is None:
            geometry_valid = ready
        if orientation_valid is None:
            orientation_valid = ready
        contribution = "full" if ready else "ring" if geometry_valid else "unavailable"
        camera_status.append({
            "camera": index,
            "orientation": orientation,
            "wedge20WireIndex": wedge_index,
            "ready": ready,
            "geometryValid": geometry_valid,
            "orientationValid": orientation_valid,
            "contribution": contribution,
        })

    if "Capturing frames for calibration" in logs and "DARTBOARD CALIBRATION COMPLETED" not in logs:
        return {"state": "calibrating", "message": "Capturing a clean board and locating rings and wires.", "cameras": camera_status}
    latest_cameras = camera_status[-len(CAMERAS):]
    full_count = sum(1 for camera in latest_cameras if camera["contribution"] == "full")
    ring_count = sum(1 for camera in latest_cameras if camera["contribution"] == "ring")
    contributing_count = full_count + ring_count
    if (
        len(latest_cameras) >= len(CAMERAS)
        and contributing_count == len(CAMERAS)
        and full_count > 0
    ):
        message = (
            "All {} cameras contribute to scoring: {} maps wedge numbers and {} provide ring consensus."
        ).format(len(CAMERAS), full_count, ring_count)
        return {"state": "ready", "message": message, "cameras": latest_cameras}
    if camera_status:
        if full_count > 0:
            message = (
                "{} of {} cameras contribute to scoring: {} maps wedge numbers and {} provide ring consensus."
            ).format(contributing_count, len(CAMERAS), full_count, ring_count)
        else:
            message = "0 of {} cameras are scoring-ready; numbered scoring is unavailable.".format(len(CAMERAS))
        return {
            "state": "degraded",
            "message": message,
            "cameras": latest_cameras,
        }
    return {"state": "unknown", "message": "Waiting for calibration diagnostics.", "cameras": []}


def board_status():
    inspected = inspect_container()
    exists = inspected is not None
    running = bool(inspected and inspected.get("State", {}).get("Running"))
    image = inspected.get("Config", {}).get("Image") if inspected else None
    command = inspected.get("Config", {}).get("Cmd") or [] if inspected else []
    autodarts_result = systemctl("is-active", AUTODARTS_SERVICE, check=False, timeout=5)
    autodarts_active = autodarts_result.stdout.strip() == "active"
    if running:
        mode = "opendartboard"
    elif autodarts_active:
        mode = "autodarts"
    else:
        mode = "offline"
    return {
        "mode": mode,
        "opendartboard": {
            "exists": exists,
            "running": running,
            "image": image,
            "release": container_release(image),
            "debug": "--debug" in command,
        },
        "autodarts": {"active": autodarts_active},
        "calibration": calibration_from_logs(running),
        "updatedAt": utc_now(),
    }


def stop_opendartboard():
    docker("stop", "--time", "5", CONTAINER_NAME, check=False, timeout=15)


def recreate_opendartboard(state, start=True):
    image = MODIFIED_IMAGE if state["release"] == "modified" else STABLE_IMAGE
    stop_opendartboard()
    docker("rm", "--force", CONTAINER_NAME, check=False, timeout=15)
    arguments = [
        "create", "--name", CONTAINER_NAME, "--network", "host",
        "--restart", "unless-stopped",
    ]
    for camera in CAMERAS:
        arguments.extend(["--device", "{}:{}".format(camera, camera)])
    arguments.extend(["--volume", "{}:/var/lib/opendartboard".format(DATA_DIR), image])
    if state["debug"]:
        arguments.append("--debug")
    arguments.extend(["--autocams", "--width", "1280", "--height", "720", "--fps", "30"])
    if state["release"] == "modified":
        arguments.extend([
            "--motion-spike-threshold", MOTION_SPIKE_THRESHOLD,
            "--motion-low-threshold", MOTION_LOW_THRESHOLD,
            "--motion-min-cameras", MOTION_MIN_CAMERAS,
            "--motion-pretrigger-activity-ratio", MOTION_PRETRIGGER_ACTIVITY_RATIO,
        ])
    docker(*arguments, timeout=30)
    save_state(state)
    if start:
        docker("start", CONTAINER_NAME, timeout=20)


def perform_action(action, parameters):
    state = load_state()
    if action == "calibrate":
        systemctl("stop", AUTODARTS_SERVICE, timeout=20)
        inspected = inspect_container()
        if inspected is None:
            recreate_opendartboard(state)
        else:
            docker("restart", "--time", "5", CONTAINER_NAME, timeout=30)
        return "Calibration started. Keep the board clear while the cameras settle."
    if action == "scorer.restart":
        systemctl("stop", AUTODARTS_SERVICE, timeout=20)
        inspected = inspect_container()
        if inspected is None:
            recreate_opendartboard(state)
        else:
            docker("restart", "--time", "5", CONTAINER_NAME, timeout=30)
        return "OpenDartboard restarted."
    if action == "debug.set":
        enabled = parameters.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        state["debug"] = enabled
        systemctl("stop", AUTODARTS_SERVICE, timeout=20)
        recreate_opendartboard(state)
        return "Diagnostic streams {}.".format("enabled" if enabled else "disabled")
    if action == "scorer.version":
        target = parameters.get("target")
        if target not in {"stable", "modified"}:
            raise ValueError("target must be stable or modified")
        state["release"] = target
        systemctl("stop", AUTODARTS_SERVICE, timeout=20)
        recreate_opendartboard(state)
        return "Now running the {} OpenDartboard scorer.".format(target)
    if action == "mode.set":
        target = parameters.get("target")
        if target == "autodarts":
            stop_opendartboard()
            systemctl("start", AUTODARTS_SERVICE, timeout=30)
            return "Autodarts now owns the cameras."
        if target == "opendartboard":
            systemctl("stop", AUTODARTS_SERVICE, timeout=20)
            inspected = inspect_container()
            if inspected is None:
                recreate_opendartboard(state)
            else:
                docker("start", CONTAINER_NAME, timeout=20)
            return "OpenDartboard now owns the cameras."
        raise ValueError("target must be autodarts or opendartboard")
    raise ValueError("Unsupported action")


ACTION_COPY = {
    "calibrate": (
        "Restart OpenDartboard and capture a clean-board calibration.",
        ["Scoring will be unavailable briefly.", "The board must be completely empty."],
        ["boardEmpty"],
    ),
    "scorer.restart": (
        "Restart the OpenDartboard scorer.",
        ["The live scoring connection will briefly disconnect."],
        [],
    ),
    "debug.set": (
        "Restart OpenDartboard with the selected diagnostic setting.",
        ["The live scoring connection will briefly disconnect."],
        [],
    ),
    "scorer.version": (
        "Recreate OpenDartboard using the selected scorer image.",
        ["The current scorer container will be replaced.", "Saved match history and calibration data remain on disk."],
        [],
    ),
    "mode.set": (
        "Transfer the cameras to the selected scoring service.",
        ["The currently active scorer will stop first.", "Any live game in that scorer will be interrupted."],
        [],
    ),
}


class ControlState:
    def __init__(self):
        self.sessions = {}
        self.confirmations = {}
        self.idempotency = {}
        self.lock = threading.Lock()
        self.operation_lock = threading.Lock()

    def purge(self):
        now = time.time()
        self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
        self.confirmations = {
            key: value for key, value in self.confirmations.items() if value["expires"] > now
        }
        self.idempotency = {
            key: value for key, value in self.idempotency.items() if value["expires"] > now
        }


CONTROL_STATE = ControlState()


class ControlHandler(BaseHTTPRequestHandler):
    server_version = "OpenDartboardControl/1.0"

    def send_json(self, status, payload, session_id=None):
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if session_id:
            self.send_header(
                "Set-Cookie",
                "ODBCONTROL_SESSION={}; HttpOnly; SameSite=Strict; Path=/api/control/v1; Max-Age={}".format(session_id, SESSION_TTL),
            )
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            raise ValueError("A small JSON request body is required")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def get_session(self, create=False):
        cookie = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("ODBCONTROL_SESSION")
        session_id = morsel.value if morsel else None
        with CONTROL_STATE.lock:
            CONTROL_STATE.purge()
            if session_id in CONTROL_STATE.sessions:
                CONTROL_STATE.sessions[session_id] = time.time() + SESSION_TTL
                return session_id, False
            if create:
                session_id = secrets.token_urlsafe(32)
                CONTROL_STATE.sessions[session_id] = time.time() + SESSION_TTL
                return session_id, True
        return None, False

    def require_same_origin(self):
        if self.headers.get("X-OpenDartboard-Action") != "1":
            raise PermissionError("Missing action header")
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if not host or origin not in {"http://" + host, "https://" + host}:
            raise PermissionError("Origin does not match this board")

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path != "/api/control/v1/status":
            self.send_json(404, {"error": "Not found"})
            return
        session_id, created = self.get_session(create=True)
        try:
            self.send_json(200, board_status(), session_id if created else None)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            self.send_json(503, {"error": "Could not read board status", "detail": str(error)[-200:]}, session_id if created else None)

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        try:
            self.require_same_origin()
            session_id, _ = self.get_session(create=False)
            if not session_id:
                self.send_json(401, {"error": "Refresh board status before performing an action"})
                return
            if path == "/api/control/v1/actions/prepare":
                self.prepare_action(session_id)
                return
            match = re.fullmatch(r"/api/control/v1/actions/([A-Za-z0-9_-]{20,100})/execute", path)
            if match:
                self.execute_action(session_id, match.group(1))
                return
            self.send_json(404, {"error": "Not found"})
        except PermissionError as error:
            self.send_json(403, {"error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error": "The board operation timed out"})
        except RuntimeError as error:
            self.send_json(500, {"error": "The board operation failed", "detail": str(error)[-200:]})

    def prepare_action(self, session_id):
        payload = self.read_json()
        action = payload.get("action")
        parameters = payload.get("parameters") or {}
        if action not in ACTION_COPY or not isinstance(parameters, dict):
            raise ValueError("Unsupported action")
        # Validate the only parameterized values before storing the request.
        if action == "debug.set" and not isinstance(parameters.get("enabled"), bool):
            raise ValueError("enabled must be true or false")
        if action == "scorer.version" and parameters.get("target") not in {"stable", "modified"}:
            raise ValueError("target must be stable or modified")
        if action == "mode.set" and parameters.get("target") not in {"autodarts", "opendartboard"}:
            raise ValueError("target must be autodarts or opendartboard")
        if action in {"calibrate", "scorer.restart"} and parameters:
            raise ValueError("This action does not accept parameters")

        confirmation_id = secrets.token_urlsafe(32)
        summary, consequences, acknowledgements = ACTION_COPY[action]
        with CONTROL_STATE.lock:
            CONTROL_STATE.confirmations[confirmation_id] = {
                "session": session_id,
                "action": action,
                "parameters": parameters,
                "acknowledgements": acknowledgements,
                "expires": time.time() + CONFIRMATION_TTL,
            }
        self.send_json(200, {
            "confirmationId": confirmation_id,
            "action": action,
            "summary": summary,
            "consequences": consequences,
            "requiredAcknowledgements": acknowledgements,
            "expiresAt": datetime.fromtimestamp(time.time() + CONFIRMATION_TTL, timezone.utc).isoformat(),
        })

    def execute_action(self, session_id, confirmation_id):
        payload = self.read_json()
        idempotency_key = str(payload.get("idempotencyKey", ""))
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", idempotency_key):
            raise ValueError("A valid idempotencyKey is required")
        with CONTROL_STATE.lock:
            previous = CONTROL_STATE.idempotency.get(idempotency_key)
            if previous:
                self.send_json(previous["status"], previous["payload"])
                return
            confirmation = CONTROL_STATE.confirmations.pop(confirmation_id, None)
        if not confirmation or confirmation["session"] != session_id or confirmation["expires"] <= time.time():
            self.send_json(410, {"error": "Confirmation expired; prepare the action again"})
            return
        acknowledgements = payload.get("acknowledgements") or {}
        missing = [name for name in confirmation["acknowledgements"] if acknowledgements.get(name) is not True]
        if missing:
            self.send_json(412, {"error": "Required acknowledgement missing", "required": missing})
            return
        if not CONTROL_STATE.operation_lock.acquire(False):
            self.send_json(409, {"error": "Another board operation is already running"})
            return
        try:
            message = perform_action(confirmation["action"], confirmation["parameters"])
            response = {"ok": True, "message": message, "completedAt": utc_now()}
            status = 200
        finally:
            CONTROL_STATE.operation_lock.release()
        with CONTROL_STATE.lock:
            CONTROL_STATE.idempotency[idempotency_key] = {
                "status": status,
                "payload": response,
                "expires": time.time() + SESSION_TTL,
            }
        self.send_json(status, response)

    def log_message(self, template, *args):
        # Unix-domain clients do not have the (host, port) tuple expected by
        # BaseHTTPRequestHandler.address_string(), especially on Python 3.6.
        client = self.headers.get("X-Real-IP", "local-socket")
        print("{} - {}".format(client, template % args), flush=True)


class ThreadingUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def run():
    socket_directory = os.path.dirname(SOCKET_PATH)
    os.makedirs(socket_directory, mode=0o755, exist_ok=True)
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    server = ThreadingUnixServer(SOCKET_PATH, ControlHandler)
    os.chmod(SOCKET_PATH, 0o666)
    print("OpenDartboard control service listening on {}".format(SOCKET_PATH), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    run()
