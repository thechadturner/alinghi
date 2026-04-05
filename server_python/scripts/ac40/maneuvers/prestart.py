import pandas as pd
import numpy as np
import math as m
import sys
import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import utilities as u
from utilities.ac40_channel_maps import apply_ac40_fusion_legacy_names

# Mark names to use for rotation center (SL1), leg1 gate (M1), and to expose on the map (SL1, SL2, M1)
MARK_NAMES = ("SL1", "SL2", "M1")

# Leg 1 time bounds for averaging across series (exclude < min or > max)
LEG1_MIN_S = 20
LEG1_MAX_S = 90
LEG1_DEFAULT_S = 35.0
REACH_TO_LEG1_RATIO = 25.0 / 35.0  # reach_time = leg1_time * this (leg1_time = first boat across M1 gate)
# Seconds before start to include in max-accel window (prestart + leg1)
ACCEL_PRESTART_S = 20
# Round reach/leg1 times to this increment (seconds) for map and timeseries
REACH_LEG1_ROUND_S = 5

# Fixed position on earth for map output (same as tacks, bearaways, gybes, takeoffs). All boats use this
# origin so relative positions are consistent regardless of race location or per-source SL1.
originlat = 39.476984
originlon = -0.291140

def _entry_timestamp(entry):
    """Parse DATETIME/Datetime/datetime/TIMESTAMP from a marks entry to Unix timestamp (seconds), or None."""
    if not isinstance(entry, dict):
        return None
    dt_str = entry.get("DATETIME") or entry.get("Datetime") or entry.get("datetime") or entry.get("TIMESTAMP")
    if dt_str is None:
        return None
    try:
        return u.get_timestamp_from_str(str(dt_str), force_utc=True)
    except (TypeError, ValueError):
        return None


def get_marks_and_sl1(api_token, class_name, project_id, date, reference_ts=None):
    """
    Fetch marks for the given project/date. Returns (marks_list, sl1_lat, sl1_lng, sl2_lat, sl2_lng)
    where marks_list is a list of dicts with NAME, LAT, LON (for SL1, SL2, MK1); sl1/sl2 are
    coordinates or None if not found.

    When the API returns multiple time-stamped entries, the entry used is the one closest to
    the data time looking back (i.e. entry_ts <= reference_ts, maximum such entry_ts).
    If reference_ts is None or no entry is at or before reference_ts, the latest entry is used.
    """
    sl1_lat, sl1_lng = None, None
    sl2_lat, sl2_lng = None, None
    marks_list = []
    date_str = str(date).replace("-", "") if hasattr(date, "replace") else str(date)
    try:
        # Prefer markwind, fallback to marks (same as frontend RaceCourseLayer)
        for obj_name in ("markwind", "marks"):
            url = ":8069/api/projects/object?class_name={}&project_id={}&date={}&object_name={}".format(
                class_name, project_id, date_str, obj_name
            )
            res = u.get_api_data(api_token, url)
            if not res or not res.get("success") or not res.get("data"):
                continue
            data = res["data"]
            if hasattr(data, "get"):
                val = data.get("value", data)
            else:
                val = data
            if isinstance(val, str):
                val = json.loads(val)
            if not isinstance(val, list) or len(val) == 0:
                continue
            # val is list of { DATETIME?, MARKS: [ { NAME, LAT, LON }, ... ] }
            entries_with_ts = []
            for entry in val:
                mar = entry.get("MARKS") if isinstance(entry, dict) else None
                if not mar:
                    continue
                entry_ts = _entry_timestamp(entry)
                entries_with_ts.append((entry_ts, entry))
            if not entries_with_ts:
                continue
            # Choose entry closest to reference time, looking back only (entry_ts <= reference_ts, max such)
            if reference_ts is not None and not (isinstance(reference_ts, float) and np.isnan(reference_ts)):
                at_or_before = [(t, e) for t, e in entries_with_ts if t is not None and t <= reference_ts]
                if at_or_before:
                    chosen = max(at_or_before, key=lambda x: x[0])
                else:
                    chosen = max((x for x in entries_with_ts if x[0] is not None), key=lambda x: x[0], default=entries_with_ts[0])
            else:
                chosen = max((x for x in entries_with_ts if x[0] is not None), key=lambda x: x[0], default=entries_with_ts[0])
            entry = chosen[1]
            mar = entry.get("MARKS") if isinstance(entry, dict) else []
            for mark in mar:
                if not isinstance(mark, dict):
                    continue
                name = (mark.get("NAME") or mark.get("POSITION") or "").strip().upper()
                try:
                    lat = float(mark.get("LAT", mark.get("lat")))
                    lon = float(mark.get("LON", mark.get("lon")))
                except (TypeError, ValueError):
                    continue
                if name in MARK_NAMES:
                    marks_list.append({"NAME": name, "LAT": lat, "LON": lon})
                    if name == "SL1":
                        sl1_lat, sl1_lng = lat, lon
                    elif name == "SL2":
                        sl2_lat, sl2_lng = lat, lon
            if marks_list or (sl1_lat is not None and sl1_lng is not None):
                break
    except Exception as e:
        u.log(api_token, "prestart.py", "warn", "get_marks_and_sl1", str(e))
    return marks_list, sl1_lat, sl1_lng, sl2_lat, sl2_lng


def _bearing_sl1_to_sl2_deg(sl1_lat, sl1_lng, sl2_lat, sl2_lng):
    """
    Bearing (degrees from North, 0–360) from SL1 to SL2. Returns None if invalid.
    Used to define the gate line through M1: same direction as the start line SL1–SL2.
    """
    if (sl1_lat is None or sl1_lng is None or sl2_lat is None or sl2_lng is None or
            not np.isfinite(sl1_lat) or not np.isfinite(sl1_lng) or
            not np.isfinite(sl2_lat) or not np.isfinite(sl2_lng)):
        return None
    seg = u.latlng_to_meters(float(sl1_lat), float(sl1_lng), float(sl2_lat), float(sl2_lng))
    if not seg or len(seg) < 2:
        return None
    dx, dy = seg[0], seg[1]
    if dx * dx + dy * dy < 1e-12:
        return None
    # Bearing from North: atan2(east, north) = atan2(dx, dy)
    bearing_rad = m.atan2(dx, dy)
    bearing_deg = (m.degrees(bearing_rad) + 360.0) % 360.0
    return float(bearing_deg)


def _distance_to_line_through_m1(lat, lng, m1_lat, m1_lng, bearing_deg):
    """
    Signed distance (meters) of a point from the infinite line through M1
    in the given bearing (degrees from North). Used to detect when a boat crosses
    the line; crossing = sign change. (Line is conceptually extended e.g. 10km each side.)
    """
    xy = u.latlng_to_meters(m1_lat, m1_lng, lat, lng)
    if not xy or len(xy) < 2:
        return None
    bx, by = xy[0], xy[1]
    rad = m.radians(bearing_deg)
    # Line direction = (sin(bearing), cos(bearing)); normal = (-cos, sin)
    return -bx * m.cos(rad) + by * m.sin(rad)


def _cross_track_distance_m(lat, lng, m1_lat, m1_lng, course_axis_deg):
    """
    Signed distance to the line through M1 with bearing course_axis_deg + 90°
    (yellow/gate line). Crossing when sign changes.
    """
    gate_bearing = (course_axis_deg + 90) % 360
    return _distance_to_line_through_m1(lat, lng, m1_lat, m1_lng, gate_bearing)


def _along_track_distance_m(lat, lng, m1_lat, m1_lng, course_axis_deg):
    """
    Signed distance to the line through M1 with bearing course_axis_deg
    (red line along course). Crossing when sign changes.
    """
    return _distance_to_line_through_m1(lat, lng, m1_lat, m1_lng, course_axis_deg)


def _signed_distance_to_start_line_m(lat_p, lng_p, sl1_lat, sl1_lng, sl2_lat, sl2_lng, m1_lat=None, m1_lng=None):
    """
    Signed distance (m) of point (lat_p, lng_p) to the start line (infinite line through SL1–SL2).
    Negative = before start side, positive = after start side (direction of mark 1).
    When M1 is provided, the sign is oriented so the half-plane containing M1 is positive.
    Returns None if line coords invalid.
    """
    if (sl1_lat is None or sl1_lng is None or sl2_lat is None or sl2_lng is None or
            not np.isfinite(sl1_lat) or not np.isfinite(sl1_lng) or
            not np.isfinite(sl2_lat) or not np.isfinite(sl2_lng) or
            not np.isfinite(lat_p) or not np.isfinite(lng_p)):
        return None
    bearing = _bearing_sl1_to_sl2_deg(sl1_lat, sl1_lng, sl2_lat, sl2_lng)
    if bearing is None:
        return None
    d = _distance_to_line_through_m1(lat_p, lng_p, sl1_lat, sl1_lng, bearing)
    if d is None:
        return None
    if m1_lat is not None and m1_lng is not None and np.isfinite(m1_lat) and np.isfinite(m1_lng):
        d_m1 = _distance_to_line_through_m1(m1_lat, m1_lng, sl1_lat, sl1_lng, bearing)
        if d_m1 is not None and d_m1 < 0:
            d = -d
    return float(d)


