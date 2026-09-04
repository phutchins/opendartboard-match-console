import os
import sys
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()
