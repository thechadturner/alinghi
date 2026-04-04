import numpy as np
import pandas as pd
import json
import utilities as u

# Earth radius in km for haversine
_EARTH_RADIUS_KM = 6371.0

def _haversine_km(lat1, lon1, lat2, lon2):
    """Return distance in km between (lat1, lon1) and (lat2, lon2). Accepts scalars or arrays."""
    lat1, lon1, lat2, lon2 = np.atleast_1d(lat1, lon1, lat2, lon2)
    lat1 = np.radians(lat1)
    lon1 = np.radians(lon1)
    lat2 = np.radians(lat2)
    lon2 = np.radians(lon2)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return _EARTH_RADIUS_KM * c


def _remove_position_outliers(df, radius_km=30, grid_deg=0.02):
    """
    Keep only points within radius_km of the densest region (grid cell with highest point count).
    Returns filtered dataframe and the number of points removed (for logging).
    """
    if df is None or len(df) == 0:
        return df, 0
    n_before = len(df)
    lat = df["Lat_dd"].astype(float)
    lon = df["Lng_dd"].astype(float)
    # Grid ~grid_deg degrees (~2.2 km per 0.02 deg at mid-latitudes)
    glat = (np.floor(lat / grid_deg) * grid_deg + grid_deg / 2).values
    glon = (np.floor(lon / grid_deg) * grid_deg + grid_deg / 2).values
    counts = pd.DataFrame({"glat": glat, "glon": glon}).groupby(["glat", "glon"]).size()
    if len(counts) == 0:
        return df, 0
    best_cell = counts.idxmax()
    in_best = (glat == best_cell[0]) & (glon == best_cell[1])
    center_lat = float(np.mean(lat.values[in_best]))
    center_lon = float(np.mean(lon.values[in_best]))
    dist_km = _haversine_km(lat.values, lon.values, center_lat, center_lon)
    mask = dist_km <= radius_km
    df_out = df.loc[mask].copy()
    n_removed = n_before - len(df_out)
    return df_out, n_removed


def get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'ts', 'type': 'float'},
            {'name': 'AC40_Latitude', 'type': 'float'},
            {'name': 'AC40_Longitude', 'type': 'float'},
            {'name': 'AC40_BowWand_TWS_kts', 'type': 'float'},
            {'name': 'AC40_BowWand_TWD', 'type': 'angle360'},
            {'name': 'AC40_HDG', 'type': 'angle360'},
            {'name': 'AC40_Speed_kts', 'type': 'float'},
            {'name': 'AC40_Tgt_Speed_kts', 'type': 'float'},
            {'name': 'AC40_TWA', 'type': 'angle180'},
            {'name': 'AC40_VMG_kts', 'type': 'float'},
            {'name': 'AC40_VMG_pc', 'type': 'float'},
            {'name': 'Foiling_state', 'type': 'int'},
            {'name': 'Race_number', 'type': 'int'},
            {'name': 'Leg_number', 'type': 'int'},
            {'name': 'Grade', 'type': 'int'},
            {'name': 'Phase_id', 'type': 'int'},
            {'name': 'Period_id', 'type': 'int'},
            {'name': 'Headsail_code', 'type': 'string'},
            {'name': 'Crew_count', 'type': 'int'},
            {'name': 'Maneuver_type', 'type': 'string'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '1s', start_ts, end_ts, 'UTC')

        print((list(dfi.columns)))
        if dfi is not None and len(dfi) > 0:
            dfi.rename(
                columns={
                    'AC40_Latitude': 'Lat_dd',
                    'AC40_Longitude': 'Lng_dd',
                    'AC40_BowWand_TWS_kts': 'Tws_kts',
                    'AC40_BowWand_TWD': 'Twd_deg',
                    'AC40_HDG': 'Hdg_deg',
                    'AC40_Speed_kts': 'Bsp_kts',
                    'AC40_Tgt_Speed_kts': 'Bsp_tgt_kts',
                    'AC40_TWA': 'Twa_deg',
                    'AC40_TWA_n': 'Twa_n_deg',
                    'AC40_VMG_kts': 'Vmg_kts',
                    'AC40_VMG_pc': 'Vmg_perc'
                },
                inplace=True,
            )

            dfi['Bsp_perc'] = (dfi['Bsp_kts'] / dfi['Bsp_tgt_kts']) * 100
            dfi['Vmg_perc'] = dfi['Vmg_perc'] * 100

            print(len(dfi),'records returned...', flush=True)

            df = u.remove_gaps(dfi,'Bsp_kts','ts')
            return df
        else:
            return df
    except Exception as e:
        print(f"Error retrieving data: {str(e)}", flush=True)
        return df