def _distance_point_to_segment_m(lat_p, lng_p, sl1_lat, sl1_lng, sl2_lat, sl2_lng):
    """
    Distance (m) from point (lat_p, lng_p) to the closest point on the line segment
    between SL1 (sl1_lat, sl1_lng) and SL2 (sl2_lat, sl2_lng). Returns None if
    coordinates are invalid or conversion fails.
    """
    if (sl1_lat is None or sl1_lng is None or sl2_lat is None or sl2_lng is None or
            not np.isfinite(sl1_lat) or not np.isfinite(sl1_lng) or
            not np.isfinite(sl2_lat) or not np.isfinite(sl2_lng) or
            not np.isfinite(lat_p) or not np.isfinite(lng_p)):
        return None
    # Vectors from SL1 to SL2 and from SL1 to P (meters)
    seg = u.latlng_to_meters(float(sl1_lat), float(sl1_lng), float(sl2_lat), float(sl2_lng))
    pt = u.latlng_to_meters(float(sl1_lat), float(sl1_lng), float(lat_p), float(lng_p))
    if not seg or len(seg) < 2 or not pt or len(pt) < 2:
        return None
    bx, by = seg[0], seg[1]
    px, py = pt[0], pt[1]
    denom = bx * bx + by * by
    if denom < 1e-12:
        return m.sqrt(px * px + py * py)
    t = (px * bx + py * by) / denom
    t = max(0.0, min(1.0, t))
    cx, cy = t * bx, t * by
    return m.sqrt((px - cx) ** 2 + (py - cy) ** 2)


def _project_point_onto_segment_t(lat_p, lng_p, sl1_lat, sl1_lng, sl2_lat, sl2_lng):
    """
    Parameter t (0 = SL1, 1 = SL2) of the projection of point (lat_p, lng_p) onto the
    infinite line through SL1–SL2. Returns None if invalid. Used to check if a crossing
    lies between the marks (0 <= t <= 1).
    """
    if (sl1_lat is None or sl1_lng is None or sl2_lat is None or sl2_lng is None or
            not np.isfinite(sl1_lat) or not np.isfinite(sl1_lng) or
            not np.isfinite(sl2_lat) or not np.isfinite(sl2_lng) or
            not np.isfinite(lat_p) or not np.isfinite(lng_p)):
        return None
    seg = u.latlng_to_meters(float(sl1_lat), float(sl1_lng), float(sl2_lat), float(sl2_lng))
    pt = u.latlng_to_meters(float(sl1_lat), float(sl1_lng), float(lat_p), float(lng_p))
    if not seg or len(seg) < 2 or not pt or len(pt) < 2:
        return None
    bx, by = seg[0], seg[1]
    px, py = pt[0], pt[1]
    denom = bx * bx + by * by
    if denom < 1e-12:
        return None
    t = (px * bx + py * by) / denom
    return float(t)


# Seconds after start within which the boat must cross the start line (SL1–SL2) to count for ranking
START_LINE_CROSSING_WINDOW_S = 30


def _get_start_line_crossing_time_from_dfm(dfm, sl1_lat, sl1_lng, sl2_lat, sl2_lng):
    """
    Return the time (sec from race start) when this boat first crosses the start line
    (segment between SL1 and SL2) within START_LINE_CROSSING_WINDOW_S seconds of the start.
    Uses sign change of signed distance to the line; crossing must lie between the marks
    (projection parameter t in [0, 1]). Returns None if marks invalid, no crossing in [0, 30],
    or crossing is not between SL1 and SL2.
    """
    if dfm is None or len(dfm) == 0:
        return None
    if (sl1_lat is None or sl1_lng is None or sl2_lat is None or sl2_lng is None or
            not np.isfinite(sl1_lat) or not np.isfinite(sl1_lng) or
            not np.isfinite(sl2_lat) or not np.isfinite(sl2_lng)):
        return None
    bearing = _bearing_sl1_to_sl2_deg(sl1_lat, sl1_lng, sl2_lat, sl2_lng)
    if bearing is None:
        return None
    if 'sec' not in dfm.columns or 'Lat_dd' not in dfm.columns or 'Lng_dd' not in dfm.columns:
        return None
    # Include points just before start to get initial side; consider crossings only in [0, window]
    window = START_LINE_CROSSING_WINDOW_S
    mask = (dfm['sec'] >= -5) & (dfm['sec'] <= window)
    subset = dfm.loc[mask].copy()
    subset = subset.sort_values('sec').reset_index(drop=True)
    if len(subset) < 2:
        return None
    prev_dist = None
    for i in range(len(subset)):
        row = subset.iloc[i]
        sec = row['sec']
        if sec < 0:
            lat = row['Lat_dd']
            lng = row['Lng_dd']
            if np.isfinite(lat) and np.isfinite(lng):
                d = _distance_to_line_through_m1(lat, lng, sl1_lat, sl1_lng, bearing)
                if d is not None:
                    prev_dist = d
            continue
        if sec > window:
            break
        lat = row['Lat_dd']
        lng = row['Lng_dd']
        if not (np.isfinite(lat) and np.isfinite(lng) and np.isfinite(sec)):
            continue
        d = _distance_to_line_through_m1(lat, lng, sl1_lat, sl1_lng, bearing)
        if d is None:
            continue
        if prev_dist is not None and (prev_dist > 0) != (d > 0):
            prev_row = subset.iloc[i - 1]
            prev_sec = prev_row['sec']
            prev_lat = prev_row['Lat_dd']
            prev_lng = prev_row['Lng_dd']
            if not (np.isfinite(prev_sec) and np.isfinite(prev_lat) and np.isfinite(prev_lng)):
                prev_dist = d
                continue
            denom = abs(prev_dist) + abs(d)
            if denom < 1e-12:
                cross_sec = (prev_sec + sec) / 2.0
                cross_lat = (prev_lat + lat) / 2.0
                cross_lng = (prev_lng + lng) / 2.0
            else:
                frac = abs(prev_dist) / denom
                cross_sec = prev_sec + (sec - prev_sec) * frac
                cross_lat = prev_lat + (lat - prev_lat) * frac
                cross_lng = prev_lng + (lng - prev_lng) * frac
            t = _project_point_onto_segment_t(cross_lat, cross_lng, sl1_lat, sl1_lng, sl2_lat, sl2_lng)
            if t is not None and 0.0 <= t <= 1.0:
                return float(cross_sec)
        prev_dist = d
    return None


def rank_points_by_wind(coords, wind_direction_deg):
    """
    Rank lat/lng coordinates by how aligned they are with the wind direction.

    coords: list of (lat, lng) tuples
    wind_direction_deg: direction wind is blowing toward, in degrees (0° = North, 90° = East)

    Returns: list of (lat, lng, score) sorted from most upwind (lowest score)
             to most downwind (highest score).
    """
    theta = m.radians(wind_direction_deg)
    wind_vec = (m.sin(theta), m.cos(theta))  # x = east, y = north

    ranked = []
    for lat, lng in coords:
        point_vec = (lng, lat)
        score = point_vec[0] * wind_vec[0] + point_vec[1] * wind_vec[1]
        ranked.append((lat, lng, score))

    ranked.sort(key=lambda x: x[2])
    return ranked

