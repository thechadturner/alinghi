"""
Day-level cleanup script for AC40.

Runs at the end of a dataset upload process when multiple sources were added (admin scripts page).
Operates on a **day** (class_name, project_id, date), not on a single dataset.

1) VMG day baselines: For each maneuver type, aggregate maneuvers across all datasets for the day,
   filter grade > 1, remove outliers, bin by TWS, compute best (max) average VMG per wind bin,
   then update each event's loss via the maneuver-loss API (same logic as update_loss.py but
   day-scoped).

2) Race position: For each (Race_number, Leg_number), get Cumulative_sec per source, sort
   ascending, assign leg Position from sort order. RACE Position = rank by total race time
   (max Cumulative_sec over legs) ascending. RACE Positions_lost = sum of LEG Positions_lost;
   LEG Positions_lost = position this leg - position previous leg.

3) Grade by VMG: Update dataset_events.tags GRADE from events_aggregate Vmg_perc (day-scoped):
   GRADE 0 for Vmg_perc > 140, GRADE 3 for 100 < Vmg_perc < 120, GRADE 1 for Vmg_perc < 50 (AVG only).

4) Optional **pages_only** (JSON parameter): skip steps 1–3 and only run `sync_day_pages_from_events`
   — updates `dataset_pages` and `day_pages` from existing events (getRaces), channels (Tws_cor),
   PRESTART detection, and dataset report links. Use to backfill day sidebars without Race.py or
   heavy cleanup on full history.
"""

import sys
import json
import os
import urllib.parse
from datetime import datetime

import pandas as pd
import numpy as np

import utilities as u

from dotenv import load_dotenv
from pathlib import Path

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac40/)
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

load_dotenv(dotenv_path=base_env_path)
load_dotenv(dotenv_path=local_env_path, override=True)

api_token = os.getenv("SYSTEM_KEY")
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")


def normalize_date(date_str):
    """Normalize date to YYYYMMDD for API."""
    if not date_str:
        return None
    s = str(date_str).strip().replace("-", "").replace("/", "")
    if len(s) == 8:
        return s
    if len(s) == 10 and s[4] == "-":
        return s[:4] + s[5:7] + s[8:10]
    return s[:8] if len(s) >= 8 else None


def _safe_race_number_row(r):
    try:
        v = r.get("Race_number", 0)
        if v is None or v == "":
            return 0
        return int(v) if not isinstance(v, int) else v
    except (ValueError, TypeError):
        return 0


def summary_page_from_races_response(races_resp):
    """
    Align with getRaces + day cleanup: LEG rows with Leg_number > 1 and Race_number > -1.
    Training-hour payloads include HOUR on every row; racing days return rows without that shape.
    """
    data = races_resp.get("data") or []
    has_data = races_resp.get("success") and len(data) > 0
    has_training_only = has_data and all(r.get("HOUR") is not None for r in data)
    has_actual_races = has_data and not has_training_only and any(_safe_race_number_row(r) > -1 for r in data)
    return "RACE SUMMARY" if has_actual_races else "TRAINING SUMMARY"


def channels_list_has_tws_cor(channels):
    if not channels:
        return False
    for name in channels:
        if name and "tws_cor" in str(name).lower():
            return True
    return False


# ---------- VMG day baselines (similar to update_loss.py, day-scoped) ----------

def calculate_vmg_loss(vmg_baseline, vmg_avg, time_seconds):
    """Calculate VMG loss in meters. Same as update_loss.py."""
    if pd.isna(vmg_baseline) or pd.isna(vmg_avg) or pd.isna(time_seconds):
        return 0.0
    loss_meters = (vmg_baseline - vmg_avg) * (time_seconds / 3600.0) * 1000.0
    return loss_meters


def remove_outliers_iqr(series, factor=1.5):
    """Remove outliers using IQR. Returns boolean mask (True = keep)."""
    if series is None or len(series) < 4:
        return np.ones(len(series) if series is not None else 0, dtype=bool)
    q1 = series.quantile(0.25)
    q3 = series.quantile(0.75)
    iqr = q3 - q1
    if iqr <= 0:
        return np.ones(len(series), dtype=bool)
    low = q1 - factor * iqr
    high = q3 + factor * iqr
    return (series >= low) & (series <= high)


