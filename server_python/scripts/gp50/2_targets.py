"""
2_targets.py — Recalculate Twa_tgt_deg in normalized parquet from targets table.

Runs before 2_processing.py. Fetches latest target (UPWIND/DOWNWIND) from the app API,
parses target JSON, then for each *_norm.parquet in the folder interpolates target TWA
by TWS and tack, and overwrites the Twa_tgt_deg column. Downstream processing and
Performance then see target-derived TWA.
"""

import os
import sys
import json
from pathlib import Path
from urllib.parse import quote_plus

import pandas as pd
import numpy as np

# Configure stdout/stderr for UTF-8
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
if sys.stderr.encoding != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8")

import utilities as u

from dotenv import load_dotenv

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"
project_root = Path(__file__).parent.parent.parent.parent
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"
load_dotenv(dotenv_path=project_root / base_env_file)
load_dotenv(dotenv_path=project_root / local_env_file, override=True)

api_token = os.getenv("SYSTEM_KEY")
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

# TWS in target CSV may be kph; normalized data uses Tws_kts. Threshold to assume kph.
TWS_KPH_TO_KTS = 1.0 / 1.852
TWS_ASSUME_KPH_IF_MEAN_ABOVE = 25.0


def _normalize_row_keys(row):
    """Normalize target row keys to lowercase and resolve twa/cwa."""
    out = {}
    for k, v in row.items():
        key = str(k).strip().lower()
        out[key] = v
    # Prefer twa, fallback to cwa for angle
    if "twa" not in out and "cwa" in out:
        out["twa"] = out["cwa"]
    return out


def _tws_to_kts(tws_value, assume_kph_if_mean_above=TWS_ASSUME_KPH_IF_MEAN_ABOVE, tws_all=None):
    """Convert TWS to knots if values look like kph."""
    try:
        x = float(tws_value)
    except (TypeError, ValueError):
        return np.nan
    if np.isnan(x):
        return np.nan
    if tws_all is not None and len(tws_all) > 0:
        mean_tws = np.nanmean(tws_all)
        if mean_tws > assume_kph_if_mean_above:
            return x * TWS_KPH_TO_KTS
    return x


def parse_target_json(target_json):
    """
    Parse target JSON into UPWIND and DOWNWIND (TWS_kts, TWA_deg) sorted by TWS for interpolation.

    Expects target_json to be the raw json column: { "UPWIND": [ {...}, ... ], "DOWNWIND": [ ... ] }.
    Returns (upwind_tws, upwind_twa, downwind_tws, downwind_twa) as 1d arrays, or (None, None, None, None) if invalid.
    """
    if not target_json:
        return (None, None, None, None)
    if isinstance(target_json, str):
        try:
            target_json = json.loads(target_json)
        except json.JSONDecodeError:
            return (None, None, None, None)
    if not isinstance(target_json, dict):
        return (None, None, None, None)

    def extract_tack(tack_array):
        if not isinstance(tack_array, list) or len(tack_array) == 0:
            return None, None
        rows = []
        for r in tack_array:
            if not isinstance(r, dict):
                continue
            nr = _normalize_row_keys(r)
            tws = nr.get("tws")
            twa = nr.get("twa")
            if tws is None or twa is None:
                continue
            try:
                tws_f = float(tws)
                twa_f = float(twa)
            except (TypeError, ValueError):
                continue
            rows.append((tws_f, twa_f))
        if not rows:
            return None, None
        tws_arr = np.array([x[0] for x in rows])
        twa_arr = np.array([x[1] for x in rows])
        # Convert TWS to kts if values look like kph
        tws_mean = np.nanmean(tws_arr)
        if tws_mean > TWS_ASSUME_KPH_IF_MEAN_ABOVE:
            tws_arr = tws_arr * TWS_KPH_TO_KTS
        order = np.argsort(tws_arr)
        return tws_arr[order], twa_arr[order]

    upwind = target_json.get("UPWIND") or target_json.get("upwind")
    downwind = target_json.get("DOWNWIND") or target_json.get("downwind")
    uw_tws, uw_twa = extract_tack(upwind)
    dw_tws, dw_twa = extract_tack(downwind)
    return (uw_tws, uw_twa, dw_tws, dw_twa)


