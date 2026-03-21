#!/usr/bin/env python3
"""
Populate {schema}.day_pages for existing (project_id, date) pairs that have datasets.

For each sailing day:
  - Inserts the correct summary row: RACE SUMMARY vs TRAINING SUMMARY, using the same
    rules as server_app/controllers/datasets.js (getRaces) and server_python/scripts/gp50/4_cleanup.py.
  - Ensures PERFORMANCE and MANEUVERS day/reports rows exist (FleetPerformance / FleetManeuvers in the UI).

Requires a direct PostgreSQL connection (same DB_* variables as the Node servers).

Optional dependency (install once if you approve it for your environment):
    pip install psycopg2-binary

Usage examples:
    python cursor_files/populate_day_pages.py --schema gp50
    python cursor_files/populate_day_pages.py --schema gp50 --project-id 2
    python cursor_files/populate_day_pages.py --schema gp50 --dry-run
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2 import sql
except ImportError:
    print(
        "Missing dependency: psycopg2. Install with: pip install psycopg2-binary",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore[assignment]


REQUIRED_REPORT_PAGES = (
    "RACE SUMMARY",
    "TRAINING SUMMARY",
    "PERFORMANCE",
    "MANEUVERS",
)


def load_env() -> None:
    if load_dotenv is None:
        return
    root = Path(__file__).resolve().parent.parent
    is_production = os.getenv("NODE_ENV") == "production"
    base = root / (".env.production" if is_production else ".env")
    local = root / (".env.production.local" if is_production else ".env.local")
    if base.exists():
        load_dotenv(dotenv_path=base)
    if local.exists():
        load_dotenv(dotenv_path=local, override=True)


def validate_schema(name: str) -> str:
    n = name.strip().lower()
    if not re.match(r"^[a-z][a-z0-9_]*$", n):
        raise ValueError(f"Invalid schema/class name: {name!r}")
    return n


def safe_race_number(row: Dict[str, Any]) -> int:
    v = row.get("Race_number")
    if v is None:
        return 0
    try:
        if isinstance(v, (int, float)):
            return int(v)
        s = str(v).strip()
        if not s:
            return 0
        return int(float(s))
    except (ValueError, TypeError):
        return 0


def fetch_races_like_api(
    cur: Any, schema: str, project_id: int, day: date
) -> List[Dict[str, Any]]:
    """
    Mirror server_app/controllers/datasets.js getRaces response `data` shape
    so summary choice matches 4_cleanup.py.
    """
    params: List[Any] = [project_id, day]

    race_sql = sql.SQL(
        """
        SELECT "Race_number" FROM (
          SELECT
            CASE
              WHEN UPPER(TRIM(a.tags ->> 'Race_number')) = 'TRAINING' THEN -1
              WHEN a.tags ->> 'Race_number' IS NOT NULL AND a.tags ->> 'Race_number' != '' THEN
                CASE
                  WHEN (a.tags ->> 'Race_number')::text ~ '^-?[0-9]+$' THEN
                    CASE
                      WHEN CAST(a.tags ->> 'Race_number' AS FLOAT) = -1 THEN -1
                      ELSE CAST(CAST(a.tags ->> 'Race_number' AS FLOAT) AS INT)
                    END
                  ELSE NULL
                END
              ELSE NULL
            END AS "Race_number"
          FROM {schema}.dataset_events a
          INNER JOIN {schema}.datasets b ON a.dataset_id = b.dataset_id
          INNER JOIN {schema}.sources c ON b.source_id = c.source_id
          WHERE c.project_id = %s AND b.date = %s
            AND (a.tags ->> 'Race_number' IS NOT NULL AND a.tags ->> 'Race_number' != '')
        ) sub
        WHERE "Race_number" IS NOT NULL AND "Race_number" >= -1
        GROUP BY "Race_number"
        ORDER BY "Race_number" ASC
        """
    ).format(schema=sql.Identifier(schema))

    cur.execute(race_sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    has_positive = any(safe_race_number(r) > 0 for r in rows)

    if has_positive:
        return rows

    hours_sql = sql.SQL(
        """
        SELECT "HOUR" FROM (
          SELECT DISTINCT (a.tags ->> 'HOUR') AS "HOUR"
          FROM {schema}.dataset_events a
          INNER JOIN {schema}.datasets b ON a.dataset_id = b.dataset_id
          INNER JOIN {schema}.sources c ON b.source_id = c.source_id
          WHERE c.project_id = %s AND b.date = %s
            AND LOWER(a.event_type) = 'training'
            AND a.tags ->> 'HOUR' IS NOT NULL AND a.tags ->> 'HOUR' != ''
        ) sub
        ORDER BY CASE WHEN "HOUR" ~ '^[0-9]+$' THEN "HOUR"::int ELSE 999 END, "HOUR"
        """
    ).format(schema=sql.Identifier(schema))

    cur.execute(hours_sql, params)
    hour_rows = cur.fetchall()
    if hour_rows:
        return [{"Race_number": r["HOUR"], "HOUR": r["HOUR"]} for r in hour_rows]

    return [dict(r) for r in rows]


def choose_summary_page(data: List[Dict[str, Any]]) -> str:
    """Same rules as server_python/scripts/gp50/4_cleanup.py (day_pages summary)."""
    has_data = len(data) > 0
    has_training_only = has_data and all(r.get("HOUR") is not None for r in data)
    has_actual_races = has_data and (not has_training_only) and any(safe_race_number(r) > 0 for r in data)
    return "RACE SUMMARY" if has_actual_races else "TRAINING SUMMARY"


def load_report_page_ids(cur: Any, schema: str) -> Dict[str, int]:
    cur.execute(
        sql.SQL(
            """
            SELECT UPPER(TRIM(page_name)) AS n, page_id
            FROM {schema}.pages
            WHERE page_type = 'day/reports'
            """
        ).format(schema=sql.Identifier(schema))
    )
    found = {str(r["n"]): int(r["page_id"]) for r in cur.fetchall() if r["n"]}
    missing = [p for p in REQUIRED_REPORT_PAGES if p not in found]
    if missing:
        raise RuntimeError(
            f"Schema {schema!r} is missing day/reports pages: {missing}. "
            f"Known page_name values: {sorted(found.keys())}"
        )
    return {p: found[p] for p in REQUIRED_REPORT_PAGES}


def distinct_project_dates(cur: Any, schema: str, project_id: Optional[int]) -> List[Tuple[int, date]]:
    base = sql.SQL(
        """
        SELECT DISTINCT s.project_id, d.date::date AS d
        FROM {schema}.datasets d
        INNER JOIN {schema}.sources s ON d.source_id = s.source_id
        """
    ).format(schema=sql.Identifier(schema))
    if project_id is not None:
        q = base + sql.SQL(" WHERE s.project_id = %s ORDER BY s.project_id, d")
        cur.execute(q, [project_id])
    else:
        q = base + sql.SQL(" ORDER BY s.project_id, d")
        cur.execute(q)
    return [(int(r["project_id"]), r["d"]) for r in cur.fetchall()]


def day_page_exists(cur: Any, schema: str, project_id: int, day: date, page_id: int) -> bool:
    cur.execute(
        sql.SQL(
            """
            SELECT 1
            FROM {schema}.day_pages
            WHERE project_id = %s AND date = %s AND page_id = %s
            LIMIT 1
            """
        ).format(schema=sql.Identifier(schema)),
        [project_id, day, page_id],
    )
    return cur.fetchone() is not None


def upsert_day_page(
    cur: Any, schema: str, project_id: int, day: date, page_id: int, dry_run: bool
) -> str:
    exists = day_page_exists(cur, schema, project_id, day, page_id)
    if dry_run:
        return "would_insert" if not exists else "would_touch"
    if exists:
        cur.execute(
            sql.SQL(
                """
                UPDATE {schema}.day_pages
                SET date_modified = CURRENT_DATE
                WHERE project_id = %s AND date = %s AND page_id = %s
                """
            ).format(schema=sql.Identifier(schema)),
            [project_id, day, page_id],
        )
        return "updated"
    cur.execute(
        sql.SQL(
            """
            INSERT INTO {schema}.day_pages (project_id, date, page_id, date_modified)
            VALUES (%s, %s, %s, CURRENT_DATE)
            """
        ).format(schema=sql.Identifier(schema)),
        [project_id, day, page_id],
    )
    return "inserted"


def remove_conflicting_summaries(
    cur: Any,
    schema: str,
    project_id: int,
    day: date,
    keep_page_id: int,
    race_id: int,
    train_id: int,
    dry_run: bool,
) -> int:
    others = [pid for pid in (race_id, train_id) if pid != keep_page_id]
    if not others:
        return 0
    if dry_run:
        cur.execute(
            sql.SQL(
                """
                SELECT COUNT(*) AS c FROM {schema}.day_pages
                WHERE project_id = %s AND date = %s AND page_id = ANY(%s)
                """
            ).format(schema=sql.Identifier(schema)),
            [project_id, day, others],
        )
        return int(cur.fetchone()["c"])
    cur.execute(
        sql.SQL(
            """
            DELETE FROM {schema}.day_pages
            WHERE project_id = %s AND date = %s AND page_id = ANY(%s)
            """
        ).format(schema=sql.Identifier(schema)),
        [project_id, day, others],
    )
    return cur.rowcount


def connect_from_env():
    host = os.getenv("DB_HOST", "localhost")
    port = int(os.getenv("DB_PORT", "5432"))
    name = os.getenv("DB_NAME")
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASSWORD", "")
    if not name or not user:
        raise RuntimeError(
            "Set DB_HOST, DB_PORT, DB_NAME, DB_USER, and DB_PASSWORD (same as server_app). "
            "Optional: DB_SSL=false for local Postgres without SSL."
        )
    sslmode = "disable" if os.getenv("DB_SSL", "").lower() in ("false", "0", "") else "require"
    conn = psycopg2.connect(
        host=host,
        port=port,
        dbname=name,
        user=user,
        password=password,
        sslmode=sslmode,
    )
    conn.autocommit = False
    return conn


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Populate day_pages for existing dataset dates.")
    p.add_argument(
        "--schema",
        required=True,
        help="Class schema name (e.g. gp50).",
    )
    p.add_argument(
        "--project-id",
        type=int,
        default=None,
        help="Limit to one project_id (optional).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print actions only; no INSERT/UPDATE/DELETE.",
    )
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    load_env()
    args = parse_args(argv)
    schema = validate_schema(args.schema)

    try:
        conn = connect_from_env()
    except Exception as e:
        print(f"Connection failed: {e}", file=sys.stderr)
        return 1

    stats = {
        "days": 0,
        "summary_race": 0,
        "summary_training": 0,
        "inserted": 0,
        "updated": 0,
        "deleted_conflicts": 0,
    }

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            page_ids = load_report_page_ids(cur, schema)
            race_id = page_ids["RACE SUMMARY"]
            train_id = page_ids["TRAINING SUMMARY"]
            perf_id = page_ids["PERFORMANCE"]
            man_id = page_ids["MANEUVERS"]

            pairs = distinct_project_dates(cur, schema, args.project_id)
            stats["days"] = len(pairs)

            for project_id, day in pairs:
                data = fetch_races_like_api(cur, schema, project_id, day)
                summary_name = choose_summary_page(data)
                summary_id = page_ids[summary_name]
                if summary_name == "RACE SUMMARY":
                    stats["summary_race"] += 1
                else:
                    stats["summary_training"] += 1

                removed = remove_conflicting_summaries(
                    cur, schema, project_id, day, summary_id, race_id, train_id, args.dry_run
                )
                stats["deleted_conflicts"] += removed

                for label, pid in (
                    (summary_name, summary_id),
                    ("PERFORMANCE", perf_id),
                    ("MANEUVERS", man_id),
                ):
                    action = upsert_day_page(cur, schema, project_id, day, pid, args.dry_run)
                    if action == "inserted":
                        stats["inserted"] += 1
                    elif action == "updated":
                        stats["updated"] += 1
                    if args.dry_run:
                        print(
                            f"[dry-run] project={project_id} date={day} {label} page_id={pid} -> {action}"
                        )

        if args.dry_run:
            conn.rollback()
        else:
            conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"Error: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    print(
        "Done."
        f" days={stats['days']}"
        f" race_summary_days={stats['summary_race']}"
        f" training_summary_days={stats['summary_training']}"
        f" rows_inserted={stats['inserted']}"
        f" rows_updated={stats['updated']}"
        f" conflicting_summary_rows_removed={stats['deleted_conflicts']}"
        + (" (dry-run)" if args.dry_run else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