def start(api_token, project_id, dataset_id, class_name, date, source_name, start_time, end_time, verbose):
    success = False

    try:

        if start_time == None:
            start_time = None
            start_ts = None
        elif len(start_time) == 0:
            start_time = None
            start_ts = None
        else:
            start_ts = u.get_timestamp_from_str(start_time, True)

        if end_time == None:
            end_time = None
            end_ts = None
        elif len(end_time) == 0:
            end_time = None
            end_ts = None
        else:
            end_ts = u.get_timestamp_from_str(end_time, True)
        
        if api_token and len(api_token) > 0 and project_id is not None and int(project_id) > 0 and dataset_id is not None and int(dataset_id) > 0 and class_name and len(class_name) > 0:
            # Get the actual processed range from the DATASET event
            # This ensures we use the same range that 2_processing.py actually processed
            # (which may have been trimmed to ensure start/end have Bsp_kts > 4)
            dataset_event = None
            res = u.get_api_data(api_token, ":8069/api/events/info?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id)+"&event_type=DATASET&timezone=UTC")
            
            if (res and res.get("success") and "data" in res and len(res["data"]) > 0):
                dataset_event = res["data"][0]
                # Use the processed start_time and end_time from the DATASET event
                processed_start_time = dataset_event.get('start_time')
                processed_end_time = dataset_event.get('end_time')
                
                if processed_start_time and processed_end_time:
                    if verbose:
                        print(f'Using processed range from DATASET event: {processed_start_time} to {processed_end_time}', flush=True)
                    # Convert to timestamps for data retrieval
                    start_ts = u.get_timestamp_from_str(processed_start_time, True)
                    end_ts = u.get_timestamp_from_str(processed_end_time, True)
                    u.log(api_token, "Map.py", "info", "using processed range", f"Using DATASET event range: {processed_start_time} to {processed_end_time}")
                else:
                    if verbose:
                        print('Warning: DATASET event found but missing start_time/end_time, using provided parameters', flush=True)
                    u.log(api_token, "Map.py", "warning", "DATASET event missing times", "Using original start_time/end_time parameters")
            else:
                if verbose:
                    print('Warning: DATASET event not found, using provided start_time/end_time parameters', flush=True)
                u.log(api_token, "Map.py", "warning", "DATASET event not found", "Using original start_time/end_time parameters")
                # If we have a valid range, create the DATASET event so we can save map data (event_id required)
                if start_ts is not None and end_ts is not None:
                    try:
                        start_dt = u.get_utc_datetime_from_ts(start_ts)
                        end_dt = u.get_utc_datetime_from_ts(end_ts)
                        start_str = u.format_timestamp(start_dt)
                        end_str = u.format_timestamp(end_dt)
                        jsondata = {
                            "class_name": class_name, "project_id": project_id, "dataset_id": dataset_id,
                            "event_type": "DATASET", "start_time": start_str, "end_time": end_str, "tags": "{}"
                        }
                        create_res = u.post_api_data(api_token, ":8059/api/events", jsondata)
                        if create_res and create_res.get("success") and create_res.get("data"):
                            # data may be the new event or event_id; re-query to get full event with event_id
                            res = u.get_api_data(api_token, ":8069/api/events/info?class_name=" + str(class_name) + "&project_id=" + str(project_id) + "&dataset_id=" + str(dataset_id) + "&event_type=DATASET&timezone=UTC")
                            if (res and res.get("success") and "data" in res and len(res["data"]) > 0):
                                dataset_event = res["data"][0]
                                if verbose:
                                    print('Created DATASET event and retrieved event_id', flush=True)
                        elif verbose and create_res:
                            print(f'DATASET event create failed: {create_res.get("message", "unknown")}', flush=True)
                    except Exception as e:
                        if verbose:
                            print(f'Could not create DATASET event: {e}', flush=True)

            if verbose:
                print('Retrieving map data...', flush=True)

            df = get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts)

            if len(df) > 0:
                if verbose:
                    print('Processing dataset records...', flush=True)

                df = df.loc[(abs(df['Lat_dd']) > 1) & (abs(df['Lng_dd']) > 1)]

                # Remove points > 30km from the densest region (outlier check)
                df, n_outliers = _remove_position_outliers(df, radius_km=30)
                if n_outliers > 0:
                    if verbose:
                        print(f'Outlier check: removed {n_outliers} points > 30km from main cluster', flush=True)
                    u.log(api_token, "Map.py", "info", "map outlier filter", f"Removed {n_outliers} points > 30km from densest region")

                dataoutput = []
                for i in range(len(df) - 1):
                    try:
                        row = df.iloc[i]
                        datetime_str = str(u.get_datetime_obj(row['Datetime']))
                        lat = u.number(row['Lat_dd'])
                        lon = u.number(row['Lng_dd'])
                        bsp = u.number(row['Bsp_kts'])
                        tws = u.number(row['Tws_kts'])
                        twd = u.number(row['Twd_deg'])
                        twa = u.number(row['Twa_deg'])
                        hdg = u.number(row['Hdg_deg'])
                        vmg = abs(u.number(row['Vmg_kts']))
                        vmg_perc = u.number(row['Vmg_perc']) / 100
                        race = u.number(row['Race_number'])
                        leg = u.number(row['Leg_number'])
                        grade = u.number(row['Grade'])
                        phase = u.number(row['Phase_id'])
                        state = u.number(row['Foiling_state'])
                        mnvr = row['Maneuver_type']

                        hdg_str = str(round(hdg, 2))
                        bsp_str = str(round(bsp, 2))
                        tws_str = str(round(tws, 2))
                        twd_str = str(round(twd, 2))
                        twa_str = str(round(twa, 2))
                        lat_str = str(round(lat, 8))
                        lon_str = str(round(lon, 8))
                            
                        values = {}
                        values['Datetime'] = datetime_str
                        values['Lat_dd'] = float(lat_str)
                        values['Lng_dd'] = float(lon_str)
                        values['Bsp_kts'] = float(bsp_str)
                        values['Hdg_deg'] = float(hdg_str)
                        values['Tws_kts'] = float(tws_str)
                        values['Twd_deg'] = float(twd_str)
                        values['Twa_deg'] = float(twa_str)
                        values['Vmg_kts'] = float(vmg)
                        values['Vmg_perc'] = float(vmg_perc)
                        values['State'] = int(state)
                        values['Phase_id'] = int(phase)
                        values['Race_number'] = int(race)
                        values['Leg_number'] = int(leg)
                        values['Grade'] = int(grade)
                        values['Maneuver_type'] = mnvr

                        dataoutput.append(values)
                    except Exception as e:
                        print(f'Error processing row {i}: {str(e)}', flush=True)
                        u.log(api_token, "Map.py", "error", f"Error processing row {i}", str(e))
                        return

                df = df.loc[(df['Race_number'] > 0) | (df['Leg_number'] > 0)]
            
                if verbose:
                    print('Processing day records...', flush=True)

                dataoutput_day = []
                for i in range(len(df) - 1):
                    try:
                        row = df.iloc[i]
                        datetime_str = str(u.get_datetime_obj(row['Datetime']))
                        lat = u.number(row['Lat_dd'])
                        lon = u.number(row['Lng_dd'])
                        bsp = u.number(row['Bsp_kts'])
                        hdg = u.number(row['Hdg_deg'])
                        tws = u.number(row['Tws_kts'])
                        twd = u.number(row['Twd_deg'])
                        
                        race = u.number(row['Race_number'])
                        leg = u.number(row['Leg_number'])
                        mnvr = row['Maneuver_type']

                        hdg_str = str(round(hdg, 2))
                        bsp_str = str(round(bsp, 2))
                        lat_str = str(round(lat, 8))
                        lon_str = str(round(lon, 8))
                        tws_str = str(round(tws, 2))
                        twd_str = str(round(twd, 2))

                        values_day = {}
                        values_day['Datetime'] = datetime_str
                        values_day['Lat_dd'] = float(lat_str)
                        values_day['Lng_dd'] = float(lon_str)
                        values_day['Bsp_kts'] = float(bsp_str)
                        values_day['Hdg_deg'] = float(hdg_str)
                        values_day['Tws_kts'] = float(tws_str)
                        values_day['Twd_deg'] = float(twd_str)
                        values_day['Race_number'] = int(race)
                        values_day['Leg_number'] = int(leg)
                        values_day['Maneuver_type'] = mnvr

                        dataoutput_day.append(values_day)
                    except Exception as e:
                        print(f'Error processing row {i}: {str(e)}', flush=True)
                        u.log(api_token, "Map.py", "error", f"Error processing row {i}", str(e))
                        return
                
                # Get dataset event_id (reuse the query result from earlier)
                # We already queried for the DATASET event above to get the processed range
                # Now we need the event_id to save the map data
                if dataset_event and 'event_id' in dataset_event:
                    event_id = dataset_event['event_id']
                elif (res and res.get("success") and "data" in res and len(res["data"]) > 0):
                    event_id = res["data"][0]['event_id']
                else:
                    u.log(api_token, "Map.py", "error", "DATASET event_id not found", "Cannot save map data without event_id")
                    return success
                
                if event_id > 0:
                    json_str = json.dumps(dataoutput)
                    payload_size_mb = len(json_str) / 1024 / 1024

                    if verbose:
                        print(f'DatasetPayload size: {payload_size_mb:.2f}MB', flush=True)

                    # For very large payloads, we might need to chunk, but try full payload first
                    jsondata = {"class_name": class_name,"project_id": project_id, "event_id": event_id, "table": "events_mapdata", "desc": "dataset", "json": json_str}
                    
                    if verbose:
                        print(f'Sending {len(dataoutput)} records to database...', flush=True)
                        
                    res = u.post_api_data(api_token, ":8059/api/events/object", jsondata)

                    if verbose:
                        print(f'API Response - success: {res.get("success", False)}', flush=True)

                    if not res or "success" not in res:
                        error_msg = f"Invalid API response: {res}"
                        print(f'Invalid API response for dataset records: {error_msg}', flush=True)
                        u.log(api_token, "Map.py", "error", "Error loading Map Data", f"Invalid API response: {error_msg}")
                        return success

                    if (res["success"]):
                        if verbose:
                            print(f'Dataset records inserted/updated successfully!', flush=True)
                        jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "page_name": "MAP"}
                        res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)

                        if (res["success"]):
                            u.log(api_token, "Map.py", "info", "Map Page Loaded!", "page_name: MAP")
                            success = True
                        else:
                            error_msg = res.get("message", "Unknown error")
                            print(f'Page load failed: {error_msg}', flush=True)
                            u.log(api_token, "Map.py", "error", "Page load failed!", error_msg)
                    else:
                        error_msg = res.get("message", "Unknown error")
                        print(f'Dataset records insert/update failed: {error_msg}', flush=True)
                        u.log(api_token, "Map.py", "error", "Error loading Map Data", f"Unable to perform object insert/update: {error_msg}")
                        # Don't continue to day records if dataset insert failed
                        return success

                    json_day_str = json.dumps(dataoutput_day)
                    payload_size_mb = len(json_day_str) / 1024 / 1024

                    if verbose:
                        print(f'Day Payload size: {payload_size_mb:.2f}MB', flush=True)

                    jsondata = {"class_name": class_name,"project_id": project_id, "event_id": event_id, "table": "events_mapdata", "desc": "day", "json": json_day_str}
                    
                    if verbose:
                        print(f'Sending {len(dataoutput_day)} records to database...', flush=True)
                        
                    res = u.post_api_data(api_token, ":8059/api/events/object", jsondata)

                    if verbose:
                        print(f'API Response - success: {res.get("success", False)}', flush=True)

                    if not res or "success" not in res:
                        error_msg = f"Invalid API response: {res}"
                        print(f'Invalid API response for day records: {error_msg}', flush=True)
                        u.log(api_token, "Map.py", "error", "Error loading Map Data", f"Invalid API response for day records: {error_msg}")
                        return success

                    if (res["success"]):
                        if verbose:
                            print(f'Day records inserted/updated successfully!', flush=True)
                        success = True
                    else:
                        error_msg = res.get("message", "Unknown error")
                        print(f'Day records insert/update failed: {error_msg}', flush=True)
                        u.log(api_token, "Map.py", "error", "Error loading Map Data", f"Unable to perform day records insert/update: {error_msg}")
                else:
                    print('No dataset event found (event_id <= 0)', flush=True)
                    u.log(api_token, "Map.py", "error", "Error loading Map Data", "No dataset event found!")
            else:
                print('No data found in dataframe', flush=True)
                u.log(api_token, "Map.py", "error", "Error loading Map Data", "No data found!")
        else:
            print('Settings not initialized', flush=True)
            u.log(api_token, "Map.py", "error", "Error loading Map Data", "Settings not initialized...")

        u.log(api_token, "Map.py", "info", "Exiting Map.py...", "Done!")   

    except Exception as e:
        error_msg = f"Unexpected error in Map.py: {str(e)}"
        print(error_msg, flush=True)
        import traceback
        traceback.print_exc()
        try:
            u.log(api_token, "Map.py", "error", "Unexpected error", error_msg)
        except:
            pass  # If logging fails, at least we printed the error

    return success

# start()