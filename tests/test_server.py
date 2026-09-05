import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone


PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "server"))

from app import StatsDatabase  # noqa: E402


def completed_match():
    return {
        "id": "match_test_001",
        "status": "completed",
        "startedAt": "2026-09-04T12:00:00+00:00",
        "completedAt": "2026-09-04T12:15:00+00:00",
        "config": {
            "mode": "501",
            "inRule": "straight",
            "outRule": "double",
            "players": ["Alice", "Bob"],
        },
        "winner": 0,
        "players": [
            {
                "name": "Alice", "score": 0, "dartsThrown": 15,
                "totalScored": 501, "marksThrown": 0, "completedVisits": 5,
            },
            {
                "name": "Bob", "score": 141, "dartsThrown": 15,
                "totalScored": 360, "marksThrown": 0, "completedVisits": 5,
            },
        ],
        "visits": [
            {
                "playerIndex": 0, "playerName": "Alice", "darts": ["T20", "T20", "T20"],
                "score": 180, "bust": False, "remaining": 321,
                "createdAt": "2026-09-04T12:01:00+00:00",
            },
            {
                "playerIndex": 1, "playerName": "Bob", "darts": ["T20", "S20", "D20"],
                "score": 120, "bust": False, "remaining": 381,
                "createdAt": "2026-09-04T12:02:00+00:00",
            },
        ],
    }


class StatsDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = StatsDatabase(os.path.join(self.temp_dir.name, "stats.db"))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_completed_match_builds_player_profiles_and_history(self):
        result = self.database.sync_match(completed_match())
        self.assertTrue(result["ok"])

        stats = self.database.stats()
        self.assertEqual(stats["overview"]["games"], 1)
        self.assertEqual(stats["overview"]["players"], 2)
        self.assertEqual(stats["overview"]["darts"], 30)
        self.assertEqual(stats["players"][0]["name"], "Alice")
        self.assertEqual(stats["players"][0]["wins"], 1)
        self.assertEqual(stats["players"][0]["x01Average"], 100.2)
        self.assertEqual(stats["matches"][0]["players"][0]["outcome"], "win")

    def test_resync_replaces_visits_instead_of_duplicating_them(self):
        payload = completed_match()
        self.database.sync_match(payload)
        payload["visits"] = payload["visits"][:1]
        self.database.sync_match(payload)

        with self.database.connect() as connection:
            visit_count = connection.execute(
                "SELECT COUNT(*) FROM visits WHERE match_id = ?",
                (payload["id"],),
            ).fetchone()[0]
        self.assertEqual(visit_count, 1)

    def test_active_matches_do_not_change_lifetime_stats(self):
        payload = completed_match()
        payload["id"] = "match_active_001"
        payload["status"] = "active"
        payload["winner"] = None
        payload["completedAt"] = None
        self.database.sync_match(payload)

        stats = self.database.stats()
        self.assertEqual(stats["overview"]["games"], 0)
        self.assertEqual(stats["players"], [])

    def test_structured_darts_power_exact_and_estimated_heatmap_data(self):
        payload = completed_match()
        payload["visits"][0]["darts"] = ["T20", "S16", "MISS"]
        payload["visits"][0]["dartDetails"] = [
            {
                "label": "T20", "boardPosition": {"x": 0.02, "y": -0.6},
                "inputSource": "board", "thrownAt": "2026-09-04T12:01:01Z",
            },
            {
                "label": "S16", "inputSource": "manual",
                "thrownAt": "2026-09-04T12:01:02Z",
            },
            {
                "label": "MISS", "inputSource": "board",
                "thrownAt": "2026-09-04T12:01:03Z",
            },
        ]
        self.database.sync_match(payload)
        player_id = self.database.stats()["players"][0]["id"]

        heatmap = self.database.heatmap(
            player_id, "7d", datetime(2026, 9, 5, tzinfo=timezone.utc),
        )
        self.assertEqual(heatmap["exactPoints"][0]["label"], "T20")
        self.assertEqual(heatmap["exactPoints"][0]["x"], 0.02)
        self.assertEqual(heatmap["estimatedBeds"], [{"label": "S16", "count": 1}])
        self.assertEqual(
            heatmap["totals"], {"darts": 3, "exact": 1, "estimated": 1, "unplottable": 1},
        )

    def test_period_filter_excludes_older_throws(self):
        self.database.sync_match(completed_match())
        player_id = self.database.stats()["players"][0]["id"]
        now = datetime(2026, 10, 20, tzinfo=timezone.utc)

        self.assertEqual(self.database.heatmap(player_id, "30d", now)["totals"]["darts"], 0)
        self.assertEqual(self.database.heatmap(player_id, "all", now)["totals"]["darts"], 3)

    def test_active_darts_are_provisional_and_replaced_on_resync(self):
        payload = completed_match()
        payload["id"] = "match_active_darts"
        payload["status"] = "active"
        payload["winner"] = None
        payload["completedAt"] = None
        payload["visits"] = []
        payload["activePlayer"] = 1
        payload["darts"] = [{
            "label": "D20", "boardPosition": {"x": 0.4, "y": -0.3},
            "inputSource": "board", "thrownAt": "2026-09-05T12:00:00Z",
        }]
        self.database.sync_match(payload)
        self.database.sync_match(payload)

        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count, MAX(provisional) AS provisional FROM dart_throws WHERE match_id = ?",
                (payload["id"],),
            ).fetchone()
        self.assertEqual(row["count"], 1)
        self.assertEqual(row["provisional"], 1)

    def test_legacy_visits_remain_honest_bed_estimates(self):
        self.database.sync_match(completed_match())
        player_id = self.database.stats()["players"][0]["id"]
        heatmap = self.database.heatmap(player_id, "all")

        self.assertEqual(heatmap["exactPoints"], [])
        self.assertEqual(heatmap["estimatedBeds"], [{"label": "T20", "count": 3}])


if __name__ == "__main__":
    unittest.main()
