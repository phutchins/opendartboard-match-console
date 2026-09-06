import json
import os
import re
import uuid
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


MATCH_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
VALID_MODES = {"301", "501", "cricket"}
VALID_RULES = {"straight", "double"}
VALID_PERIODS = {"7d": 7, "30d": 30, "90d": 90, "1y": 365, "all": None}
SCORE_PATTERN = re.compile(r"^(?:MISS|BULL|OUTER|[SDT](?:[1-9]|1[0-9]|20))$")
INPUT_SOURCES = {"board", "manual", "unknown", "legacy"}
PROFILE_ID_PATTERN = re.compile(r"^[a-f0-9-]{32,36}$")
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def normalized_name(name):
    return " ".join(name.strip().lower().split())


def clean_email(value):
    email = str(value or "").strip().lower()[:254]
    if not email:
        return None
    if not EMAIL_PATTERN.match(email):
        raise ValueError("Enter a valid email address")
    return email


def safe_int(value, minimum=0, maximum=1_000_000):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return minimum
    return max(minimum, min(maximum, parsed))


def normalized_timestamp(value, fallback):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        return fallback


def clean_label(value):
    label = str(value or "").strip().upper()[:12]
    return label if SCORE_PATTERN.match(label) else None


def clean_position(value):
    if not isinstance(value, dict):
        return None
    try:
        x = float(value.get("x"))
        y = float(value.get("y"))
    except (TypeError, ValueError):
        return None
    if not (-2 <= x <= 2 and -2 <= y <= 2):
        return None
    return x, y