def interpolate_twa_tgt(tws_kts, twa_deg, uw_tws, uw_twa, dw_tws, dw_twa):
    """
    Interpolate target TWA for one row: tack from abs(Twa_deg), then np.interp(Tws_kts).

    Returns float (degrees). Same sign as twa_deg (starboard/port). If no valid target, returns np.nan.
    """
    if np.isnan(tws_kts) or np.isnan(twa_deg):
        return np.nan
    abs_twa = abs(twa_deg)
    sign = np.sign(twa_deg)
    if sign == 0:
        sign = 1.0
    # Upwind: abs TWA < 90; downwind: abs TWA > 90
    if abs_twa < 90:
        xp, yp = uw_tws, uw_twa
    else:
        xp, yp = dw_tws, dw_twa
    if xp is None or len(xp) == 0:
        return np.nan
    # Clamp TWS to target range to avoid extrapolation
    tws_clamp = np.clip(tws_kts, float(np.min(xp)), float(np.max(xp)))
    twa_tgt = np.interp(tws_clamp, xp, yp)
    return float(sign * abs(twa_tgt))


def compute_twa_tgt_column(df, uw_tws, uw_twa, dw_tws, dw_twa):
    """
    Vectorized: compute Twa_tgt_deg for a dataframe. Uses Tws_kts and Twa_deg.
    """
    tws = df["Tws_kts"].astype(float).values
    twa = df["Twa_deg"].astype(float).values
    sign = np.sign(twa)
    sign[sign == 0] = 1.0
    out = np.full(len(df), np.nan, dtype=float)
    mask_uw = np.isfinite(tws) & np.isfinite(twa) & (np.abs(twa) < 90)
    mask_dw = np.isfinite(tws) & np.isfinite(twa) & (np.abs(twa) >= 90)
    if uw_tws is not None and len(uw_tws) > 0:
        tws_uw = np.clip(tws[mask_uw], np.min(uw_tws), np.max(uw_tws))
        out[mask_uw] = np.interp(tws_uw, uw_tws, uw_twa)
        out[mask_uw] = sign[mask_uw] * np.abs(out[mask_uw])
    if dw_tws is not None and len(dw_tws) > 0:
        tws_dw = np.clip(tws[mask_dw], np.min(dw_tws), np.max(dw_tws))
        out[mask_dw] = np.interp(tws_dw, dw_tws, dw_twa)
        out[mask_dw] = sign[mask_dw] * np.abs(out[mask_dw])
    return out


def fetch_latest_target(class_name, project_id):
    """Fetch latest non-polar target JSON from app API. Returns (success, target_json or None)."""
    url = (
        ":8069/api/targets/latest?"
        f"class_name={quote_plus(str(class_name))}&project_id={project_id}&isPolar=0"
    )
    try:
        resp = u.get_api_data(api_token, url)
    except Exception as e:
        u.log(api_token, "2_targets.py", "error", "fetch target", f"API request failed: {e}")
        return False, None
    if not resp or not resp.get("success"):
        u.log(api_token, "2_targets.py", "warning", "fetch target", "No target returned or success=false")
        return False, None
    data = resp.get("data")
    if not data or (isinstance(data, list) and len(data) == 0):
        u.log(api_token, "2_targets.py", "warning", "fetch target", "Target data empty")
        return False, None
    row = data[0] if isinstance(data, list) else data
    target_json = row.get("json") if isinstance(row, dict) else None
    if not target_json:
        u.log(api_token, "2_targets.py", "warning", "fetch target", "Target row has no json")
        return False, None
    return True, target_json


