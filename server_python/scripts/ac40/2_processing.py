from re import I
import pandas as pd
import numpy as np
import sys
import json
import pyarrow as pa
import os
from datetime import timedelta
import pytz

# Configure stdout/stderr to use UTF-8 encoding to handle Unicode characters
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

import utilities as u

from dotenv import load_dotenv
from pathlib import Path

s = u.LocalStorage()

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/scripts/ac40/)
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode
# Development: .env -> .env.local
# Production: .env.production -> .env.production.local
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

# Load base .env file first (defaults)
load_dotenv(dotenv_path=base_env_path)

# Load local .env file second (overrides base, gitignored secrets)
load_dotenv(dotenv_path=local_env_path, override=True)

api_token = os.getenv('SYSTEM_KEY')
if not api_token:
    raise RuntimeError("SYSTEM_KEY is missing from environment configuration.")

LOG_SCRIPT = "2_processing.py"


def get_data(class_name, project_id, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'ts', 'type': 'float'},
            {'name': 'AC40_Latitude', 'type': 'float'},
            {'name': 'AC40_Longitude', 'type': 'float'},
            {'name': 'AC40_BowWand_TWS_kts', 'type': 'float'},
            {'name': 'AC40_HDG', 'type': 'angle360'},
            {'name': 'AC40_BowWand_TWD', 'type': 'angle360'},
            {'name': 'AC40_Speed_kts', 'type': 'float'},
            {'name': 'AC40_TWA', 'type': 'angle180'},
            {'name': 'AC40_TWA_n', 'type': 'angle180'},
            {'name': 'AC40_CWA', 'type': 'angle180'},
            {'name': 'AC40_CWA_n', 'type': 'angle180'},
            {'name': 'AC40_VMG_kts', 'type': 'float'},
            {'name': 'AC40_COG', 'type': 'angle360'},
            {'name': 'AC40_HullAltitude', 'type': 'int'},
            {'name': 'AC40_Loads_MainSheetLoad', 'type': 'float'},
            {'name': 'AC40_FoilPort_Cant', 'type': 'float'},
            {'name': 'AC40_FoilStbd_Cant', 'type': 'float'},
            {'name': 'AC40_Leeway', 'type': 'float'},
            {'name': 'AC40_BowWand_AWA', 'type': 'angle180'},
            {'name': 'AC40_BowWand_AWS', 'type': 'float'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '100ms', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            dfi.rename(
                columns={
                    'AC40_Latitude': 'Lat_dd',
                    'AC40_Longitude': 'Lng_dd',
                    'AC40_BowWand_TWS_kts': 'Tws_kts',
                    'AC40_HDG': 'Hdg_deg',
                    'AC40_BowWand_TWD': 'Twd_deg',
                    'AC40_Speed_kts': 'Bsp_kts',
                    'AC40_TWA': 'Twa_deg',
                    'AC40_CWA': 'Cwa_deg',
                    'AC40_TWA_n': 'Twa_n_deg',
                    'AC40_CWA_n': 'Cwa_n_deg',
                    'AC40_VMG_kts': 'Vmg_kts',
                    'AC40_COG': 'Cog_deg',
                    'AC40_HullAltitude': 'Hull_altitude',
                    'AC40_Loads_MainSheetLoad': 'Main_sheet_load',
                    'AC40_FoilPort_Cant': 'Foil_port_cant',
                    'AC40_FoilStbd_Cant': 'Foil_stbd_cant',
                    'AC40_Leeway': 'Lwy_deg',
                    'AC40_BowWand_AWA': 'Awa_deg',
                    'AC40_BowWand_AWS': 'Aws_kts',
                    'AC40_HDG': 'Cog_deg',
                    'AC40_COG': 'Hdg_deg'
                },
                inplace=True,
            )

            u.log(api_token, LOG_SCRIPT, "info", "get_data", str(len(dfi))+" records found!")

            if dfi['ts'].dtype == 'Float64':
                dfi['ts'] = dfi['ts'].astype('float64')

            ts_sample = dfi['ts'].dropna()
            if len(ts_sample) > 0:
                if ts_sample.max() > 1e12:
                    dfi['ts'] = (dfi['ts'] / 1000.0).round(3)
                else:
                    dfi['ts'] = dfi['ts'].round(3)

            dfo = u.remove_gaps(dfi,'Bsp_kts','ts')
            u.log(api_token, LOG_SCRIPT, "info", "get_data", "Gaps removed!")
            
            # BASIC FILTERS
            # Exclude datetime columns from fillna(0) as they are timezone-aware and incompatible with 0
            datetime_cols = dfo.select_dtypes(include=['datetime64[ns, UTC]', 'datetime64[ns]']).columns
            non_datetime_cols = [col for col in dfo.columns if col not in datetime_cols]
            if len(non_datetime_cols) > 0:
                dfo[non_datetime_cols] = dfo[non_datetime_cols].fillna(0)
            dfo.replace(np.nan, 0, inplace=True)
            dfo.replace('NA', 0, inplace=True)

            # BASIC CALCULATIONS
            dfo['Foiling_state'] = np.select(
                [
                    (dfo['Bsp_kts'] > 15) & (dfo['Hull_altitude'] > 0),  # H0
                    (dfo['Bsp_kts'] > 15) & (dfo['Hull_altitude'] < 0.2),  # H1
                    (dfo['Bsp_kts'] < 15),  # H2
                ],
                [0, 1, 2],
                default=1,
            )

            # Longitudinal acceleration (m/s²): d/dt of boat speed, Bsp_kts → m/s then gradient vs ts (s).
            _kn_to_ms = 1852.0 / 3600.0
            _ts = dfo['ts'].to_numpy(dtype=np.float64, copy=False)
            _v_ms = dfo['Bsp_kts'].to_numpy(dtype=np.float64, copy=False) * _kn_to_ms
            dfo['Accel_rate_mps2'] = np.gradient(_v_ms, _ts, edge_order=1)

            # Yaw rate (deg/s): d/dt of heading; unwrap 0–360° discontinuities before differentiating.
            _hdg_rad = np.deg2rad(dfo['Hdg_deg'].to_numpy(dtype=np.float64, copy=False))
            _hdg_u = np.unwrap(_hdg_rad)
            dfo['Yaw_rate_dps'] = np.rad2deg(np.gradient(_hdg_u, _ts, edge_order=1))

            dfo['Foiling_state'] = pd.to_numeric(dfo['Foiling_state'], errors='coerce').fillna(2).astype('int64')

            dfo['Race_number'] = -1
            dfo['Leg_number'] = -1
            dfo['AC40_Leeway_n'] = dfo['Lwy_deg'] * np.sign(dfo['Twa_deg'])
            _low_bsp = dfo['Bsp_kts'].to_numpy(dtype=np.float64, copy=False) < 3
            dfo.loc[_low_bsp, 'Lwy_deg'] = 0
            dfo.loc[_low_bsp, 'AC40_Leeway_n'] = 0
            dfo['AC40_BowWand_AWA_n'] = abs(dfo['Awa_deg']) 
            dfo['AC40_VMG_n_kts'] = abs(dfo['Vmg_kts']) 
            
            return dfo
        else:
            return df
    except Exception as e:
        u.log(api_token, LOG_SCRIPT, "error", "processing data", "script exception error:"+str(e))
        return df

def remove_keys_with_value(obj, target_value):
    if isinstance(obj, dict):
        return {k: remove_keys_with_value(v, target_value) for k, v in obj.items() if v != target_value}
    elif isinstance(obj, list):
        return [remove_keys_with_value(item, target_value) for item in obj]
    else:
        return obj
    
def getDatasetInfo(df):
    if len(df) > 0:  
        dataset_info = u.get_api_data(api_token, ":8069/api/datasets/id?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id))

        day = 0
        if dataset_info and isinstance(dataset_info, dict) and 'data' in dataset_info:
            report_name = dataset_info['data'].get('report_name') or ''
            if report_name.find('Day') != -1:
                suffix = report_name.replace('Day ', '', 1).strip()
                try:
                    day = int(suffix) if suffix.isdigit() else 0
                except (ValueError, TypeError):
                    day = 0
        if day == 0:
            day = 1

        total_sec = df['ts'].max() - df['ts'].min()
        total_hours = round(float(total_sec / 3600), 2)
        
        tws_min = 0
        tws_max = 0
        twd = 0
        
        dfa = df.loc[(df['Bsp_kts'] > 10)]

        if len(dfa) > 0:
            twd = u.mean360(list(dfa['Twd_deg']))

            quantiles = dfa['Tws_kts'].quantile([0.10,0.90])
            tws_min = round(u.number(quantiles.iloc[0]) * 1.852,1)
            tws_max = round(u.number(quantiles.iloc[1]) * 1.852,1)
            sailing_time = len(dfa) / 10 #assuming input data of 10hz
        
            sailing_hours = round(float(sailing_time / 3600), 2)
            percent = round(float((sailing_hours / total_hours) * 100), 1)
            
            if tws_min > 0 and tws_max > 0:
                if tws_max == tws_min:
                    tws_str = str(tws_max)
                else:
                    tws_str = str(tws_min) + " - " + str(tws_max)
            else:
                tws_str = 'NA'
                
            if twd < 0:
                twd += 360
            
            twd_str = "NA"
            if twd > 0 and twd < 360:
                if twd >= 337.5 and twd <= 22.5:
                    twd_str = "N"
                elif twd > 22.5 and twd <= 67.5:
                    twd_str = "NE"
                elif twd > 67.5 and twd <= 112.5:
                    twd_str = "E"
                elif twd > 112.5 and twd <= 157.5:
                    twd_str = "SE"
                elif twd > 157.5 and twd <= 202.5:
                    twd_str = "S"
                elif twd > 202.5 and twd <= 247.5:
                    twd_str = "SW"
                elif twd > 247.5 and twd <= 292.5:
                    twd_str = "W"
                elif twd > 292.5 and twd <= 337.5:
                    twd_str = "NW"
                elif twd > 337.5:
                    twd_str = "N"
            else:
                twd_str = 'NA'

            # Preserve existing tags (e.g. isUploaded, Race_type) when writing Day/Source/Weather/Productivity
            existing_tags = {}
            try:
                tags_resp = u.get_api_data(api_token, ":8069/api/datasets/tags?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&dataset_id=" + str(dataset_id))
                if tags_resp and tags_resp.get("success") and tags_resp.get("data") is not None:
                    data = tags_resp["data"]
                    if isinstance(data, dict):
                        existing_tags = dict(data)
                    elif isinstance(data, str):
                        existing_tags = json.loads(data) if data else {}
            except (TypeError, ValueError, KeyError):
                pass

            # Dataset_type and Race_type: use dataframe first (getDatasetInfo runs before RACE events are re-created, so desc is empty)
            has_real_races = False
            if 'Race_number' in df.columns:
                try:
                    has_real_races = (df['Race_number'] > 0).any()
                except (TypeError, ValueError):
                    pass
            if not has_real_races:
                try:
                    desc_resp = u.get_api_data(api_token, ":8069/api/datasets/desc?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&dataset_id=" + str(dataset_id))
                    races_list = desc_resp.get("data") if isinstance(desc_resp, dict) and desc_resp.get("success") and desc_resp.get("data") is not None else []
                    if isinstance(races_list, list):
                        for r in races_list:
                            if not isinstance(r, dict):
                                continue
                            val = r.get("races")
                            if val is None:
                                continue
                            try:
                                num = int(val) if isinstance(val, (int, float)) else int(val)
                            except (TypeError, ValueError):
                                continue
                            if num > 0:
                                has_real_races = True
                                break
                except (TypeError, ValueError, KeyError):
                    pass
            dataset_type = 'RACING' if has_real_races else 'TRAINING'
            race_type_val = (race_type[0] if race_type else 'INSHORE') if has_real_races else None

            datasetinfo = dict(existing_tags)
            for _legacy in ('RACE_TYPE', 'DATASET_TYPE', 'raceType'):
                datasetinfo.pop(_legacy, None)
            datasetinfo['Source'] = 'Sailing'
            datasetinfo['Day'] = day
            datasetinfo['Weather'] = {'TWS': tws_str, 'TWD': twd_str}
            datasetinfo['Productivity'] = {'Total Hours': total_hours, 'Sailing  Hours': sailing_hours, 'Percent': percent}
            datasetinfo['Dataset_type'] = dataset_type
            if race_type_val:
                datasetinfo['Race_type'] = race_type_val

            tags_str = json.dumps(datasetinfo)
            res = u.put_api_data(api_token, ":8069/api/datasets/tags", {"class_name": class_name, "project_id": project_id, "dataset_id": dataset_id, "tags": tags_str})

            # Merge Dataset_type and Race_type into the DATASET event's tags
            if res.get('success'):
                try:
                    event_tags = {"Dataset_type": dataset_type}
                    if race_type_val:
                        event_tags["Race_type"] = race_type_val
                    u.put_api_data(api_token, ":8059/api/events/dataset-event-tags", {"class_name": class_name, "project_id": project_id, "dataset_id": dataset_id, "tags": event_tags})
                except (TypeError, ValueError, KeyError):
                    pass

            if (res['success']):
                if (len(tags_str) > 20):
                    u.log(api_token, LOG_SCRIPT, "info", "getDatasetInfo", "Dataset info generated successfully!")
                else:
                    u.log(api_token, LOG_SCRIPT, "error", "getDatasetInfo", "Failed to generate dataset info!")
            else:
                u.log(api_token, LOG_SCRIPT, "error", "getDatasetInfo", "Failed to generate dataset info!")

def insertDatasetEvent(event): 
    et = event['EventType']
    if et == 'CrewCount':
        et = 'Crew'
    value = event['Event']
    start = event['Start']
    end = event['End']
    tags = {}
  
    # Format timestamps using utility function
    start_str = u.format_timestamp(start)
    end_str = u.format_timestamp(end)
    
    jsondata = {}
    if et == 'Race':
        tags = value
        jsondata = {"class_name": str(class_name),"project_id": int(project_id), "dataset_id": int(dataset_id), "event_type": "RACE", "start_time": start_str, "end_time": end_str, "tags": json.dumps(tags)}
    elif et == 'Prestart':
        tags = value
        jsondata = {"class_name": str(class_name),"project_id": int(project_id), "dataset_id": int(dataset_id), "event_type": "PRESTART", "start_time": start_str, "end_time": end_str, "tags": json.dumps(tags)}
    elif et == 'Leg':
        tags = value
        jsondata = {"class_name": str(class_name),"project_id": int(project_id), "dataset_id": int(dataset_id), "event_type": "LEG", "start_time": start_str, "end_time": end_str, "tags": json.dumps(tags)}
    elif et == 'Config':
        tags = value
        jsondata = {"class_name": str(class_name),"project_id": int(project_id), "dataset_id": int(dataset_id), "event_type": "CONFIGURATION", "start_time": start_str, "end_time": end_str, "tags": json.dumps(tags)}
    elif et == 'Crew':
        # Handle 'NA' and invalid values for crew count
        try:
            if value == 'NA' or value == '' or pd.isna(value):
                tags['Count'] = 0
            else:
                tags['Count'] = int(value)
        except (ValueError, TypeError):
            tags['Count'] = 0
        jsondata = {"class_name": str(class_name),"project_id": int(project_id), "dataset_id": int(dataset_id), "event_type": "CREW", "start_time": start_str, "end_time": end_str, "tags": json.dumps(tags)}
    elif et == 'Headsail':
        HEADSAIL_CODE_TO_ID = {'J1': 1, 'J2': 2, 'J3': 3}
        tags['Headsail_code'] = value

        # Handle 'NA' and invalid values
        if value and value != 'NA' and isinstance(value, str):
            if value in HEADSAIL_CODE_TO_ID:
                tags['Headsail_Id'] = float(HEADSAIL_CODE_TO_ID[value])
            else:
                try:
                    # Remove 'J' prefix and '.' characters for legacy/numeric codes
                    cleaned_value = value.replace('J', '').replace('.', '')
                    # Check if cleaned value is numeric
                    if cleaned_value and cleaned_value.isdigit():
                        if value.find('.') > 0:
                            tags['Headsail_Id'] = float(int(cleaned_value)) + 0.1
                        else:
                            tags['Headsail_Id'] = float(int(cleaned_value) * 10) + 0.1
                    else:
                        tags['Headsail_Id'] = 0.0
                except (ValueError, TypeError):
                    tags['Headsail_Id'] = 0.0
        else:
            # 'NA' or empty value, set default
            tags['Headsail_Id'] = 0.0

        jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "event_type": "HEADSAIL", "start_time": start_str, "end_time": end_str, "tags": json.dumps(tags)}


    if jsondata != {}:
        res = u.post_api_data(api_token, ":8059/api/events", jsondata)
        if res["success"] == True:
            return True
        else:
            return False
    else:
        return False


def _fill_df_from_events(df, events, tag_key, column, value_normalizer=None):
    """
    Fill a dataframe column from existing dataset_events by matching row ts to event start/end.
    Events are sorted by start_time; first overlapping event wins.
    """
    if not events or not hasattr(df, 'ts') or 'ts' not in df.columns:
        return
    # Parse to (start_ts, end_ts, value) and sort by start_ts for deterministic match
    parsed = []
    for ev in events:
        try:
            start_str = ev.get('start_time') or ev.get('Start')
            end_str = ev.get('end_time') or ev.get('End')
            tags = ev.get('tags') or {}
            if start_str is None or end_str is None:
                continue
            start_ts = u.get_timestamp_from_str(str(start_str), force_utc=True)
            end_ts = u.get_timestamp_from_str(str(end_str), force_utc=True)
            val = tags.get(tag_key)
            parsed.append((start_ts, end_ts, val))
        except (ValueError, TypeError) as e:
            u.log(api_token, LOG_SCRIPT, "warning", "_fill_df_from_events", f"Skip event: {e}")
            continue
    parsed.sort(key=lambda x: x[0])
    for idx in df.index:
        ts = df.at[idx, 'ts']
        if pd.isna(ts):
            continue
        for start_ts, end_ts, val in parsed:
            if start_ts <= ts <= end_ts:
                if value_normalizer is not None and val is not None:
                    val = value_normalizer(val)
                if column == 'Crew_count':
                    try:
                        df.at[idx, column] = int(val) if val not in ('NA', '', None) and not pd.isna(val) else 0
                    except (ValueError, TypeError):
                        df.at[idx, column] = 0
                else:
                    df.at[idx, column] = val if val is not None and not pd.isna(val) else 'NA'
                break


def apply_yaw_not_normal_grade_one(df):
    # Percentiles of Yaw_rate_dps (deg/s) used to define "normal" range from the distribution; rows outside [low, high] or NaN are downgraded to grade 1. Tighter band = more sensitive (more rows downgraded).
    YAW_RATE_NORMAL_PERCENTILE_LOW = 0.05
    YAW_RATE_NORMAL_PERCENTILE_HIGH = 0.95
    # Minimum number of grade > 1 rows with valid Yaw_rate_dps to compute distribution; otherwise skip the filter.
    YAW_RATE_NORMAL_MIN_SAMPLE = 30

    """
    Downgrade to grade 1 any row with Grade > 1 where Yaw_rate_dps is not in the "normal" range.
    Normal range is computed from the distribution of Yaw_rate_dps over grade > 1 rows:
    [percentile(YAW_RATE_NORMAL_PERCENTILE_LOW), percentile(YAW_RATE_NORMAL_PERCENTILE_HIGH)].
    Rows with NaN Yaw_rate_dps or outside this range are downgraded.
    """
    if 'Yaw_rate_dps' not in df.columns:
        return df
    eligible = (df['Grade'] > 1) & df['Yaw_rate_dps'].notna()
    values = df.loc[eligible, 'Yaw_rate_dps']
    if len(values) < YAW_RATE_NORMAL_MIN_SAMPLE:
        return df
    low = float(values.quantile(YAW_RATE_NORMAL_PERCENTILE_LOW))
    high = float(values.quantile(YAW_RATE_NORMAL_PERCENTILE_HIGH))
    not_normal = (
        (df['Grade'] > 1) &
        (pd.isna(df['Yaw_rate_dps']) | (df['Yaw_rate_dps'] < low) | (df['Yaw_rate_dps'] > high))
    )
    df.loc[not_normal, 'Grade'] = 1
    return df


def remove_small_segments(df, grades=[1, 2, 3], min_length=4):
    """
    Remove small segments of specified grades in the DataFrame.
    Segments shorter than min_length seconds are replaced with the previous segment's grade.
    Assumes 'ts' is a monotonically increasing timestamp column.
    """
    df = df.copy()
    for grade in grades:
        mask = df['Grade'] == grade
        seg_start = None
        prev_grade = None

        for i in range(len(df)):
            if mask.iloc[i]:
                if seg_start is None:
                    seg_start = i
                    prev_grade = df['Grade'].iloc[i-1] if i > 0 else None
            else:
                if seg_start is not None:
                    seg_end = i - 1
                    seg_len = df['ts'].iloc[seg_end] - df['ts'].iloc[seg_start]
                    if seg_len < min_length and prev_grade is not None:
                        df.iloc[seg_start:seg_end + 1, df.columns.get_loc('Grade')] = prev_grade
                    seg_start = None
                    prev_grade = df['Grade'].iloc[i]

        # Handle segment at end of df
        if seg_start is not None:
            seg_end = len(df) - 1
            seg_len = df['ts'].iloc[seg_end] - df['ts'].iloc[seg_start]
            if seg_len < min_length and prev_grade is not None:
                df.iloc[seg_start:seg_end + 1, df.columns.get_loc('Grade')] = prev_grade
    return df


def remove_small_grade_one_segments(df, min_length_sec=2):
    """
    Remove small segments of grade 1 that are shorter than min_length_sec seconds.
    Each segment is replaced with the previous segment's grade.
    Assumes 'ts' is a monotonically increasing timestamp column.
    """
    return remove_small_segments(df, grades=[1], min_length=min_length_sec)


# Boat speed stability window (rolling max-min Bsp_kts): shared by too-stable and twin-board grading
BSP_STABLE_MAX_DEVIATION_KTS = 1
BSP_STABLE_MIN_DURATION_SEC = 180  # 3 minutes


def _bsp_stable_mask(df, duration_sec=None, max_deviation_kts=None):
    """
    Trailing window over Bsp_kts: True where max(Bsp_kts)-min(Bsp_kts) <= max_deviation_kts
    over duration_sec (inferred row count from median ts step). False/NaN until window is full.
    Returns None if stability cannot be computed.
    """
    if 'Bsp_kts' not in df.columns or 'ts' not in df.columns or len(df) == 0:
        return None
    duration_sec = duration_sec if duration_sec is not None else BSP_STABLE_MIN_DURATION_SEC
    max_deviation_kts = max_deviation_kts if max_deviation_kts is not None else BSP_STABLE_MAX_DEVIATION_KTS
    diff_ts = df['ts'].diff().dropna()
    if len(diff_ts) == 0:
        return None
    median_dt = float(diff_ts.median())
    if median_dt <= 0:
        return None
    window_rows = int(round(duration_sec / median_dt))
    if window_rows < 2:
        return None
    rmax = df['Bsp_kts'].rolling(window=window_rows, min_periods=window_rows).max()
    rmin = df['Bsp_kts'].rolling(window=window_rows, min_periods=window_rows).min()
    range_in_window = rmax - rmin
    return (range_in_window <= max_deviation_kts) & range_in_window.notna()


def apply_high_speed_twin_board_grades(df, duration_sec=None, max_deviation_kts=None):
    """
    High-speed twin board: Bsp_kts > 15 and both foil cants < 65.
    If boat speed is stable over the shared 3 min / 1 kt window → Grade 0; else → Grade 1.
    """
    required = ['ts', 'Bsp_kts', 'Foil_stbd_cant', 'Foil_port_cant', 'Grade']
    if not all(c in df.columns for c in required):
        return df
    stable = _bsp_stable_mask(df, duration_sec=duration_sec, max_deviation_kts=max_deviation_kts)
    if stable is None:
        return df
    df = df.copy()
    twin_hs = (
        (df['Bsp_kts'] > 15)
        & (df['Foil_stbd_cant'] < 65)
        & (df['Foil_port_cant'] < 65)
    )
    twin_hs = twin_hs.fillna(False)
    df.loc[twin_hs & stable, 'Grade'] = 0
    df.loc[twin_hs & ~stable, 'Grade'] = 1
    return df


def apply_too_stable_boat_speed_grade_one(df, duration_sec=None, max_deviation_kts=None):
    """
    Downgrade to grade 1 any row where boat speed has been too stable for at least duration_sec:
    over a trailing window of duration_sec, max(Bsp_kts) - min(Bsp_kts) <= max_deviation_kts.
    Assumes 'ts' is monotonically increasing; window size is inferred from median sampling interval.
    Only affects rows with Grade > 1.
    """
    if 'Bsp_kts' not in df.columns or len(df) == 0:
        return df
    stable = _bsp_stable_mask(df, duration_sec=duration_sec, max_deviation_kts=max_deviation_kts)
    if stable is None:
        return df
    too_stable = (df['Grade'] > 1) & stable
    df.loc[too_stable, 'Grade'] = 1
    return df


# Minimum duration (seconds) for a non-sailing period to be treated as a session split (e.g. 30 minutes)
NON_SAILING_GAP_MIN_DURATION_SEC = 15 * 60
# Boat speed threshold: rows with Bsp_kts <= this are considered non-sailing for gap detection
SAILING_BSP_THRESHOLD_KTS = 5
# Grading: valid Bsp_kts strictly below this is always Grade 0 (after segment fill and other rules)
GRADE_ZERO_MAX_EXCLUSIVE_BSP_KTS = 10


def _find_long_non_sailing_gaps(df, min_duration_sec, sailing_threshold_kts=SAILING_BSP_THRESHOLD_KTS):
    """
    Find contiguous non-sailing periods longer than min_duration_sec.
    Non-sailing = Bsp_kts <= sailing_threshold_kts. Assumes df is sorted by ts.
    Returns list of (gap_start_ts, gap_end_ts).
    """
    if df is None or len(df) == 0 or 'ts' not in df.columns or 'Bsp_kts' not in df.columns:
        return []
    non_sailing = (df['Bsp_kts'] <= sailing_threshold_kts)
    non_sailing = non_sailing.fillna(True)
    gaps = []
    in_gap = False
    gap_start_idx = None
    for i in range(len(df)):
        if non_sailing.iloc[i]:
            if not in_gap:
                in_gap = True
                gap_start_idx = i
        else:
            if in_gap:
                in_gap = False
                gap_start_ts = df['ts'].iloc[gap_start_idx]
                gap_end_ts = df['ts'].iloc[i - 1]
                if gap_end_ts - gap_start_ts >= min_duration_sec:
                    gaps.append((float(gap_start_ts), float(gap_end_ts)))
    if in_gap:
        gap_start_ts = df['ts'].iloc[gap_start_idx]
        gap_end_ts = df['ts'].iloc[-1]
        if gap_end_ts - gap_start_ts >= min_duration_sec:
            gaps.append((float(gap_start_ts), float(gap_end_ts)))
    return gaps


def _sailing_sessions_from_gaps(df, gaps):
    """
    Given long non-sailing gaps, return sailing sessions as list of (session_start_ts, session_end_ts).
    Sessions are the intervals between gaps (and before first gap, after last gap).
    """
    if df is None or len(df) == 0:
        return []
    t_min = float(df['ts'].min())
    t_max = float(df['ts'].max())
    if not gaps:
        return [(t_min, t_max)]
    sorted_gaps = sorted(gaps, key=lambda g: g[0])
    sessions = []
    prev_end = t_min
    for g_start, g_end in sorted_gaps:
        if g_start > prev_end:
            sessions.append((prev_end, g_start))
        prev_end = max(prev_end, g_end)
    if prev_end < t_max:
        sessions.append((prev_end, t_max))
    return sessions


def _trimmed_range_for_session(df, session_start_ts, session_end_ts, extend_sec=60):
    """
    Apply the same start/end trim logic used for the whole file to a single sailing session:
    within the session, find rows with Bsp_kts > 5, compute mean Bsp_kts, then take rows above mean
    and extend by extend_sec on each side. Returns (trim_start_ts, trim_end_ts) or None if no sailing in session.
    """
    df_s = df.loc[(df['ts'] >= session_start_ts) & (df['ts'] <= session_end_ts)]
    if len(df_s) == 0:
        return None
    df_filtered = df_s.loc[df_s['Bsp_kts'] > SAILING_BSP_THRESHOLD_KTS]
    if len(df_filtered) == 0:
        return None
    mean_bsp = df_filtered['Bsp_kts'].mean()
    df_above = df_s.loc[df_s['Bsp_kts'] > mean_bsp]
    if len(df_above) == 0:
        return None
    trim_start = float(df_above['ts'].min()) - extend_sec
    trim_end = float(df_above['ts'].max()) + extend_sec
    return (trim_start, trim_end)


def compute_trimmed_sailing_ranges(df, non_sailing_gap_min_sec=NON_SAILING_GAP_MIN_DURATION_SEC):
    """
    Detect long non-sailing periods (>= non_sailing_gap_min_sec), split into sailing sessions,
    and apply the same start/end trim logic to each session. Returns list of (start_ts, end_ts)
    to keep (union of trimmed session ranges). Sorts by ts internally for gap detection.
    """
    if df is None or len(df) == 0:
        return []
    df_sorted = df.sort_values('ts').reset_index(drop=True)
    gaps = _find_long_non_sailing_gaps(df_sorted, non_sailing_gap_min_sec)
    if gaps and len(gaps) > 0:
        u.log(api_token, LOG_SCRIPT, "info", "compute_trimmed_sailing_ranges",
              f"Found {len(gaps)} long non-sailing gap(s) (>= {non_sailing_gap_min_sec / 60:.0f} min)")
    sessions = _sailing_sessions_from_gaps(df_sorted, gaps)
    ranges = []
    for s_start, s_end in sessions:
        r = _trimmed_range_for_session(df_sorted, s_start, s_end)
        if r is not None:
            ranges.append(r)
    if len(ranges) > 1:
        u.log(api_token, LOG_SCRIPT, "info", "compute_trimmed_sailing_ranges",
              f"Keeping {len(ranges)} sailing session(s) after trimming start/end of each")
    return ranges


def _df_filter_by_ranges(df, ranges):
    """Filter df to rows whose ts falls within any of the (start_ts, end_ts) ranges."""
    if not ranges:
        return df.iloc[0:0].copy()
    mask = np.zeros(len(df), dtype=bool)
    for (s, e) in ranges:
        mask |= (df['ts'].values >= s) & (df['ts'].values <= e)
    return df.loc[mask].copy()


def fetch_existing_crew_and_headsail_for_dataset(c_class_name, c_project_id, c_dataset_id):
    """
    Fetch existing CREW and HEADSAIL events for the given dataset from the API.
    Returns a list of { EventType, Event, Start, End } for use in processData.
    Used in batch mode so each dataset gets its own CREW/HEADSAIL re-inserted (no stale/shared state).
    """
    events_out = []
    try:
        crew_resp = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(c_class_name) + "&project_id=" + str(c_project_id) + "&dataset_id=" + str(c_dataset_id) + "&event_type=CREW")
        if crew_resp and crew_resp.get('success') and isinstance(crew_resp.get('data'), list):
            for row in crew_resp['data']:
                start = row.get('start_time')
                end = row.get('end_time')
                tags = row.get('tags') or {}
                count = tags.get('Count', 0)
                if start is not None and end is not None and count is not None:
                    c = int(count) if isinstance(count, (int, float)) else 0
                    if c > 0:
                        events_out.append({'EventType': 'Crew', 'Event': c, 'Start': start, 'End': end})
        headsail_resp = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(c_class_name) + "&project_id=" + str(c_project_id) + "&dataset_id=" + str(c_dataset_id) + "&event_type=HEADSAIL")
        if headsail_resp and headsail_resp.get('success') and isinstance(headsail_resp.get('data'), list):
            for row in headsail_resp['data']:
                start = row.get('start_time')
                end = row.get('end_time')
                tags = row.get('tags') or {}
                code = (tags.get('Headsail_code') or '').strip() if tags.get('Headsail_code') is not None else ''
                if start is not None and end is not None and code:
                    events_out.append({'EventType': 'Headsail', 'Event': code, 'Start': start, 'End': end})
    except Exception as e:
        u.log(api_token, LOG_SCRIPT, "warning", "fetch_existing_crew_and_headsail", str(e))
    return events_out