def get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'ts', 'type': 'float'},
            {'name': 'TIME_RACE_s', 'type': 'float'},
            {'name': 'TIME_TC_START_s', 'type': 'float'},
            {'name': 'Course_axis_deg', 'type': 'float'},
            {'name': 'TRK_RACE_RANK_unk', 'type': 'float'},
            {'name': 'PC_DTO_m', 'type': 'float'},
            {'name': 'PC_DTL_m', 'type': 'float'},
            {'name': 'PC_TTK_s', 'type': 'float'},
            {'name': 'PC_START_RATIO_unk', 'type': 'float'},
            {'name': 'PC_START_LINE_PER_pct', 'type': 'float'},

            {'name': 'Lat_dd', 'type': 'float'},
            {'name': 'Lng_dd', 'type': 'float'},

            # Corrected wind (fused and per-sensor)
            {'name': 'Tws_cor_kph', 'type': 'float'},
            {'name': 'Twd_cor_deg', 'type': 'angle360'},
            {'name': 'Twa_cor_deg', 'type': 'angle180'},
            {'name': 'Twa_n_cor_deg', 'type': 'angle180'},
            {'name': 'Cwa_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_BowWand_TWD_cor_deg', 'type': 'angle360'},
            {'name': 'AC40_TWA_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_TWA_n_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_CWA_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_BowWand_TWS_cor_kts', 'type': 'float'},
            {'name': 'Hdg_deg', 'type': 'angle360'},
            {'name': 'Bsp_kts', 'type': 'float'},
            {'name': 'Polar_perc', 'type': 'float'},
            {'name': 'Pitch_deg', 'type': 'float'},
            {'name': 'Heel_n_deg', 'type': 'float'},
            {'name': 'Accel_rate_mps2', 'type': 'float'},
            {'name': 'RH_lwd_mm', 'type': 'float'},
            # Fallback channels (used when _cor_ values are missing)
            {'name': 'Tws_kph', 'type': 'float'},
            {'name': 'Twd_deg', 'type': 'angle360'},
            {'name': 'Twa_deg', 'type': 'angle180'},
            {'name': 'Twa_n_deg', 'type': 'angle180'},
            {'name': 'Cwa_deg', 'type': 'angle180'},

            {'name': 'RUD_rake_ang_deg', 'type': 'float'},
            {'name': 'RUD_diff_ang_deg', 'type': 'float'},
            {'name': 'DB_rake_ang_lwd_deg', 'type': 'float'},
            {'name': 'DB_cant_lwd_deg', 'type': 'float'},
            {'name': 'DB_cant_eff_lwd_deg', 'type': 'float'},

            {'name': 'CA1_ang_n_deg', 'type': 'float'},
            {'name': 'WING_twist_n_deg', 'type': 'float'},
            {'name': 'WING_clew_pos_n_mm', 'type': 'float'},
            {'name': 'JIB_sheet_load_kgf', 'type': 'float'},
            {'name': 'JIB_cunno_load_kgf', 'type': 'float'},
            {'name': 'JIB_lead_ang_deg', 'type': 'float'},

            {'name': 'Leg_number', 'type': 'int'},
            {'name': 'Wing_code', 'type': 'string'},
            {'name': 'Headsail_code', 'type': 'string'},
            {'name': 'Daggerboard_code', 'type': 'string'},
            {'name': 'Rudder_code', 'type': 'string'},
            {'name': 'Config_code', 'type': 'string'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '100ms', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            apply_ac40_fusion_legacy_names(dfi)
            # Rename corrected (_cor) channels to standard names. If a corrected column exists,
            # drop the standard column first (to avoid duplicate names), then rename. Otherwise keep standard as fallback.
            cor_to_standard = {
                'Tws_cor_kph': 'Tws_kph',
                'Twd_cor_deg': 'Twd_deg',
                'Twa_cor_deg': 'Twa_deg',
                'Twa_n_cor_deg': 'Twa_n_deg',
                'Cwa_cor_deg': 'Cwa_deg',
            }
            for cor_name, std_name in cor_to_standard.items():
                if cor_name in dfi.columns:
                    if std_name in dfi.columns:
                        dfi.drop(columns=[std_name], inplace=True)
                    dfi.rename(columns={cor_name: std_name}, inplace=True)

            kts_to_kph = 1.852
            if 'Tws_cor_kts' in dfi.columns:
                if 'Tws_kph' in dfi.columns:
                    dfi.drop(columns=['Tws_kph'], inplace=True)
                dfi['Tws_kph'] = pd.to_numeric(
                    dfi['Tws_cor_kts'], errors='coerce'
                ) * kts_to_kph
            if 'Tws_kph' in dfi.columns:
                dfi['Tws_kts'] = dfi['Tws_kph'] * 0.539957
            if 'Cwa_deg' not in dfi.columns and 'Twa_deg' in dfi.columns:
                dfi['Cwa_deg'] = dfi['Twa_deg']

            return dfi
        else:
            return df
    except Exception as e:
        u.log(api_token, "prestart.py", "error", "Error occurred while retrieving data!", e)
        return df
    
def _get_race_number_from_tags(tags):
    """Extract Race_number from event tags (dict or JSON string). Returns None if not found."""
    if tags is None:
        return None
    if isinstance(tags, str):
        try:
            tags = json.loads(tags)
        except (TypeError, ValueError):
            return None
    if not isinstance(tags, dict):
        return None
    race = tags.get("Race_number") or (tags.get("RACES") or {}).get("Race_number")
    if race is not None:
        return str(race).strip()
    return None


def _get_gate_crossing_time_from_dfm(dfm, m1_lat, m1_lng, sl1_lat, sl1_lng, sl2_lat, sl2_lng):
    """
    Return the time (sec from race start) when this boat first crosses the gate line:
    the line through M1 with the same direction as the start line SL1–SL2 (i.e. SL1–SL2
    translated so it passes through M1). Uses sign change of signed distance to that line;
    crossing time is interpolated between the two samples where the sign changes.
    Returns None if marks invalid, no post-start data, or no crossing in window.
    """
    if dfm is None or len(dfm) == 0:
        return None
    if m1_lat is None or m1_lng is None:
        return None
    if not np.isfinite(m1_lat) or not np.isfinite(m1_lng):
        return None
    gate_bearing = _bearing_sl1_to_sl2_deg(sl1_lat, sl1_lng, sl2_lat, sl2_lng)
    if gate_bearing is None:
        return None
    if 'sec' not in dfm.columns or 'Lat_dd' not in dfm.columns or 'Lng_dd' not in dfm.columns:
        return None
    post_start = dfm.loc[dfm['sec'] > 0].copy()
    if len(post_start) < 2:
        return None
    post_start = post_start.sort_values('sec').reset_index(drop=True)
    prev_dist = None
    for i in range(len(post_start)):
        row = post_start.iloc[i]
        lat = row['Lat_dd']
        lng = row['Lng_dd']
        sec = row['sec']
        if not (np.isfinite(lat) and np.isfinite(lng) and np.isfinite(sec)):
            continue
        d = _distance_to_line_through_m1(lat, lng, m1_lat, m1_lng, gate_bearing)
        if d is None:
            continue
        if prev_dist is not None and (prev_dist > 0) != (d > 0):
            # Sign change: crossing between prev and this row; interpolate time
            prev_row = post_start.iloc[i - 1]
            prev_sec = prev_row['sec']
            if np.isfinite(prev_sec):
                denom = abs(prev_dist) + abs(d)
                if denom > 1e-12:
                    frac = abs(prev_dist) / denom
                    t_cross = prev_sec + (sec - prev_sec) * frac
                    return float(t_cross)
                return float((prev_sec + sec) / 2.0)
        prev_dist = d
    return None


def _get_leg1_time_from_dfm(dfm):
    """
    Return the estimated leg 1 end time (sec from race start): the midpoint between the
    last sample with Leg_number == 1 and the first with Leg_number != 1. This avoids
    biasing the duration too long when the transition is detected one sample late.

    Returns None if no transition in window or Leg_number is missing/invalid.
    """
    if dfm is None or len(dfm) == 0:
        return None
    if 'sec' not in dfm.columns or 'Leg_number' not in dfm.columns:
        return None
    post_start = dfm.loc[dfm['sec'] > 0].copy()
    if len(post_start) == 0:
        return None
    # Ensure numeric for comparison (e.g. in case of category)
    leg = post_start['Leg_number']
    try:
        leg = pd.to_numeric(leg, errors='coerce')
    except (TypeError, ValueError):
        return None
    post_start = post_start.sort_values('sec')
    last_leg1 = post_start.loc[leg == 1]
    not_leg1 = post_start.loc[leg != 1]
    if len(not_leg1) == 0:
        return None
    first_not_sec = not_leg1.iloc[0]['sec']
    if not np.isfinite(first_not_sec):
        return None
    if len(last_leg1) > 0:
        last_leg1_sec = last_leg1.iloc[-1]['sec']
        if np.isfinite(last_leg1_sec):
            # Midpoint between last leg1 and first not-leg1 = better estimate of crossing time
            return float((last_leg1_sec + first_not_sec) / 2.0)
    return float(first_not_sec)


def _get_race_course_axis(api_token, class_name, project_id, date_str, race_number):
    """
    Fetch a single course axis for the race from prestart-summary so all boats use the same
    rotation for map output (avoids misalignment from per-event course_axis).
    Returns float or None if unavailable.
    """
    if not race_number or not date_str:
        return None
    date_norm = str(date_str).replace("-", "") if hasattr(date_str, "replace") else str(date_str)
    if len(date_norm) != 8:
        return None
    try:
        url = ":8069/api/data/prestart-summary?class_name={}&project_id={}&date={}&race={}&view=prestart".format(
            class_name, project_id, date_norm, race_number
        )
        res = u.get_api_data(api_token, url)
        if not res.get("success") or not res.get("data"):
            return None
        data = res["data"]
        rows = data.get("rows") if isinstance(data, dict) else None
        if not rows or len(rows) == 0:
            return None
        first = rows[0]
        course_axis = first.get("Course_axis") if isinstance(first, dict) else None
        if course_axis is not None and (isinstance(course_axis, (int, float)) and not (isinstance(course_axis, bool))):
            return float(course_axis)
        return None
    except Exception as e:
        u.log(api_token, "prestart.py", "warn", "get_race_course_axis", str(e))
        return None


def start(api_token, project_id, dataset_id, class_name, date, source_name, verbose, map_data_reference_ts=None):
    event_type = 'PRESTART'

    res = u.get_api_data(api_token, ":8069/api/events/info?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id)+"&event_type="+str(event_type)+"&timezone=UTC")

    try:
        if res["success"]:
            json_data = res["data"]
            # Reference time for marks: use time of actual start so mark snapshot matches boat positions.
            # Use earliest prestart period end_time (first crossing / gun time); fallback to map_data_reference_ts or first period.
            # If we use RACE event start_time (e.g. race window start) marks can be from the wrong snapshot and appear offset from tracks.
            reference_ts = map_data_reference_ts
            if json_data:
                period_end_timestamps = []
                for p in json_data:
                    if not isinstance(p, dict):
                        continue
                    et = p.get("end_time")
                    if et:
                        ts = u.get_timestamp_from_str(str(et), force_utc=True)
                        if ts is not None and not (isinstance(ts, float) and np.isnan(ts)):
                            period_end_timestamps.append(float(ts))
                if period_end_timestamps:
                    reference_ts = min(period_end_timestamps)
            if reference_ts is None and json_data:
                first_period = json_data[0]
                end_time = first_period.get("end_time") if isinstance(first_period, dict) else None
                if end_time:
                    reference_ts = u.get_timestamp_from_str(end_time, force_utc=True)

            # Single course axis for the race so all boats align on the map (avoids per-event rotation mismatch)
            race_course_axis = None
            if json_data and len(json_data) > 0:
                first_period = json_data[0]
                tags = first_period.get("tags") if isinstance(first_period, dict) else None
                race_number = _get_race_number_from_tags(tags)
                if race_number:
                    race_course_axis = _get_race_course_axis(api_token, class_name, project_id, date, race_number)

            # Initial marks check only (full fetch is per-period so each start gets marks at its own time)
            _check_marks, _sl1, _sl2, _, _ = get_marks_and_sl1(api_token, class_name, project_id, date, reference_ts=reference_ts)
            if not _check_marks and (_sl1 is None or _sl2 is None):
                u.log(api_token, "prestart.py", "warn", "Prestart skipped", "No mark information available for this project/date; cannot compute prestarts.")
                if verbose:
                    print("Prestart skipped: no mark information available.", flush=True)
                return True

            processed_count = 0

            # First pass: for each start (climax_ts), collect gate-crossing times from ALL boats;
            # leg1 time for that start = time when the first boat crosses the M1 gate line (yellow line).
            leg1_by_climax = defaultdict(list)
            date_norm = str(date or "").replace("-", "").replace("/", "") if hasattr(date, "replace") else str(date or "").replace("-", "").replace("/", "")
            try:
                resp = u.get_api_data(api_token, ":8069/api/datasets/date/datasets_with_duration?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&date=" + str(date_norm))
                datasets_for_date = []
                if resp and resp.get("success") and isinstance(resp.get("data"), list):
                    for r in resp["data"]:
                        d_id = r.get("dataset_id")
                        src = r.get("source_name")
                        if d_id is not None and src:
                            datasets_for_date.append((d_id, src))
            except Exception as e:
                u.log(api_token, "prestart.py", "warn", "datasets_for_date", str(e))
                datasets_for_date = [(dataset_id, source_name)]
            for d_id, src_name in datasets_for_date:
                prestart_res = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&dataset_id=" + str(d_id) + "&event_type=PRESTART&timezone=UTC")
                if not prestart_res or not prestart_res.get("success") or not isinstance(prestart_res.get("data"), list):
                    continue
                for period in prestart_res["data"]:
                    if not isinstance(period, dict):
                        continue
                    climax_ts = u.get_timestamp_from_str(period.get("end_time"), force_utc=True)
                    if climax_ts is None or (isinstance(climax_ts, float) and np.isnan(climax_ts)):
                        continue
                    dfn = get_data(api_token, project_id, class_name, date, src_name, climax_ts - 120, climax_ts + 120)
                    if len(dfn) == 0:
                        continue
                    dfn = dfn.loc[(dfn["ts"] >= climax_ts - 120) & (dfn["ts"] <= climax_ts + 120)].copy()
                    dfn.sort_values(by=["ts"], inplace=True, ascending=True)
                    if len(dfn) == 0:
                        continue
                    dfm_pass = dfn.copy()
                    if "Leg_number" in dfm_pass.columns:
                        dfm_pass["Leg_number"] = pd.to_numeric(dfm_pass["Leg_number"], errors="coerce").fillna(1)
                    u.UpdateManeuverSeconds(dfm_pass, climax_ts)
                    marks_list, sl1_lat, sl1_lng, sl2_lat, sl2_lng = get_marks_and_sl1(api_token, class_name, project_id, date, reference_ts=climax_ts)
                    m1_lat, m1_lng = None, None
                    for mark in (marks_list or []):
                        name = (mark.get("NAME") or mark.get("Name") or "").strip().upper()
                        if name in ("M1", "MK1"):
                            m1_lat = mark.get("LAT", mark.get("lat"))
                            m1_lng = mark.get("LON", mark.get("lon"))
                            break
                    t = _get_gate_crossing_time_from_dfm(dfm_pass, m1_lat, m1_lng, sl1_lat, sl1_lng, sl2_lat, sl2_lng)
                    if t is not None:
                        leg1_by_climax[climax_ts].append(t)
            # Per start: leg1 time = first boat across the gate (min of crossing times); use actual time, no 20–90s clamp
            leg1_time_per_climax = {}
            for climax_ts, times in leg1_by_climax.items():
                if times:
                    first_boat_time = min(times)
                    # Use raw crossing time; only reject clearly invalid (e.g. < 5s or > 120s) and fall back to default
                    if first_boat_time < 5.0 or first_boat_time > 120.0:
                        leg1_time_per_climax[climax_ts] = LEG1_DEFAULT_S
                        if verbose:
                            u.log(api_token, "prestart.py", "warn", "leg1 time (gate crossing out of range)", f"Start {climax_ts}: first boat at {first_boat_time:.1f}s, using default {LEG1_DEFAULT_S}s")
                    else:
                        leg1_time_per_climax[climax_ts] = first_boat_time
                    if verbose and leg1_time_per_climax[climax_ts] == first_boat_time:
                        u.log(api_token, "prestart.py", "info", "leg1 time (first boat across M1)", f"Start {climax_ts}: leg1_time={leg1_time_per_climax[climax_ts]:.1f}s from {len(times)} boats")
                else:
                    leg1_time_per_climax[climax_ts] = LEG1_DEFAULT_S
                    if verbose:
                        u.log(api_token, "prestart.py", "warn", "leg1 time fallback", f"Start {climax_ts}: no gate crossings; using default {LEG1_DEFAULT_S}s")

            for period in json_data: 
                event_id = period['event_id']

                climax_ts = u.get_timestamp_from_str(period['end_time'], force_utc=True)
                # Per start: leg1 time = first boat across M1 gate; reach time derived from it
                leg1_time = leg1_time_per_climax.get(climax_ts, LEG1_DEFAULT_S)
                reach_time = leg1_time * REACH_TO_LEG1_RATIO
                # Rounded to nearest 5s for map and timeseries (stats use exact values)
                reach_time_rounded = round(reach_time / REACH_LEG1_ROUND_S) * REACH_LEG1_ROUND_S
                leg1_time_rounded = round(leg1_time / REACH_LEG1_ROUND_S) * REACH_LEG1_ROUND_S

                dfn = get_data(api_token, project_id, class_name, date, source_name, climax_ts - 120, climax_ts + 120)
                
                if len(dfn) > 0:
                    # Use PRESTART end_time as race start for all boats; trim and filter by timestamp only.
                    # TRIM DATAFRAME TO ROUGH DIMENSIONS (copy to avoid SettingWithCopyWarning on sort)
                    # Fixed 120 s before/after climax so prestart stats and map use a consistent 2 min window.
                    dfn = dfn.loc[(dfn['ts'] >= climax_ts - 120) & (dfn['ts'] <= climax_ts + 120)].copy()
                    dfn.sort_values(by=['ts'], inplace=True, ascending=True)

                    if len(dfn) > 0:
                        # Window defined by prestart end_time (climax_ts), not TIME_RACE_s / Race_number / Leg_number
                        dfm = dfn.copy()

                        # Fetch marks at this period's start time so each start gets the correct mark snapshot
                        marks_list, sl1_lat, sl1_lng, sl2_lat, sl2_lng = get_marks_and_sl1(
                            api_token, class_name, project_id, date, reference_ts=climax_ts
                        )
                        m1_lat, m1_lng = None, None
                        for mark in (marks_list or []):
                            name = (mark.get("NAME") or mark.get("Name") or "").strip().upper()
                            if name in ("M1", "MK1"):
                                m1_lat = mark.get("LAT", mark.get("lat"))
                                m1_lng = mark.get("LON", mark.get("lon"))
                                break
                        if not marks_list and (sl1_lat is None or sl1_lng is None):
                            u.log(api_token, "prestart.py", "warn", "Prestart period skipped", f"No marks for event_id {event_id} at climax_ts {climax_ts}; skipping.")
                            continue

                        # Convert categorical columns to regular columns to avoid errors when setting values
                        # Define string columns that should never be converted to numeric
                        string_columns = ['Wing_code', 'Headsail_code', 'Daggerboard_code', 'Rudder_code', 'Config_code', 'Name']
                        categorical_cols = dfm.select_dtypes(include=['category']).columns
                        for col in categorical_cols:
                            # If this is a string column, convert directly to string without trying numeric conversion
                            if col in string_columns:
                                dfm[col] = dfm[col].astype(str)
                            else:
                                # Try to convert to numeric first, otherwise convert to string
                                try:
                                    dfm[col] = pd.to_numeric(dfm[col], errors='coerce')
                                    # Fill any NaN values created by conversion with 0
                                    dfm[col] = dfm[col].fillna(0)
                                except (ValueError, TypeError):
                                    # If conversion fails, convert to string
                                    dfm[col] = dfm[col].astype(str)

                        # COMPUTE SECONDS FROM ORIGIN
                        u.UpdateManeuverSeconds(dfm, climax_ts)

                        # Only fill NaN in numeric columns to avoid categorical column errors
                        numeric_cols = dfm.select_dtypes(include=[np.number]).columns
                        dfm[numeric_cols] = dfm[numeric_cols].fillna(0)
                        dfm['note'] = ""
                        dfm['note'] = dfm['note'].astype(object)  # allow string labels e.g. 'max accel', 'max bsp'

                        # CALCILATE PRESTART INFO
                        prestart_df = dfm.loc[dfm['sec'] < 0]
                        if prestart_df.empty:
                            u.log(api_token, "prestart.py", "warn", "Prestart period skipped", f"No prestart data (sec < 0) for event_id {event_id}; skipping.")
                            continue

                        tws_avg = prestart_df['Tws_kts'].mean()

                        # --- MIN TWA ---
                        min_twa = prestart_df['Twa_n_deg'].min()
                        min_group = prestart_df.loc[prestart_df['Twa_n_deg'] == min_twa]

                        # pick the sec closest to zero (i.e., max sec because sec < 0)
                        if min_group.empty:
                            u.log(api_token, "prestart.py", "warn", "Prestart period skipped", f"No valid Twa_n_deg for min at event_id {event_id}; skipping.")
                            continue
                        min_twa_time = min_group.loc[min_group['sec'].idxmax(), 'sec']

                        # --- MAX TWA ---
                        max_twa = prestart_df['Twa_n_deg'].max()
                        max_group = prestart_df.loc[prestart_df['Twa_n_deg'] == max_twa]

                        if max_group.empty:
                            u.log(api_token, "prestart.py", "warn", "Prestart period skipped", f"No valid Twa_n_deg for max at event_id {event_id}; skipping.")
                            continue
                        max_twa_time = max_group.loc[max_group['sec'].idxmax(), 'sec']

                        time_turnback = -999
                        if min_twa < 5 and max_twa < 175: #TACK
                            time_turnback = min_twa_time - 5
                        elif min_twa > 5 and max_twa > 175: #GYBE
                            time_turnback = max_twa_time - 5
                        elif min_twa < 5 and max_twa > 175: #CIRCLE
                            time_turnback = max(min_twa_time, max_twa_time) - 5

                        prestart_df = prestart_df.loc[(prestart_df['sec'] >= time_turnback) & (prestart_df['sec'] <= 0)]
                        turnback = prestart_df.iloc[0] 

                        prestart_df = prestart_df.loc[(prestart_df['sec'] >= time_turnback + 10) & (prestart_df['sec'] <= 0)]
                        turnback_exit = prestart_df.iloc[0] 
                        
                        bsp_min = prestart_df['Bsp_kts'].min()
                        dfc = prestart_df.loc[prestart_df['Bsp_kts'] == bsp_min]
                        time_bsp_min = dfc['sec'].iloc[0]

                        bsp_avg_pre = prestart_df['Bsp_kts'].mean()
                        ttk_turnback = turnback['PC_TTK_s']
                        dto_turnback = turnback['PC_DTO_m']
                        dtl_turnback = turnback['PC_DTL_m']
                        ratio_turnback = turnback['PC_START_RATIO_unk']

                        ttk_turnback_exit = turnback_exit['PC_TTK_s']
                        ttk_burn = ttk_turnback - ttk_turnback_exit

                        # CALCULATE START INFO
                        start = prestart_df.iloc[-1]
                        bsp_start = start['Bsp_kts']
                        twa_start = start['Twa_n_deg']
                        ttk_start = start['PC_TTK_s']
                        dto_start = start['PC_DTO_m']
                        dtl_start = start['PC_DTL_m']
                        line_perc_start = start['PC_START_LINE_PER_pct']
                        course_axis = start['Course_axis_deg']

                        # Signed distance (m) from start line at last position in (0, 10)s: negative = before start,
                        # positive = after start (direction of mark 1). Ranking: most positive = 1, smallest = last.
                        dist_0_10_df = dfm.loc[(dfm['sec'] > 0) & (dfm['sec'] < 10)].sort_values('sec')
                        prestart_dist = -999
                        if not dist_0_10_df.empty:
                            last_row = dist_0_10_df.iloc[-1]
                            d_m = _signed_distance_to_start_line_m(
                                last_row['Lat_dd'], last_row['Lng_dd'],
                                sl1_lat, sl1_lng, sl2_lat, sl2_lng,
                                m1_lat, m1_lng
                            )
                            prestart_dist = round(d_m, 2) if d_m is not None else -999
                        bsp_avg_start = dist_0_10_df['Bsp_kts'].mean() if not dist_0_10_df.empty else -999

                        # Distance sailed (m) in TIME_RACE_s in (0, reach_time); reach_time from leg1 (first boat across M1)
                        dist_reach_df = dfm.loc[(dfm['sec'] > 0) & (dfm['sec'] < reach_time)].sort_values('sec')
                        distance_sailed = -999

                        # Single distance: last point (at ~reach_time) to closest point on start line SL1–SL2
                        if not dist_reach_df.empty:
                            last_row = dist_reach_df.iloc[-1]
                            d_m = _distance_point_to_segment_m(
                                last_row['Lat_dd'], last_row['Lng_dd'],
                                sl1_lat, sl1_lng, sl2_lat, sl2_lng
                            )
                            distance_sailed = round(d_m, 2) if d_m is not None else -999

                        reach_dist = distance_sailed 
                        bsp_avg_reach = dist_reach_df['Bsp_kts'].mean()

                        # Distance sailed (m) in TIME_RACE_s in (0, leg1_time); leg1_time = first boat across M1 gate
                        dist_leg1_df = dfm.loc[(dfm['sec'] > 0) & (dfm['sec'] < leg1_time)].sort_values('sec')
                        distance_sailed = -999

                        # Single distance: last point (at ~leg1_time) to closest point on start line SL1–SL2
                        if not dist_leg1_df.empty:
                            last_row = dist_leg1_df.iloc[-1]
                            d_m = _distance_point_to_segment_m(
                                last_row['Lat_dd'], last_row['Lng_dd'],
                                sl1_lat, sl1_lng, sl2_lat, sl2_lng
                            )
                            distance_sailed = round(d_m, 2) if d_m is not None else -999

                        leg1_dist = distance_sailed 
                        bsp_avg_leg1 = dist_leg1_df['Bsp_kts'].mean()

                        # CALCULATE TTC
                        ttc_df = dfm.loc[(dfm['sec'] >= -10) & (dfm['sec'] <= 30) & (dfm['TIME_TC_START_s'] != 0)]
                        if not ttc_df.empty:
                            ttc = ttc_df.iloc[0] 
                            ttc_start = ttc['TIME_TC_START_s']
                        else:
                            ttc_start = -999

                        # Window for accel/bsp: up to leg1 time (first boat across M1 line)
                        reach_valid = reach_time != -999 and np.isfinite(reach_time)
                        leg1_window_end = leg1_time if (np.isfinite(leg1_time) and leg1_time > 0) else (reach_time if reach_valid else 30)

                        # CALCULATE ACCELERATION INFO (ACCEL_PRESTART_S before start to leg1 crossing)
                        accel_df = dfm.loc[(dfm['sec'] >= -ACCEL_PRESTART_S) & (dfm['sec'] <= leg1_window_end)]
                        accel_max = accel_df['Accel_rate_mps2'].max()

                        dfc = accel_df.loc[accel_df['Accel_rate_mps2'] == accel_max]

                        if not dfc.empty:
                            accel_max_time = dfc['sec'].iloc[0]
                            bs_accmax = dfc['Bsp_kts'].iloc[0]
                            twa_accmax = dfc['Twa_deg'].iloc[0]
                            cant_accmax = dfc['DB_cant_lwd_deg'].iloc[0]
                            cant_eff_accmax = dfc['DB_cant_eff_lwd_deg'].iloc[0]
                            pitch_accmax = dfc['Pitch_deg'].iloc[0]
                            heel_accmax = dfc['Heel_n_deg'].iloc[0]
                            rh_lwd_accmax = dfc['RH_lwd_mm'].iloc[0]
                            Jib_sheet_load_accmax = dfc['JIB_sheet_load_kgf'].iloc[0]
                            jib_lead_ang_accmax = dfc['JIB_lead_ang_deg'].iloc[0]
                            jib_cunno_load_accmax = dfc['JIB_cunno_load_kgf'].iloc[0]
                            wing_clew_pos_accmax = dfc['WING_clew_pos_n_mm'].iloc[0]
                            wing_twist_accmax = dfc['WING_twist_n_deg'].iloc[0]
                            ca1_accmax = dfc['CA1_ang_n_deg'].iloc[0]
                            dfm.loc[dfc.index, 'note'] = 'max accel'
                        else:
                            accel_max_time = -999
                            bs_accmax = -999
                            twa_accmax = -999
                            cant_accmax = -999
                            cant_eff_accmax = -999
                            pitch_accmax = -999
                            heel_accmax = -999
                            rh_lwd_accmax = -999
                            Jib_sheet_load_accmax = -999
                            jib_lead_ang_accmax = -999
                            jib_cunno_load_accmax = -999
                            wing_clew_pos_accmax = -999
                            wing_twist_accmax = -999
                            ca1_accmax = -999

                        # CALCULATE BSP MAX INFO (within leg1 time window: turnback to first-boat gate crossing)
                        if reach_valid:
                            bsp_df = dfm.loc[(dfm['sec'] >= time_turnback) & (dfm['sec'] <= leg1_window_end)]
                        else:
                            bsp_df = dfm.loc[(dfm['sec'] >= time_turnback) & (dfm['sec'] <= leg1_window_end)] if (np.isfinite(leg1_window_end) and leg1_window_end > 0) else dfm.loc[(dfm['sec'] >= time_turnback)]
                        bsp_max = bsp_df['Bsp_kts'].max()

                        dfc = bsp_df.loc[bsp_df['Bsp_kts'] == bsp_max]

                        if not dfc.empty:
                            bsp_max_time = dfc['sec'].iloc[0]
                            twa_bspmax = dfc['Twa_deg'].iloc[0]
                            cant_bspmax= dfc['DB_cant_lwd_deg'].iloc[0]
                            cant_eff_bspmax = dfc['DB_cant_eff_lwd_deg'].iloc[0]
                            pitch_bspmax = dfc['Pitch_deg'].iloc[0]
                            heel_bspmax = dfc['Heel_n_deg'].iloc[0]
                            rh_lwd_bspmax = dfc['RH_lwd_mm'].iloc[0]
                            Jib_sheet_load_bspmax= dfc['JIB_sheet_load_kgf'].iloc[0]
                            jib_lead_ang_bspmax = dfc['JIB_lead_ang_deg'].iloc[0]
                            jib_cunno_load_bspmax = dfc['JIB_cunno_load_kgf'].iloc[0]
                            wing_clew_pos_bspmax = dfc['WING_clew_pos_n_mm'].iloc[0]
                            wing_twist_bspmax = dfc['WING_twist_n_deg'].iloc[0]
                            ca1_bspmax = dfc['CA1_ang_n_deg'].iloc[0]
                            dfm.loc[dfc.index, 'note'] = 'max bsp'
                        else:
                            bsp_max_time = -999
                            bsp_max = -999
                            twa_bspmax = -999
                            cant_bspmax= -999
                            cant_eff_bspmax = -999
                            pitch_bspmax = -999
                            heel_bspmax = -999
                            rh_lwd_bspmax = -999
                            Jib_sheet_load_bspmax = -999
                            jib_lead_ang_bspmax = -999
                            jib_cunno_load_bspmax = -999
                            wing_clew_pos_bspmax = -999
                            wing_twist_bspmax = -999
                            ca1_bspmax = -999

                        info = {}
                        info["Tws_avg"] = round(tws_avg * 1.852, 2)
                        info["Tws_bin"] = u.get_even_integer(tws_avg * 1.852)
                        info["Prestart_dist"] = round(prestart_dist, 1) if prestart_dist != -999 else -999
                        info["Bsp_avg_pre"] = round(bsp_avg_pre * 1.852, 1) if bsp_avg_pre != -999 else -999
                        info["Bsp_avg_start"] = round(bsp_avg_start * 1.852, 1) if bsp_avg_start != -999 else -999
                        info["Course_axis"] = round(course_axis, 2)
                        info["Time_bspmin"] = round(time_bsp_min, 1)
                        info["Bsp_min"] = round(bsp_min * 1.852, 2)
                        info["Reach_time"] = int(reach_time) if reach_time != -999 else -999
                        info["Reach_dist"] = round(reach_dist, 1) if reach_dist != -999 else -999
                        info["Bsp_avg_reach"] = round(bsp_avg_reach * 1.852, 1) if bsp_avg_reach != -999 else -999
                        info["Leg1_time"] = int(leg1_time) if leg1_time != -999 else -999
                        info["Leg1_dist"] = round(leg1_dist, 2) if leg1_dist != -999 else -999
                        info["Bsp_avg_leg1"] = round(bsp_avg_leg1 * 1.852, 2) if bsp_avg_leg1 != -999 else -999
                        info["Time_turnback"] = round(time_turnback, 2) if time_turnback != -999 else -999
                        info["DTO_turnback"] = round(dto_turnback, 2)
                        info["DTL_turnback"] = round(dtl_turnback, 2)
                        info["TTK_turnback"] = round(ttk_turnback, 2)
                        info["TTK_burn"] = round(ttk_burn, 2)
                        info["RATIO_turnback"] = round(ratio_turnback, 2)
                        info["Bsp_avg_pre"] = round(bsp_avg_pre * 1.852, 2)
                        info["TTC_start"] = round(ttc_start, 2) if ttc_start != -999 else -999
                        info["DTO_start"] = round(dto_start, 2)
                        info["DTL_start"] = round(dtl_start, 2)
                        info["TTK_start"] = round(ttk_start, 2)
                        info["LINE_PERC_start"] = round(line_perc_start, 2)
                        info["Bsp_start"] = round(bsp_start * 1.852, 2)
                        info["Twa_start"] = round(twa_start, 2)
                        info["Time_accmax"] = round(accel_max_time, 1)
                        info["Accel_max"] = round(accel_max, 1)
                        info["Bsp_accmax"] = round(bs_accmax * 1.852, 2)
                        info["Twa_accmax"] = round(twa_accmax, 2)
                        info["Heel_accmax"] = round(heel_accmax, 2)
                        info["Pitch_accmax"] = round(pitch_accmax, 2)
                        info["RH_lwd_accmax"] = round(rh_lwd_accmax, 2)
                        info["Cant_accmax"] = round(cant_accmax, 2)
                        info["Cant_eff_accmax"] = round(cant_eff_accmax, 2)
                        info["Jib_sheet_load_accmax"] = round(Jib_sheet_load_accmax, 2)
                        info["Jib_cunno_load_accmax"] = round(jib_cunno_load_accmax, 2)
                        info["Jib_lead_ang_accmax"] = round(jib_lead_ang_accmax, 2)
                        info["Wing_twist_accmax"] = round(wing_twist_accmax, 2)
                        info["Wing_clew_pos_accmax"] = round(wing_clew_pos_accmax, 2)
                        info["CA1_accmax"] = round(ca1_accmax, 2)
                        info["Time_bspmax"] = round(bsp_max_time, 1)
                        info["Bsp_max"] = round(bsp_max * 1.852, 2) if bsp_max != -999 else -999
                        info["Twa_bspmax"] = round(twa_bspmax, 2)
                        info["Heel_bspmax"] = round(heel_bspmax, 2)
                        info["Pitch_bspmax"] = round(pitch_bspmax, 2)
                        info["RH_lwd_bspmax"] = round(rh_lwd_bspmax, 2)
                        info["Cant_bspmax"] = round(cant_bspmax, 2)
                        info["Cant_eff_bspmax"] = round(cant_eff_bspmax, 2)
                        info["Jib_sheet_load_bspmax"] = round(Jib_sheet_load_bspmax, 2)
                        info["Jib_cunno_load_bspmax"] = round(jib_cunno_load_bspmax, 2)
                        info["Jib_lead_ang_bspmax"] = round(jib_lead_ang_bspmax, 2)
                        info["Wing_twist_bspmax"] = round(wing_twist_bspmax, 2)
                        info["Wing_clew_pos_bspmax"] = round(wing_clew_pos_bspmax, 2)
                        info["CA1_bspmax"] = round(ca1_bspmax, 2)

                        #CLEAN INFO (REMOVE NANs)
                        for k,v in info.items():
                            if pd.isna(v):
                                info[k] = 0
                                
                        info_str = json.dumps(info)

                        jsondata = {}
                        jsondata["class_name"] = str(class_name)
                        jsondata["project_id"] = int(project_id)
                        jsondata["table"] = str("start_stats")
                        jsondata["event_id"] = str(event_id)
                        jsondata["agr_type"] = str('NONE')
                        jsondata["json"] = info_str

                        res = u.post_api_data(api_token, ":8059/api/events/row", jsondata)

                        # Use race-level course axis for map so all boats align; fallback to per-event course_axis
                        map_twd = race_course_axis if race_course_axis is not None else course_axis

                        # Run map data and time series data operations in parallel.
                        # Index 1: max accel, max bsp, reach modes (pre-start through reach, rounded).
                        # Index 2: leg 1 mode only (0 to leg1, rounded).
                        with ThreadPoolExecutor(max_workers=8) as executor:
                            futures = []
                            futures.append(executor.submit(addMapData, dfm, event_id, '0', climax_ts, -60, 10, map_twd, api_token, class_name, project_id, date, sl1_lat, sl1_lng, marks_list))
                            futures.append(executor.submit(addMapData, dfm, event_id, '1', climax_ts, -ACCEL_PRESTART_S, reach_time_rounded, map_twd, api_token, class_name, project_id, date, sl1_lat, sl1_lng, marks_list))
                            futures.append(executor.submit(addMapData, dfm, event_id, '2', climax_ts, 0, leg1_time_rounded, map_twd, api_token, class_name, project_id, date, sl1_lat, sl1_lng, marks_list))
                            
                            futures.append(executor.submit(addTimeSeriesData, 'Basics', dfm, event_id, '0', climax_ts, -60, 10, api_token, class_name, project_id))
                            futures.append(executor.submit(addTimeSeriesData, 'Details', dfm, event_id, '1', climax_ts, -ACCEL_PRESTART_S, reach_time_rounded, api_token, class_name, project_id))
                            futures.append(executor.submit(addTimeSeriesData, 'Details', dfm, event_id, '2', climax_ts, 0, leg1_time_rounded, api_token, class_name, project_id))
                            
                            # Wait for all tasks to complete and handle any exceptions
                            for future in as_completed(futures):
                                try:
                                    future.result()  # This will raise any exceptions that occurred
                                except Exception as e:
                                    u.log(api_token, "prestart.py", "error", "Pre-start stats Failed! Error in parallel execution", e)
                                    print(f"Error in parallel execution: {e}", flush=True)
                                    raise  # Re-raise to be caught by outer exception handler

                        processed_count += 1

        # Log summary
        summary_msg = f"Processed {processed_count} prestarts successfully!"
        u.log(api_token, "prestart.py", "info", "Prestart processing summary", summary_msg)
        if verbose:
            print(summary_msg, flush=True)

        return True                   
    except Exception as e:
        error_msg = f"Error processing prestart at {climax_ts}: {str(e)}"
        u.log(api_token, "prestart.py", "error", "Prestart processing failed", error_msg)
        if verbose:
            print(f"Failed to process prestart {climax_ts}: {e}", flush=True)
        import traceback
        u.log(api_token, "prestart.py", "error", "Prestart processing traceback", traceback.format_exc())
           
def addMapData(df, event_id, desc, mnvr_time, start_sec, stop_sec, twd, api_token, class_name, project_id, date=None, sl1_lat=None, sl1_lng=None, marks_list=None):
    if hasattr(mnvr_time, 'timestamp'):
        start_ts = (mnvr_time + u.td(seconds=start_sec)).timestamp()
        end_ts = (mnvr_time + u.td(seconds=stop_sec)).timestamp()
    else:
        start_ts = float(mnvr_time) + start_sec
        end_ts = float(mnvr_time) + stop_sec

    dff = df.loc[(df['ts'] >= start_ts) & (df['ts'] <= end_ts)].copy()
    
    # Check if DataFrame is empty
    if dff.empty:
        u.log(api_token, "prestart.py", "warn", "addMapData", f"No data found for event_id {event_id} in time range {start_ts} to {end_ts}")
        return

    # Only fill NaN in numeric columns to avoid categorical column errors
    numeric_cols = dff.select_dtypes(include=[np.number]).columns
    dff[numeric_cols] = dff[numeric_cols].fillna(0)

    # Local origin for computing relative position and rotation (SL1 or first point). Output uses fixed
    # origin (originlat, originlon) so all boats are in the same global frame, matching other maneuvers.
    if sl1_lat is not None and sl1_lng is not None and np.isfinite(sl1_lat) and np.isfinite(sl1_lng):
        lat0 = float(sl1_lat)
        lng0 = float(sl1_lng)
    else:
        u.log(api_token, "prestart.py", "warn", "addMapData", f"event_id {event_id} desc {desc}: no SL1, using first track point as local origin")
        lat0 = dff.iloc[0]['Lat_dd']
        lng0 = dff.iloc[0]['Lng_dd']
    xy0 = u.latlng_to_meters(lat0, lng0, lat0, lng0)
    x0 = xy0[0]
    y0 = xy0[1]

    # BUILD OUTPUT JSON
    dataoutput_n = {}
    dataoutput_n["event_id"] = str(event_id)

    items_n = []

    rotation = twd
    
    scounter = 0
    start_twa = None
    for index, row in dff.iterrows():
        if start_twa == None:
            start_twa = row['Twa_deg']

        if (scounter == 0 or scounter == 5):
            seconds = row['sec']
            lat = row['Lat_dd']
            lng = row['Lng_dd']
            hdg = row['Hdg_deg']
            twa = row['Twa_deg']
            note = row['note']

            # Convert to meters relative to rotation center (SL1 or first point)
            xy = u.latlng_to_meters(lat0, lng0, lat, lng)
            x = xy[0]
            y = xy[1]
            xT = x - x0
            yT = y - y0

            # Rotate so TWD is north (around rotation center)
            xR = (m.cos(m.radians(rotation)) * xT) - (m.sin(m.radians(rotation)) * yT)
            yR = (m.sin(m.radians(rotation)) * xT) + (m.cos(m.radians(rotation)) * yT)
            hdgR = u.angle360_normalize(u.angle_subtract(hdg, twd))
            if not np.isfinite(hdgR):
                hdgR = 0.0

            # Convert back to lat/lng using fixed origin (pass yR,xR for correct lat/lng per geo_utils convention)
            latlng = u.meters_to_latlng(originlat, originlon, yR, xR)
            latR = latlng[0]
            lngR = latlng[1]

            item = {}
            item["time"] = str(round(float(seconds), 2))
            item["lat"] = str(round(float(latR), 6))
            item["lng"] = str(round(float(lngR), 6))
            item["twa"] = str(round(float(twa), 2)) if np.isfinite(twa) else "0.0"
            item["hdg"] = str(round(float(hdgR), 2))
            item["note"] = str(note)

            items_n.append(item)
            scounter = 0
            
        scounter += 1

    # Ensure 'max bsp' and 'max accel' points are always included (they may have been skipped by sampling)
    times_in_output = {round(float(it.get("time", 0)), 2) for it in items_n}
    for index, row in dff.iterrows():
        note_val = row.get("note", "")
        if note_val not in ("max bsp", "max accel"):
            continue
        seconds = row["sec"]
        t_key = round(float(seconds), 2)
        if t_key in times_in_output:
            continue
        lat = row["Lat_dd"]
        lng = row["Lng_dd"]
        hdg = row["Hdg_deg"]
        twa = row["Twa_deg"]
        xy = u.latlng_to_meters(lat0, lng0, lat, lng)
        xT = xy[0] - x0
        yT = xy[1] - y0
        xR = (m.cos(m.radians(rotation)) * xT) - (m.sin(m.radians(rotation)) * yT)
        yR = (m.sin(m.radians(rotation)) * xT) + (m.cos(m.radians(rotation)) * yT)
        hdgR = u.angle360_normalize(u.angle_subtract(hdg, twd))
        if not np.isfinite(hdgR):
            hdgR = 0.0
        latlng = u.meters_to_latlng(originlat, originlon, yR, xR)
        latR, lngR = latlng[0], latlng[1]
        item = {
            "time": str(round(float(seconds), 2)),
            "lat": str(round(float(latR), 6)),
            "lng": str(round(float(lngR), 6)),
            "twa": str(round(float(twa), 2)) if np.isfinite(twa) else "0.0",
            "hdg": str(round(float(hdgR), 2)),
            "note": str(note_val),
        }
        items_n.append(item)
        times_in_output.add(t_key)

    items_n.sort(key=lambda it: float(it.get("time", 0)))
    dataoutput_n["values"] = items_n

    # Rotated marks (SL1, SL2, M1 only) in same frame as track for prestart report map
    if marks_list:
        rotated_marks = []
        for mark in marks_list:
            name = (mark.get("NAME") or mark.get("POSITION") or "").strip().upper()
            if name not in MARK_NAMES:
                continue
            try:
                m_lat = float(mark.get("LAT", mark.get("lat")))
                m_lng = float(mark.get("LON", mark.get("lon", mark.get("lng"))))
            except (TypeError, ValueError):
                continue
            if not (np.isfinite(m_lat) and np.isfinite(m_lng)):
                continue
            xy = u.latlng_to_meters(lat0, lng0, m_lat, m_lng)
            xT = xy[0] - x0
            yT = xy[1] - y0
            xR = (m.cos(m.radians(rotation)) * xT) - (m.sin(m.radians(rotation)) * yT)
            yR = (m.sin(m.radians(rotation)) * xT) + (m.cos(m.radians(rotation)) * yT)
            latlng = u.meters_to_latlng(originlat, originlon, yR, xR)
            latR, lngR = round(float(latlng[0]), 6), round(float(latlng[1]), 6)
            rotated_marks.append({"name": name, "NAME": name, "lat": latR, "lng": lngR, "LAT": latR, "LON": lngR})
        if rotated_marks:
            dataoutput_n["marks"] = rotated_marks

    #INSERT NORMALIZED MAP DATA
    output_str = json.dumps(dataoutput_n)
    jsondata = {"class_name": class_name,"project_id": project_id, "event_id": event_id, "table": "events_mapdata", "desc": desc+"_prestart", "json": str(output_str)}
    res = u.post_api_data(api_token, ":8059/api/events/object", jsondata)
    
    if (res['success'] == False):
        u.log(api_token, "prestart.py", "warning", "Map Type "+desc+" Failed!", "")
        print("Map Type "+desc+" Failed!", flush=True)

def addTimeSeriesData(type, df, event_id, desc, mnvr_time, start_sec, stop_sec, api_token, class_name, project_id):
    # DO TIMESERIES
    dataoutput = {}
    dataoutput["event_id"] = str(event_id)
    items = []

    if hasattr(mnvr_time, 'timestamp'):
        start_ts = (mnvr_time + u.td(seconds=start_sec)).timestamp()
        end_ts = (mnvr_time + u.td(seconds=stop_sec)).timestamp()
        mnvr_ts = mnvr_time.timestamp()
    else:
        mnvr_ts = float(mnvr_time)
        start_ts = mnvr_ts + start_sec
        end_ts = mnvr_ts + stop_sec

    dfc = df.loc[(df['ts'] >= start_ts) & (df['ts'] <= end_ts)].copy()

    for index, row in dfc.iterrows():
        second = u.number(row['sec'])
        twa = u.number(row['Twa_deg'])

        ttk = u.number(row['PC_TTK_s'])
        bs = u.number(row['Bsp_kts'])
        polar = u.number(row['Polar_perc'])
        pitch = u.number(row['Pitch_deg'])
        heel = u.number(row['Heel_n_deg'])
        accel = u.number(row['Accel_rate_mps2'])
        rh_lwd = u.number(row['RH_lwd_mm']) 
        rud_rake = u.number(row['RUD_rake_ang_deg'])
        rud_diff = u.number(row['RUD_diff_ang_deg'])
        db_rake_lwd = u.number(row['DB_rake_ang_lwd_deg'])
        db_cant_lwd = u.number(row['DB_cant_lwd_deg'])
        db_cant_eff_lwd = u.number(row['DB_cant_eff_lwd_deg'])
        camber1 = u.number(row['CA1_ang_n_deg'])
        twist = u.number(row['WING_twist_n_deg'])
        clew = u.number(row['WING_clew_pos_n_mm'])
        jib_sheet_load = u.number(row['JIB_sheet_load_kgf'])
        jib_cunno = u.number(row['JIB_cunno_load_kgf']) 
        jib_lead = u.number(row['JIB_lead_ang_deg'])
        
        if (type == 'Basics'):
            item = {}
            item["time"] = round(float(second), 2)
            item["ttk_s"] = round(float(ttk), 2)
            item["bsp_kph"] = round(float(bs), 2) * 1.852
            item["polar_perc"] = round(float(polar), 2)
            item["twa_n_deg"] = round(abs(float(twa)), 2)
            item["heel_n_deg"] = round(float(heel), 2)
            item["accel_rate_mps2"] = round(float(accel), 2)
            item["rh_lwd_mm"] = round(float(rh_lwd), 2)

            items.append(item)
        else:
            item = {}
            item["time"] = round(float(second), 2)
            item["bsp_kph"] = round(float(bs), 2) * 1.852
            item["polar_perc"] = round(float(polar), 2)
            item["twa_n_deg"] = round(abs(float(twa)), 2)
            item["heel_n_deg"] = round(float(heel), 2)
            item["pitch_deg"] = round(float(pitch), 2)
            item["accel_rate_mps2"] = round(float(accel), 2)
            item["rh_lwd_mm"] = round(float(rh_lwd), 2)
            item["rud_rake_ang_deg"] = round(float(rud_rake), 2)
            item["rud_diff_ang_deg"] = round(float(rud_diff), 2)
            item["db_rake_lwd_deg"] = round(float(db_rake_lwd), 2)
            item["db_cant_lwd_deg"] = round(float(db_cant_lwd), 2)
            item["db_cant_eff_lwd_deg"] = round(float(db_cant_eff_lwd), 2)
            item["wing_camber1_n_deg"] = round(float(camber1), 2)
            item["wing_total_twist_deg"] = round(float(twist), 2)
            item["wing_clew_position_mm"] = round(float(clew), 2) 
            item["jib_sheet_load_kgf"] = round(float(jib_sheet_load), 2)  
            item["jib_cunno_load_kgf"] = round(float(jib_cunno), 2)
            item["jib_lead_ang_deg"] = round(float(jib_lead), 2)

            items.append(item)

    if (type == 'Basics'):
        charts = ['ttk_s', 'bsp_kph', 'polar_perc', 'twa_n_deg', 'accel_rate_mps2',  'heel_n_deg', 'rh_lwd_mm']
    else:
        charts = ['bsp_kph', 'polar_perc', 'twa_n_deg', 'accel_rate_mps2', 'heel_n_deg', 'pitch_deg', 'rh_lwd_mm','rud_rake_ang_deg','rud_diff_ang_deg','db_rake_lwd_deg','db_cant_lwd_deg','db_cant_eff_lwd_deg','wing_camber1_n_deg','wing_total_twist_deg','wing_clew_position_mm','jib_sheet_load_kgf','jib_cunno_load_kgf','jib_lead_ang_deg']

    dataoutput["charts"] = charts
    dataoutput["values"] = items
    output_str = json.dumps(dataoutput)

    #INSERT DATA
    if len(output_str) > 50: 
        jsondata = {"class_name": class_name,"project_id": project_id, "event_id": event_id, "table": "events_timeseries", "desc": desc+"_"+type, "json": str(output_str)}
        res = u.post_api_data(api_token, ":8059/api/events/object", jsondata)

        if (res['success'] == False):
            u.log(api_token, "prestart.py", "warning", "Time Series "+desc+" Failed!", "")
            print("Time Series "+desc+" Failed!", flush=True)