def apply_target_to_parquet_folder(
    folder_path,
    uw_tws,
    uw_twa,
    dw_tws,
    dw_twa,
    verbose=False,
):
    """
    Read each *_norm.parquet in folder_path, recompute Twa_tgt_deg, write back.
    Returns (files_updated, error_message). error_message is None on success.
    """
    if not os.path.isdir(folder_path):
        return 0, f"Folder does not exist: {folder_path}"
    files = [f for f in os.listdir(folder_path) if f.endswith("_norm.parquet")]
    if not files:
        u.log(api_token, "2_targets.py", "info", "apply target", f"No *_norm.parquet files in {folder_path}")
        return 0, None  # No norm files is success (nothing to do)

    has_upwind = uw_tws is not None and len(uw_tws) > 0
    has_downwind = dw_tws is not None and len(dw_tws) > 0
    if not has_upwind and not has_downwind:
        return 0, "Target has no valid UPWIND or DOWNWIND rows"

    updated = 0
    for fname in sorted(files):
        path = os.path.join(folder_path, fname)
        try:
            df = pd.read_parquet(path, engine="pyarrow")
        except Exception as e:
            u.log(api_token, "2_targets.py", "error", "read parquet", f"{fname}: {e}")
            return updated, str(e)
        if "Tws_kts" not in df.columns or "Twa_deg" not in df.columns:
            u.log(api_token, "2_targets.py", "warning", "apply target", f"{fname}: missing Tws_kts or Twa_deg, skip")
            continue
        df["Twa_tgt_deg"] = compute_twa_tgt_column(df, uw_tws, uw_twa, dw_tws, dw_twa)
        try:
            df.to_parquet(path, engine="pyarrow", index=False)
        except Exception as e:
            u.log(api_token, "2_targets.py", "error", "write parquet", f"{fname}: {e}")
            return updated, str(e)
        updated += 1
        if verbose:
            print(f"Updated {fname} ({len(df)} rows)", flush=True)
    return updated, None


def main():
    if len(sys.argv) < 2:
        print("Usage: 2_targets.py <json_params>", flush=True)
        sys.exit(1)
    try:
        params = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        u.log(api_token, "2_targets.py", "error", "parameters", f"Invalid JSON: {e}")
        sys.exit(1)

    class_name = params.get("class_name")
    project_id = params.get("project_id")
    date = params.get("date")
    source_name = params.get("source_name")
    verbose = params.get("verbose", False)

    for key in ("class_name", "project_id", "date", "source_name"):
        if not params.get(key):
            u.log(api_token, "2_targets.py", "error", "parameters", f"Missing required parameter: {key}")
            sys.exit(1)

    u.log(api_token, "2_targets.py", "info", "parameters", json.dumps(params))

    ok, target_json = fetch_latest_target(class_name, project_id)
    if not ok or not target_json:
        u.log(api_token, "2_targets.py", "warning", "targets", "No target data; skipping Twa_tgt_deg update")
        sys.exit(0)  # Plan: skip overwrite, exit success

    uw_tws, uw_twa, dw_tws, dw_twa = parse_target_json(target_json)
    if uw_tws is None and dw_tws is None:
        u.log(api_token, "2_targets.py", "warning", "targets", "Target JSON had no valid UPWIND/DOWNWIND; skipping")
        sys.exit(0)

    data_dir = os.getenv("DATA_DIRECTORY", "C:/MyApps/Hunico/Uploads/Data")
    class_lower = (class_name or "").lower()
    date_clean = (date or "").replace("-", "").replace("/", "")
    folder_path = os.path.join(data_dir, "System", str(project_id), class_lower, date_clean, source_name or "")

    if verbose:
        print(f"Applying target to parquet folder: {folder_path}", flush=True)
    n_updated, err = apply_target_to_parquet_folder(
        folder_path, uw_tws, uw_twa, dw_tws, dw_twa, verbose=verbose
    )
    if err:
        u.log(api_token, "2_targets.py", "error", "apply target", err)
        sys.exit(1)
    u.log(api_token, "2_targets.py", "info", "apply target", f"Updated Twa_tgt_deg in {n_updated} parquet file(s)")
    if verbose:
        print(f"2_targets.py completed: {n_updated} file(s) updated", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