def fetch_existing_race_and_prestart(c_class_name, c_project_id, c_dataset_id):
    """
    Fetch existing RACE and PRESTART events for the dataset.
    Returns (existing_race_list, existing_prestart_list); each list has items with start_time, end_time, tags (incl. Race_number).
    """
    existing_race = []
    existing_prestart = []
    try:
        race_resp = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(c_class_name) + "&project_id=" + str(c_project_id) + "&dataset_id=" + str(c_dataset_id) + "&event_type=RACE")
        if race_resp and race_resp.get('success') and isinstance(race_resp.get('data'), list):
            existing_race = race_resp['data']
        prestart_resp = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(c_class_name) + "&project_id=" + str(c_project_id) + "&dataset_id=" + str(c_dataset_id) + "&event_type=PRESTART")
        if prestart_resp and prestart_resp.get('success') and isinstance(prestart_resp.get('data'), list):
            existing_prestart = prestart_resp['data']
    except Exception as e:
        u.log(api_token, LOG_SCRIPT, "warning", "fetch_existing_race_and_prestart", str(e))
    return existing_race, existing_prestart


def getConfiguration(df, preserve_events=True):
    """
    Load project configuration and create CONFIGURATION/CREW/HEADSAIL events.
    Derives config-query date from this dataset's data and timezone so config can vary by dataset/time of day.
    """
    headsail_exists = False
    df['Name'] = 'NA'
    df['Headsail_code'] = 'NA'
    df['Crew_count'] = 0
    df['Wing_code'] = 'NA'
    df['Rudder_code'] = 'NA'
    df['Daggerboard_code'] = 'NA'
    df['Config_code'] = 'NA'

    # Dataset time range for events - set once so start_dt/end_dt are always defined in all code paths
    _start_ts = df['ts'].min()
    _end_ts = df['ts'].max()
    start_dt = u.get_utc_datetime_from_ts(_start_ts)
    end_dt = u.get_utc_datetime_from_ts(_end_ts)

    # When preserve_events True we keep user-edited CREW/HEADSAIL and RACE/PRESTART; when False we replace from config/fallback or derive from df
    existing_crew = []
    existing_headsail = []
    existing_race = []
    existing_prestart = []
    if preserve_events:
        try:
            crew_resp = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&dataset_id=" + str(dataset_id) + "&event_type=CREW")
            if crew_resp and crew_resp.get('success') and isinstance(crew_resp.get('data'), list):
                existing_crew = crew_resp['data']
            headsail_resp = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&dataset_id=" + str(dataset_id) + "&event_type=HEADSAIL")
            if headsail_resp and headsail_resp.get('success') and isinstance(headsail_resp.get('data'), list):
                existing_headsail = headsail_resp['data']
            existing_race, existing_prestart = fetch_existing_race_and_prestart(class_name, project_id, dataset_id)
        except Exception as e:
            u.log(api_token, LOG_SCRIPT, "warning", "getConfiguration", "Could not fetch existing CREW/HEADSAIL/RACE/PRESTART events: " + str(e))

    # Derive date for config API from this dataset's data and timezone (config can change through the day)
    timezone_str = None
    try:
        dataset_resp = u.get_api_data(api_token, ":8069/api/datasets/id?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id))
        if dataset_resp and isinstance(dataset_resp, dict) and dataset_resp.get('success') and dataset_resp.get('data'):
            tz = dataset_resp['data'].get('timezone')
            if tz and isinstance(tz, str) and tz.strip():
                timezone_str = tz.strip()
    except Exception as e:
        u.log(api_token, LOG_SCRIPT, "warning", "getConfiguration", "Could not get dataset timezone, using UTC date: "+str(e))

    date_dt = u.get_utc_datetime_from_ts(df['ts'].iloc[10])
    if timezone_str:
        try:
            tz = pytz.timezone(timezone_str)
            local_dt = date_dt.astimezone(tz)
            date = local_dt.strftime('%Y-%m-%d')
        except Exception as e:
            u.log(api_token, LOG_SCRIPT, "warning", "getConfiguration", "Invalid timezone '"+timezone_str+"', using UTC date: "+str(e))
            date = date_dt.strftime('%Y-%m-%d')
    else:
        date = date_dt.strftime('%Y-%m-%d')

    config_info = u.get_api_data(api_token, ":8069/api/projects/object?class_name="+str(class_name)+"&project_id="+str(project_id)+"&date="+str(date)+"&object_name="+str("configurations"))
    
    # Check if API call was successful and data exists
    if config_info != None and config_info.get('success') == True and 'data' in config_info and config_info['data'] is not None:
        config_info = config_info['data']
        
        # Ensure config_info is a list (it may be a single dict or a list)
        if not isinstance(config_info, list):
            config_info = [config_info]
        
        # Sort configurations by time to ensure chronological order
        config_info_sorted = sorted(config_info, key=lambda x: x['time'])
        
        # Use the LAST known configuration from the list (most recent)
        if len(config_info_sorted) > 0:
            last_config_item = config_info_sorted[-1]
            config = last_config_item['configuration']
            
            # Apply this configuration to ALL rows in the dataframe
            headsail_exists = True

            crew_str = config.get('crew', '').replace('C', '')
            crew_count = int(crew_str) if crew_str and crew_str.isdigit() else 0
            df['Name'] = config.get('name', '')
            df['Crew_count'] = crew_count
            df['Headsail_code'] = config.get('headsail', '')
            df['Wing_code'] = config.get('wing', '')
            df['Rudder_code'] = config.get('rudder', '')
            df['Daggerboard_code'] = config.get('daggerboard', '')
            name = config.get('name', '') or ''
            headsail = config.get('headsail', '') or ''
            wing = config.get('wing', '') or ''
            rudder = config.get('rudder', '') or ''
            daggerboard = config.get('daggerboard', '') or ''
            df['Config_code'] = config.get('config', '')

            # CONFIG: name only (headsail/crew come from CREW/HEADSAIL events and are applied by sync)
            config_str = name or 'NA'
            # CONFIGURATION object: static boat/setup only (Name, Wing_code, Daggerboard_code, Rudder_code)
            configuration_obj = {
                'Name': name,
                'Wing_code': wing,
                'Daggerboard_code': daggerboard,
                'Rudder_code': rudder,
            }
            # Store only CONFIG and CONFIGURATION; config fields live only inside CONFIGURATION
            tags = {
                'CONFIG': config_str,
                'CONFIGURATION': configuration_obj,
            }
            # Convert to UTC-aware datetime using ts (timestamp in seconds) to ensure UTC timezone
            start_ts = df['ts'].min()
            end_ts = df['ts'].max()
            start_dt = u.get_utc_datetime_from_ts(start_ts)
            end_dt = u.get_utc_datetime_from_ts(end_ts)
            event = {
                'EventType': 'Config',
                'Event': tags,
                'Start': u.format_timestamp(start_dt),
                'End': u.format_timestamp(end_dt)
            }

            insertDatasetEvent(event)

            # Dataset-level Crew and Headsail: preserve existing if user-edited in Events.tsx
            if existing_crew:
                _fill_df_from_events(df, existing_crew, 'Count', 'Crew_count')
            else:
                # Only insert CREW when crew count is non-zero (same as empty headsail)
                if crew_count > 0:
                    crew_event = {
                        'EventType': 'Crew',
                        'Event': crew_count,
                        'Start': u.format_timestamp(start_dt),
                        'End': u.format_timestamp(end_dt)
                    }
                    insertDatasetEvent(crew_event)

            if existing_headsail:
                _fill_df_from_events(df, existing_headsail, 'Headsail_code', 'Headsail_code')
            else:
                config_headsail = (config.get('headsail') or '').strip() if config.get('headsail') is not None else ''
                if config_headsail:
                    headsail_event = {
                        'EventType': 'Headsail',
                        'Event': config_headsail,
                        'Start': u.format_timestamp(start_dt),
                        'End': u.format_timestamp(end_dt)
                    }
                    insertDatasetEvent(headsail_event)

    if not headsail_exists:
        for race_number in df['Race_number'].unique():
            if pd.isna(race_number):
                continue
            avg_tws = df[df['Race_number'] == race_number]['Tws_kts'].mean()

            if avg_tws <= 8:
                df.loc[(df['Race_number'] == race_number), 'Headsail_code'] = 'J1'  
            elif avg_tws > 8 and avg_tws <= 10:
                df.loc[(df['Race_number'] == race_number), 'Headsail_code'] = 'J2'
            elif avg_tws > 10 and avg_tws <= 13:
                df.loc[(df['Race_number'] == race_number), 'Headsail_code'] = 'J2'
            elif avg_tws > 13 and avg_tws <= 16:
                df.loc[(df['Race_number'] == race_number), 'Headsail_code'] = 'J3'
            elif avg_tws > 16 and avg_tws <= 20:
                df.loc[(df['Race_number'] == race_number), 'Headsail_code'] = 'J3'
            elif avg_tws > 20:
                df.loc[(df['Race_number'] == race_number), 'Headsail_code'] = 'J3'

        # Dataset-level Crew and Headsail when no config: preserve existing if user-edited in Events.tsx
        start_ts = df['ts'].min()
        end_ts = df['ts'].max()
        start_dt = u.get_utc_datetime_from_ts(start_ts)
        end_dt = u.get_utc_datetime_from_ts(end_ts)
        if existing_crew:
            _fill_df_from_events(df, existing_crew, 'Count', 'Crew_count')
        else:
            # Do not insert CREW when crew count would be zero
            pass
        if existing_headsail:
            _fill_df_from_events(df, existing_headsail, 'Headsail_code', 'Headsail_code')
        else:
            # Fallback headsail: first non-NA value in df or 'NA'
            headsail_codes = df['Headsail_code'].dropna()
            headsail_codes = headsail_codes[headsail_codes != 'NA']
            fallback_headsail = headsail_codes.iloc[0] if len(headsail_codes) > 0 else 'NA'
            headsail_event = {
                'EventType': 'Headsail',
                'Event': fallback_headsail,
                'Start': u.format_timestamp(start_dt),
                'End': u.format_timestamp(end_dt)
            }
            insertDatasetEvent(headsail_event)

    # Lookup existing RACE and PRESTART by Race_number (one event per race)
    existing_race_by_rn = {}
    for ev in existing_race:
        tags = ev.get('tags') or {}
        rn = tags.get('Race_number')
        if rn is not None and int(rn) not in existing_race_by_rn:
            existing_race_by_rn[int(rn)] = ev
    existing_prestart_by_rn = {}
    for ev in existing_prestart:
        tags = ev.get('tags') or {}
        rn = tags.get('Race_number')
        if rn is not None and int(rn) not in existing_prestart_by_rn:
            existing_prestart_by_rn[int(rn)] = ev

    # INSERT EVENTS
    for race_num in df['Race_number'].unique():
        if pd.isna(race_num):
            continue

        try:
            race_number = int(race_num)
        except (ValueError, TypeError):
            continue

        if race_number == 0:
            continue

        dfr = df.loc[(df['Race_number'] == race_number)].copy()

        if len(dfr) > 180 and race_number > 0:
            # Race bounds: use existing RACE event times if present, else derive from df
            race_ev = existing_race_by_rn.get(race_number)
            if race_ev and race_ev.get('start_time') and race_ev.get('end_time'):
                race_start_ts = u.get_timestamp_from_str(race_ev['start_time'])
                race_end_ts = u.get_timestamp_from_str(race_ev['end_time'])
            else:
                race_start_ts = dfr['ts'].min()
                race_end_ts = dfr['ts'].max()
            race_start_dt = u.get_utc_datetime_from_ts(race_start_ts)
            race_end_dt = u.get_utc_datetime_from_ts(race_end_ts)
            
            # RACE
            event = {
                'EventType': 'Race',
                'Event': {'Race_number': race_number},
                'Start': u.format_timestamp(race_start_dt),
                'End': u.format_timestamp(race_end_dt)
            }

            insertDatasetEvent(event)

            # RACES & LEGS
            for leg_num_raw in dfr['Leg_number'].unique():
                if pd.isna(leg_num_raw) or leg_num_raw == 'NA' or leg_num_raw == '':
                    continue
                try:
                    leg_number = int(leg_num_raw)
                except (ValueError, TypeError):
                    continue
                dfl = dfr.loc[(dfr['Leg_number'] == leg_num_raw)].copy()

                if leg_number == 0:
                    event_type = 'Prestart'
                    event = {'Race_number': race_number}
                    # Use existing PRESTART event times if present; else end at race start, start = end - 120
                    prestart_ev = existing_prestart_by_rn.get(race_number)
                    if prestart_ev and prestart_ev.get('start_time') and prestart_ev.get('end_time'):
                        prestart_start_str = prestart_ev['start_time'] if isinstance(prestart_ev['start_time'], str) else u.format_timestamp(prestart_ev['start_time'])
                        prestart_end_str = prestart_ev['end_time'] if isinstance(prestart_ev['end_time'], str) else u.format_timestamp(prestart_ev['end_time'])
                    else:
                        # End PRESTART at race start (first Leg 1); start = end - 2 min
                        leg1_rows = dfr.loc[dfr['Leg_number'] == 1]
                        if len(leg1_rows) > 0:
                            prestart_end_ts = leg1_rows['ts'].min()
                        else:
                            prestart_end_ts = dfl['ts'].max()
                        prestart_start_ts = prestart_end_ts - 120  # 2 minutes in seconds
                        prestart_end_dt = u.get_utc_datetime_from_ts(prestart_end_ts)
                        prestart_start_dt = u.get_utc_datetime_from_ts(prestart_start_ts)
                        prestart_start_str = u.format_timestamp(prestart_start_dt)
                        prestart_end_str = u.format_timestamp(prestart_end_dt)

                    event = {
                        'EventType': event_type,
                        'Event': event,
                        'Start': prestart_start_str,
                        'End': prestart_end_str
                    }
                elif leg_number > 0:
                    event_type = 'Leg'
                    event = {'Race_number': race_number, 'Leg_number': leg_number}
                    # Convert to UTC-aware datetime using ts (timestamp in seconds) to ensure UTC timezone
                    leg_start_ts = dfl['ts'].min()
                    leg_end_ts = dfl['ts'].max()
                    leg_start_dt = u.get_utc_datetime_from_ts(leg_start_ts)
                    leg_end_dt = u.get_utc_datetime_from_ts(leg_end_ts)

                    event = {
                        'EventType': event_type,
                        'Event': event,
                        'Start': u.format_timestamp(leg_start_dt),
                        'End': u.format_timestamp(leg_end_dt)
                    }

                insertDatasetEvent(event)

    return df

def processRaces(df, apply_grades=True):
    for race_num in df['Race_number'].unique():
        if pd.isna(race_num):
            continue

        try:
            race_number = int(race_num)
        except (ValueError, TypeError):
            continue

        dfr = df.loc[df['Race_number'] == race_number].copy()

        if len(dfr) > 180 and race_number > 0:
            last_leg_number = dfr['Leg_number'].max()

            if apply_grades == False:
                df.loc[(df['Race_number'] == race_num), 'Grade'] = 3

            # RACES & LEGS
            for leg_num_raw in dfr['Leg_number'].unique():
                if pd.isna(leg_num_raw) or leg_num_raw == 'NA' or leg_num_raw == '':
                    continue
                try:
                    leg_number = int(leg_num_raw)
                except (ValueError, TypeError):
                    continue

                dfr_leg = dfr.loc[dfr['Leg_number'] == leg_number]

                if leg_number == 1:
                    leg_start = dfr_leg['ts'].min()
                    # Leg 0 window: 2 min before race start, aligned with normalization and PRESTART event
                    mask = (df['ts'] >= leg_start - 120) & (df['ts'] <= leg_start)
                    df.loc[mask & (df['Grade'] > 0), 'Grade'] = 1
                    df.loc[mask, 'Race_number'] = race_num
                    df.loc[mask, 'Leg_number'] = 0

                # Only grade legs > 1 and not the last leg
                if apply_grades:
                    if leg_number > 1 and leg_number != last_leg_number:
                        # Find start and end times of this leg
                        leg_start = dfr_leg['ts'].min()
                        leg_end   = dfr_leg['ts'].max()

                        first_mask = (df['Race_number'] == race_num) & (df['Leg_number'] == leg_number) & (df['ts'] <= leg_start + 5.0)
                        last_mask  = (df['Race_number'] == race_num) & (df['Leg_number'] == leg_number) & (df['ts'] >= leg_end - 5.0)

                        # Apply grading only to those windows
                        df.loc[first_mask & (df['Grade'] > 0), 'Grade'] = 1
                        df.loc[last_mask  & (df['Grade'] > 0), 'Grade'] = 1
    
    if apply_grades:
        valid_legs = df.loc[(df['Race_number'] > 1) & (df['Leg_number'] >= -1)]

        if not valid_legs.empty:
            min_ts = valid_legs['ts'].min()
            max_ts = valid_legs['ts'].max()

            mask_between = (
                (df['Race_number'] == -1) &
                (df['Leg_number'] == -1) &
                (df['ts'] >= min_ts) &
                (df['ts'] <= max_ts)
            )

            df.loc[mask_between, 'Grade'] = 1

    return df

def identifyPhases(df):
    # IDENTIFY PHASES
    dff = df.loc[(df['Grade'] > 1)].copy()
               
    pts = 0
    ts1 = 0
    ts2 = 0
    phase_id = 1
    for i in range(len(dff) - 1):
        row = dff.iloc[i]
        ts = row['ts']
    
        if i == 0:
            ts1 = ts
        else:
            diff = ts - pts
            
            if diff > 3:
                ts2 = pts

                df.loc[(df['ts'] > ts1) & (df['ts'] < ts2), 'Phase_id'] = int(phase_id)
                
                phase_id += 1
                ts1 = ts
                    
        pts = ts
    
    if ts1 > 0:
        df.loc[(df['ts'] > ts1) & (df['ts'] < ts), 'Phase_id'] = int(phase_id)

    return df

def identifyPeriods(df):
    phases = df['Phase_id'].unique()

    period_id = 1
    for phase in phases:
        if phase > 0:
            dff = df.loc[(df['Grade'] > 2) & (df['Phase_id'] == phase)].copy()
            
            if len(dff) > 0:               
                ts_min = dff['ts'].min()
                ts_max = dff['ts'].max()
                
                if ts_max - ts_min > 10:
                    df.loc[(df['ts'] > ts_min) & (df['ts'] < ts_max), 'Period_id'] = int(period_id)
                    period_id += 1

    return df

def processData(df, events_json, preserve_events=True):
    df = df.copy()
    
    # Initialize or reset columns
    df['Grade'] = 0
    df['Maneuver_type'] = ''
    df['Phase_id'] = -1
    df['Period_id'] = -1
   
    # LOOP THROUGH EVENTS
    for event in events_json:
        et = event['EventType']
        start = u.get_timestamp_from_str(event['Start'])
        end = u.get_timestamp_from_str(event['End'])

        # Do not insert Config here: getConfiguration() below is the single source of CONFIGURATION event (one per dataset)
        if et != 'Config':
            insertDatasetEvent(event)

        #INSERT EVENT
        if et == 'Dataset':
            df.loc[(df['ts'] >= start) & (df['ts'] <= end), 'Grade'] = 3

    df = getConfiguration(df, preserve_events=preserve_events)

    df = processRaces(df, False)

    # IDENTIFY MANEUVERS
    dfi = u.identifyManeuvers(df)

    df = identifyPhases(df)

    df = processRaces(df, True)

    # APPLY GRADES
    dfi.loc[(dfi['Leg_number'] == 0), 'Grade'] = 1
    dfi.loc[(dfi['Twa_n_deg'] < 20) | (dfi['Twa_n_deg'] > 160), 'Grade'] = 1

    dfi.loc[(dfi['Foiling_state'] == 2) & ~(dfi['Race_number'] > 0), 'Grade'] = 0

    dfi = apply_yaw_not_normal_grade_one(dfi)

    dfi = apply_too_stable_boat_speed_grade_one(dfi)

    dfi = remove_small_segments(dfi)

    dfi = apply_high_speed_twin_board_grades(dfi)

    # Below-speed data excluded when not racing; segment fill must not leave low Bsp as usable grades there.
    if 'Bsp_kts' in dfi.columns:
        dfi.loc[
            dfi['Bsp_kts'].notna()
            & (dfi['Bsp_kts'] < GRADE_ZERO_MAX_EXCLUSIVE_BSP_KTS)
            & ~(dfi['Race_number'] > 0),
            'Grade',
        ] = 0

    # Grade 0 = excluded data; strip phase/period (identifyPeriods paints full ts windows; grade 0 may lie inside)
    g0 = dfi['Grade'] == 0
    dfi.loc[g0, 'Phase_id'] = -1
    dfi.loc[g0, 'Period_id'] = -1

    dfi = identifyPeriods(dfi)

    # Race_status = 1 from prestart start to race end per race (for visualization/filtering)
    dfi = apply_race_status_channel(dfi)

    return dfi


def apply_race_status_channel(df):
    """
    Set Race_status = 1 for rows where ts is between prestart start and race end (inclusive) per race_number.
    Prestart start = race start (first Leg 1 or race min) - 120 s; race end = max ts for that race.
    """
    if 'Race_number' not in df.columns or 'ts' not in df.columns:
        return df
    df = df.copy()
    df['Race_status'] = 0
    for race_num in df['Race_number'].dropna().unique():
        try:
            race_number = int(race_num)
        except (ValueError, TypeError):
            continue
        if race_number <= 0:
            continue
        dfr = df.loc[df['Race_number'] == race_number]
        if len(dfr) == 0:
            continue
        race_end_ts = dfr['ts'].max()
        leg1 = dfr.loc[dfr['Leg_number'] == 1]
        if len(leg1) > 0:
            race_start_ts = leg1['ts'].min()
        else:
            race_start_ts = dfr['ts'].min()
        prestart_start_ts = race_start_ts - 120
        mask = (
            (df['Race_number'] == race_number) &
            (df['ts'] >= prestart_start_ts) &
            (df['ts'] <= race_end_ts)
        )
        df.loc[mask, 'Race_status'] = 1
    return df

if __name__ == "__main__":
    parameters_json = {}
    # Set True to run from IDE / CLI without argv JSON (edit values in the branch below). Same pattern as 3_systems.py / 3_corrections.py.
    USE_MANUAL_TEST_INPUTS = True

    try:
        if USE_MANUAL_TEST_INPUTS:
            class_name = "AC40"
            project_id = 2
            dataset_id = 1
            date = "20260328"
            source_name = "AC40-SUI1"
            start_time = None
            end_time = None
            events_json = [
                {
                    "Event": "Active",
                    "Start": "2026-03-28T01:20:40.000Z",
                    "End": "2026-03-28T20:58:18.000Z",
                    "EventType": "Dataset",
                },
            ]
            batch = False
            verbose = True
            preserve_events = True
            day_type = "TRAINING"
            race_type = "INSHORE"
            parameters_json = {"verbose": verbose}
        else:
            parameters_str = sys.argv[1]
            parameters_json = json.loads(parameters_str)

            u.log(api_token, LOG_SCRIPT, "info", "parameters", parameters_str)

            class_name = parameters_json.get("class_name")
            project_id = parameters_json.get("project_id")
            dataset_id = parameters_json.get("dataset_id")
            date = parameters_json.get("date")
            source_name = parameters_json.get("source_name")
            start_time = parameters_json.get("start_time")
            end_time = parameters_json.get("end_time")
            if start_time == "":
                start_time = None
            if end_time == "":
                end_time = None
            events_json = parameters_json.get("events", [])
            batch = parameters_json.get("batch", False)
            verbose = parameters_json.get("verbose", False)
            preserve_events = parameters_json.get("preserve_events", True)

            day_type = parameters_json.get("day_type", ["TRAINING", "RACING"])
            race_type = parameters_json.get("race_type", ["INSHORE", "COASTAL", "OFFSHORE"])

        if not isinstance(day_type, list):
            day_type = [day_type] if day_type is not None else ["TRAINING", "RACING"]
        if not isinstance(race_type, list):
            race_type = [race_type] if race_type is not None else ["INSHORE", "COASTAL", "OFFSHORE"]

        s.set_item('class_name', class_name)
        s.set_item('project_id', project_id)
        s.set_item('dataset_id', dataset_id)
        s.set_item('date', date)
        s.set_item('source_name', source_name)
        s.set_item('start_time', start_time)
        s.set_item('end_time', end_time)
        s.set_item('batch', batch)
        s.set_item('verbose', verbose)
        s.set_item('day_type', json.dumps(day_type))
        s.set_item('race_type', json.dumps(race_type))

        if verbose:
            print("Querying data...", flush=True)
        print(f"{LOG_SCRIPT}: Querying data...", flush=True)

        df = get_data(class_name, project_id, date, source_name, None, None)

        print(f"{LOG_SCRIPT}: Data returned!", flush=True)
        #LOG
        u.log(api_token, LOG_SCRIPT, "info", "processing data", str(len(df))+ " records retrieved...")

        if len(df) > 0:
            if verbose:
                print(len(df),'records found...', flush=True)

            # When batch=True and no start/end, fetch datasets for this date (optionally filter to parameter dataset_id for Admin single-dataset requests)
            dataset_list = []
            if batch and (start_time is None or end_time is None):
                date_norm = (date or '').replace('-', '').replace('/', '')
                if date_norm:
                    try:
                        resp = u.get_api_data(api_token, ":8069/api/datasets/date/datasets_with_duration?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&date=" + str(date_norm))
                        if resp and resp.get('success') and isinstance(resp.get('data'), list) and len(resp['data']) > 0:
                            for r in resp['data']:
                                ds_id = r.get('dataset_id')
                                src = r.get('source_name') or source_name or ''
                                st = r.get('start_time')
                                et = r.get('end_time')
                                if ds_id is not None and st and et:
                                    dataset_list.append((ds_id, src, st, et))
                            # When caller sent dataset_id (e.g. Admin page one-request-per-dataset), process only that dataset
                            if dataset_id is not None and str(dataset_id).strip() != '':
                                try:
                                    want_id = int(dataset_id)
                                    dataset_list = [(did, s, st, et) for (did, s, st, et) in dataset_list if int(did) == want_id]
                                except (ValueError, TypeError):
                                    pass
                            u.log(api_token, LOG_SCRIPT, "info", "processing data", f"Batch date mode: {len(dataset_list)} dataset(s) for date {date_norm}")
                            print(f"{LOG_SCRIPT}: batch date mode, {len(dataset_list)} dataset(s) to process", flush=True)
                    except Exception as e:
                        u.log(api_token, LOG_SCRIPT, "warning", "processing data", "Failed to fetch datasets for date: " + str(e))
                if not dataset_list:
                    dataset_list = [(dataset_id, source_name, None, None)]
            else:
                dataset_list = [(dataset_id, source_name, start_time, end_time)]

            for loop_idx, (cur_dataset_id, cur_source_name, cur_start_time, cur_end_time) in enumerate(dataset_list):
                dataset_id = cur_dataset_id
                source_name = cur_source_name
                start_time = cur_start_time
                end_time = cur_end_time
                if batch and len(dataset_list) > 1:
                    print(f"{LOG_SCRIPT}: processing dataset {loop_idx + 1} of {len(dataset_list)} (dataset_id={cur_dataset_id})", flush=True)
                s.set_item('dataset_id', cur_dataset_id)
                s.set_item('source_name', cur_source_name)
                # For batch date mode (no start/end in params), fetch data for this dataset's range from API
                if batch and cur_start_time and cur_end_time:
                    start_ts_cur = u.get_timestamp_from_str(cur_start_time) if isinstance(cur_start_time, str) else cur_start_time
                    end_ts_cur = u.get_timestamp_from_str(cur_end_time) if isinstance(cur_end_time, str) else cur_end_time
                    df = get_data(class_name, project_id, date, cur_source_name, start_ts_cur, end_ts_cur)
                    if len(df) == 0:
                        u.log(api_token, LOG_SCRIPT, "warning", "processing data", f"No data for dataset_id={cur_dataset_id}, skipping")
                        continue

                if start_time is not None and end_time is not None:
                    # Convert string times to timestamps for filtering
                    param_start_ts = u.get_timestamp_from_str(start_time) if isinstance(start_time, str) else start_time
                    param_end_ts = u.get_timestamp_from_str(end_time) if isinstance(end_time, str) else end_time
                    
                    if param_start_ts is None or param_end_ts is None or pd.isna(param_start_ts) or pd.isna(param_end_ts):
                        u.log(api_token, LOG_SCRIPT, "error", "processing data", f"Invalid datetime format: start_time={start_time}, end_time={end_time}")
                        print("Scripts Failed: Invalid datetime format", flush=True)
                        sys.exit(1)
                    
                    # Window = user-specified time range; detect long non-sailing gaps and trim each sailing session within it
                    window_df = df.loc[(df['ts'] >= param_start_ts) & (df['ts'] <= param_end_ts)].copy()
                    ranges = compute_trimmed_sailing_ranges(window_df)
                    if not ranges:
                        u.log(api_token, LOG_SCRIPT, "info", "All data filtered out (no Bsp_kts > 5 in time range)", str(u.dt.now()))
                        print("Scripts Failed: No sailing data in specified time range (no Bsp_kts > 5 or no valid sessions)", flush=True)
                        sys.exit(1)
                    df1 = _df_filter_by_ranges(df, ranges)
                    df1 = df1.loc[(df1['ts'] >= param_start_ts) & (df1['ts'] <= param_end_ts)].copy()
                else:
                    # Full file: detect long non-sailing gaps (>= 30 min), trim start/end of each sailing session, keep union of ranges
                    ranges = compute_trimmed_sailing_ranges(df)
                    if not ranges:
                        u.log(api_token, LOG_SCRIPT, "info", "All data filtered out (no Bsp_kts > 5)", str(u.dt.now()))
                        print("Scripts Failed: No sailing data (no Bsp_kts > 5 or no valid sessions)", flush=True)
                        sys.exit(1)
                    df1 = _df_filter_by_ranges(df, ranges)
                    if len(df1) == 0:
                        u.log(api_token, LOG_SCRIPT, "info", "All data filtered out after session trimming", str(u.dt.now()))
                        print("Scripts Failed: No data after session trimming", flush=True)
                        sys.exit(1)
                
                if len(df1) > 0:
                    # In batch multi-dataset mode, fetch this dataset's CREW/HEADSAIL before delete so we can re-insert them (per-dataset, no stale state)
                    batch_crew_headsail_events = []
                    if batch and len(dataset_list) > 1:
                        batch_crew_headsail_events = fetch_existing_crew_and_headsail_for_dataset(class_name, project_id, dataset_id)

                    # REMOVE EXISTING EVENTS (when preserve_events False, replace CREW/HEADSAIL; otherwise preserve user-edited).
                    # Do not delete DATASET: we update it via POST (addEvent updates if exists) so a failed run cannot leave the dataset without a DATASET event.
                    event_types = ["CONFIGURATION", "RACE", "LEG", "PRESTART"]
                    if not preserve_events:
                        event_types = ["CREW", "HEADSAIL", "CONFIGURATION", "RACE", "LEG", "PRESTART"]
                    jsondata = {"class_name": class_name, "project_id": project_id, "dataset_id": dataset_id, "event_types": event_types}
                    u.delete_api_data(api_token, ":8059/api/events/by_event_type", jsondata)

                    # ADD NEW DATASET EVENT
                    # Convert to UTC datetime strings using ts (timestamp in seconds) to ensure UTC timezone
                    dataset_start_ts = df1['ts'].min()
                    dataset_end_ts = df1['ts'].max()
                    dataset_start_dt = u.get_utc_datetime_from_ts(dataset_start_ts)
                    dataset_end_dt = u.get_utc_datetime_from_ts(dataset_end_ts)
                    dataset_start_str = u.format_timestamp(dataset_start_dt)
                    dataset_end_str = u.format_timestamp(dataset_end_dt)
                    has_real_dataset = False
                    if 'Race_number' in df1.columns:
                        try:
                            has_real_dataset = (df1['Race_number'] > 0).any()
                        except (TypeError, ValueError):
                            pass
                    dataset_event_tags = {
                        "Dataset_type": "RACING" if has_real_dataset else "TRAINING",
                        "Race_type": (race_type[0] if race_type else "INSHORE")
                    }
                    jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "event_type": "DATASET", "start_time": dataset_start_str, "end_time": dataset_end_str, "tags": json.dumps(dataset_event_tags)}
                    res = u.post_api_data(api_token, ":8059/api/events", jsondata)

                    #LOG
                    if res["success"] == True:
                        u.log(api_token, LOG_SCRIPT, "info", "processing data", "Dataset Events Updated!")
                    else:
                        u.log(api_token, LOG_SCRIPT, "error", "processing data", res["message"])

                    getDatasetInfo(df1)

                    if verbose:
                        print("Processing data...", flush=True)

                    # Batch multi-dataset: use Dataset event + this dataset's fetched CREW/HEADSAIL so each dataset gets correct events (no shared/stale vars)
                    if batch and len(dataset_list) > 1:
                        events_json_iter = [{"EventType": "Dataset", "Event": "Active", "Start": dataset_start_str, "End": dataset_end_str}] + batch_crew_headsail_events
                    else:
                        events_json_iter = events_json
                    df2 = processData(df1, events_json_iter, preserve_events=preserve_events)

                    #LOG
                    u.log(api_token, LOG_SCRIPT, "info", "processing data", str(len(df))+ " records processed...")

                    if len(df2) > 0:
                        chosen_columns = ['Datetime', 'ts', 'Grade', 'Race_number', 'Leg_number', 'Headsail_code', 'Crew_count', 'Wing_code', 'Rudder_code', 'Daggerboard_code', 'Config_code', 'Maneuver_type', 'Phase_id', 'Period_id', 'Race_status', 'Foiling_state', 'AC40_Leeway_n', 'AC40_VMG_n_kts', 'AC40_BowWand_AWA_n', 'Accel_rate_mps2', 'Yaw_rate_dps']
                        
                        # Filter to only include columns that actually exist in df3
                        chosen_columns = [col for col in chosen_columns if col in df2.columns]
                        df_selected = df2[chosen_columns].copy()
                        
                        # Ensure Datetime column is properly typed before saving to parquet
                        if 'Datetime' in df_selected.columns:
                            # Convert to datetime64[ns, UTC] if it's object type
                            if df_selected['Datetime'].dtype == 'object':
                                df_selected['Datetime'] = pd.to_datetime(df_selected['Datetime'], utc=True, errors='coerce')
                                u.log(api_token, LOG_SCRIPT, "info", "processing data", "Converted Datetime column from object to datetime64[ns, UTC]")
                            # Ensure it's timezone-aware UTC
                            if df_selected['Datetime'].dtype.name.startswith('datetime64'):
                                if df_selected['Datetime'].dt.tz is None:
                                    df_selected['Datetime'] = df_selected['Datetime'].dt.tz_localize('UTC')
                                elif str(df_selected['Datetime'].dt.tz) != 'UTC':
                                    df_selected['Datetime'] = df_selected['Datetime'].dt.tz_convert('UTC')
                        
                        if verbose:
                            print("Saving to parquet...", flush=True)

                        # Get data directory from environment variable
                        data_dir = os.getenv('DATA_DIRECTORY', 'C:/MyApps/Alinghi/uploads/data')
                        
                        event_file_path = os.path.join(data_dir, 'system', str(project_id), class_name, date, source_name, 'processed_data_racesight.parquet')

                        if os.path.exists(event_file_path):
                            os.remove(event_file_path)

                        #LOG
                        u.log(api_token, LOG_SCRIPT, "info", "processing data", "processed data saved to parquet...")
                        df_selected.to_parquet(event_file_path, engine='pyarrow')
                        print(str(len(df_selected))+" records saved to parquet", flush=True)

                        #DEFAULT PAGES
                        jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "page_name": "TIME SERIES"}
                        res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)

                        u.log(api_token, LOG_SCRIPT, "info", "processing data", "script completed successfully!")

                        # Update dataset date_modified to trigger cache refresh
                        u.update_dataset_date_modified(api_token, class_name, project_id, dataset_id=dataset_id)

                        if batch and len(dataset_list) > 1:
                            continue
                        if batch == False:
                            print("Script Completed:", u.dt.now(), flush=True)
                        sys.exit(0)
                    else:
                        u.log(api_token, LOG_SCRIPT, "info", "processData returned empty dataframe", str(u.dt.now()))
                        print(f"Scripts Failed: processData returned {len(df2)} records (expected > 0)", flush=True)
                        sys.exit(1)
                else:
                    u.log(api_token, LOG_SCRIPT, "info", "All data filtered out", str(u.dt.now()))
                    print("Scripts Failed:", u.dt.now(), flush=True)
                    sys.exit(1)
            if batch and len(dataset_list) > 1:
                print("Script Completed (batch):", len(dataset_list), "datasets processed.", u.dt.now(), flush=True)
        else:
            u.log(api_token, LOG_SCRIPT, "info", "No data found", str(u.dt.now()))
            print(
                "Scripts Failed: No rows loaded (get_data returned empty). "
                "Typical causes: file server channel-groups 404 'Source not found' (no parquet folder for this "
                f"source/date), wrong source_name, or date/class/project mismatch. "
                f"class_name={class_name!r} project_id={project_id!r} date={date!r} source_name={source_name!r}",
                flush=True,
            )
            sys.exit(1)

    except Exception as error:
        import traceback
        error_trace = traceback.format_exc()
        u.log(api_token, LOG_SCRIPT, "error", "processing data", "script exception error:"+str(error))
        u.log(api_token, LOG_SCRIPT, "error", "processing data", "traceback:"+error_trace)
        # Use errors='replace' to handle any Unicode encoding issues on Windows
        try:
            print(f"Scripts Failed: {str(error)}", flush=True)
            if parameters_json.get("verbose", False):
                print(error_trace, flush=True)
        except UnicodeEncodeError:
            # Fallback: replace problematic characters with '?'
            print(f"Scripts Failed: {str(error).encode('ascii', errors='replace').decode('ascii')}", flush=True)
            if parameters_json.get("verbose", False):
                print(error_trace.encode('ascii', errors='replace').decode('ascii'), flush=True)
        sys.exit(1)