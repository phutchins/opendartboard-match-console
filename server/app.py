import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


MATCH_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
VALID_MODES = {"301", "501", "cricket"}
VALID_RULES = {"straight", "double"}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def normalized_name(name):
    return " ".join(name.strip().lower().split())


def safe_int(value, minimum=0, maximum=1_000_000):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return minimum
    return max(minimum, min(maximum, parsed))


class StatsDatabase:
    def __init__(self, path):
        self.path = path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.initialize()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        return connection

    def initialize(self):
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS players (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS matches (
                    id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL CHECK (mode IN ('301', '501', 'cricket')),
                    in_rule TEXT NOT NULL,
                    out_rule TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
                    winner_player_id INTEGER REFERENCES players(id),
                    started_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS match_players (
                    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
                    player_id INTEGER NOT NULL REFERENCES players(id),
                    seat INTEGER NOT NULL,
                    final_score INTEGER NOT NULL,
                    darts_thrown INTEGER NOT NULL,
                    total_scored INTEGER NOT NULL,
                    marks_thrown INTEGER NOT NULL,
                    completed_visits INTEGER NOT NULL,
                    highest_visit INTEGER NOT NULL,
                    outcome TEXT,
                    PRIMARY KEY (match_id, player_id)
                );

                CREATE TABLE IF NOT EXISTS visits (
                    id INTEGER PRIMARY KEY,
                    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
                    player_id INTEGER NOT NULL REFERENCES players(id),
                    visit_number INTEGER NOT NULL,
                    scored INTEGER NOT NULL,
                    bust INTEGER NOT NULL,
                    remaining INTEGER NOT NULL,
                    darts_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE (match_id, visit_number)
                );

                CREATE INDEX IF NOT EXISTS idx_matches_status_started
                ON matches(status, started_at DESC);

                CREATE INDEX IF NOT EXISTS idx_match_players_player
                ON match_players(player_id, match_id);

                CREATE INDEX IF NOT EXISTS idx_visits_match_player
                ON visits(match_id, player_id);
                """
            )
            connection.execute("PRAGMA optimize")

    def validate_match(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Match payload must be an object")
        match_id = str(payload.get("id", ""))
        if not MATCH_ID_PATTERN.match(match_id):
            raise ValueError("Invalid match id")

        config = payload.get("config") or {}
        mode = config.get("mode")
        if mode not in VALID_MODES:
            raise ValueError("Invalid game mode")
        in_rule = config.get("inRule")
        out_rule = config.get("outRule")
        if in_rule not in VALID_RULES or out_rule not in VALID_RULES:
            raise ValueError("Invalid match rules")

        players = payload.get("players")
        if not isinstance(players, list) or not 1 <= len(players) <= 4:
            raise ValueError("A match requires one to four players")
        clean_players = []
        seen_names = set()
        for player in players:
            name = str((player or {}).get("name", "")).strip()[:50]
            key = normalized_name(name)
            if not key:
                raise ValueError("Player names cannot be empty")
            if key in seen_names:
                raise ValueError("Player names must be unique within a match")
            seen_names.add(key)
            clean_players.append({**player, "name": name, "key": key})

        visits = payload.get("visits") or []
        if not isinstance(visits, list) or len(visits) > 1000:
            raise ValueError("Invalid visit history")
        status = payload.get("status", "active")
        if status not in {"active", "completed", "abandoned"}:
            raise ValueError("Invalid match status")

        return {
            "id": match_id,
            "mode": mode,
            "in_rule": in_rule,
            "out_rule": out_rule,
            "status": status,
            "players": clean_players,
            "visits": visits,
            "winner": payload.get("winner"),
            "started_at": str(payload.get("startedAt") or utc_now()),
            "completed_at": payload.get("completedAt"),
        }

    def sync_match(self, payload):
        match = self.validate_match(payload)
        now = utc_now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            player_ids = []
            for player in match["players"]:
                connection.execute(
                    """
                    INSERT INTO players(name, normalized_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(normalized_name) DO UPDATE SET
                        name = excluded.name,
                        updated_at = excluded.updated_at
                    """,
                    (player["name"], player["key"], now, now),
                )
                row = connection.execute(
                    "SELECT id FROM players WHERE normalized_name = ?",
                    (player["key"],),
                ).fetchone()
                player_ids.append(row["id"])

            winner_index = match["winner"]
            winner_player_id = None
            if isinstance(winner_index, int) and 0 <= winner_index < len(player_ids):
                winner_player_id = player_ids[winner_index]

            completed_at = match["completed_at"]
            if match["status"] == "completed" and not completed_at:
                completed_at = now

            connection.execute(
                """
                INSERT INTO matches(
                    id, mode, in_rule, out_rule, status, winner_player_id,
                    started_at, updated_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    mode = excluded.mode,
                    in_rule = excluded.in_rule,
                    out_rule = excluded.out_rule,
                    status = excluded.status,
                    winner_player_id = excluded.winner_player_id,
                    updated_at = excluded.updated_at,
                    completed_at = excluded.completed_at
                """,
                (
                    match["id"], match["mode"], match["in_rule"], match["out_rule"],
                    match["status"], winner_player_id, match["started_at"], now, completed_at,
                ),
            )
            connection.execute("DELETE FROM visits WHERE match_id = ?", (match["id"],))
            connection.execute("DELETE FROM match_players WHERE match_id = ?", (match["id"],))

            highest_visits = {index: 0 for index in range(len(player_ids))}
            for sequence, visit in enumerate(match["visits"], start=1):
                player_index = safe_int((visit or {}).get("playerIndex"), 0, len(player_ids) - 1)
                scored = safe_int((visit or {}).get("score"))
                remaining = safe_int((visit or {}).get("remaining"))
                darts = (visit or {}).get("darts") or []
                clean_darts = [str(dart)[:12] for dart in darts[:3]]
                highest_visits[player_index] = max(highest_visits[player_index], scored)
                connection.execute(
                    """
                    INSERT INTO visits(
                        match_id, player_id, visit_number, scored, bust,
                        remaining, darts_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        match["id"], player_ids[player_index], sequence, scored,
                        1 if (visit or {}).get("bust") else 0, remaining,
                        json.dumps(clean_darts, separators=(",", ":")),
                        str((visit or {}).get("createdAt") or now),
                    ),
                )

            for index, player in enumerate(match["players"]):
                outcome = "win" if winner_player_id == player_ids[index] else (
                    "loss" if match["status"] == "completed" else None
                )
                connection.execute(
                    """
                    INSERT INTO match_players(
                        match_id, player_id, seat, final_score, darts_thrown,
                        total_scored, marks_thrown, completed_visits,
                        highest_visit, outcome
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        match["id"], player_ids[index], index,
                        safe_int(player.get("score")), safe_int(player.get("dartsThrown")),
                        safe_int(player.get("totalScored")), safe_int(player.get("marksThrown")),
                        safe_int(player.get("completedVisits")), highest_visits[index], outcome,
                    ),
                )

            connection.commit()
        return {"ok": True, "matchId": match["id"], "savedAt": now}

    def stats(self):
        with self.connect() as connection:
            overview_row = connection.execute(
                """
                SELECT
                    COUNT(DISTINCT m.id) AS games,
                    COUNT(DISTINCT mp.player_id) AS players,
                    COALESCE(SUM(mp.darts_thrown), 0) AS darts,
                    COALESCE(SUM(mp.completed_visits), 0) AS visits
                FROM matches m
                LEFT JOIN match_players mp ON mp.match_id = m.id
                WHERE m.status = 'completed'
                """
            ).fetchone()

            player_rows = connection.execute(
                """
                SELECT
                    p.id,
                    p.name,
                    COUNT(*) AS games,
                    SUM(CASE WHEN mp.outcome = 'win' THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN m.mode IN ('301', '501') THEN mp.darts_thrown ELSE 0 END) AS x01_darts,
                    SUM(CASE WHEN m.mode IN ('301', '501') THEN mp.total_scored ELSE 0 END) AS x01_scored,
                    MAX(CASE WHEN m.mode IN ('301', '501') AND mp.darts_thrown > 0
                        THEN (mp.total_scored * 3.0 / mp.darts_thrown) END) AS best_x01_average,
                    MAX(CASE WHEN m.mode IN ('301', '501') THEN mp.highest_visit END) AS highest_visit,
                    SUM(CASE WHEN m.mode = 'cricket' THEN mp.darts_thrown ELSE 0 END) AS cricket_darts,
                    SUM(CASE WHEN m.mode = 'cricket' THEN mp.marks_thrown ELSE 0 END) AS cricket_marks,
                    MAX(m.completed_at) AS last_played
                FROM players p
                JOIN match_players mp ON mp.player_id = p.id
                JOIN matches m ON m.id = mp.match_id
                WHERE m.status = 'completed'
                GROUP BY p.id, p.name
                ORDER BY wins DESC, x01_scored DESC, p.name COLLATE NOCASE
                """
            ).fetchall()

            match_rows = connection.execute(
                """
                SELECT
                    m.id, m.mode, m.in_rule, m.out_rule, m.started_at, m.completed_at,
                    mp.seat, mp.final_score, mp.darts_thrown, mp.total_scored,
                    mp.marks_thrown, mp.completed_visits, mp.highest_visit, mp.outcome,
                    p.name
                FROM matches m
                JOIN match_players mp ON mp.match_id = m.id
                JOIN players p ON p.id = mp.player_id
                WHERE m.id IN (
                    SELECT id FROM matches
                    WHERE status = 'completed'
                    ORDER BY completed_at DESC
                    LIMIT 20
                )
                ORDER BY m.completed_at DESC, mp.seat ASC
                """
            ).fetchall()

        players = []
        for row in player_rows:
            x01_darts = row["x01_darts"] or 0
            cricket_darts = row["cricket_darts"] or 0
            games = row["games"] or 0
            wins = row["wins"] or 0
            players.append({
                "id": row["id"],
                "name": row["name"],
                "games": games,
                "wins": wins,
                "winRate": round(wins * 100 / games, 1) if games else 0,
                "x01Average": round((row["x01_scored"] or 0) * 3 / x01_darts, 2) if x01_darts else None,
                "bestX01Average": round(row["best_x01_average"], 2) if row["best_x01_average"] is not None else None,
                "highestVisit": row["highest_visit"],
                "cricketMpr": round((row["cricket_marks"] or 0) * 3 / cricket_darts, 2) if cricket_darts else None,
                "darts": x01_darts + cricket_darts,
                "lastPlayed": row["last_played"],
            })

        matches_by_id = {}
        for row in match_rows:
            item = matches_by_id.setdefault(row["id"], {
                "id": row["id"],
                "mode": row["mode"],
                "inRule": row["in_rule"],
                "outRule": row["out_rule"],
                "startedAt": row["started_at"],
                "completedAt": row["completed_at"],
                "players": [],
            })
            darts = row["darts_thrown"] or 0
            is_cricket = row["mode"] == "cricket"
            numerator = row["marks_thrown"] if is_cricket else row["total_scored"]
            item["players"].append({
                "name": row["name"],
                "finalScore": row["final_score"],
                "darts": darts,
                "visits": row["completed_visits"],
                "highestVisit": row["highest_visit"],
                "outcome": row["outcome"],
                "rate": round((numerator or 0) * 3 / darts, 2) if darts else None,
            })

        return {
            "overview": dict(overview_row),
            "players": players,
            "matches": list(matches_by_id.values()),
            "generatedAt": utc_now(),
        }


class ApiHandler(BaseHTTPRequestHandler):
    database = None
    server_version = "OpenDartboardStats/1.0"

    def send_json(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = safe_int(self.headers.get("Content-Length"), 0, 1_000_000)
        if length <= 0:
            raise ValueError("Request body is required")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/api/health":
            self.send_json(200, {"status": "ok", "service": "OpenDartboard Stats"})
            return
        if path == "/api/stats":
            self.send_json(200, self.database.stats())
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path != "/api/matches/sync":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            result = self.database.sync_match(self.read_json())
            self.send_json(200, result)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except sqlite3.Error:
            self.send_json(500, {"error": "Could not save match data"})

    def log_message(self, template, *args):
        print(f"{self.address_string()} - {template % args}", flush=True)


def run():
    database_path = os.environ.get("DB_PATH", "/data/stats.db")
    port = safe_int(os.environ.get("PORT", "8091"), 1, 65535)
    ApiHandler.database = StatsDatabase(database_path)
    server = ThreadingHTTPServer(("0.0.0.0", port), ApiHandler)
    print(f"OpenDartboard Stats listening on {port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
