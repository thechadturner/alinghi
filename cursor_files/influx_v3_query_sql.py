"""
Run InfluxDB v3 query_sql using the same env as other tools (INFLUX_HOST, INFLUX_PORT,
INFLUX_DATABASE, INFLUX_TOKEN). Loads repo .env and .env.local when present.

Usage (from repo root):
  python cursor_files/influx_v3_query_sql.py
  python cursor_files/influx_v3_query_sql.py "SELECT DISTINCT \"Day\" FROM \"iox\".\"universalized_logs\" LIMIT 5"
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

_REPO = Path(__file__).resolve().parent.parent
_LIBS = _REPO / "libs" / "utilities"
if str(_LIBS) not in sys.path:
    sys.path.insert(0, str(_LIBS))

from utilities.api_utils import (  # noqa: E402
    _influx_v3_origin_from_host,
    _influx_v3_query_sql,
    _normalize_influx_token,
)


def _load_env() -> None:
    is_prod = os.getenv("NODE_ENV") == "production"
    base = _REPO / (".env.production" if is_prod else ".env")
    local = _REPO / (".env.production.local" if is_prod else ".env.local")
    if base.exists():
        load_dotenv(base)
    if local.exists():
        load_dotenv(local, override=True)


DEFAULT_SQL = """
SELECT DISTINCT "Day" FROM "iox"."universalized_logs"
WHERE time >= '2026-03-26T23:00:00Z' AND time <= '2026-03-27T22:59:59Z'
LIMIT 20
""".strip()


def main() -> int:
    _load_env()
    token = _normalize_influx_token(os.getenv("INFLUX_TOKEN"))
    host = (os.getenv("INFLUX_HOST") or os.getenv("INFLUX_URL") or "").strip()
    db = (os.getenv("INFLUX_DATABASE") or "").strip()
    if not token or not host or not db:
        print("Set INFLUX_TOKEN, INFLUX_HOST (or INFLUX_URL), INFLUX_DATABASE", file=sys.stderr)
        return 1
    origin = _influx_v3_origin_from_host(host)
    sql = " ".join(sys.argv[1:]).strip() if len(sys.argv) > 1 else DEFAULT_SQL
    print(f"POST {origin}/api/v3/query_sql  db={db}", file=sys.stderr)
    print(sql, file=sys.stderr)
    print("---", file=sys.stderr)
    try:
        rows = _influx_v3_query_sql(origin, token, db, sql, 120.0)
    except Exception as e:
        print(e, file=sys.stderr)
        return 1
    for row in rows:
        print(json.dumps(row, default=str))
    print(f"--- {len(rows)} row(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