def process_maneuver_type_day(api_token, class_name, project_id, date_norm, dataset_ids, event_type, verbose=False):
    """
    Process one maneuver type for the day: fetch maneuvers from all datasets,
    aggregate, filter grade>1, remove outliers, bin by TWS, max vmg_baseline per bin,
    then update each event's loss via maneuver-loss API.
    """
    channels = [
        "vmg_baseline",
        "vmg_total_avg",
        "vmg_inv_avg",
        "vmg_turn_avg",
        "vmg_build_avg",
        "tws_avg",
    ]
    filters = {"GRADE": [2, 3, 4, 5]}
    channels_encoded = urllib.parse.quote(json.dumps(channels))
    filters_encoded = urllib.parse.quote(json.dumps(filters))

    all_rows = []
    for dataset_id in dataset_ids:
        url = (
            f":8069/api/data/maneuvers-table-data?"
            f"class_name={class_name}&project_id={project_id}&dataset_id={dataset_id}"
            f"&event_type={event_type.lower()}&channels={channels_encoded}&filters={filters_encoded}"
        )
        response = u.get_api_data(api_token, url)
        if not response.get("success"):
            if verbose:
                u.log(api_token, "4_cleanup.py", "info", f"No data for {event_type} dataset {dataset_id}", response.get("message", ""))
            continue
        data = response.get("data", [])
        if data:
            all_rows.extend(data)

    if not all_rows:
        u.log(api_token, "4_cleanup.py", "info", f"No {event_type} maneuvers for day", "Skipping")
        return True

    df = pd.DataFrame(all_rows)
    df = df.dropna(subset=["tws_avg", "vmg_baseline"])
    if len(df) == 0:
        return True

    # Remove outliers on vmg_baseline (day-level)
    keep = remove_outliers_iqr(df["vmg_baseline"])
    df = df.loc[keep].reset_index(drop=True)
    if len(df) == 0:
        return True

    df = df.sort_values("tws_avg").reset_index(drop=True)
    min_tws = df["tws_avg"].min()
    max_tws = df["tws_avg"].max()

    bins = []
    bin_start = float(min_tws)
    while bin_start < max_tws + 2:
        bins.append((bin_start, bin_start + 2))
        bin_start += 2

    bin_baselines = {}
    for bin_min, bin_max in bins:
        events_in_bin = df[(df["tws_avg"] >= bin_min) & (df["tws_avg"] < bin_max)]
        if len(events_in_bin) > 0:
            bin_baselines[(bin_min, bin_max)] = events_in_bin["vmg_baseline"].max()

    if event_type in ("bearaway", "roundup"):
        total_time, inv_time, turn_time, build_time = 30, 10, 10, 10
    else:
        total_time, inv_time, turn_time, build_time = 35, 10, 10, 15

    update_url = ":8059/api/events/maneuver-loss"
    updates_ok = 0
    updates_fail = 0
    for _, row in df.iterrows():
        event_id = row["event_id"]
        tws_avg = row["tws_avg"]
        vmg_baseline_for_bin = None
        for (bmin, bmax), bl in bin_baselines.items():
            if bmin <= tws_avg < bmax:
                vmg_baseline_for_bin = bl
                break
        if vmg_baseline_for_bin is None:
            updates_fail += 1
            continue

        loss_total_vmg = calculate_vmg_loss(vmg_baseline_for_bin, row.get("vmg_total_avg", 0), total_time)
        loss_inv_vmg = calculate_vmg_loss(vmg_baseline_for_bin, row.get("vmg_inv_avg", 0), inv_time)
        loss_turn_vmg = calculate_vmg_loss(vmg_baseline_for_bin, row.get("vmg_turn_avg", 0), turn_time)
        loss_build_vmg = calculate_vmg_loss(vmg_baseline_for_bin, row.get("vmg_build_avg", 0), build_time)

        body = {
            "class_name": class_name,
            "project_id": int(project_id),
            "event_id": int(event_id),
            "vmg_applied": float(round(vmg_baseline_for_bin, 2)),
            "loss_total_vmg": float(round(loss_total_vmg, 2)),
            "loss_inv_vmg": float(round(loss_inv_vmg, 2)),
            "loss_turn_vmg": float(round(loss_turn_vmg, 2)),
            "loss_build_vmg": float(round(loss_build_vmg, 2)),
        }
        resp = u.put_api_data(api_token, update_url, body)
        if resp.get("success"):
            updates_ok += 1
        else:
            updates_fail += 1

    u.log(api_token, "4_cleanup.py", "info", f"{event_type} day VMG", f"Updated: {updates_ok}, Failed: {updates_fail}")
    return updates_fail == 0


def run_vmg_day(api_token, class_name, project_id, date_norm, dataset_ids, verbose=False):
    """Run VMG baseline and loss updates for the day (all maneuver types)."""
    maneuver_types = ["TACK", "GYBE", "ROUNDUP", "BEARAWAY", "TAKEOFF"]
    all_ok = True
    for event_type in maneuver_types:
        ok = process_maneuver_type_day(
            api_token, class_name, project_id, date_norm, dataset_ids, event_type, verbose
        )
        all_ok = all_ok and ok
    return all_ok


