import pandas as pd
import numpy as np
import sys
import json
import pyarrow as pa
import os
import urllib.parse
from datetime import datetime, timedelta, timezone
import pytz

# Configure stdout/stderr to use UTF-8 encoding to handle Unicode characters
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

import utilities as u

current_dir = os.path.dirname(os.path.abspath(__file__))
maneuvers_path = os.path.join(current_dir, 'maneuvers')
sys.path.append(maneuvers_path)

import prestart as p

from dotenv import load_dotenv
from pathlib import Path

s = u.LocalStorage()

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/gp50/)
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode
# Development: .env -> .env.local
# Production: .env.production -> .env.production.local
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

load_dotenv(dotenv_path=base_env_path)
load_dotenv(dotenv_path=local_env_path, override=True)

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

def get_data(class_name, project_id, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'ts', 'type': 'float'},
            {'name': 'Lat_dd', 'type': 'float'},
            {'name': 'Lng_dd', 'type': 'float'},
            {'name': 'Twd_cor_deg', 'type': 'angle360'},
            {'name': 'Tws_cor_kph', 'type': 'float'},
            
            {'name': 'Polar_perc', 'type': 'float'},
            {'name': 'Bsp_kts', 'type': 'float'},
            {'name': 'Twa_cor_deg', 'type': 'float'},
            {'name': 'Twa_n_cor_deg', 'type': 'float'},
            {'name': 'Vmg_cor_kph', 'type': 'float'},
            {'name': 'Vmg_cor_perc', 'type': 'float'},
            # Fallback channels (used when _cor_ values are missing)
            {'name': 'Tws_kph', 'type': 'float'},
            {'name': 'Twd_deg', 'type': 'angle360'},
            {'name': 'Twa_deg', 'type': 'float'},
            {'name': 'Twa_n_deg', 'type': 'float'},
            {'name': 'Vmg_kph', 'type': 'float'},
            {'name': 'Vmg_perc', 'type': 'float'},

            {'name': 'Pitch_deg', 'type': 'float'},
            {'name': 'Heel_n_deg', 'type': 'float'},
            {'name': 'RH_lwd_mm', 'type': 'float'},

            {'name': 'RUD_rake_ang_deg', 'type': 'float'},
            {'name': 'RUD_diff_ang_deg', 'type': 'float'},
            {'name': 'DB_cant_lwd_deg', 'type': 'float'},
            {'name': 'DB_cant_eff_lwd_deg', 'type': 'float'},

            {'name': 'CA1_ang_n_deg', 'type': 'float'},
            {'name': 'WING_twist_n_deg', 'type': 'float'},
            {'name': 'WING_clew_pos_n_mm', 'type': 'float'},
            {'name': 'JIB_sheet_load_kgf', 'type': 'float'},
            {'name': 'JIB_cunno_load_kgf', 'type': 'float'},
            {'name': 'JIB_lead_ang_deg', 'type': 'float'},

            {'name': 'Foiling_state', 'type': 'int'},
            {'name': 'Phase_id', 'type': 'int'},
            {'name': 'Race_number', 'type': 'int'},
            {'name': 'Leg_number', 'type': 'int'},
            {'name': 'Maneuver_type', 'type': 'string'},
            {'name': 'Grade', 'type': 'int'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '100ms', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            # Rename corrected (_cor) channels to standard names. If a corrected column exists,
            # drop the standard column first (to avoid duplicate names), then rename. Otherwise keep standard as fallback.
            cor_to_standard = {
                'Tws_cor_kph': 'Tws_kph',
                'Twd_cor_deg': 'Twd_deg',
                'Twa_cor_deg': 'Twa_deg',
                'Twa_n_cor_deg': 'Twa_n_deg',
                'Vmg_cor_kph': 'Vmg_kph',
                'Vmg_cor_perc': 'Vmg_perc',
            }
            for cor_name, std_name in cor_to_standard.items():
                if cor_name in dfi.columns:
                    if std_name in dfi.columns:
                        dfi.drop(columns=[std_name], inplace=True)
                    dfi.rename(columns={cor_name: std_name}, inplace=True)

            u.log(api_token, "Race.py", "info", "get_data", str(len(dfi))+" records found!")

            return dfi
        else:
            return df
    except Exception as e:
        u.log(api_token, "Race.py", "error", "processing data", "script exception error:"+str(e))
        return df

def getRaceObject(class_name, project_id, dataset_id):
    dataset_id = int(dataset_id) if dataset_id is not None else None
    project_id_int = int(project_id) if project_id is not None else None
    res = u.get_api_data(api_token, ":8069/api/events/info?class_name="+str(class_name)+"&project_id="+str(project_id_int)+"&dataset_id="+str(dataset_id)+"&event_type=RACE&timezone=UTC")

    if res and res.get("success"):
        json_data = res["data"]

        # Fetch LEG events once (was N calls when done inside the loop)
        leg_res = u.get_api_data(api_token, ":8069/api/events/info?class_name="+str(class_name)+"&project_id="+str(project_id_int)+"&dataset_id="+str(dataset_id)+"&event_type=LEG&timezone=UTC")
        legs_by_race = {}
        if leg_res and leg_res.get("success"):
            for leg_event in leg_res["data"]:
                tags = leg_event.get("tags") or {}
                race_num = tags.get("Race_number")
                if race_num is not None:
                    leg_list = legs_by_race.setdefault(race_num, [])
                    leg_list.append({
                        "Event_id": leg_event["event_id"],
                        "Leg_number": tags.get("Leg_number"),
                    })

        # FOR EACH RACE
        race_objects = []
        for event in json_data:
            event_id = event['event_id']
            tags = event['tags']

            race_object = {}
            race_number = tags['Race_number']

            race_object['Event_id'] = event_id
            race_object['Race_number'] = race_number
            # Store race event times so prestart can use a single reference for marks (avoids per-boat offset)
            race_object['start_time'] = event.get('start_time')
            race_object['end_time'] = event.get('end_time')

            Leg_numbers = legs_by_race.get(race_number, [])
            race_object['Legs'] = Leg_numbers

            race_objects.append(race_object)

        return race_objects
    return None

def _safe_col_mean(df, col):
    """Return mean of column if present, else None. Handles empty df."""
    if df is None or len(df) == 0 or col not in df.columns:
        return None
    val = df[col].mean()
    return None if (val is None or (isinstance(val, float) and np.isnan(val))) else val

def _safe_col_std(df, col):
    """Return std of column if present, else None. Handles empty df."""
    if df is None or len(df) == 0 or col not in df.columns:
        return None
    val = df[col].std()
    return None if (val is None or (isinstance(val, float) and np.isnan(val))) else val

def _safe_col_series(df, col):
    """Return series if column present, else None."""
    if df is None or col not in df.columns:
        return None
    return df[col]

def _empty_channelinfo(event_id, isRace, previous_cumulative_sec=None):
    """Return minimal channelinfo dict when df is empty or missing required columns."""
    cumulative_sec = float(previous_cumulative_sec) if previous_cumulative_sec is not None else None
    out = {
        'event_id': int(event_id),
        'Duration_sec': None,
        'Cumulative_sec': cumulative_sec,
        'Distance_m': None,
        'Tws_avg_kph': None,
        'Twd_avg_deg': None,
        'Bsp_avg_kph': None,
        'Bsp_max_kph': None,
        'Vmg_avg_kph': None,
        'Foiling_perc': None,
        'Maneuver_count': None,
        'Phase_duration_avg_sec': None,
        'Bsp_start_kph': None,
    }
    if isRace:
        out['Vmg_perc_avg'] = None
        out['Polar_perc_avg'] = None
    else:
        out['Leg_start_twa'] = None
        out['Leg_end_twa'] = None
        out['Twa_avg_deg'] = None
        out['Polar_perc_avg'] = None
        out['Vmg_perc_avg'] = None
        out['Heel_avg_deg'] = None
        out['Heel_std_deg'] = None
        out['Pitch_avg_deg'] = None
        out['Pitch_std_deg'] = None
        out['RH_lwd_avg_mm'] = None
        out['RH_lwd_std_mm'] = None
        out['CA1_avg_deg'] = None
        out['WING_twist_avg_deg'] = None
        out['WING_clew_pos_n_mm'] = None
        out['RUD_rake_ang_deg'] = None
        out['RUD_diff_ang_deg'] = None
        out['DB_cant_avg_deg'] = None
        out['DB_cant_eff_avg_deg'] = None
        out['JIB_sheet_avg_deg'] = None
        out['JIB_lead_avg_deg'] = None
        out['JIB_cunno_avg_deg'] = None
        out['Legs_completed'] = 0
    return out

def getChannelInfo(event_id, df, isRace=True, previous_cumulative_sec=None):
    if df is None or len(df) == 0:
        return _empty_channelinfo(event_id, isRace, previous_cumulative_sec)
    if 'ts' not in df.columns:
        return _empty_channelinfo(event_id, isRace, previous_cumulative_sec)

    start_ts = df['ts'].min()
    end_ts = df['ts'].max()
    time_s = end_ts - start_ts
    tws_avg = _safe_col_mean(df, 'Tws_kph')
    twd_deg_series = _safe_col_series(df, 'Twd_deg')
    twd_avg = u.mean360(list(twd_deg_series)) if twd_deg_series is not None else None
    bsp_avg = _safe_col_mean(df, 'Bsp_kts')
    bsp_max = df['Bsp_kts'].max() if 'Bsp_kts' in df.columns else None

    leg_col = 'Leg_number' in df.columns
    dfrf = df.loc[(df['Leg_number'] > 1)].copy() if leg_col else pd.DataFrame()
    vmg_avg = _safe_col_mean(dfrf, 'Vmg_kph') if len(dfrf) > 0 else _safe_col_mean(df, 'Vmg_kph')

    dflf = df.loc[(df['Leg_number'] > 0)].copy() if leg_col else df
    # When there are no legs (e.g. training-by-hour), dflf is empty; use full df for time range so foiling_perc and racetime_s are valid
    if len(dflf) == 0:
        dflf = df.copy()
    start_ts = dflf['ts'].min()
    end_ts = dflf['ts'].max()
    racetime_s = end_ts - start_ts if (start_ts is not None and end_ts is not None) else None
    if racetime_s is not None and (np.isnan(racetime_s) or racetime_s <= 0):
        racetime_s = None

    foil_col = 'Foiling_state' in df.columns
    # For foiling count: when we have legs use only Leg_number > 0; when no legs (training) use full df
    if leg_col and len(df.loc[(df['Leg_number'] > 0)]) > 0:
        dfrf = df.loc[(df['Foiling_state'] == 0) & (df['Leg_number'] > 0)].copy() if foil_col else pd.DataFrame()
    else:
        dfrf = df.loc[(df['Foiling_state'] == 0)].copy() if foil_col else pd.DataFrame()
    foiling_time_s = len(dfrf) / 10
    foiling_perc = (foiling_time_s / racetime_s) * 100 if racetime_s and racetime_s > 0 else None

    # Maneuver count: tacks ('T') and gybes ('G') only (excludes roundup, bearaway, takeoff)
    maneuver_count = df['Maneuver_type'].isin(['T', 'G']).sum() if 'Maneuver_type' in df.columns else 0
    distance_m = (bsp_avg * u.mps) * time_s if bsp_avg is not None and time_s is not None else None

    #Phase Duration
    def _safe_float(v, digits=None):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return None
        # Extract scalar if v is a pandas Series or numpy array (e.g. from duplicate columns or groupby)
        if isinstance(v, pd.Series):
            v = v.iloc[0] if len(v) > 0 else None
        elif isinstance(v, np.ndarray):
            v = v.flat[0] if v.size > 0 else None
        if v is None or (isinstance(v, (float, np.floating)) and np.isnan(v)):
            return None
        return float(round(v, digits)) if digits is not None else float(v)

    phase_col = 'Phase_id' in df.columns
    dfp = df.loc[(df['Phase_id'] > 0)].copy() if phase_col else df.copy()

    if len(dfp) == 0:
        dfp = df.copy()

    if 'ts' not in dfp.columns:
        phase_duration_s = None
        twd_avg = twd_avg
        tws_avg = tws_avg
        bsp_avg = bsp_avg
    else:
        dfp = dfp.sort_values('ts').copy()
        if phase_col:
            dfp['phase_run'] = (dfp['Phase_id'] != dfp['Phase_id'].shift()).cumsum()
            run_counts_uw = dfp.groupby(['Phase_id', 'phase_run']).size().reset_index(name='n_samples')
            run_counts_uw['duration_s'] = run_counts_uw['n_samples'] / 10
            _dur = run_counts_uw.groupby('Phase_id')['duration_s'].mean().mean()
            phase_duration_s = None if pd.isna(_dur) else float(_dur)
        else:
            phase_duration_s = None
        twd_deg_p = _safe_col_series(dfp, 'Twd_deg')
        twd_avg = u.mean360(list(twd_deg_p)) if twd_deg_p is not None else twd_avg
        tws_avg = _safe_col_mean(dfp, 'Tws_kph') if tws_avg is None else tws_avg
        bsp_avg = _safe_col_mean(dfp, 'Bsp_kts') if bsp_avg is None else bsp_avg

    if isRace == False:
        twa_avg = dfp['Twa_n_deg'].mean()
        # Leg_start_twa / Leg_end_twa = first and last Twa_deg of the leg (by ts)
        df_sorted_ts = df.sort_values('ts')
        twa_start = df_sorted_ts['Twa_deg'].iloc[0] if len(df_sorted_ts) > 0 and 'Twa_deg' in df_sorted_ts.columns else None
        twa_end = df_sorted_ts['Twa_deg'].iloc[-1] if len(df_sorted_ts) > 0 and 'Twa_deg' in df_sorted_ts.columns else None

        polar_perc_avg = dfp['Polar_perc'].mean()
        vmg_perc_avg = dfp['Vmg_perc'].mean()
        # rh_lwd_avg = dfp['RH_lwd_mm'].mean()
        # pitch_avg = dfp['Pitch_deg'].mean()
        # heel_avg = dfp['Heel_n_deg'].mean()
        # rh_lwd_std = dfp['RH_lwd_mm'].std()
        # pitch_std = dfp['Pitch_deg'].std()
        # heel_std = dfp['Heel_n_deg'].std()
        # rud_rake_avg = dfp['RUD_rake_ang_deg'].mean()
        # rud_diff_avg = dfp['RUD_diff_ang_deg'].mean()
        # db_cant_avg = dfp['DB_cant_lwd_deg'].mean()
        # db_cant_eff_avg = dfp['DB_cant_eff_lwd_deg'].mean()
        # ca1_ang_avg = dfp['CA1_ang_n_deg'].mean()
        # wing_twist_avg = dfp['WING_twist_n_deg'].mean() 
        # wing_clew_avg = dfp['WING_clew_pos_n_mm'].mean() 
        # jib_sheet_load_avg = dfp['JIB_sheet_load_kgf'].mean()
        # jib_cunno_load_avg = dfp['JIB_cunno_load_kgf'].mean()
        # jib_lead_ang_avg = dfp['JIB_lead_ang_deg'].mean()

        if bsp_avg is not None and not (isinstance(bsp_avg, float) and np.isnan(bsp_avg)):
            bsp_avg *= 1.852
        if bsp_max is not None and not (isinstance(bsp_max, float) and np.isnan(bsp_max)):
            bsp_max *= 1.852

    channelinfo = {}
    cumulative_sec = time_s + (previous_cumulative_sec if previous_cumulative_sec is not None else 0.0)
    channelinfo['event_id'] = int(event_id)
    channelinfo['Duration_sec'] = _safe_float(time_s, 3)
    channelinfo['Cumulative_sec'] = _safe_float(cumulative_sec, 3)
    channelinfo['Distance_m'] = _safe_float(distance_m, 3)
    channelinfo['Tws_avg_kph'] = _safe_float(tws_avg, 3)
    channelinfo['Twd_avg_deg'] = _safe_float(twd_avg, 3)
    channelinfo['Bsp_avg_kph'] = _safe_float(bsp_avg, 3)
    channelinfo['Bsp_max_kph'] = _safe_float(bsp_max, 3)
    channelinfo['Vmg_avg_kph'] = _safe_float(vmg_avg, 3)
    channelinfo['Foiling_perc'] = _safe_float(foiling_perc, 3)
    channelinfo['Maneuver_count'] = _safe_float(maneuver_count, 3)
    channelinfo['Phase_duration_avg_sec'] = _safe_float(phase_duration_s, 3)

    if isRace == True:
        # Race Bsp_start_kph = Bsp at start of Leg 1 (first sample of leg 1 by ts), in kph
        bsp_start_kph = None
        if 'Leg_number' in df.columns:
            df_leg1 = df.loc[df['Leg_number'] == 1]
            if len(df_leg1) > 0:
                df_leg1_sorted = df_leg1.sort_values('ts')
                bsp_start_kts = df_leg1_sorted['Bsp_kts'].iloc[0]
                if bsp_start_kts is not None and not (isinstance(bsp_start_kts, float) and np.isnan(bsp_start_kts)):
                    bsp_start_kph = float(bsp_start_kts) * 1.852
        channelinfo['Bsp_start_kph'] = _safe_float(bsp_start_kph, 3)
        # Race-level Vmg_perc_avg and Polar_perc_avg (from phases) so race-summary table can show and order by them
        vmg_perc_avg_race = dfp['Vmg_perc'].mean() if 'Vmg_perc' in dfp.columns else None
        polar_perc_avg_race = dfp['Polar_perc'].mean() if 'Polar_perc' in dfp.columns else None
        channelinfo['Vmg_perc_avg'] = _safe_float(vmg_perc_avg_race, 3)
        channelinfo['Polar_perc_avg'] = _safe_float(polar_perc_avg_race, 3)

    if isRace == False:
        # Bsp at start of leg (first sample by ts), in kph (including leg 1)
        bsp_start_kph = None
        if len(df) > 0:
            df_sorted = df.sort_values('ts')
            bsp_start_kts = df_sorted['Bsp_kts'].iloc[0]
            if bsp_start_kts is not None and not (isinstance(bsp_start_kts, float) and np.isnan(bsp_start_kts)):
                bsp_start_kph = float(bsp_start_kts) * 1.852
                
        channelinfo['Bsp_start_kph'] = _safe_float(bsp_start_kph, 3)

        channelinfo['Leg_start_twa'] = _safe_float(twa_start, 3)
        channelinfo['Leg_end_twa'] = _safe_float(twa_end, 3)

        channelinfo['Twa_avg_deg'] = _safe_float(twa_avg, 3)
        channelinfo['Polar_perc_avg'] = _safe_float(polar_perc_avg, 3)
        channelinfo['Vmg_perc_avg'] = _safe_float(vmg_perc_avg, 3)
        # channelinfo['Heel_avg_deg'] = _safe_float(heel_avg, 3)
        # channelinfo['Heel_std_deg'] = _safe_float(heel_std, 3)

        # channelinfo['Pitch_avg_deg'] = _safe_float(pitch_avg, 3)
        # channelinfo['Pitch_std_deg'] = _safe_float(pitch_std, 3)

        # channelinfo['RH_lwd_avg_mm'] = _safe_float(rh_lwd_avg, 3)
        # channelinfo['RH_lwd_std_mm'] = _safe_float(rh_lwd_std, 3)

        # channelinfo['CA1_avg_deg'] = _safe_float(ca1_ang_avg, 3)
        # channelinfo['WING_twist_avg_deg'] = _safe_float(wing_twist_avg, 3)
        # channelinfo['WING_clew_pos_n_mm'] = _safe_float(wing_clew_avg, 3)

        # channelinfo['RUD_rake_ang_deg'] = _safe_float(rud_rake_avg, 3)
        # channelinfo['RUD_diff_ang_deg'] = _safe_float(rud_diff_avg, 3)
        # channelinfo['DB_cant_avg_deg'] = _safe_float(db_cant_avg, 3)
        # channelinfo['DB_cant_eff_avg_deg'] = _safe_float(db_cant_eff_avg, 3)

        # channelinfo['JIB_sheet_avg_deg'] = _safe_float(jib_sheet_load_avg, 3)
        # channelinfo['JIB_lead_avg_deg'] = _safe_float(jib_lead_ang_avg, 3)
        # channelinfo['JIB_cunno_avg_deg'] = _safe_float(jib_cunno_load_avg, 3)

        # Legs_completed: 1 if this leg has valid duration > 0, else 0
        leg_has_duration = (
            time_s is not None
            and not (isinstance(time_s, float) and np.isnan(time_s))
            and time_s > 0
        )
        channelinfo['Legs_completed'] = 1 if leg_has_duration else 0

    return channelinfo


def _ts_to_iso(ts):
    """Convert Unix timestamp (seconds) to ISO8601 for addEvent API."""
    if ts is None or (isinstance(ts, float) and np.isnan(ts)):
        return None
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _run_training_hours(api_token, project_id, dataset_id, class_name, date, source_name, df, verbose):
    """
    No-race path: aggregate by calendar whole hours (00:00-01:00, 01:00-02:00, ...) in the dataset timezone.
    Create TRAINING events with tag HOUR: "11:00", "12:00", ... and GRADE: 2; write stats to race_stats.
    Data is averaged for each whole hour. TRAINING row start_time/end_time are the calendar hour bounds (UTC),
    matching the ts window used for stats, so race-setup can overlap phase/bin events with the same hour as race-summary.
    """
    if "ts" not in df.columns or df["ts"].isna().all():
        u.log(api_token, "Race.py", "warning", "_run_training_hours", "No ts; skipping")
        return True
    min_ts = float(df["ts"].min())
    max_ts = float(df["ts"].max())
    if np.isnan(min_ts) or np.isnan(max_ts):
        return True

    # Get timezone for this project/date (for calendar-hour bins)
    date_norm = str(date).replace("-", "").strip()
    if len(date_norm) == 8 and date_norm.isdigit():
        date_for_tz = date_norm
    else:
        date_for_tz = date_norm
    tz_resp = u.get_api_data(
        api_token,
        ":8069/api/datasets/date/timezone?class_name=" + str(class_name)
        + "&project_id=" + str(project_id) + "&date=" + date_for_tz,
    )
    tz_str = "UTC"
    if tz_resp and tz_resp.get("success") and tz_resp.get("data") and tz_resp["data"].get("timezone"):
        tz_str = str(tz_resp["data"]["timezone"]).strip() or "UTC"
    try:
        tz = pytz.timezone(tz_str)
    except Exception:
        tz = pytz.utc
        tz_str = "UTC"

    # Day start (00:00:00) in local timezone, then as UTC timestamp
    if len(date_norm) >= 8 and date_norm[:8].isdigit():
        y, m, d = int(date_norm[:4]), int(date_norm[4:6]), int(date_norm[6:8])
    else:
        u.log(api_token, "Race.py", "warning", "_run_training_hours", "Invalid date format; using UTC")
        y, m, d = 2020, 1, 1
    try:
        local_midnight = tz.localize(datetime(y, m, d, 0, 0, 0))
    except Exception:
        local_midnight = datetime(y, m, d, 0, 0, 0, tzinfo=tz)
    day_start_ts = local_midnight.astimezone(timezone.utc).timestamp()

    race_stats_rows = []
    hour_windows = []  # (event_id, window_start_ts, window_end_ts) same order as race_stats_rows
    hour_to_event_id = {}

    train_res = u.get_api_data(
        api_token,
        ":8069/api/events/info?class_name=" + str(class_name) + "&project_id=" + str(project_id)
        + "&dataset_id=" + str(dataset_id) + "&event_type=TRAINING&timezone=UTC",
    )
    if train_res and train_res.get("success") and train_res.get("data"):
        for ev in train_res["data"]:
            tags = ev.get("tags") or {}
            h = tags.get("HOUR")
            if h is not None and ev.get("event_id") is not None:
                try:
                    if isinstance(h, (int, float)) and not np.isnan(h):
                        key = f"{int(h):02d}:00"
                    else:
                        key = str(h).strip()
                    if key and key != "":
                        hour_to_event_id[key] = int(ev["event_id"])
                except (TypeError, ValueError):
                    pass

    for h in range(24):
        window_start = day_start_ts + h * 3600
        window_end = day_start_ts + (h + 1) * 3600
        if window_start >= max_ts:
            break
        if window_end <= min_ts:
            continue
        dfb = df.loc[(df["ts"] >= window_start) & (df["ts"] < window_end)].copy()
        if len(dfb) == 0:
            continue
        # Calendar hour [window_start, window_end) in UTC — same as dfb filter — not min/max of samples.
        # Otherwise phase events (often starting before first sample) fail race-setup EXISTS vs TRAINING times.
        cal_start_time = _ts_to_iso(window_start)
        cal_end_time = _ts_to_iso(window_end)
        if cal_start_time is None or cal_end_time is None:
            continue

        hour_label = f"{h:02d}:00"
        event_id = hour_to_event_id.get(hour_label)
        if event_id is None:
            tags = json.dumps({"HOUR": hour_label, "GRADE": 2})
            jsondata = {
                "class_name": str(class_name),
                "project_id": int(project_id),
                "dataset_id": int(dataset_id),
                "event_type": "TRAINING",
                "start_time": cal_start_time,
                "end_time": cal_end_time,
                "tags": tags,
            }
            res = u.post_api_data(api_token, ":8059/api/events", jsondata)
            if not res or not res.get("success"):
                u.log(api_token, "Race.py", "error", "_run_training_hours", "addEvent TRAINING failed for hour " + hour_label)
                continue
            event_id = res.get("data")
            if event_id is None:
                continue
            event_id = int(event_id)
            hour_to_event_id[hour_label] = event_id

        channelinfo = getChannelInfo(event_id, dfb, isRace=True)
        race_stats_rows.append(channelinfo)
        hour_windows.append((event_id, window_start, window_end))

    if not race_stats_rows:
        return True

    # Fetch maneuver losses via existing API; compute per-hour averages and attach to race_stats
    if dataset_id is not None:
        channels = ["loss_total_tgt"]
        filters = {"GRADE": [1, 2, 3, 4, 5]}
        channels_encoded = urllib.parse.quote(json.dumps(channels))
        filters_encoded = urllib.parse.quote(json.dumps(filters))
        maneuver_types = ["tack", "gybe", "roundup", "bearaway"]
        loss_by_type = {}  # event_type -> list of (ts, loss_total_tgt)
        for event_type in maneuver_types:
            loss_by_type[event_type] = []
            url = (
                f":8069/api/data/maneuvers-table-data?"
                f"class_name={class_name}&project_id={project_id}&dataset_id={dataset_id}"
                f"&event_type={event_type}&channels={channels_encoded}&filters={filters_encoded}"
            )
            resp = u.get_api_data(api_token, url)
            if not resp or not resp.get("success"):
                continue
            data = resp.get("data") or []
            for row in data:
                dt_val = row.get("Datetime")
                loss_val = row.get("loss_total_tgt")
                if dt_val is None or loss_val is None or (isinstance(loss_val, float) and np.isnan(loss_val)):
                    continue
                try:
                    ts = pd.to_datetime(dt_val, utc=True).timestamp()
                except Exception:
                    continue
                loss_by_type[event_type].append((ts, float(loss_val)))

        loss_col_map = {"tack": "Tack_loss_avg", "gybe": "Gybe_loss_avg", "roundup": "Roundup_loss_avg", "bearaway": "Bearaway_loss_avg"}
        for i, (event_id, window_start_ts, window_end_ts) in enumerate(hour_windows):
            if i >= len(race_stats_rows):
                break
            row = race_stats_rows[i]
            for event_type in maneuver_types:
                col = loss_col_map[event_type]
                in_window = [(ts, loss) for ts, loss in loss_by_type[event_type] if window_start_ts <= ts < window_end_ts and not (isinstance(loss, float) and np.isnan(loss))]
                if in_window:
                    avg_loss = round(float(np.mean([x[1] for x in in_window])), 2)
                    row[col] = avg_loss

    jsondata = {
        "class_name": str(class_name),
        "project_id": int(project_id),
        "table": "race_stats",
        "json": json.dumps({"rows": race_stats_rows}),
    }
    res = u.post_api_data(api_token, ":8059/api/events/aggregates", jsondata)
    if verbose:
        if res and res.get("success"):
            print("Training hour stats added (" + str(len(race_stats_rows)) + " hours)", flush=True)
        else:
            print("Training hour stats failed", flush=True)
    u.log(api_token, "Race.py", "info", "training_hours", str(len(race_stats_rows)) + " hours posted")
    return True


def _upsert_day_summary_page(api_token, class_name, project_id, date):
    """
    Upsert day_page for (project_id, date) to TRAINING SUMMARY or RACE SUMMARY
    so the day sidebar shows the correct report. Uses same logic as 4_cleanup:
    GET date/races (LEG with Leg_number > 1, Race_number > -1);
    if any Race_number > -1 without training HOUR shape, RACE SUMMARY else TRAINING SUMMARY.
    Does not raise; logs success/failure only.
    """
    try:
        date_norm = str(date).replace("-", "").replace("/", "").strip()
        if len(date_norm) >= 8 and date_norm[:8].isdigit():
            date_norm = date_norm[:8]
        else:
            u.log(api_token, "Race.py", "warning", "day_page", "Invalid date; skipping day-page upsert")
            return
        url = f":8069/api/datasets/date/races?class_name={class_name}&project_id={project_id}&date={date_norm}"
        races_resp = u.get_api_data(api_token, url)
        data = races_resp.get("data") or [] if races_resp else []
        has_data = races_resp and races_resp.get("success") and len(data) > 0

        def _safe_race_number(r):
            try:
                v = r.get("Race_number", 0)
                if v is None:
                    return 0
                return int(v) if not isinstance(v, int) else v
            except (ValueError, TypeError):
                return 0

        has_training_only = has_data and all(r.get("HOUR") is not None for r in data)
        has_actual_races = has_data and not has_training_only and any(_safe_race_number(r) > 0 for r in data)
        summary_page = "RACE SUMMARY" if has_actual_races else "TRAINING SUMMARY"
        other_summary = "TRAINING SUMMARY" if summary_page == "RACE SUMMARY" else "RACE SUMMARY"
        u.delete_api_data(
            api_token,
            ":8059/api/datasets/day-page",
            {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": other_summary},
        )
        day_page_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": summary_page}
        day_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", day_page_payload)
        if day_res and day_res.get("success"):
            u.log(api_token, "Race.py", "info", "day_page", f"Upserted page_name: {summary_page}")
        else:
            u.log(api_token, "Race.py", "warning", "day_page", day_res.get("message", "unknown") if day_res else "no response")
    except Exception as e:
        u.log(api_token, "Race.py", "warning", "day_page", str(e))


def start(api_token, project_id, dataset_id, class_name, date, source_name, verbose):
    if verbose:
        print("Querying data...", flush=True)

    df = get_data(class_name, project_id, date, source_name, None, None)

    #LOG
    u.log(api_token, "Race.py", "info", "processing data", str(len(df))+ " records retrieved...")

    if len(df) > 0:
        if verbose:
            print(len(df),'records found', flush=True)

        if dataset_id is None:
            u.log(api_token, "Race.py", "error", "start", "dataset_id is required for getRaceObject()")
            return False
        dataset_id = int(dataset_id) if not isinstance(dataset_id, int) else dataset_id
        race_objects = getRaceObject(class_name, project_id, dataset_id)
        if race_objects is None:
            u.log(api_token, "Race.py", "error", "start", "getRaceObject() failed (events API returned success=False)")
            return False

        has_race_data = (
            race_objects
            and len(race_objects) > 0
            and "Race_number" in df.columns
            and (df["Race_number"] > 0).any()
        )
        if not has_race_data:
            ok = _run_training_hours(api_token, project_id, dataset_id, class_name, date, source_name, df, verbose)
            if not ok:
                return False
            map_data_reference_ts = float(df["ts"].min()) if "ts" in df.columns and len(df) > 0 else None
            prestart_ok = p.start(api_token, project_id, dataset_id, class_name, date, source_name, verbose, map_data_reference_ts=map_data_reference_ts)
            if not prestart_ok and verbose:
                print("Prestart stats: no data or failed", flush=True)
            _upsert_day_summary_page(api_token, class_name, project_id, date)
            return True

        for race_object in race_objects:
            event_id = race_object['Event_id']
            race_number = race_object['Race_number']

            # DO RACE: use only legs that this source has data for (from df), with duration > 0 and not null
            dfr = df.loc[(df['Race_number'] == race_number) & (df['Leg_number'] > 0)].copy()
            # Derive valid legs purely from this source's data - not from API leg list
            valid_leg_numbers = []
            for leg_num in dfr['Leg_number'].unique():
                dfl = dfr.loc[(dfr['Leg_number'] == leg_num)].copy()
                if len(dfl) > 0:
                    time_s = dfl['ts'].max() - dfl['ts'].min()
                    if time_s is not None and not (isinstance(time_s, float) and np.isnan(time_s)) and time_s > 0:
                        valid_leg_numbers.append(int(leg_num))
            valid_leg_numbers = sorted(valid_leg_numbers)
            leg_count = max(valid_leg_numbers) if valid_leg_numbers else 0
            if leg_count == 0:
                continue
            # Per-leg stats and race aggregate: only valid legs; include last leg so race time = cumulative over all legs
            dfr = dfr.loc[dfr['Leg_number'].isin(valid_leg_numbers)].copy()
            df_legs = dfr.copy()
            dfr_race = dfr.copy()

            # RACE Duration_sec and Cumulative_sec = cumulative time for all valid legs including last leg
            total_valid_duration_s = 0.0
            for ln in valid_leg_numbers:
                dfl = dfr.loc[dfr['Leg_number'] == ln]
                if len(dfl) > 0:
                    leg_time = dfl['ts'].max() - dfl['ts'].min()
                    if leg_time is not None and not (isinstance(leg_time, float) and np.isnan(leg_time)) and leg_time > 0:
                        total_valid_duration_s += leg_time

            dfr_racing = dfr_race.loc[(dfr_race['Leg_number'] > 0)].copy()

            channelinfo = getChannelInfo(event_id, dfr_racing, isRace=True)
            # Set race total from sum of all valid legs including last leg
            channelinfo['Duration_sec'] = float(round(total_valid_duration_s, 3))
            channelinfo['Cumulative_sec'] = float(round(total_valid_duration_s, 3))
            channelinfo['Legs_completed'] = len(valid_leg_numbers)

            # Collect race row + all valid leg rows and POST once per race (fewer API round-trips)
            race_stats_rows = [channelinfo]

            # NOW DO RACE LEGS: only legs with valid duration_s; include last leg in race_stats
            previous_cumulative_sec = 0.0
            for leg_object in race_object['Legs']:
                leg_event_id = leg_object['Event_id']
                leg_number = leg_object['Leg_number']
                if leg_number not in valid_leg_numbers:
                    continue

                dfl = df_legs.loc[(df_legs['Leg_number'] == leg_number)].copy()

                leg_channelinfo = getChannelInfo(leg_event_id, dfl, isRace=False, previous_cumulative_sec=previous_cumulative_sec if leg_number > 1 else None)

                # Skip legs with null Duration_sec (missing/invalid times)
                dur_sec = leg_channelinfo.get('Duration_sec')
                if dur_sec is None or (isinstance(dur_sec, float) and np.isnan(dur_sec)):
                    continue

                race_stats_rows.append(leg_channelinfo)

                # Add this leg's duration for next leg's cumulative
                if len(dfl) > 0:
                    previous_cumulative_sec += dfl['ts'].max() - dfl['ts'].min()

            jsondata = {}
            jsondata["class_name"] = str(class_name)
            jsondata["project_id"] = int(project_id)
            jsondata["table"] = "race_stats"
            jsondata["json"] = json.dumps({"rows": race_stats_rows})

            res = u.post_api_data(api_token, ":8059/api/events/aggregates", jsondata)

            if verbose:
                if res["success"]:
                    print("Race + Leg Stats Added!", flush=True)
                else:
                    print("Race Stats Failed!", flush=True) 

        # Run prestart after race/leg stats (populates PRESTART event stats).
        # Use a single race-level reference time for marks so all boats get the same SL1/marks and align on the map.
        # Otherwise each boat would use its own df["ts"].min(), which can select different mark snapshots and cause ~100m offset.
        map_data_reference_ts = None
        if race_objects:
            ref_ts_list = []
            for ro in race_objects:
                st = ro.get('start_time')
                if st:
                    ts = u.get_timestamp_from_str(str(st), force_utc=True)
                    if ts is not None and not (isinstance(ts, float) and np.isnan(ts)):
                        ref_ts_list.append(float(ts))
            if ref_ts_list:
                map_data_reference_ts = min(ref_ts_list)
        if map_data_reference_ts is None and "ts" in df.columns and len(df) > 0:
            map_data_reference_ts = float(df["ts"].min())
        prestart_ok = p.start(api_token, project_id, dataset_id, class_name, date, source_name, verbose, map_data_reference_ts=map_data_reference_ts)
        if not prestart_ok and verbose:
            print("Prestart stats: no data or failed", flush=True)
        _upsert_day_summary_page(api_token, class_name, project_id, date)
        return True
    else:
        # No channel data: run prestart only, return its result
        prestart_ok = p.start(api_token, project_id, dataset_id, class_name, date, source_name, verbose)
        return prestart_ok
