import os
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "server"))

import board_control  # noqa: E402


class Result:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class BoardControlTests(unittest.TestCase):
    def test_calibration_logs_mark_unknown_orientation_degraded(self):
        logs = """
        Camera 0 Position: UNKNOWN
        Camera 0 Wedge 20 Wire Index: -1
        Camera 1 Position: TOP
        Camera 1 Wedge 20 Wire Index: 4
        Camera 2 Position: BOTTOM
        Camera 2 Wedge 20 Wire Index: 17
        DARTBOARD CALIBRATION COMPLETED
        """
        with patch.object(board_control, "docker", return_value=Result(stdout=logs)):
            status = board_control.calibration_from_logs(True)

        self.assertEqual(status["state"], "degraded")
        self.assertEqual(len(status["cameras"]), 3)
        self.assertFalse(status["cameras"][0]["ready"])
        self.assertTrue(status["cameras"][1]["ready"])
        self.assertIn("single-camera scoring is active", status["message"])

    def test_calibration_logs_accept_all_oriented_cameras(self):
        logs = "\n".join(
            "CALIBRATION_STATUS camera={} status=READY geometry=valid orientation=valid "
            "camera_position={} wedge20_wire={} south_wire=9 wires_valid=true".format(
                index, orientation, index + 2
            )
            for index, orientation in enumerate(("TOP", "MIDDLE", "BOTTOM"))
        )
        with patch.object(board_control, "docker", return_value=Result(stdout=logs)):
            status = board_control.calibration_from_logs(True)

        self.assertEqual(status["state"], "ready")
        self.assertTrue(all(camera["ready"] for camera in status["cameras"]))

    def test_calibration_logs_reject_degraded_orientation(self):
        logs = """
        CALIBRATION_STATUS camera=0 status=READY geometry=valid orientation=valid camera_position=TOP wedge20_wire=2 south_wire=12 wires_valid=true
        CALIBRATION_STATUS camera=1 status=DEGRADED geometry=valid orientation=invalid camera_position=UNKNOWN wedge20_wire=-1 south_wire=-1 wires_valid=true
        CALIBRATION_STATUS camera=2 status=READY geometry=valid orientation=valid camera_position=BOTTOM wedge20_wire=17 south_wire=7 wires_valid=true
        """
        with patch.object(board_control, "docker", return_value=Result(stdout=logs)):
            status = board_control.calibration_from_logs(True)

        self.assertEqual(status["state"], "degraded")
        self.assertFalse(status["cameras"][1]["ready"])
        self.assertIn("single-camera scoring is active", status["message"])

    def test_calibration_logs_report_numbered_scoring_unavailable_without_ready_camera(self):
        logs = """
        CALIBRATION_STATUS camera=0 status=INVALID geometry=invalid orientation=invalid camera_position=UNKNOWN wedge20_wire=-1 south_wire=-1 wires_valid=false
        CALIBRATION_STATUS camera=1 status=DEGRADED geometry=valid orientation=invalid camera_position=MIDDLE wedge20_wire=-1 south_wire=19 wires_valid=true
        CALIBRATION_STATUS camera=2 status=INVALID geometry=invalid orientation=invalid camera_position=UNKNOWN wedge20_wire=-1 south_wire=-1 wires_valid=false
        """
        with patch.object(board_control, "docker", return_value=Result(stdout=logs)):
            status = board_control.calibration_from_logs(True)

        self.assertEqual(status["state"], "degraded")
        self.assertIn("numbered scoring is unavailable", status["message"])

    def test_action_enum_rejects_unknown_commands(self):
        with self.assertRaisesRegex(ValueError, "Unsupported action"):
            board_control.perform_action("shell.run", {"command": "anything"})

    def test_switch_to_autodarts_uses_only_fixed_commands(self):
        calls = []

        def fake_docker(*arguments, **kwargs):
            calls.append(("docker", arguments))
            return Result()

        def fake_systemctl(*arguments, **kwargs):
            calls.append(("systemctl", arguments))
            return Result()

        with patch.object(board_control, "docker", side_effect=fake_docker), patch.object(
            board_control, "systemctl", side_effect=fake_systemctl
        ):
            message = board_control.perform_action("mode.set", {"target": "autodarts"})

        self.assertIn("Autodarts", message)
        self.assertIn(("docker", ("stop", "--time", "5", "opendartboard")), calls)
        self.assertIn(("systemctl", ("start", "autodarts")), calls)

    def test_modified_scorer_receives_host_motion_tuning(self):
        calls = []

        def fake_docker(*arguments, **kwargs):
            calls.append(arguments)
            return Result()

        state = {"release": "modified", "debug": True}
        with patch.object(board_control, "docker", side_effect=fake_docker), patch.object(
            board_control, "save_state"
        ), patch.object(board_control, "MOTION_SPIKE_THRESHOLD", "0.003"), patch.object(
            board_control, "MOTION_LOW_THRESHOLD", "0.0005"
        ), patch.object(board_control, "MOTION_MIN_CAMERAS", "2"):
            board_control.recreate_opendartboard(state)

        create_call = next(arguments for arguments in calls if arguments[0] == "create")
        self.assertIn("--motion-spike-threshold", create_call)
        self.assertEqual(create_call[create_call.index("--motion-spike-threshold") + 1], "0.003")
        self.assertEqual(create_call[create_call.index("--motion-low-threshold") + 1], "0.0005")
        self.assertEqual(create_call[create_call.index("--motion-min-cameras") + 1], "2")

    def test_stable_scorer_does_not_receive_modified_only_motion_flags(self):
        calls = []

        def fake_docker(*arguments, **kwargs):
            calls.append(arguments)
            return Result()

        with patch.object(board_control, "docker", side_effect=fake_docker), patch.object(
            board_control, "save_state"
        ):
            board_control.recreate_opendartboard({"release": "stable", "debug": False})

        create_call = next(arguments for arguments in calls if arguments[0] == "create")
        self.assertNotIn("--motion-spike-threshold", create_call)


if __name__ == "__main__":
    unittest.main()