# ---------- Race position from leg durations ----------

def parse_event_time(ts_str):
    """Parse start_time/end_time from API (ISO or numeric) to Unix seconds."""
    if ts_str is None:
        return None
    if isinstance(ts_str, (int, float)):
        return float(ts_str)
    try:
        dt = pd.to_datetime(ts_str, utc=True)
        return float(dt.timestamp())
    except Exception:
        return None


def run_race_position_day(api_token, class_name, project_id, date_norm, datasets_info, verbose=False):
    """
    For each (race, leg): get list of Cumulative_sec per source, sort ascending, assign
    leg Position from sort order. RACE Position = rank by total race time (max
    Cumulative_sec over legs) ascending; position 1 = fastest. RACE Positions_lost =
    sum of LEG Positions_lost; LEG Positions_lost = position this leg - position previous leg.
    """
    # datasets_info: list of { dataset_id, source_name }
    # Collect (event_id, dataset_id, source_name, event_type, Race_number, Leg_number, start_ts, end_ts, duration_s)
    rows = []
    for d in datasets_info:
        dataset_id = d.get("dataset_id")
        source_name = d.get("source_name", "")
        for event_type in ("RACE", "LEG"):
            url = (
                f":8069/api/events/info?"
                f"class_name={class_name}&project_id={project_id}&dataset_id={dataset_id}"
                f"&event_type={event_type}&timezone=UTC"
            )
            resp = u.get_api_data(api_token, url)
            if not resp.get("success"):
                continue
            data = resp.get("data") or []
            for ev in data:
                event_id = ev.get("event_id")
                tags = ev.get("tags") or {}
                try:
                    race_num = tags.get("Race_number")
                    if race_num is not None:
                        race_num = int(race_num) if not isinstance(race_num, int) else race_num
                except (TypeError, ValueError):
                    race_num = None
                leg_num = None
                if event_type == "LEG":
                    try:
                        leg_num = tags.get("Leg_number")
                        if leg_num is not None:
                            leg_num = int(leg_num) if not isinstance(leg_num, int) else leg_num
                    except (TypeError, ValueError):
                        leg_num = None
                start_ts = parse_event_time(ev.get("start_time"))
                end_ts = parse_event_time(ev.get("end_time"))
                duration_s = None
                if start_ts is not None and end_ts is not None and end_ts >= start_ts:
                    duration_s = end_ts - start_ts
                row = {
                    "event_id": event_id,
                    "dataset_id": dataset_id,
                    "source_name": source_name,
                    "event_type": event_type,
                    "Race_number": race_num,
                    "Leg_number": leg_num,
                    "start_ts": start_ts,
                    "end_ts": end_ts,
                    "duration_s": duration_s,
                }
                if event_type == "RACE":
                    rs_duration = ev.get("duration_sec")
                    rs_cumulative = ev.get("cumulative_sec")
                    if rs_duration is not None and not (isinstance(rs_duration, (int, float)) and np.isnan(rs_duration)):
                        row["race_stats_duration_sec"] = float(rs_duration)
                    else:
                        row["race_stats_duration_sec"] = None
                    if rs_cumulative is not None and not (isinstance(rs_cumulative, (int, float)) and np.isnan(rs_cumulative)):
                        row["race_stats_cumulative_sec"] = float(rs_cumulative)
                    else:
                        row["race_stats_cumulative_sec"] = None
                rows.append(row)

    if not rows:
        u.log(api_token, "4_cleanup.py", "info", "Race position day", "No RACE/LEG events found")
        return True

    df = pd.DataFrame(rows)

    # Group by (Race_number). For each race, we have RACE events (one per source) and LEG events (per source, per leg).
    # Only consider legs where duration_s is not null (exclude legs with missing/invalid times).
    race_numbers = df["Race_number"].dropna().unique()
    leg_events = df[(df["event_type"] == "LEG") & df["duration_s"].notna()].copy()
    race_events = df[df["event_type"] == "RACE"].copy()

    # Cumulative_sec per LEG: for each (dataset_id, Race_number), cumulative sum of duration_s by Leg_number order
    # (same as Race.py). Used to determine leg positioning: rank by Cumulative_sec ascending = position.
    leg_events["Cumulative_sec"] = np.nan
    for (_did, race_num), grp in leg_events.groupby(["dataset_id", "Race_number"]):
        grp_sorted = grp.sort_values("Leg_number")
        dur = grp_sorted["duration_s"].values
        cum = np.full(len(dur), np.nan, dtype=float)
        acc = 0.0
        for i in range(len(dur)):
            d = dur[i]
            if not pd.isna(d):
                acc += float(d)
                cum[i] = acc
            else:
                cum[i] = np.nan
        for i, idx in enumerate(grp_sorted.index):
            leg_events.at[idx, "Cumulative_sec"] = cum[i] if not np.isnan(cum[i]) else np.nan

    # Include all legs for positions: for each race, score legs 1..last. RACE position = position on final leg.
    # Build per-race list of legs to score (include the last leg).
    legs_to_score_by_race = {}
    for race_num in race_numbers:
        rn_legs = leg_events[leg_events["Race_number"] == race_num]
        leg_nums = sorted([int(x) for x in rn_legs["Leg_number"].dropna().unique()])
        legs_to_score_by_race[race_num] = leg_nums

    # Leg position: determined solely by Cumulative_sec (elapsed time to end of leg). Lower = faster = better (position 1).
    # Only assign position to rows with valid Cumulative_sec; leave position nan for missing/invalid.
    leg_events["position"] = np.nan
    for race_num in race_numbers:
        legs_to_score = legs_to_score_by_race.get(race_num, [])
        for leg_num in legs_to_score:
            subset = leg_events[(leg_events["Race_number"] == race_num) & (leg_events["Leg_number"] == leg_num)]
            if subset.empty:
                continue
            # Restrict to rows with valid Cumulative_sec so we rank only comparable times
            valid = subset["Cumulative_sec"].notna()
            if not valid.any():
                continue
            subset_valid = subset.loc[valid]
            # Sort by Cumulative_sec ascending; position = 1-based rank (1 = fastest)
            order = subset_valid["Cumulative_sec"].rank(method="min", ascending=True)
            for idx in subset_valid.index:
                rk = order[idx]
                leg_events.at[idx, "position"] = int(rk) if not np.isnan(rk) else np.nan

    # Positions_lost = position this leg - position previous leg (for LEG events only). Only for legs we score.
    # For leg 1, Positions_lost = 0 (no previous leg). Sign for leg 2+: positive = lost a place, negative = gained.
    leg_events["Positions_lost"] = np.nan
    for race_num in race_numbers:
        legs_to_score = legs_to_score_by_race.get(race_num, [])
        for i, leg_num in enumerate(legs_to_score):
            mask = (leg_events["Race_number"] == race_num) & (leg_events["Leg_number"] == leg_num)
            prev_leg = legs_to_score[i - 1] if i > 0 else None
            for idx in leg_events.index[mask]:
                pos_curr = leg_events.at[idx, "position"]
                if pd.isna(pos_curr):
                    continue
                if prev_leg is None:
                    # Leg 1: Positions_lost = 0 by default
                    leg_events.at[idx, "Positions_lost"] = 0
                else:
                    did = leg_events.at[idx, "dataset_id"]
                    prev_row = leg_events[
                        (leg_events["Race_number"] == race_num)
                        & (leg_events["Leg_number"] == prev_leg)
                        & (leg_events["dataset_id"] == did)
                    ]
                    if not prev_row.empty:
                        pos_prev = prev_row["position"].iloc[0]
                        if not np.isnan(pos_prev):
                            # pos_curr - pos_prev: drop in rank -> positive, gain in rank -> negative
                            leg_events.at[idx, "Positions_lost"] = int(round(pos_curr - pos_prev))

    # RACE position = rank by total race time. Use stored race_stats Duration_sec (same as UI) when
    # available so position order matches displayed cumulative_sec. Per race, rank only sources that
    # completed all legs; position 1 = fastest.
    race_events["position"] = np.nan
    for race_num in race_numbers:
        total_legs = len(legs_to_score_by_race.get(race_num, []))
        if total_legs == 0:
            continue
        # Legs completed per (dataset_id, race_num): count LEG rows with duration_s > 0 for this race
        rn_legs_with_duration = leg_events[
            (leg_events["Race_number"] == race_num)
            & leg_events["duration_s"].notna()
            & (leg_events["duration_s"] > 0)
        ]
        legs_completed = rn_legs_with_duration.groupby("dataset_id").size()
        eligible_dids = legs_completed[legs_completed == total_legs].index.tolist()

        rn_race = race_events[(race_events["Race_number"] == race_num) & (race_events["dataset_id"].isin(eligible_dids))]
        if rn_race.empty:
            continue
        # Prefer stored race total from race_stats (matches UI); fall back to leg-derived total if missing
        if "race_stats_duration_sec" in rn_race.columns and rn_race["race_stats_duration_sec"].notna().any():
            total_sec = (
                rn_race.dropna(subset=["race_stats_duration_sec"])
                .drop_duplicates("dataset_id")
                .set_index("dataset_id")["race_stats_duration_sec"]
            )
        else:
            rn_legs = leg_events[leg_events["Race_number"] == race_num]
            rn_legs_eligible = rn_legs[rn_legs["dataset_id"].isin(eligible_dids)]
            if rn_legs_eligible.empty:
                continue
            total_sec = rn_legs_eligible.groupby("dataset_id")["Cumulative_sec"].max().dropna()
        if total_sec.empty:
            continue
        # Rank by total_sec ascending (1 = fastest)
        position_series = total_sec.rank(method="min", ascending=True)
        for did, pos in position_series.items():
            if pd.isna(pos):
                continue
            pos = int(pos)
            mask = (race_events["Race_number"] == race_num) & (race_events["dataset_id"] == did)
            race_events.loc[mask, "position"] = pos

    # RACE Positions_lost = sum of that source's LEG Positions_lost (same sign: positive = net places lost, negative = net gained).
    race_events["Positions_lost"] = np.nan
    for (did, race_num), leg_grp in leg_events.groupby(["dataset_id", "Race_number"]):
        pl = leg_grp["Positions_lost"].dropna()
        total_lost = int(round(pl.sum())) if len(pl) > 0 else 0
        mask = (race_events["dataset_id"] == did) & (race_events["Race_number"] == race_num)
        race_events.loc[mask, "Positions_lost"] = total_lost

    # Maneuver loss averages: fetched from server_app GET /api/events/maneuver-loss-averages (port 8069).
    # That API reads ac40.maneuver_stats (Loss_total_tgt) joined to dataset_events, grouped by
    # dataset_id/race_number[/leg_number], only events with GRADE>1 and Race_number in tags.
    # Averages can be null if: maneuver_stats has no row for those events, Loss_total_tgt is null,
    # or no TACK/GYBE/ROUNDUP/BEARAWAY events exist with GRADE>1 for that race/leg. maneuver_stats
    # is populated by the maneuver scripts (tacks.py, gybes.py, etc.) when they POST to the
    # aggregates API; run those before day cleanup if you need loss averages.
    dataset_ids_list = df["dataset_id"].dropna().unique().tolist()
    race_events["Tack_loss_avg"] = np.nan
    race_events["Gybe_loss_avg"] = np.nan
    race_events["Roundup_loss_avg"] = np.nan
    race_events["Bearaway_loss_avg"] = np.nan
    leg_events["Tack_loss_avg"] = np.nan
    leg_events["Gybe_loss_avg"] = np.nan
    leg_events["Roundup_loss_avg"] = np.nan
    leg_events["Bearaway_loss_avg"] = np.nan
    if dataset_ids_list:
        ids_param = ",".join(str(int(x)) for x in dataset_ids_list)
        url = (
            f":8069/api/events/maneuver-loss-averages?"
            f"class_name={urllib.parse.quote(class_name)}&project_id={project_id}&dataset_ids={urllib.parse.quote(ids_param)}&scope=both"
        )
        resp = u.get_api_data(api_token, url)
        if resp.get("success"):
            data = resp.get("data") or {}
            race_list = data.get("race") or []
            leg_list = data.get("leg") or []
            race_lookup = {}
            for row in race_list:
                did = row.get("dataset_id")
                rn = row.get("race_number")
                if did is not None and rn is not None:
                    race_lookup[(int(did), int(rn))] = {
                        "Tack_loss_avg": row.get("tack_loss_avg"),
                        "Gybe_loss_avg": row.get("gybe_loss_avg"),
                        "Roundup_loss_avg": row.get("roundup_loss_avg"),
                        "Bearaway_loss_avg": row.get("bearaway_loss_avg"),
                    }
            leg_lookup = {}
            for row in leg_list:
                did = row.get("dataset_id")
                rn = row.get("race_number")
                ln = row.get("leg_number")
                if did is not None and rn is not None and ln is not None:
                    leg_lookup[(int(did), int(rn), int(ln))] = {
                        "Tack_loss_avg": row.get("tack_loss_avg"),
                        "Gybe_loss_avg": row.get("gybe_loss_avg"),
                        "Roundup_loss_avg": row.get("roundup_loss_avg"),
                        "Bearaway_loss_avg": row.get("bearaway_loss_avg"),
                    }
            for idx, rrow in race_events.iterrows():
                did = rrow["dataset_id"]
                rn = rrow["Race_number"]
                if pd.isna(did) or pd.isna(rn):
                    continue
                key = (int(did), int(rn))
                if key in race_lookup:
                    for col, val in race_lookup[key].items():
                        if val is not None and not (isinstance(val, float) and np.isnan(val)):
                            race_events.at[idx, col] = round(float(val), 2)
            for idx, lrow in leg_events.iterrows():
                did = lrow["dataset_id"]
                rn = lrow["Race_number"]
                ln = lrow["Leg_number"]
                if pd.isna(did) or pd.isna(rn) or pd.isna(ln):
                    continue
                key = (int(did), int(rn), int(ln))
                if key in leg_lookup:
                    for col, val in leg_lookup[key].items():
                        if val is not None and not (isinstance(val, float) and np.isnan(val)):
                            leg_events.at[idx, col] = round(float(val), 2)

    # POST updates: race_stats with event_id, Position and optionally Positions_lost and maneuver loss averages
    aggregates_url = ":8059/api/events/aggregates"
    updated = 0
    failed = 0

    loss_avg_cols = ["Tack_loss_avg", "Gybe_loss_avg", "Roundup_loss_avg", "Bearaway_loss_avg"]
    for _, rrow in race_events.iterrows():
        if np.isnan(rrow.get("position")):
            continue
        row_payload = {"event_id": int(rrow["event_id"]), "Position": int(rrow["position"])}
        pl = rrow.get("Positions_lost")
        if pl is not None and not np.isnan(pl):
            row_payload["Positions_lost"] = int(pl)
        for col in loss_avg_cols:
            val = rrow.get(col)
            if val is not None and not np.isnan(val):
                row_payload[col] = round(float(val), 2)
        jsondata = {
            "class_name": class_name,
            "project_id": int(project_id),
            "table": "race_stats",
            "json": json.dumps({"rows": [row_payload]}),
        }
        res = u.post_api_data(api_token, aggregates_url, jsondata)
        if res.get("success"):
            updated += 1
        else:
            failed += 1

    for _, lrow in leg_events.iterrows():
        pos = lrow.get("position")
        if pos is None or np.isnan(pos):
            continue
        row_payload = {"event_id": int(lrow["event_id"]), "Position": int(pos)}
        pl = lrow.get("Positions_lost")
        if pl is not None and not np.isnan(pl):
            row_payload["Positions_lost"] = int(pl)
        for col in loss_avg_cols:
            val = lrow.get(col)
            if val is not None and not np.isnan(val):
                row_payload[col] = round(float(val), 2)
        jsondata = {
            "class_name": class_name,
            "project_id": int(project_id),
            "table": "race_stats",
            "json": json.dumps({"rows": [row_payload]}),
        }
        res = u.post_api_data(api_token, aggregates_url, jsondata)
        if res.get("success"):
            updated += 1
        else:
            failed += 1

    u.log(api_token, "4_cleanup.py", "info", "Race position day", f"Updated: {updated}, Failed: {failed}")
    return failed == 0