def clean_dart(value, fallback_label, fallback_time, legacy=False):
    detail = value if isinstance(value, dict) else {}
    label = clean_label(detail.get("label")) or clean_label(fallback_label)
    if not label:
        return None
    position = clean_position(detail.get("boardPosition"))
    source = str(detail.get("inputSource") or ("legacy" if legacy else "unknown"))
    if source not in INPUT_SOURCES:
        source = "unknown"
    return {
        "label": label,
        "board_x": position[0] if position else None,
        "board_y": position[1] if position else None,
        "coordinate_source": "canonical" if position else "none",
        "input_source": source,
        "thrown_at": normalized_timestamp(detail.get("thrownAt"), fallback_time),
    }


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
        self.backup_legacy_database()
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS players (
                    id INTEGER PRIMARY KEY,
                    public_id TEXT,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE,
                    email TEXT,
                    normalized_email TEXT,
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

                CREATE TABLE IF NOT EXISTS dart_throws (
                    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
                    player_id INTEGER NOT NULL REFERENCES players(id),
                    visit_number INTEGER NOT NULL,
                    dart_number INTEGER NOT NULL,
                    label TEXT NOT NULL,
                    board_x REAL,
                    board_y REAL,
                    coordinate_source TEXT NOT NULL CHECK (coordinate_source IN ('canonical', 'none')),
                    input_source TEXT NOT NULL CHECK (input_source IN ('board', 'manual', 'unknown', 'legacy')),
                    thrown_at TEXT NOT NULL,
                    provisional INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (match_id, visit_number, dart_number)
                );

                CREATE INDEX IF NOT EXISTS idx_matches_status_started
                ON matches(status, started_at DESC);

                CREATE INDEX IF NOT EXISTS idx_match_players_player
                ON match_players(player_id, match_id);

                CREATE INDEX IF NOT EXISTS idx_visits_match_player
                ON visits(match_id, player_id);

                CREATE INDEX IF NOT EXISTS idx_dart_throws_player_time
                ON dart_throws(player_id, thrown_at DESC);

                CREATE INDEX IF NOT EXISTS idx_dart_throws_match_player
                ON dart_throws(match_id, player_id);
                """
            )
            self.ensure_profile_schema(connection)
            self.backfill_legacy_darts(connection)
            connection.execute("PRAGMA user_version = 2")
            connection.execute("PRAGMA optimize")

    @staticmethod
    def ensure_profile_schema(connection):
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(players)").fetchall()
        }
        if "public_id" not in columns:
            connection.execute("ALTER TABLE players ADD COLUMN public_id TEXT")
        if "email" not in columns:
            connection.execute("ALTER TABLE players ADD COLUMN email TEXT")
        if "normalized_email" not in columns:
            connection.execute("ALTER TABLE players ADD COLUMN normalized_email TEXT")
        for row in connection.execute("SELECT id FROM players WHERE public_id IS NULL OR public_id = ''"):
            connection.execute(
                "UPDATE players SET public_id = ? WHERE id = ?",
                (str(uuid.uuid4()), row["id"]),
            )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_public_id ON players(public_id)"
        )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_normalized_email "
            "ON players(normalized_email) WHERE normalized_email IS NOT NULL"
        )

    def backup_legacy_database(self):
        if not os.path.exists(self.path) or os.path.getsize(self.path) == 0:
            return
        backup_path = f"{self.path}.pre-v2.bak"
        if os.path.exists(backup_path):
            return
        with sqlite3.connect(self.path) as source:
            version = source.execute("PRAGMA user_version").fetchone()[0]
            has_visits = source.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'visits'"
            ).fetchone()
            if version >= 2 or not has_visits:
                return
            with sqlite3.connect(backup_path) as destination:
                source.backup(destination)

    def backfill_legacy_darts(self, connection):
        rows = connection.execute(
            """
            SELECT match_id, player_id, visit_number, darts_json, created_at
            FROM visits
            WHERE NOT EXISTS (
                SELECT 1 FROM dart_throws d
                WHERE d.match_id = visits.match_id
                  AND d.visit_number = visits.visit_number
            )
            """
        ).fetchall()
        for row in rows:
            try:
                labels = json.loads(row["darts_json"])
            except (TypeError, json.JSONDecodeError):
                labels = []
            for dart_number, value in enumerate(labels[:3], start=1):
                dart = clean_dart({}, value, row["created_at"], legacy=True)
                if dart:
                    self.insert_dart(
                        connection, row["match_id"], row["player_id"],
                        row["visit_number"], dart_number, dart, False,
                    )

    @staticmethod
    def insert_dart(connection, match_id, player_id, visit_number, dart_number, dart, provisional):
        connection.execute(
            """
            INSERT INTO dart_throws(
                match_id, player_id, visit_number, dart_number, label,
                board_x, board_y, coordinate_source, input_source,
                thrown_at, provisional
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                match_id, player_id, visit_number, dart_number, dart["label"],
                dart["board_x"], dart["board_y"], dart["coordinate_source"],
                dart["input_source"], dart["thrown_at"], 1 if provisional else 0,
            ),
        )

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

            profile_id = str((player or {}).get("profileId") or "").strip().lower()
            if profile_id and not PROFILE_ID_PATTERN.match(profile_id):
                raise ValueError("Invalid player profile id")
            clean_players[-1]["profile_id"] = profile_id or None
            clean_players[-1]["email"] = clean_email((player or {}).get("email"))

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
            "active_player": safe_int(payload.get("activePlayer"), 0, len(clean_players) - 1),
            "darts": payload.get("darts") if isinstance(payload.get("darts"), list) else [],
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
                row = None
                if player["profile_id"]:
                    row = connection.execute(
                        "SELECT id FROM players WHERE public_id = ?",
                        (player["profile_id"],),
                    ).fetchone()
                if row:
                    connection.execute(
                        """
                        UPDATE players
                        SET name = ?, normalized_name = ?,
                            email = COALESCE(?, email),
                            normalized_email = COALESCE(?, normalized_email),
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            player["name"], player["key"], player["email"],
                            player["email"], now, row["id"],
                        ),
                    )
                else:
                    public_id = player["profile_id"] or str(uuid.uuid4())
                    connection.execute(
                        """
                        INSERT INTO players(
                            public_id, name, normalized_name, email,
                            normalized_email, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(normalized_name) DO UPDATE SET
                            name = excluded.name,
                            email = COALESCE(excluded.email, players.email),
                            normalized_email = COALESCE(excluded.normalized_email, players.normalized_email),
                            updated_at = excluded.updated_at
                        """,
                        (
                            public_id, player["name"], player["key"], player["email"],
                            player["email"], now, now,
                        ),
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
            connection.execute("DELETE FROM dart_throws WHERE match_id = ?", (match["id"],))
            connection.execute("DELETE FROM visits WHERE match_id = ?", (match["id"],))
            connection.execute("DELETE FROM match_players WHERE match_id = ?", (match["id"],))

            highest_visits = {index: 0 for index in range(len(player_ids))}
            for sequence, visit in enumerate(match["visits"], start=1):
                player_index = safe_int((visit or {}).get("playerIndex"), 0, len(player_ids) - 1)
                scored = safe_int((visit or {}).get("score"))
                remaining = safe_int((visit or {}).get("remaining"))
                darts = (visit or {}).get("darts") or []
                clean_darts = [label for dart in darts[:3] if (label := clean_label(dart))]
                visit_time = normalized_timestamp((visit or {}).get("createdAt"), now)
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
                        visit_time,
                    ),
                )
                details = (visit or {}).get("dartDetails")
                has_details = isinstance(details, list)
                for dart_number, label in enumerate(clean_darts, start=1):
                    detail = details[dart_number - 1] if has_details and dart_number <= len(details) else {}
                    dart = clean_dart(detail, label, visit_time, legacy=not has_details)
                    if dart:
                        self.insert_dart(
                            connection, match["id"], player_ids[player_index],
                            sequence, dart_number, dart, False,
                        )

            if match["status"] == "active":
                player_index = match["active_player"]
                visit_number = len(match["visits"]) + 1
                for dart_number, detail in enumerate(match["darts"][:3], start=1):
                    dart = clean_dart(detail, None, now)
                    if dart:
                        self.insert_dart(
                            connection, match["id"], player_ids[player_index],
                            visit_number, dart_number, dart, True,
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

    def profiles(self):
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT p.public_id, p.name, p.email, p.updated_at,
                       COUNT(CASE WHEN m.status = 'completed' THEN 1 END) AS games,
                       MAX(CASE WHEN m.status = 'completed' THEN m.completed_at END) AS last_played
                FROM players p
                LEFT JOIN match_players mp ON mp.player_id = p.id
                LEFT JOIN matches m ON m.id = mp.match_id
                GROUP BY p.id, p.public_id, p.name, p.email, p.updated_at
                ORDER BY last_played DESC, p.name COLLATE NOCASE
                """
            ).fetchall()
        return [
            {
                "id": row["public_id"],
                "name": row["name"],
                "email": row["email"],
                "games": row["games"] or 0,
                "lastPlayed": row["last_played"],
            }
            for row in rows
        ]

    def save_profile(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Player profile must be an object")
        name = str(payload.get("name") or "").strip()[:50]
        if not name:
            raise ValueError("Player name is required")
        key = normalized_name(name)
        email = clean_email(payload.get("email"))
        profile_id = str(payload.get("id") or "").strip().lower()
        if profile_id and not PROFILE_ID_PATTERN.match(profile_id):
            raise ValueError("Invalid player profile id")
        now = utc_now()

        try:
            with self.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = None
                if profile_id:
                    row = connection.execute(
                        "SELECT id FROM players WHERE public_id = ?", (profile_id,),
                    ).fetchone()
                    if not row:
                        raise ValueError("Player profile not found")
                elif email:
                    row = connection.execute(
                        "SELECT id, public_id FROM players WHERE normalized_email = ?", (email,),
                    ).fetchone()
                    if row:
                        profile_id = row["public_id"]
                if not row:
                    row = connection.execute(
                        "SELECT id, public_id FROM players WHERE normalized_name = ?", (key,),
                    ).fetchone()
                    if row:
                        profile_id = row["public_id"]

                if row:
                    connection.execute(
                        """
                        UPDATE players
                        SET name = ?, normalized_name = ?, email = ?,
                            normalized_email = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (name, key, email, email, now, row["id"]),
                    )
                else:
                    profile_id = str(uuid.uuid4())
                    connection.execute(
                        """
                        INSERT INTO players(
                            public_id, name, normalized_name, email,
                            normalized_email, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (profile_id, name, key, email, email, now, now),
                    )
                connection.commit()
        except sqlite3.IntegrityError as error:
            if "normalized_email" in str(error):
                raise ValueError("That email belongs to another player") from error
            raise ValueError("That player name is already in use") from error

        return next(profile for profile in self.profiles() if profile["id"] == profile_id)

    def heatmap(self, player_id, period="30d", now=None):
        if period not in VALID_PERIODS:
            raise ValueError("Invalid heatmap period")
        reference = now or datetime.now(timezone.utc)
        if reference.tzinfo is None:
            reference = reference.replace(tzinfo=timezone.utc)
        days = VALID_PERIODS[period]
        range_start = (reference - timedelta(days=days)).isoformat() if days else None

        with self.connect() as connection:
            player = connection.execute(
                "SELECT id, name FROM players WHERE id = ?", (player_id,),
            ).fetchone()
            if not player:
                raise KeyError("Player not found")
            parameters = [player_id]
            cutoff_clause = ""
            if range_start:
                cutoff_clause = "AND d.thrown_at >= ?"
                parameters.append(range_start)
            rows = connection.execute(
                f"""
                SELECT d.label, d.board_x, d.board_y, d.coordinate_source,
                       d.input_source, d.thrown_at
                FROM dart_throws d
                JOIN matches m ON m.id = d.match_id
                WHERE d.player_id = ? AND m.status = 'completed'
                  AND d.provisional = 0 {cutoff_clause}
                ORDER BY d.thrown_at ASC, d.visit_number ASC, d.dart_number ASC
                """,
                parameters,
            ).fetchall()

        exact_points = []
        estimated = {}
        unplottable = 0
        for row in rows:
            if row["coordinate_source"] == "canonical" and row["board_x"] is not None:
                exact_points.append({
                    "label": row["label"],
                    "x": row["board_x"],
                    "y": row["board_y"],
                    "thrownAt": row["thrown_at"],
                })
            elif row["label"] != "MISS" and clean_label(row["label"]):
                estimated[row["label"]] = estimated.get(row["label"], 0) + 1
            else:
                unplottable += 1

        return {
            "schemaVersion": 1,
            "period": period,
            "rangeStart": range_start,
            "player": {"id": player["id"], "name": player["name"]},
            "exactPoints": exact_points,
            "estimatedBeds": [
                {"label": label, "count": count}
                for label, count in sorted(estimated.items(), key=lambda item: (-item[1], item[0]))
            ],
            "totals": {
                "darts": len(rows),
                "exact": len(exact_points),
                "estimated": sum(estimated.values()),
                "unplottable": unplottable,
            },
            "generatedAt": reference.astimezone(timezone.utc).isoformat(),
        }

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
                    p.public_id,
                    p.name,
                    p.email,
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
                "profileId": row["public_id"],
                "name": row["name"],
                "email": row["email"],
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
        parsed_url = urlparse(self.path)
        path = parsed_url.path.rstrip("/")
        if path == "/api/health":
            self.send_json(200, {"status": "ok", "service": "OpenDartboard Stats"})
            return
        if path == "/api/stats":
            self.send_json(200, self.database.stats())
            return
        if path == "/api/players":
            self.send_json(200, {"players": self.database.profiles()})
            return
        if path == "/api/heatmap":
            try:
                query = parse_qs(parsed_url.query)
                player_id = int((query.get("playerId") or [""])[0])
                period = (query.get("period") or ["30d"])[0]
                self.send_json(200, self.database.heatmap(player_id, period))
            except (TypeError, ValueError):
                self.send_json(400, {"error": "A valid playerId and period are required"})
            except KeyError:
                self.send_json(404, {"error": "Player not found"})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/api/players":
            try:
                self.send_json(200, {"player": self.database.save_profile(self.read_json())})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
            except sqlite3.Error:
                self.send_json(500, {"error": "Could not save player profile"})
            return
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
