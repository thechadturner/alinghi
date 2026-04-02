"""
0_parse_db.py — Convert AC40 training SQLite .db (under data/raw/...) to parquet files
under data/system/... using the same table mapping as assets/temp/convert_to_parquet.py.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime

import pandas as pd
import utilities as u
from dotenv import load_dotenv
from pathlib import Path

# SQLite table name -> output file prefix (from convert_to_parquet.py)
TABLE_MAP = {
    "AC40_ECC.Blocks_log": "blocks",
    "AC40_ECC.PLC_log": "plc",
    "AC40_ECC.PLC_100HZ_log": "plc100hz",
    "AC40_ECC.Messages_log": "messages",
    "AC40_ECC.Alarms_log": "alarms",
}

is_production = os.getenv("NODE_ENV") == "production"
project_root = Path(__file__).parent.parent.parent.parent
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"
# Do not use override=True: Docker Compose sets DATA_DIRECTORY=/data (mount point). A local
# .env.production.local with DATA_DIRECTORY=... would replace it and break raw/system paths.
load_dotenv(dotenv_path=project_root / base_env_file)
load_dotenv(dotenv_path=project_root / local_env_file)

api_token = os.getenv("SYSTEM_KEY")
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")


def extract_timestamp(db_path: str) -> str:
    """Return yyyymmdd_HHMMSS from the filename, or generate from now()."""
    match = re.search(r"(\d{8}_\d{6})", os.path.basename(db_path))
    return match.group(1) if match else datetime.now().strftime("%Y%m%d_%H%M%S")


def resolve_data_directory() -> str:
    """
    Match server_admin/controllers/uploads.js: if basename is not 'data' (case-insensitive),
    append 'Data'. So DATA_DIRECTORY=/data stays /data; C:/.../Uploads becomes .../Uploads/Data.
    """
    root = os.getenv("DATA_DIRECTORY", "C:/MyApps/Alinghi/uploads/data")
    root = os.path.normpath(str(root).rstrip("/\\"))
    if os.path.basename(root).lower() != "data":
        root = os.path.join(root, "Data")
    return root


def _expected_raw_dir(data_dir: str, project_id, class_lower: str, date_compact: str, source_name: str) -> str:
    return os.path.normpath(
        os.path.join(data_dir, "raw", str(project_id), class_lower, date_compact, source_name)
    )


def _tutc_source_column(columns: list, table_name: str) -> str | None:
    """
    After dot→underscore (and optional _100hz suffix), return the column name that holds
    UTC time (tUTC), or None if not found.
    """
    cols = list(columns)
    lower = {c.lower(): c for c in cols}
    is_100hz = table_name == "AC40_ECC.PLC_100HZ_log"
    if is_100hz:
        if "tutc_100hz" in lower:
            return lower["tutc_100hz"]
        for c in cols:
            if c.lower().endswith("_tutc_100hz"):
                return c
        return None
    if "tutc" in lower:
        return lower["tutc"]
    for c in cols:
        cl = c.lower()
        if cl.endswith("_tutc") and not cl.endswith("_tutc_100hz"):
            return c
    return None


def _open_sqlite_checked(db_path: str) -> sqlite3.Connection:
    """
    Open the training .db and fail fast with a clear message if the file is corrupt
    or truncated (SQLite: 'database disk image is malformed').
    """
    try:
        size = os.path.getsize(db_path)
    except OSError as e:
        raise RuntimeError(f"Cannot stat db file {db_path!r}: {e}") from e
    try:
        conn = sqlite3.connect(db_path)
    except sqlite3.DatabaseError as e:
        raise RuntimeError(
            f"{e} (path={db_path!r}, size={size} bytes). "
            "The file is not a readable SQLite database on disk — often a truncated upload "
            "or a corrupt export. Verify with: sqlite3 <file.db> \"PRAGMA quick_check;\" "
            "then re-export or re-upload."
        ) from e
    try:
        rows = conn.execute("PRAGMA quick_check").fetchall()
    except sqlite3.DatabaseError as e:
        conn.close()
        raise RuntimeError(
            f"{e} (path={db_path!r}, size={size} bytes). "
            "PRAGMA quick_check failed; database may be corrupt or incomplete."
        ) from e
    if not rows or rows[0][0] != "ok":
        detail = rows[0][0] if rows else "no result"
        conn.close()
        raise RuntimeError(
            f"SQLite quick_check reported: {detail!r} (path={db_path!r}, size={size} bytes). "
            "Re-export the log database from the boat / logger PC or upload a known-good copy."
        )
    return conn


def convert_db_to_parquet(db_path: str, output_dir: str, timestamp: str) -> None:
    os.makedirs(output_dir, exist_ok=True)
    conn = None
    try:
        conn = _open_sqlite_checked(db_path)
    except (OSError, RuntimeError) as exc:
        u.log(
            api_token,
            "0_parse_db.py",
            "error",
            "parse db",
            f"SQLite file not readable, skipping all parquet export: {db_path} — {exc}",
        )
        print(f"WARNING: SQLite not readable, parquet export skipped: {exc}", flush=True)
        return
    try:
        for table_name, prefix in TABLE_MAP.items():
            u.log(api_token, "0_parse_db.py", "info", "parse db", f"Reading {table_name}")
            try:
                df = pd.read_sql_query(f'SELECT * FROM "{table_name}"', conn)
                df.columns = [col.replace(".", "_") for col in df.columns]
                if table_name == "AC40_ECC.PLC_100HZ_log":
                    df.columns = [f"{col}_100hz" for col in df.columns]
                tutc_col = _tutc_source_column(df.columns.tolist(), table_name)
                if tutc_col is not None:
                    df["ts"] = df[tutc_col]
                else:
                    u.log(
                        api_token,
                        "0_parse_db.py",
                        "warning",
                        "parse db",
                        f"{table_name}: no tUTC column found, ts not added",
                    )
                out_path = os.path.join(output_dir, f"{prefix}_{timestamp}.parquet")
                if os.path.exists(out_path):
                    os.remove(out_path)
                df.to_parquet(out_path, engine="pyarrow", index=False)
                u.log(
                    api_token,
                    "0_parse_db.py",
                    "info",
                    "parse db",
                    f"Wrote {out_path} ({len(df):,} rows)",
                )
            except Exception as exc:
                u.log(
                    api_token,
                    "0_parse_db.py",
                    "error",
                    "parse db",
                    f"{table_name}: failed, skipping this table: {exc}",
                )
                print(f"WARNING: table {table_name} skipped: {exc}", flush=True)
                continue
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("ERROR: Missing required parameters JSON (argv[1])", flush=True)
        sys.exit(1)

    parameters_str = sys.argv[1]
    try:
        parameters_json = json.loads(parameters_str)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid parameters JSON: {e}", flush=True)
        sys.exit(1)

    u.log(api_token, "0_parse_db.py", "info", "parameters", parameters_str)

    class_name = parameters_json.get("class_name")
    project_id = parameters_json.get("project_id")
    date_compact = parameters_json.get("date")
    source_name = parameters_json.get("source_name")
    file_name = parameters_json.get("file_name")

    # class_name = 'ac40'
    # project_id = 2
    # date_compact = '20260328'
    # source_name = 'AC40-SUI1'
    # file_name = r'C:\MyApps\Alinghi\uploads\data\raw\2\ac40\20260327\AC40-SUI2\log_20260328_125404.db'

    missing = [k for k, v in [
        ("class_name", class_name),
        ("project_id", project_id),
        ("date", date_compact),
        ("source_name", source_name),
        ("file_name", file_name),
    ] if not v and v != 0]
    if missing:
        print(f"ERROR: Missing parameters: {missing}", flush=True)
        sys.exit(1)

    date_compact = str(date_compact).replace("-", "").replace("/", "")[:8]
    class_lower = str(class_name).lower()
    source_name = str(source_name).strip()
    raw_name = str(file_name).strip()
    basename = os.path.basename(raw_name)

    if not basename.lower().endswith(".db"):
        print("ERROR: file_name must be a .db file", flush=True)
        sys.exit(1)

    # Resolve DB path on *this* host (Python service). Admin may pass its own absolute path
    # (e.g. /data/raw/...) which does not exist inside the Python container — always prefer
    # DATA_DIRECTORY + standard raw layout, same as uploads.js.
    data_dir = resolve_data_directory()
    expected_raw = _expected_raw_dir(data_dir, project_id, class_lower, date_compact, source_name)
    canonical_db = os.path.normpath(os.path.join(expected_raw, basename))

    db_path = None
    if os.path.isfile(canonical_db):
        db_path = canonical_db
    else:
        alt = os.path.normpath(os.path.abspath(raw_name))
        if os.path.isfile(alt) and os.path.basename(alt) == basename:
            try:
                same_dir = os.path.normcase(os.path.realpath(os.path.dirname(alt))) == os.path.normcase(
                    os.path.realpath(expected_raw)
                )
            except OSError:
                same_dir = os.path.normcase(os.path.dirname(alt)) == os.path.normcase(expected_raw)
            if same_dir:
                db_path = alt

    if not db_path:
        msg = (
            f"File not found at {canonical_db} "
            f"(DATA_DIRECTORY resolves to {data_dir!r}; check Python service env and volume mounts)."
        )
        u.log(api_token, "0_parse_db.py", "error", "parse db", msg)
        print(f"ERROR: {msg}", flush=True)
        if raw_name != canonical_db:
            print(f"       Admin-reported path was {raw_name!r}", flush=True)
        sys.exit(1)

    timestamp = extract_timestamp(db_path)
    output_dir = os.path.join(data_dir, "system", str(project_id), class_lower, date_compact, source_name)

    try:
        u.log(
            api_token,
            "0_parse_db.py",
            "info",
            "parse db",
            f"db={db_path} -> {output_dir} (timestamp={timestamp})",
        )
        convert_db_to_parquet(db_path, output_dir, timestamp)
    except Exception as err:
        u.log(api_token, "0_parse_db.py", "error", "parse db", str(err))
        print(f"ERROR: {err}", flush=True)
        sys.exit(1)

    print("Script Completed:", u.dt.now(), flush=True)
    sys.exit(0)