# ---------- Main: day-level cleanup ----------

def run_day_cleanup(api_token, class_name, project_id, date_norm, verbose=False):
    """Run full day cleanup: VMG day baselines + race position."""
    # 1) Get all datasets for this day
    url = f":8069/api/datasets/date/dataset_id?class_name={class_name}&project_id={project_id}&date={date_norm}"
    resp = u.get_api_data(api_token, url)
    if not resp.get("success"):
        u.log(api_token, "4_cleanup.py", "error", "Day cleanup", f"Failed to get datasets: {resp.get('message', '')}")
        return False
    datasets = resp.get("data") or []
    if not datasets:
        u.log(api_token, "4_cleanup.py", "info", "Day cleanup", "No datasets for this date")
        return True

    dataset_ids = [d.get("dataset_id") for d in datasets if d.get("dataset_id") is not None]
    if not dataset_ids:
        return True

    u.log(api_token, "4_cleanup.py", "info", "Day cleanup VMG", f"Datasets: {len(dataset_ids)}")
    vmg_ok = run_vmg_day(api_token, class_name, project_id, date_norm, dataset_ids, verbose)

    u.log(api_token, "4_cleanup.py", "info", "Day cleanup race position", f"Datasets: {len(datasets)}")
    position_ok = run_race_position_day(api_token, class_name, project_id, date_norm, datasets, verbose)

    u.log(api_token, "4_cleanup.py", "info", "Day cleanup grade-by-VMG", "Updating GRADE from events_aggregate Vmg_perc")
    grade_ok = True
    try:
        grade_url = ":8059/api/admin/events/grade-by-vmg"
        jsondata = {"class_name": class_name, "project_id": project_id, "date": date_norm}
        resp = u.post_api_data(api_token, grade_url, jsondata)
        if not resp.get("success"):
            u.log(api_token, "4_cleanup.py", "warning", "Grade-by-VMG", resp.get("message", "Unknown error"))
            grade_ok = False
    except Exception as e:
        u.log(api_token, "4_cleanup.py", "warning", "Grade-by-VMG", str(e))
        grade_ok = False

    return vmg_ok and position_ok and grade_ok


def sync_day_pages_from_events(api_token, class_name, project_id, date_norm):
    """
    Upsert dataset_pages (RACE/TRAINING summary, CALIBRATION from Tws_cor) and day_pages
    (summary, opposite removed, PRESTART, PERFORMANCE/MANEUVERS from dataset_pages, day CALIBRATION).
    Uses only read APIs + admin page/day-page POSTs. No VMG, race position, or grade-by-VMG.

    Returns True if the dataset list call succeeded (including zero datasets); False on API failure.
    """
    url = f":8069/api/datasets/date/dataset_id?class_name={class_name}&project_id={project_id}&date={date_norm}"
    resp = u.get_api_data(api_token, url)
    if not resp.get("success"):
        u.log(api_token, "4_cleanup.py", "error", "sync_day_pages_from_events", f"Failed to get datasets: {resp.get('message', '')}")
        return False

    datasets = resp.get("data") or []
    cn_enc = urllib.parse.quote(class_name, safe="")
    has_tws_cor_any = False

    # Dataset_pages: RACE SUMMARY vs TRAINING SUMMARY per dataset; CALIBRATION if Tws_cor* channels exist
    for d in datasets:
        dataset_id = d.get("dataset_id")
        if dataset_id is None:
            continue
        races_ds_url = f":8069/api/datasets/date/races?class_name={cn_enc}&project_id={project_id}&date={date_norm}&dataset_id={dataset_id}"
        races_ds = u.get_api_data(api_token, races_ds_url)
        ds_summary = summary_page_from_races_response(races_ds)
        jsondata = {"class_name": class_name, "project_id": project_id, "dataset_id": dataset_id, "page_name": ds_summary}
        res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)
        if res.get("success"):
            u.log(api_token, "4_cleanup.py", "info", "Page Loaded!", f"page_name: {ds_summary} dataset_id={dataset_id}")
        else:
            u.log(api_token, "4_cleanup.py", "error", "Page load failed!", f"page_name: {ds_summary} dataset_id={dataset_id}")

        ch_url = f":8069/api/datasets/channels?class_name={cn_enc}&project_id={project_id}&date={date_norm}&dataset_id={dataset_id}"
        ch_resp = u.get_api_data(api_token, ch_url)
        ch_list = ch_resp.get("data") if ch_resp.get("success") else None
        if channels_list_has_tws_cor(ch_list):
            has_tws_cor_any = True
            cal_res = u.post_api_data(
                api_token,
                ":8059/api/datasets/page",
                {"class_name": class_name, "project_id": project_id, "dataset_id": dataset_id, "page_name": "CALIBRATION"},
            )
            if cal_res.get("success"):
                u.log(api_token, "4_cleanup.py", "info", "Page Loaded!", f"page_name: CALIBRATION dataset_id={dataset_id}")
            else:
                u.log(api_token, "4_cleanup.py", "warning", "CALIBRATION page load failed", cal_res.get("message", "unknown"))

    # Day_pages: one summary page (RACE or TRAINING) for the whole day; remove the opposite day/reports summary if present
    races_resp = u.get_api_data(api_token, f":8069/api/datasets/date/races?class_name={cn_enc}&project_id={project_id}&date={date_norm}")
    summary_page = summary_page_from_races_response(races_resp)
    other_summary = "TRAINING SUMMARY" if summary_page == "RACE SUMMARY" else "RACE SUMMARY"
    del_other = u.delete_api_data(
        api_token,
        ":8059/api/datasets/day-page",
        {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": other_summary},
    )
    if not del_other.get("success"):
        u.log(api_token, "4_cleanup.py", "info", "Day page delete opposite summary (non-fatal if absent)", del_other.get("message", "unknown"))

    day_page_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": summary_page}
    day_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", day_page_payload)
    if day_res.get("success"):
        u.log(api_token, "4_cleanup.py", "info", "Day page upserted", f"page_name: {summary_page}")
    else:
        u.log(api_token, "4_cleanup.py", "warning", "Day page upsert failed", day_res.get("message", "unknown"))

    has_prestarts = False
    for d in datasets:
        did = d.get("dataset_id")
        if did is None:
            continue
        prestart_resp = u.get_api_data(api_token, f":8069/api/events/info?class_name={class_name}&project_id={project_id}&dataset_id={did}&event_type=PRESTART&timezone=UTC")
        if prestart_resp.get("success") and prestart_resp.get("data") and len(prestart_resp.get("data")) > 0:
            has_prestarts = True
            break
    if has_prestarts:
        # Must match ac40.pages.page_name (day/reports), e.g. "START SUMMARY" -> Prestart.tsx — not event_type "PRESTART"
        prestart_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": "START SUMMARY"}
        prestart_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", prestart_payload)
        if prestart_res.get("success"):
            u.log(api_token, "4_cleanup.py", "info", "Day page upserted", "page_name: START SUMMARY (Prestart)")
        else:
            u.log(api_token, "4_cleanup.py", "warning", "Day page START SUMMARY upsert failed", prestart_res.get("message", "unknown"))

    day_report_pages_to_sync = {"PERFORMANCE", "MANEUVERS"}
    found_day_reports = set()
    pt_enc = urllib.parse.quote("dataset/reports", safe="")
    for d in datasets:
        did = d.get("dataset_id")
        if did is None:
            continue
        pages_url = f":8069/api/pages?class_name={cn_enc}&project_id={project_id}&dataset_id={did}&page_type={pt_enc}"
        pages_resp = u.get_api_data(api_token, pages_url)
        if not pages_resp.get("success") or not pages_resp.get("data"):
            continue
        for item in pages_resp["data"]:
            pname = (item.get("page_name") or "").strip().upper()
            if pname in day_report_pages_to_sync:
                found_day_reports.add(pname)
    for pname in sorted(found_day_reports):
        sync_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": pname}
        sync_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", sync_payload)
        if sync_res.get("success"):
            u.log(api_token, "4_cleanup.py", "info", "Day page upserted (sync from dataset_pages)", f"page_name: {pname}")
        else:
            u.log(api_token, "4_cleanup.py", "warning", "Day page sync upsert failed", f"{pname}: {sync_res.get('message', 'unknown')}")

    if has_tws_cor_any:
        cal_day_res = u.post_api_data(
            api_token,
            ":8059/api/datasets/day-page",
            {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": "CALIBRATION"},
        )
        if cal_day_res.get("success"):
            u.log(api_token, "4_cleanup.py", "info", "Day page upserted", "page_name: CALIBRATION")
        else:
            u.log(api_token, "4_cleanup.py", "warning", "Day page CALIBRATION upsert failed", cal_day_res.get("message", "unknown"))

    return True


if __name__ == "__main__":
    try:
        parameters_str = sys.argv[1]
        parameters_json = json.loads(parameters_str)

        class_name = parameters_json.get("class_name")
        project_id = parameters_json.get("project_id")
        date = parameters_json.get("date")
        verbose = parameters_json.get("verbose", False)
        pages_only = bool(parameters_json.get("pages_only", False))

        # class_name = "ac40"
        # project_id = 1
        # date = "20260118"
        # verbose = True

        if not class_name or not project_id or not date:
            u.log(api_token, "4_cleanup.py", "error", "Day cleanup", "class_name, project_id, and date are required")
            print("4_cleanup.py requires class_name, project_id, and date (day-level cleanup)", flush=True)
            sys.exit(1)

        date_norm = normalize_date(date)
        if not date_norm:
            u.log(api_token, "4_cleanup.py", "error", "Day cleanup", f"Invalid date: {date}")
            sys.exit(1)

        if pages_only:
            u.log(api_token, "4_cleanup.py", "info", "Day pages sync only", f"date={date_norm} (skipping VMG, race position, grade-by-VMG)")
            print("4_cleanup.py pages_only: syncing day_pages from events...", flush=True)
            sync_ok = sync_day_pages_from_events(api_token, class_name, project_id, date_norm)
            if sync_ok:
                print("Day pages sync completed:", u.dt.now(), flush=True)
                sys.exit(0)
            print("Day pages sync failed (dataset list API)", flush=True)
            sys.exit(1)

        u.log(api_token, "4_cleanup.py", "info", "Day cleanup starting", f"date={date_norm}")

        success = run_day_cleanup(api_token, class_name, project_id, date_norm, verbose)

        if success:
            u.log(api_token, "4_cleanup.py", "info", "Day cleanup completed", str(u.dt.now()))
            print("Day cleanup completed:", u.dt.now(), flush=True)
            sync_day_pages_from_events(api_token, class_name, project_id, date_norm)
            sys.exit(0)
        else:
            u.log(api_token, "4_cleanup.py", "warn", "Day cleanup completed with errors", str(u.dt.now()))
            print("Day cleanup completed with errors", flush=True)
            sys.exit(1)
    except Exception as e:
        u.log(api_token, "4_cleanup.py", "error", "exception", str(e))
        print(f"Script exception error: {e}", flush=True)
        sys.exit(1)
