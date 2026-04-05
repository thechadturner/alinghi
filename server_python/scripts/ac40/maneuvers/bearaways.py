import pandas as pd
import numpy as np
import math as m
import sys
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

import utilities as u
from utilities.ac40_channel_maps import apply_ac40_fusion_legacy_names

originlat = 39.476984
originlon = -0.291140

def get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'ts', 'type': 'float'},
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'Lat_dd', 'type': 'float'},
            {'name': 'Lng_dd', 'type': 'float'},
            
            # Corrected wind (fused and per-sensor)
            {'name': 'Tws_cor_kph', 'type': 'float'},
            {'name': 'Twd_cor_deg', 'type': 'angle360'},
            {'name': 'Twa_cor_deg', 'type': 'angle180'},
            {'name': 'Twa_n_cor_deg', 'type': 'angle180'},
            {'name': 'Cwa_cor_deg', 'type': 'angle180'},
            {'name': 'Lwy_cor_deg', 'type': 'float'},
            {'name': 'AC40_BowWand_TWD_cor_deg', 'type': 'angle360'},
            {'name': 'AC40_TWA_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_TWA_n_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_CWA_cor_deg', 'type': 'angle180'},
            {'name': 'AC40_Leeway_cor_deg', 'type': 'float'},
            {'name': 'AC40_Leeway_n_cor_deg', 'type': 'float'},
            {'name': 'AC40_BowWand_TWS_cor_kts', 'type': 'float'},
            {'name': 'Twd_bow_cor_deg', 'type': 'angle360'},
            {'name': 'Twd_mhu_cor_deg', 'type': 'angle360'},
            {'name': 'Twa_bow_cor_deg', 'type': 'angle180'},
            {'name': 'Twa_mhu_cor_deg', 'type': 'angle180'},
            {'name': 'Awa_bow_cor_deg', 'type': 'angle180'},
            {'name': 'Awa_mhu_cor_deg', 'type': 'angle180'},
            {'name': 'Aws_bow_cor_kph', 'type': 'float'},
            {'name': 'Aws_mhu_cor_kph', 'type': 'float'},
            {'name': 'Hdg_deg', 'type': 'angle360'},
            {'name': 'Cog_deg', 'type': 'angle360'},
            {'name': 'Bsp_kts', 'type': 'float'},
            {'name': 'Bsp_tgt_cor_kts', 'type': 'float'},
            {'name': 'Vmg_cor_kts', 'type': 'float'},
            {'name': 'Vmg_tgt_cor_kts', 'type': 'float'},
            {'name': 'Pitch_deg', 'type': 'float'},
            {'name': 'Heel_deg', 'type': 'float'},
            {'name': 'Heel_n_deg', 'type': 'float'},
            {'name': 'Yaw_rate_n_dps', 'type': 'float'},
            {'name': 'RH_lwd_mm', 'type': 'float'},
            {'name': 'RH_wwd_mm', 'type': 'float'},
            {'name': 'RH_port_mm', 'type': 'float'},
            {'name': 'RH_stbd_mm', 'type': 'float'},

            {'name': 'RUD_ang_deg', 'type': 'float'},
            {'name': 'RUD_rake_ang_deg', 'type': 'float'},
            {'name': 'RUD_diff_ang_deg', 'type': 'float'},
            {'name': 'RUD_imm_port_mm', 'type': 'float'},
            {'name': 'RUD_imm_stbd_mm', 'type': 'float'},
            {'name': 'DB_ext_port_mm', 'type': 'float'},
            {'name': 'DB_ext_stbd_mm', 'type': 'float'},
            {'name': 'DB_imm_port_mm', 'type': 'float'},
            {'name': 'DB_imm_stbd_mm', 'type': 'float'},
            {'name': 'DB_cant_stbd_deg', 'type': 'float'},
            {'name': 'DB_cant_port_deg', 'type': 'float'},
            {'name': 'DB_cant_eff_stbd_deg', 'type': 'float'},
            {'name': 'DB_cant_eff_port_deg', 'type': 'float'},
            {'name': 'DB_stow_state_stbd', 'type': 'float'},
            {'name': 'DB_stow_state_port', 'type': 'float'},
            {'name': 'DB_rake_ang_stbd_deg', 'type': 'float'},
            {'name': 'DB_rake_ang_port_deg', 'type': 'float'},
            {'name': 'DB_rake_aoa_stbd_deg', 'type': 'float'},
            {'name': 'DB_rake_aoa_port_deg', 'type': 'float'},

            {'name': 'CA1_ang_deg', 'type': 'float'},
            {'name': 'CA6_ang_deg', 'type': 'float'},
            {'name': 'WING_twist_deg', 'type': 'float'},
            {'name': 'WING_rot_deg', 'type': 'float'},
            {'name': 'WING_aoa_deg', 'type': 'float'},
            {'name': 'WING_clew_pos_mm', 'type': 'float'},
            {'name': 'JIB_sheet_load_kgf', 'type': 'float'},
            {'name': 'JIB_sheet_pct', 'type': 'float'},
            {'name': 'JIB_cunno_load_kgf', 'type': 'float'},
            {'name': 'JIB_lead_ang_deg', 'type': 'float'},
            {'name': 'RIG_load_tf', 'type': 'float'},

            {'name': 'ANGLE_CANT_DROP_TARG_UW_deg', 'type': 'float'},
            {'name': 'ANGLE_CANT_DROP_TARG_DW_deg', 'type': 'float'},

            {'name': 'Race_number', 'type': 'int'},
            {'name': 'Leg_number', 'type': 'int'},
            {'name': 'Wing_code', 'type': 'string'},
            {'name': 'Headsail_code', 'type': 'string'},
            {'name': 'Daggerboard_code', 'type': 'string'},
            {'name': 'Rudder_code', 'type': 'string'},
            {'name': 'Crew_count', 'type': 'int'},
            {'name': 'Config_code', 'type': 'string'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '100ms', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            apply_ac40_fusion_legacy_names(dfi)
            # Rename corrected (_cor) channels to standard names
            cor_to_standard = {
                'Tws_cor_kph': 'Tws_kph',
                'Twd_cor_deg': 'Twd_deg',
                'Twa_cor_deg': 'Twa_deg',
                'Twa_n_cor_deg': 'Twa_n_deg',
                'Cwa_cor_deg': 'Cwa_deg',
                'Lwy_cor_deg': 'Lwy_deg',
                'Lwy_n_cor_deg': 'Lwy_n_deg',
                'Twd_bow_cor_deg': 'Twd_bow_deg',
                'Twd_mhu_cor_deg': 'Twd_mhu_deg',
                'Twa_bow_cor_deg': 'Twa_bow_deg',
                'Twa_mhu_cor_deg': 'Twa_mhu_deg',
                'Awa_bow_cor_deg': 'Awa_bow_deg',
                'Awa_mhu_cor_deg': 'Awa_mhu_deg',
                'Aws_bow_cor_kph': 'Aws_bow_kph',
                'Aws_mhu_cor_kph': 'Aws_mhu_kph',
                'Vmg_cor_kph': 'Vmg_kph',
                'Vmg_tgt_cor_kts': 'Vmg_tgt_kts',
                'Bsp_tgt_cor_kts': 'Bsp_tgt_kts',
            }
            rename_map = {k: v for k, v in cor_to_standard.items() if k in dfi.columns}
            if rename_map:
                dfi.rename(columns=rename_map, inplace=True)
            kts_to_kph = 1.852
            if 'Tws_cor_kts' in dfi.columns:
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
        u.log(api_token, "bearaways.py", "error", "Error occurred while retrieving data!", e)
        return df
    
def computeLoss(df, seconds):
    if len(df) > 0 and 'vmg_baseline_kts' in df.columns:
        vmg_baseline = df['vmg_baseline_kts'].mean()
        vmg_avg = df['Vmg_n_kts'].mean() if 'Vmg_n_kts' in df.columns else 0
        vmgtgt_avg = df['Vmg_tgt_kts'].mean() if 'Vmg_tgt_kts' in df.columns else 0

        # Handle NaN values
        if pd.isna(vmg_baseline):
            vmg_baseline = 0
        if pd.isna(vmg_avg):
            vmg_avg = 0
        if pd.isna(vmgtgt_avg):
            vmgtgt_avg = 0

        vmg_baseline_meters = (vmg_baseline * u.mps) * seconds
        vmg_tgt_meters = (vmgtgt_avg * u.mps) * seconds
        vmg_avg_meters = (vmg_avg * u.mps) * seconds
        
        loss_vmg = vmg_baseline_meters - vmg_avg_meters
        loss_tgt = vmg_tgt_meters - vmg_avg_meters
    else:
        loss_vmg = -999
        loss_tgt = -999
        vmg_avg = -999

    return vmg_avg, loss_vmg, loss_tgt

def start(df, api_token, project_id, dataset_id, class_name, date, source_name, verbose, sec_before = 15, sec_after = 15):
    maneuver_list = df.loc[df['Maneuver_type'] == 'B', 'ts']

    if len(maneuver_list) > 0:
        u.log(api_token, "bearaways.py", "info", "Processing bearaways...",  str(len(maneuver_list))+" maneuvers found")

        # REMOVE EXISTING MANEUVERS
        jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "event_types": ["BEARAWAY","CHICAGO","DEANO"]}
        res = u.delete_api_data(api_token, ":8059/api/events/by_event_type", jsondata)

        processed_count = 0
        failed_count = 0

        for maneuver in maneuver_list:
            climax_ts = float(maneuver)

            try:
                climax_time = u.get_utc_datetime_from_ts(climax_ts)

                if verbose: 
                    print('Working on Bearaway:', climax_time, flush=True)

                #GET INITIAL CONSTRAINTS
                start_ts = (climax_ts - sec_before)
                end_ts =  (climax_ts + sec_after)

                # GET MANEUVER DATA
                dfn = get_data(api_token, project_id, class_name, date, source_name, start_ts - 5, end_ts + 5)

                if len(dfn) > 0:
                    # TRIM DATAFRAME TO ROUGH DIMENSIONS
                    dfi = dfn.loc[(dfn['ts'] >= start_ts - 5) & (dfn['ts'] <= end_ts + 5)].copy()
                    dfi.sort_values(by=['ts'], inplace=True, ascending=True)

                    if len(dfi) > 0:
                        # Convert categorical columns to regular columns to avoid errors when setting values
                        # Define string columns that should never be converted to numeric
                        string_columns = ['Wing_code', 'Headsail_code', 'Daggerboard_code', 'Rudder_code', 'Config_code', 'Name']
                        categorical_cols = dfi.select_dtypes(include=['category']).columns
                        for col in categorical_cols:
                            # If this is a string column, convert directly to string without trying numeric conversion
                            if col in string_columns:
                                dfi[col] = dfi[col].astype(str)
                            else:
                                # Try to convert to numeric first, otherwise convert to string
                                try:
                                    dfi[col] = pd.to_numeric(dfi[col], errors='coerce')
                                    # Fill any NaN values created by conversion with 0
                                    dfi[col] = dfi[col].fillna(0)
                                except (ValueError, TypeError):
                                    # If conversion fails, convert to string
                                    dfi[col] = dfi[col].astype(str)
                        
                        # PREPARE DATA
                        u.PrepareManeuverData(dfi) 

                        # UPDATE PRFX MANEUVER CLIMAX TIME
                        new_ts = u.updateManeuverTime(dfi, climax_ts, 'BEARAWAY')
                        
                        # UPDATE CLIMAX TIME
                        if new_ts != climax_ts:
                            climax_ts = new_ts
                            climax_time = u.get_utc_datetime_from_ts(new_ts)
                        
                        start_ts = (climax_ts - sec_before)
                        end_ts =  (climax_ts + sec_after)

                        # TRIM DATAFRAME TO FINAL SIZE
                        dfm = dfi.loc[(dfi['ts'] >= start_ts) & (dfi['ts'] <= end_ts)].copy()
                        dfm.sort_values(by=['ts'], inplace=True, ascending=True)
                        
                        # COMPUTE SECONDS FROM ORIGIN
                        u.UpdateManeuverSeconds(dfm, climax_ts)
                        
                        # MAKE MAXIMUM ANGULAR RATES AND TURN ANGLES POSITIVE
                        u.NormalizeManeuverData(dfm)

                        # Only fill NaN in numeric columns to avoid categorical column errors
                        numeric_cols = dfm.select_dtypes(include=[np.number]).columns
                        dfm[numeric_cols] = dfm[numeric_cols].fillna(0)
                        
                        max_turn_angle = abs(dfm['TotalTurnAng'].max())
                        bs_max = dfm['Bsp_kts'].max()

                        if bs_max > 10:
                            entry_time, exit_time = u.IdentifyEntryExit(dfm, -10, 15)
                        else:
                            entry_time, exit_time = [-10, 15]

                        if (entry_time < 0 and exit_time > 0 and dfm['sec'].min() == -sec_before and dfm['sec'].max() == sec_after): 
                            # GET EVENT AGGREGATES
                            twd_avg = u.mean360(list(dfm['Twd_deg']))
                            lwy_max = abs(dfm['Lwy_n_deg']).max()
                            rud_ang_max = abs(dfm['RUD_ang_deg']).max()

                            twa_min = dfm['Twa_n_deg'].min()
                            twa_max = dfm['Twa_n_deg'].max()

                            # GET ENTRY INFO
                            dfa_entry = dfm.loc[dfm['sec'] >= entry_time]
                            entry_bs = dfa_entry.iloc[0]['Bsp_kts']
                            entry_twa = dfa_entry.iloc[0]['Twa_deg']
                            entry_foiling_state = u.getFoilingState(dfa_entry, dfa_entry.iloc[0]['ts'])
                            entry_tack = 'STBD' if entry_twa > 0 else 'PORT'

                            # CALC BS MAX
                            bs_max_time = dfm.loc[dfm['Bsp_kts'] == bs_max, 'sec'].iloc[0]

                            # CALC BS MIN
                            bs_min = dfm.loc[(dfm['sec'] > -5) & (dfm['sec'] < 10), 'Bsp_kts'].min()
                            bs_min_df = dfm.loc[(dfm['Bsp_kts'] == bs_min) & (dfm['sec'] > -10) & (dfm['sec'] < 10), 'sec']
                            if not bs_min_df.empty:
                                bs_min_time = bs_min_df.iloc[0]
                            else:
                                bs_min_time = -999

                            # CALC ACCEL INFO
                            dfa = dfm.loc[(dfm['sec'] > -5) & (dfm['sec'] < 10)]
                            accel_min = dfa['Accel_rate_mps2'].min()
                            accel_min_time = dfa.loc[dfa['Accel_rate_mps2'] == accel_min, 'sec'].iloc[0]

                            dfa_after_bs_min = dfm.loc[(dfm['sec'] > bs_min_time) & (dfm['sec'] < bs_min_time + 10)]
                            accel_max = dfa_after_bs_min['Accel_rate_mps2'].max()

                            dfc = dfa_after_bs_min.loc[dfa_after_bs_min['Accel_rate_mps2'] == accel_max]

                            if not dfc.empty:
                                accel_max_time = dfc['sec'].iloc[0]
                                bs_accmax = dfc['Bsp_kts'].iloc[0]
                                twa_accmax = dfc['Twa_deg'].iloc[0]

                                if twa_accmax < 0:
                                    rake_accmax = dfc['DB_rake_ang_stbd_deg'].iloc[0]
                                    cant_accmax = dfc['DB_cant_stbd_deg'].iloc[0]
                                    cant_eff_accmax = dfc['DB_cant_eff_stbd_deg'].iloc[0]
                                    wing_clew_pos_accmax = dfc['WING_clew_pos_mm'].iloc[0] * -1
                                    wing_twist_accmax = dfc['WING_twist_deg'].iloc[0] * -1
                                    wing_ca1_accmax = dfc['CA1_ang_deg'].iloc[0] * -1
                                else:
                                    rake_accmax = dfc['DB_rake_ang_port_deg'].iloc[0]
                                    cant_accmax = dfc['DB_cant_port_deg'].iloc[0]
                                    cant_eff_accmax = dfc['DB_cant_eff_port_deg'].iloc[0]
                                    wing_clew_pos_accmax = dfc['WING_clew_pos_mm'].iloc[0]
                                    wing_twist_accmax = dfc['WING_twist_deg'].iloc[0] 
                                    wing_ca1_accmax = dfc['CA1_ang_deg'].iloc[0]

                                pitch_accmax = dfc['Pitch_deg'].iloc[0]
                                heel_accmax = dfc['Heel_n_deg'].iloc[0]
                                Jib_sheet_pct_accmax = dfc['JIB_sheet_pct'].iloc[0]
                                jib_lead_ang_accmax = dfc['JIB_lead_ang_deg'].iloc[0]
                                jib_cunno_load_accmax = dfc['JIB_cunno_load_kgf'].iloc[0]
                                rud_rake_accmax = dfc['RUD_rake_ang_deg'].iloc[0]
                                rud_diff_accmax = dfc['RUD_diff_ang_deg'].iloc[0]
                            else:
                                accel_max_time = -999
                                bs_accmax = -999
                                twa_accmax = -999
                                cant_accmax = -999
                                cant_eff_accmax = -999
                                pitch_accmax = -999
                                heel_accmax = -999
                                Jib_sheet_pct_accmax = -999
                                jib_lead_ang_accmax = -999
                                jib_cunno_load_accmax = -999
                                wing_clew_pos_accmax = -999
                                wing_twist_accmax = -999
                                wing_ca1_accmax = -999
                                rake_accmax = -999
                                rud_rake_accmax = -999
                                rud_diff_accmax = -999
                                
                            # GET BOAT SPEED CLOSEST TO TARGET
                            dfa = dfm.loc[(dfm['sec'] > accel_max_time) & (dfm['sec'] < sec_after) & (abs(dfm['Yaw_rate_dps']) < 2)]

                            bsptgtdelta = dfa['BspTgtDelta'].abs().min()
                            dfc = dfa.loc[dfa['BspTgtDelta'].abs() == bsptgtdelta]

                            if not dfc.empty:
                                final_time = dfc['sec'].iloc[0]
                            else:
                                final_time = dfm['sec'].max()

                            end_time = dfm['sec'].max()

                            # CALC AVG TWS
                            tws_avg = dfm.loc[dfm['sec'] < final_time, 'Tws_kts'].mean()

                            # CALC INIT INFO
                            init_time = sec_before * -1
                            dfa_init = dfm.loc[dfm['sec'] >= init_time]
                            init_twa = dfa_init.iloc[0]['Twa_deg']
                            init_tack = 'STBD' if init_twa > 0 else 'PORT'

                            # CALC START INFO
                            start_time = sec_before * -1
                            dfa_start = dfm.loc[dfm['sec'] < (sec_before - 5) * -1]

                            start_bs = dfa_start['Bsp_kts'].mean()
                            start_twa = dfa_start['Twa_deg'].mean()
                            start_tws = dfa_start['Tws_kts'].mean()
                            start_twd = u.mean360(dfa_start['Twd_deg'].tolist())
                            start_tack = 'STBD' if start_twa > 0 else 'PORT'
                            start_Vmg_perc = dfa_start['Vmg_perc'].mean()

                            # CALC BEFORE INFO
                            dfa_before = dfm.loc[dfm['sec'] >= -10]
                            before_twa = dfa_before.iloc[0]['Twa_deg']
                            before_tack = 'STBD' if before_twa > 0 else 'PORT'

                            # CALC ORIGIN INFO
                            dfa_origin = dfm.loc[dfm['sec'] >= 0]
                            origin_twa = dfa_origin['Twa_deg'].mean()
                            origin_tack = 'STBD' if origin_twa > 0 else 'PORT'

                            # CALC FINAL INFO
                            dfa_final = dfm.loc[(dfm['sec'] > final_time - 5) & (dfm['sec'] < final_time)]

                            final_bs = dfa_final['Bsp_kts'].mean()
                            final_twa = dfa_final['Twa_deg'].mean()
                            final_tws = dfa_final['Tws_kts'].mean()
                            final_foiling_state = u.getFoilingState(dfa_final, dfa_final.iloc[0]['ts'])
                            final_twd = u.mean360(dfa_final['Twd_deg'].tolist())
                            if len(dfa_final) > 0:
                                final_turn_cum = float(dfa_final['TotalTurnAng'].mean())
                            else:
                                dfa_fb = dfm.loc[dfm['sec'] <= final_time].sort_values('sec')
                                final_turn_cum = float(dfa_fb['TotalTurnAng'].iloc[-1]) if len(dfa_fb) > 0 else 0.0

                            final_twa = dfm['Twa_deg'].iloc[-1]
                            final_tack = 'STBD' if final_twa > 0 else 'PORT'
                            final_Vmg_perc = dfm['Vmg_perc'].iloc[-1]

                            # CALC END INFO
                            dfa_end = dfm.iloc[-1]
                            end_twa = dfa_end['Twa_deg']
                            end_tack = 'STBD' if end_twa > 0 else 'PORT'

                            # GET TWO BOARD INFO
                            # twoboard_mask = (dfm['sec'] > -15) & (dfm['sec'] < 15) & ((dfm['DB_imm_stbd_mm'] <= 0) | (dfm['DB_ext_stbd_mm'] >= 200)) & ((dfm['DB_imm_port_mm'] <= 0) | (dfm['DB_ext_port_mm'] <= 200))
                            twoboard_mask = (dfm['sec'] > -15) & (dfm['sec'] < 15) & (dfm['DB_ext_stbd_mm'] >= 1200) & (dfm['DB_ext_port_mm'] >= 1200)
                            dfa_twoboards = dfm.loc[twoboard_mask].copy()
                            time_two_boards = dfa_twoboards['sec'].max() - dfa_twoboards['sec'].min()

                            # GET EXIT INFO
                            dfa_exit = dfm.loc[(dfm['sec'] >= exit_time)].copy()
                            exit_bs = dfa_exit.iloc[0]['Bsp_kts']
                            exit_twa = dfa_exit.iloc[0]['Twa_deg']
                            exit_foiling_state = u.getFoilingState(dfa_exit, dfa_exit.iloc[0]['ts'])
                            exit_turn_cum = float(dfa_exit.iloc[0]['TotalTurnAng'])
                            exit_tack = 'STBD' if exit_twa > 0 else 'PORT'

                            # WIND DELTAS
                            tws_delta = final_tws - start_tws
                            twd_delta = u.angle_subtract(final_twd, start_twd)
                            if entry_tack == 'PORT':
                                twd_delta = twd_delta * -1
                            
                            # CALC TURN ANGLE INFO (signed cumulative TotalTurnAng: first sample in window -> final_time band)
                            dfa_win_start = dfm.sort_values('sec', ascending=True).iloc[:1]
                            maneuver_start_turn_cum = (
                                float(dfa_win_start['TotalTurnAng'].iloc[0]) if len(dfa_win_start) > 0 else 0.0
                            )
                            overshoot_angle = exit_turn_cum - final_turn_cum
                            overshoot_perc = exit_twa / overshoot_angle if abs(overshoot_angle) > 1e-6 else 0.0
                            turn_angle = final_turn_cum - maneuver_start_turn_cum
                            time_turning = exit_time - entry_time
                            accel_time = final_time - bs_min_time
                            decel_time = bs_min_time - entry_time
                            
                            # CALC BUILD INFO
                            dfa = dfm.loc[(dfm['sec'] > bs_min_time) & (dfm['sec'] < final_time)].copy()
                            build_bs = dfa['Bsp_kts'].mean()
                            build_twa = dfa['Twa_deg'].mean()
                            
                            build_vmg = dfa['Vmg_n_kts'].mean()
                            build_vmg_tgt = dfa['Vmg_tgt_kts'].mean()
                            if build_vmg_tgt > 0 and build_vmg > 0:
                                build_vmg_perc = (build_vmg / build_vmg_tgt) * 100
                            else:
                                build_vmg_perc = -999
                            
                            # CALC ANGULAR RATES
                            dfa = dfm.loc[(dfm['sec'] > entry_time) & (dfm['sec'] < exit_time)].copy()
                            angrate_avg = abs(dfa['Yaw_rate_dps']).mean()
                            angrate_max = abs(dfa['Yaw_rate_dps']).max()
                            
                            dfa = dfm.loc[(dfm['sec'] > -2) & (dfm['sec'] < 2)].copy()
                            speed = dfa['Bsp_kts'].mean()
                            rate = dfa['Yaw_rate_dps'].mean()

                            if rate > 0:
                                radius = (speed * u.mps) / (m.radians(rate))
                            else:
                                radius = -999
                            
                            # CALC TOTAL TIME
                            total_time = sec_before + sec_after
                            
                            # COMPUTE SLOPES
                            decel_slope = 0
                            if abs(bs_accmax - bs_min) > 0 and abs(accel_max_time - bs_min_time) > 0:             
                                accel_slope = (bs_accmax - bs_min) / (accel_max_time - bs_min_time)
                            else:
                                accel_slope = 0

                            #CALC LOSS
                            u.UpdateManeuverSeconds(dfi, climax_ts)

                            first_five_seconds = dfi.loc[(dfi['sec'] <= -10)].copy()
                            vmg_start_max = first_five_seconds['Vmg_n_kts'].max() 

                            last_five_seconds = dfi.loc[(dfi['sec'] >= 10)].copy()
                            vmg_end_max = last_five_seconds['Vmg_n_kts'].max()
                            
                            vmg_baseline = (vmg_start_max + vmg_end_max) / 2
                            dfm['vmg_baseline_kts'] = vmg_baseline
                            dfi['vmg_baseline_kts'] = vmg_baseline

                            #CALC TOTAL LOSS
                            dfc = dfi.loc[(dfi['sec'] >= -20) & (dfi['sec'] <= 20)].copy()
                            vmg_perc_avg = dfc['Vmg_perc'].mean()
                            vmg_avg = dfc['Vmg_n_kts'].mean()
                            mmg = (vmg_avg * u.mps) * 30
                        
                            vmg_total_avg, loss_total_vmg, loss_total_tgt = computeLoss(dfc, 30)

                            #CALC INVESTMENT LOSS
                            dfc = dfi.loc[(dfi['sec'] >= -20) & (dfi['sec'] <= -5)].copy()
                            vmg_inv_avg, loss_inv_vmg, loss_inv_tgt = computeLoss(dfc, 10)

                            #CALC TURN LOSS
                            dfc = dfi.loc[(dfi['sec'] >= -5) & (dfi['sec'] <= 5)].copy()
                            vmg_turn_avg, loss_turn_vmg, loss_turn_tgt = computeLoss(dfc, 10)
                            
                            #CALC BUILD LOSS
                            dfc = dfi.loc[(dfi['sec'] >= 5) & (dfi['sec'] <= 30)].copy()
                            vmg_build_avg, loss_build_vmg, loss_build_tgt = computeLoss(dfc, 10)

                            # DETERMINE TYPE
                            event_type = 'BEARAWAY'
                            mnvr_grade = 3

                            if before_tack != origin_tack and twa_min < 20 and abs(start_twa) < 90 and abs(final_twa) > 90:
                                event_type = 'DEANO'
                            elif origin_tack != end_tack and twa_max > 160 and abs(start_twa) < 90 and abs(final_twa) > 90:
                                event_type = 'CHICAGO'

                            if abs(end_twa) < 90:
                                mnvr_grade = 0
                            elif abs(max_turn_angle) < 10 or (event_type == 'BEARAWAY' and abs(final_turn_cum) > 300) or abs(twd_delta) > 15 or bs_min < 10:
                                # print("mnvr_grade = 1 triggered due to:")
                                # print(f"  abs(twd_delta) > 15: {abs(twd_delta) > 15} (twd_delta={twd_delta})")
                                # print(f"  max_turn_angle < 30: {max_turn_angle < 30} (max_turn_angle={max_turn_angle})")
                                # print(f"  max_turn_angle > 270: {max_turn_angle > 270} (max_turn_angle={max_turn_angle})")
                                # print(f"  bs_min < 15: {bs_min < 15} (bs_min={bs_min})")
                                # print(f"  abs(init_twa) > 90: {abs(init_twa) > 90} (init_twa={init_twa})")
                                # print(f"  abs(init_twa) < 20: {abs(init_twa) < 20} (init_twa={init_twa})")
                                # print(f"  abs(end_twa) < 20: {abs(end_twa) < 20} (end_twa={end_twa})")
                                # print(f"  abs(end_twa) > 90: {abs(end_twa) > 90} (end_twa={end_twa})")
                                # print(f"  start_Vmg_perc < 50: {start_Vmg_perc < 50} (start_Vmg_perc={start_Vmg_perc})")
                                # print(f"  final_Vmg_perc < 50: {final_Vmg_perc < 50} (final_Vmg_perc={final_Vmg_perc})")
                                
                                mnvr_grade = 1
                            elif bs_min < 18 or abs(max_turn_angle) > 100 or abs(max_turn_angle) < 20 or abs(twd_delta) > 10:
                                mnvr_grade = 2
                            
                            if (mnvr_grade > 0):
                                bs_min_delta = bs_min - entry_bs
                                
                                start_dt = climax_time + u.td(seconds=start_time)
                                end_dt = climax_time + u.td(seconds=end_time)

                                eventinfo = {}     
                                eventinfo = u.getMetadata(dfi, climax_ts, class_name)  

                                if (int(eventinfo['RACES']['Race_number']) > 0 and int(eventinfo['RACES']['Leg_number']) == 0):
                                    mnvr_grade = 1

                                if entry_foiling_state == 'H1' and final_foiling_state == 'H1':
                                    foiling_state = 'H1'
                                elif entry_foiling_state == 'H2' and final_foiling_state == 'H2':
                                    foiling_state =  'H2'
                                elif entry_foiling_state == 'H2' and final_foiling_state == 'H2':
                                    foiling_state =  'H2'
                                elif entry_foiling_state == 'H2' and exit_foiling_state == 'H0' and final_foiling_state == 'H0':
                                    foiling_state = 'H2-H0'
                                elif entry_foiling_state == 'H1' and exit_foiling_state == 'H0' and final_foiling_state == 'H0':
                                    foiling_state = 'H1-H0'
                                elif entry_foiling_state == 'H2' and exit_foiling_state == 'H1' and final_foiling_state == 'H1':
                                    foiling_state = 'H2-H1'
                                elif entry_foiling_state == 'H0' and exit_foiling_state == 'H0' and final_foiling_state == 'H0':
                                    foiling_state =  'H0'
                                elif entry_foiling_state == 'H0' and (exit_foiling_state == 'H1' or exit_foiling_state == 'H2') and final_foiling_state == 'H0':
                                    foiling_state = 'T&G'
                                elif entry_foiling_state != 'H2' and exit_foiling_state == 'H1' and final_foiling_state == 'H1':
                                    foiling_state = entry_foiling_state +'-H1'
                                elif entry_foiling_state != 'H2' and exit_foiling_state == 'H2' and final_foiling_state == 'H2':
                                    foiling_state = entry_foiling_state +'-H2'
                                else:
                                    foiling_state = 'NA'

                                eventinfo["GRADE"] = mnvr_grade
                                eventinfo["MANEUVER_TYPE"] = event_type    
                                eventinfo["FOILING_STATE"] = foiling_state
                                eventinfo_str = json.dumps(eventinfo)

                                jsondata = {}
                                jsondata["class_name"] = str(class_name)
                                jsondata["project_id"] = int(project_id)
                                jsondata["dataset_id"] = int(dataset_id)
                                jsondata["event_type"] = 'BEARAWAY'

                                jsondata["start_time"] = start_dt.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                                jsondata["end_time"] = end_dt.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                                jsondata["tags"] = str(eventinfo_str)

                                res = u.post_api_data(api_token, ":8059/api/events", jsondata)

                                if (res['success']):
                                    print('Added Bearaway:', u.dt.now(), flush=True)

                                    event_id = res['data']
                                
                                    if event_id > 0:
                                        info = {}
                                        info["Datetime"] = str(climax_time)
                                        
                                        info["Tws_avg"] = round(tws_avg * 1.852, 2) 
                                        info["Tws_bin"] = u.get_even_integer(tws_avg * 1.852) 
                                        info["Vmg_avg"] = round(vmg_avg * 1.852, 2) 
                                        info["Vmg_perc_avg"] = round(vmg_perc_avg, 2)
                                        info["Twd_avg"] = round(twd_avg, 2)
                                        info["Twd_cor"] = round(twd_avg, 2)
                                        info["Lwy_max"] = round(lwy_max, 2)
                                        info["Rud_ang_max"] = round(rud_ang_max, 2)

                                        info["Bsp_max"] = round(bs_max * 1.852, 2) 
                                        info["Bsp_max_time"] = round(bs_max_time, 1)
                                        info["Bsp_min"] = round(bs_min * 1.852, 2) 
                                        info["Bsp_min_time"] = round(bs_min_time, 1)
                                        info["Bsp_min_delta"] = round(bs_min_delta * 1.852, 2) 

                                        info["Time_decel"] = round(decel_time, 2)
                                        info["Time_accel"] = round(accel_time, 2)
                                        info["Time_turning"] = round(time_turning, 1)
                                        info["Time_total"] = round(total_time, 1)
                                        info["Time_two_boards"] = round(time_two_boards, 2)

                                        info["Accel_min"] = round(accel_min, 2)
                                        info["Accel_slope"] = round(accel_slope, 2)

                                        info["Start_time"] = round(start_time, 2)
                                        info["Bsp_start"] = round(start_bs * 1.852, 2) 
                                        info["Twa_start"] = round(start_twa, 2)

                                        info["Entry_time"] = round(entry_time, 1)
                                        info["Bsp_entry"] = round(entry_bs * 1.852, 2) 
                                        info["Twa_entry"] = round(entry_twa, 2)

                                        info["Bsp_build"] = round(build_bs * 1.852, 2)
                                        info["Twa_build"] = round(build_twa, 2)
                                        info["Vmg_perc_build"] = round(build_vmg_perc, 2)

                                        info["Exit_time"] = round(exit_time, 1)
                                        info["Bsp_exit"] = round(exit_bs * 1.852, 2) 
                                        info["Twa_exit"] = round(exit_twa, 2)

                                        info["Accel_max_time"] = round(accel_max_time, 1)
                                        info["Bsp_accmax"] = round(bs_accmax * 1.852, 2) 
                                        info["Twa_accmax"] = round(twa_accmax, 2)

                                        info["Cant_accmax"] = round(cant_accmax, 2)
                                        info["Cant_eff_accmax"] = round(cant_eff_accmax, 2)
                                        info["Pitch_accmax"] = round(pitch_accmax, 2)
                                        info["Heel_accmax"] = round(heel_accmax, 2)
                                        info["Jib_sheet_pct_accmax"] = round(Jib_sheet_pct_accmax, 2)
                                        info["Jib_lead_ang_accmax"] = round(jib_lead_ang_accmax, 2)
                                        info["Jib_cunno_load_accmax"] = round(jib_cunno_load_accmax, 2)
                                        info["Wing_clew_pos_accmax"] = round(wing_clew_pos_accmax, 2)
                                        info["Wing_twist_accmax"] = round(wing_twist_accmax, 2)
                                        info["Wing_ca1_accmax"] = round(wing_ca1_accmax, 2)
                                        info["Rake_accmax"] = round(rake_accmax, 2)
                                        info["Rud_rake_accmax"] = round(rud_rake_accmax, 2)
                                        info["Rud_diff_accmax"] = round(rud_diff_accmax, 2)

                                        info["Final_time"] = round(final_time, 2)
                                        info["Bsp_final"] = round(final_bs * 1.852, 2) 
                                        info["Twa_final"] = round(final_twa, 2)

                                        info["Turn_radius"] = round(radius, 2)
                                        info["Turn_rate_avg"] = round(angrate_avg, 2)
                                        info["Turn_rate_max"] = round(angrate_max, 2)
                                        info["Turn_angle_max"] = round(max_turn_angle, 2)
                                        info["Turn_angle"] = round(abs(turn_angle), 2)
                                        info["Overshoot_angle"] = round(overshoot_angle, 2)
                                        info["Overshoot_perc"] = round(overshoot_perc, 2)

                                        info["Tws_delta"] = round(tws_delta * 1.852, 2)
                                        info["Twd_delta"] = round(twd_delta, 2)

                                        info["Mmg"] = round(mmg, 2)
                                        info["Vmg_baseline"] = round(vmg_baseline * 1.852, 2)
                                        info["Vmg_applied"] = round(vmg_baseline * 1.852, 2)
                                        info["Vmg_total_avg"] = round(vmg_total_avg * 1.852, 2)
                                        info["Vmg_inv_avg"] = round(vmg_inv_avg * 1.852, 2)
                                        info["Vmg_turn_avg"] = round(vmg_turn_avg * 1.852, 2)
                                        info["Vmg_build_avg"] = round(vmg_build_avg * 1.852, 2)

                                        info["Loss_total_vmg"] = round(loss_total_vmg, 2)
                                        info["Loss_total_tgt"] = round(loss_total_tgt, 2)
                                        info["Loss_inv_tgt"] = round(loss_inv_tgt, 2)
                                        info["Loss_inv_vmg"] = round(loss_inv_vmg, 2)
                                        info["Loss_turn_tgt"] = round(loss_turn_tgt, 2)
                                        info["Loss_turn_vmg"] = round(loss_turn_vmg, 2)
                                        info["Loss_build_tgt"] = round(loss_build_tgt, 2)
                                        info["Loss_build_vmg"] = round(loss_build_vmg, 2)

                                        #CLEAN INFO (REMOVE NANs)
                                        for k,v in info.items():
                                            if pd.isna(v):
                                                info[k] = 0
                                                
                                        info_str = json.dumps(info)

                                        jsondata = {}
                                        jsondata["class_name"] = str(class_name)
                                        jsondata["project_id"] = int(project_id)
                                        jsondata["table"] = str("maneuver_stats")
                                        jsondata["event_id"] = str(event_id)
                                        jsondata["agr_type"] = str('NONE')
                                        jsondata["json"] = info_str

                                        res = u.post_api_data(api_token, ":8059/api/events/row", jsondata)

                                        # Run map data and time series data operations in parallel
                                        with ThreadPoolExecutor(max_workers=8) as executor:
                                            # Submit all tasks
                                            futures = []
                                            
                                            # Map data tasks
                                            futures.append(executor.submit(addMapData, dfm, event_id, '0', climax_time, -15, 15, twd_avg, api_token, class_name, project_id))
                                            futures.append(executor.submit(addMapData, dfm, event_id, '1', climax_time, -15, -5, twd_avg, api_token, class_name, project_id))
                                            futures.append(executor.submit(addMapData, dfm, event_id, '2', climax_time, -5, 5, twd_avg, api_token, class_name, project_id))
                                            futures.append(executor.submit(addMapData, dfm, event_id, '3', climax_time, 5, 15, twd_avg, api_token, class_name, project_id))
                                            
                                            # Time series data tasks
                                            futures.append(executor.submit(addTimeSeriesData, 'Basics', dfm, event_id, '0', climax_time, -15, 15, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Basics', dfm, event_id, '1', climax_time, -15, -5, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Basics', dfm, event_id, '2', climax_time, -5, 5, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Basics', dfm, event_id, '3', climax_time, 5, 15, api_token, class_name, project_id))

                                            futures.append(executor.submit(addTimeSeriesData, 'Foils', dfm, event_id, '0', climax_time, -15, 15, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Foils', dfm, event_id, '1', climax_time, -15, -5, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Foils', dfm, event_id, '2', climax_time, -5, 5, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Foils', dfm, event_id, '3', climax_time, 5, 15, api_token, class_name, project_id))

                                            futures.append(executor.submit(addTimeSeriesData, 'Aero', dfm, event_id, '0', climax_time, -15, 15, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Aero', dfm, event_id, '1', climax_time, -15, -5, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Aero', dfm, event_id, '2', climax_time, -5, 5, api_token, class_name, project_id))
                                            futures.append(executor.submit(addTimeSeriesData, 'Aero', dfm, event_id, '3', climax_time, 5, 15, api_token, class_name, project_id))
                                            
                                            # Wait for all tasks to complete and handle any exceptions
                                            for future in as_completed(futures):
                                                try:
                                                    future.result()  # This will raise any exceptions that occurred
                                                except Exception as e:
                                                    u.log(api_token, "bearaways.py", "error", "Bearaways Failed! Error in parallel execution", e)
                                                    print(f"Error in parallel execution: {e}", flush=True)
                                                    raise  # Re-raise to be caught by outer exception handler
                                        
                                        processed_count += 1
                                
            except Exception as e:
                failed_count += 1
                error_msg = f"Error processing bearaway at {climax_ts}: {str(e)}"
                u.log(api_token, "bearaways.py", "error", "Bearaways processing failed", error_msg)
                if verbose:
                    print(f"Failed to process bearaway {climax_ts}: {e}", flush=True)
                import traceback
                u.log(api_token, "bearaways.py", "error", "Bearaways processing traceback", traceback.format_exc())
                continue

        # Log summary
        summary_msg = f"Processed {processed_count} Bearaways successfully, {failed_count} failed out of {len(maneuver_list)} total"
        u.log(api_token, "bearaways.py", "info", "Bearaways processing summary", summary_msg)
        if verbose:
            print(summary_msg, flush=True)

        return True
    else:
        # No bearaways found
        u.log(api_token, "bearaways.py", "info", "No bearaways found", "No bearaway maneuvers in data")
        if verbose:
            print("No bearaways found", flush=True)
        return True
                                
def addMapData(df, event_id, desc, mnvr_time, start_sec, stop_sec, twd, api_token, class_name, project_id):
    start_ts = (mnvr_time + u.td(seconds=start_sec)).timestamp()
    end_ts = (mnvr_time + u.td(seconds=stop_sec)).timestamp()

    dff = df.loc[(df['ts'] >= start_ts) & (df['ts'] <= end_ts)].copy()
    
    # Check if DataFrame is empty
    if dff.empty:
        u.log(api_token, "bearaways.py", "warn", "addMapData", f"No data found for event_id {event_id} in time range {start_ts} to {end_ts}")
        return

    # Fill NaN values only for numeric columns to avoid issues with datetime/string columns
    numeric_cols = dff.select_dtypes(include=[np.number]).columns
    dff[numeric_cols] = dff[numeric_cols].fillna(0)

    # GET ORIGIN LAT LON 
    if desc == '1':
        if len(dff) == 0:
            u.log(api_token, "bearaways.py", "warn", "addMapData", f"No data in dff for event_id {event_id}, desc='1'")
            return
        lat0 = dff.iloc[-1]['Lat_dd']
        lng0 = dff.iloc[-1]['Lng_dd']
        start_twa = dff.iloc[-1]['Twa_deg']
    else:
        dfa = dff.loc[(dff['sec'] >= 0)].copy()
        if len(dfa) == 0:
            u.log(api_token, "bearaways.py", "warn", "addMapData", f"No data in dfa for event_id {event_id}, desc='{desc}'")
            return
        lat0 = dfa.iloc[0]['Lat_dd']
        lng0 = dfa.iloc[0]['Lng_dd']
        start_twa = dfa.iloc[0]['Twa_deg']

    xy0 = u.latlng_to_meters(lat0, lng0, lat0, lng0)

    # BUILD OUTPUT JSON
    dataoutput = {}
    dataoutput_n = {}
    
    dataoutput["event_id"] = str(event_id)
    dataoutput_n["event_id"] = str(event_id)

    items_n = []

    x0 = xy0[0]
    y0 = xy0[1]

    # rotation = u.angle_subtract(twd, 180)
    rotation = twd
    
    scounter = 0
    for index, row in dff.iterrows():
        if (scounter == 0 or scounter == 5):
            seconds = row['sec']
            lat = row['Lat_dd']
            lng = row['Lng_dd']
            hdg = row['Hdg_deg']
            twa = row['Twa_deg']
            sink_min = row['RH_lwd_mm']

            xy = u.latlng_to_meters(lat0, lng0, lat, lng)
            x = xy[0]
            y = xy[1]

            yT = y - y0
            xT = x - x0

            xR = (m.cos(m.radians(rotation)) * xT) - (m.sin(m.radians(rotation)) * yT)
            yR = (m.sin(m.radians(rotation)) * xT) + (m.cos(m.radians(rotation)) * yT)
            hdgR = u.angle360_normalize(u.angle_subtract(hdg, twd))

            latlng = u.meters_to_latlng(originlon, originlat, xR, yR)
            latR = latlng[0]
            lngR = latlng[1]

            if (start_twa < 0):
                hdgR = u.angle360_normalize(u.angle_subtract(hdgR, twa * -2))

                xR_n = xR * -1
                latlng = u.meters_to_latlng(originlon, originlat, xR_n, yR)
                latR = latlng[0]
                lngR = latlng[1]

            item = {}
            item["time"] = str(round(float(seconds), 2))
            item["lat"] = str(round(float(latR), 6))
            item["lng"] = str(round(float(lngR), 6))
            item["twa"] = str(round(float(twa), 2))
            item["hdg"] = str(round(float(hdgR), 2))
            item["sink_min"] = str(round(float(sink_min), 2))

            items_n.append(item)
            scounter = 0
            
        scounter += 1
        
    dataoutput_n["values"] = items_n

    #INSERT NORMALIZED MAP DATA
    output_str = json.dumps(dataoutput_n)
    jsondata = {"class_name": class_name,"project_id": project_id, "event_id": event_id, "table": "events_mapdata", "desc": desc+"_Normalized", "json": str(output_str)}
    res = u.post_api_data(api_token, ":8059/api/events/object", jsondata)
    
    if (res['success'] == False):
        u.log(api_token, "tacks.py", "warning", "Map Type "+desc+" Failed!", "")
        print("Map Type "+desc+" Failed!", flush=True)

def addTimeSeriesData(type, df, event_id, desc, mnvr_time, start_sec, stop_sec, api_token, class_name, project_id):
    # DO TIMESERIES
    dataoutput = {}
    dataoutput["event_id"] = str(event_id)
    items = []

    start_ts = (mnvr_time + u.td(seconds=start_sec)).timestamp()
    end_ts = (mnvr_time + u.td(seconds=stop_sec)).timestamp()
    mnvr_ts = mnvr_time.timestamp() if hasattr(mnvr_time, 'timestamp') else float(mnvr_time)

    dfc = df.loc[(df['ts'] >= start_ts) & (df['ts'] <= end_ts)].copy()

    # Fill missing time buckets: channel-values API returns only buckets that have ≥1 raw row
    # (GROUP BY FLOOR(ts/resolution)), so e.g. 5 Hz data yields buckets at -14.5, -14.3, -14.1 and -14.4 is skipped.
    # Reindex to a full 100ms grid and forward/back fill so every relative second (e.g. -14.4) has a row.
    # resolution_sec = 0.1
    # if not dfc.empty:
    #     full_ts = np.arange(start_ts, end_ts + resolution_sec / 2, resolution_sec)
    #     dfc = dfc.set_index('ts')
    #     dfc = dfc.reindex(full_ts)
    #     dfc = dfc.ffill().bfill()
    #     dfc = dfc.reset_index().rename(columns={'index': 'ts'})
    #     dfc['sec'] = dfc['ts'] - mnvr_ts

    start_twa = None
    start_turn_angle = None
    prev_vmg_loss_tgt = 0
    prev_vmg_loss = 0
    prev_mmg = 0
    for index, row in dfc.iterrows():
        second = u.number(row['sec'])
        twa = u.number(row['Twa_deg'])

        if (type == 'Basics'):
            tws = u.number(row['Tws_kts'])
            bs = u.number(row['Bsp_kts'])
            vmg = abs(u.number(row['Vmg_kts']))
            vmg_tgt = abs(u.number(row['Vmg_tgt_kts']))
            vmg_baseline = abs(u.number(row['vmg_baseline_kts']))
            vmg_perc = u.number(row['Vmg_perc'])
            pitch = u.number(row['Pitch_deg'])
            lwy = u.number(row['Lwy_deg'])
            heel = u.number(row['Heel_deg'])
            yaw_rate = u.number(row['Yaw_rate_dps']) 
            accel = u.number(row['Accel_rate_mps2'])
            totalturn = u.number(row['TotalTurnAng']) 
            period = u.number(row['Period'])

            if start_twa == None:
                start_twa = twa
            
            if start_turn_angle == None:
                start_turn_angle = totalturn
            
            # Compute totalturnang from zero
            totalturnang = totalturn - start_turn_angle

            # Convert vmg loss from knots to meters per second
            vmg_loss_tgt = ((vmg_tgt - vmg) * u.mps * period) + prev_vmg_loss_tgt
            vmg_loss = ((vmg_baseline - vmg) * u.mps * period) + prev_vmg_loss
            prev_vmg_loss_tgt = vmg_loss_tgt
            prev_vmg_loss = vmg_loss
            
            # Calculate VMG meters traveled in this timestep
            mmg = (vmg * u.mps * period) + prev_mmg
            prev_mmg = mmg
                
            if start_twa < 0:
                lwy = lwy * -1
                heel = heel * -1
            
            item = {}
            item["time"] = round(float(second), 2)
            item["tws_kph"] = round(float(tws), 2) * 1.852
            item["bsp_kph"] = round(float(bs), 2) * 1.852
            item["twa_n_deg"] = round(abs(float(twa)), 2)
            item["vmg_perc"] = round(float(vmg_perc), 2)
            item["vmg_loss_m"] = round(float(vmg_loss), 2)
            item["vmg_loss_tgt_m"] = round(float(vmg_loss_tgt), 2)
            item["yaw_rate_n_dps"] = round(float(yaw_rate), 2)
            item["heel_n_deg"] = round(float(heel), 2)
            item["pitch_deg"] = round(float(pitch), 2)
            item["accel_rate_mps2"] = round(float(accel), 2)
            item["total_turn_angle_deg"] = round(float(totalturnang), 2)
            item["mmg_m"] = round(float(mmg), 2)

            items.append(item)
        elif (type == 'Foils'):
            tws = u.number(row['Tws_kts'])
            bs = u.number(row['Bsp_kts'])
            rud_ang = u.number(row['RUD_ang_deg'])
            rud_rake = u.number(row['RUD_rake_ang_deg'])
            rud_diff = u.number(row['RUD_diff_ang_deg'])
            rud_imm_port = u.number(row['RUD_imm_port_mm'])
            rud_imm_stbd = u.number(row['RUD_imm_stbd_mm'])
            rh_port = u.number(row['RH_port_mm'])
            rh_stbd = u.number(row['RH_stbd_mm'])
            db_ext_port = u.number(row['DB_ext_port_mm'])
            db_ext_stbd = u.number(row['DB_ext_stbd_mm']) 
            db_cant_port = u.number(row['DB_cant_port_deg']) 
            db_cant_stbd = u.number(row['DB_cant_stbd_deg'])
            db_rake_port = u.number(row['DB_rake_ang_port_deg'])
            db_rake_stbd = u.number(row['DB_rake_ang_stbd_deg'])
            db_stow_stbd = u.number(row['DB_stow_state_stbd'])
            db_stow_port = u.number(row['DB_stow_state_port'])
            db_rake_aoa_port = u.number(row['DB_rake_aoa_port_deg'])
            db_rake_aoa_stbd = u.number(row['DB_rake_aoa_stbd_deg'])

            if start_twa == None:
                start_twa = twa

            if start_twa < 0:
                rud_ang = rud_ang * -1

            if start_twa > 0:
                rud_imm_old = rud_imm_port
                rud_imm_new = rud_imm_stbd
                db_ext_old = db_ext_port
                db_ext_new = db_ext_stbd
                db_cant_old = db_cant_port
                db_cant_new = db_cant_stbd
                db_rake_old = db_rake_port
                db_rake_new = db_rake_stbd
                db_rake_aoa_old = db_rake_aoa_port
                db_rake_aoa_new = db_rake_aoa_stbd
                db_stow_old = db_stow_port
                db_stow_new = db_stow_stbd
                rh_old = rh_port
                rh_new = rh_stbd
            else:
                rud_imm_old = rud_imm_stbd
                rud_imm_new = rud_imm_port
                db_ext_old = db_ext_stbd
                db_ext_new = db_ext_port
                db_cant_old = db_cant_stbd
                db_cant_new = db_cant_port
                db_rake_old = db_rake_stbd
                db_rake_new = db_rake_port
                db_rake_aoa_old = db_rake_aoa_stbd
                db_rake_aoa_new = db_rake_aoa_port
                db_stow_old = db_stow_stbd
                db_stow_new = db_stow_port
                rh_old = rh_stbd
                rh_new = rh_port
            
            item = {}
            item["time"] = round(float(second), 2)
            item["tws_kph"] = round(float(tws), 2) * 1.852
            item["bsp_kph"] = round(float(bs), 2) * 1.852
            item["rud_ang_deg"] = round(float(rud_ang), 2)
            item["rud_rake_deg"] = round(abs(float(rud_rake)), 2)
            item["rud_diff_deg"] = round(float(rud_diff), 2)
            item["rud_imm_lwd_mm"] = round(float(rud_imm_old), 2)
            item["rud_imm_wwd_mm"] = round(float(rud_imm_new), 2) 
            item["rh_lwd_mm"] = round(float(rh_old), 2)
            item["rh_wwd_mm"] = round(float(rh_new), 2) 
            item["db_ext_lwd_mm"] = round(float(db_ext_old), 2)  
            item["db_ext_wwd_mm"] = round(float(db_ext_new), 2)
            item["db_cant_lwd_deg"] = round(float(db_cant_old), 2)
            item["db_cant_wwd_deg"] = round(float(db_cant_new), 2)
            item["db_rake_lwd_deg"] = round(float(db_rake_old), 2)
            item["db_rake_wwd_deg"] = round(float(db_rake_new), 2)
            item["db_rake_aoa_lwd_deg"] = round(float(db_rake_aoa_old), 2)
            item["db_rake_aoa_wwd_deg"] = round(float(db_rake_aoa_new), 2)
            item["db_stow_state_lwd"] = round(float(db_stow_old), 2)
            item["db_stow_state_wwd"] = round(float(db_stow_new), 2)

            items.append(item)
        elif (type == 'Aero'):
            tws = u.number(row['Tws_kts'])
            bs = u.number(row['Bsp_kts'])
            camber1 = u.number(row['CA1_ang_deg'])
            camber6 = u.number(row['CA6_ang_deg'])
            twist = u.number(row['WING_twist_deg'])
            rot = u.number(row['WING_rot_deg'])
            aoa = u.number(row['WING_aoa_deg'])
            clew = u.number(row['WING_clew_pos_mm'])
            jib_sheet_load = u.number(row['JIB_sheet_load_kgf'])
            jib_sheet = u.number(row['JIB_sheet_pct'])
            jib_cunno = u.number(row['JIB_cunno_load_kgf']) 
            jib_lead = u.number(row['JIB_lead_ang_deg'])
            rig_load = u.number(row['RIG_load_tf'])

            if start_twa == None:
                start_twa = twa

            if start_twa < 0:
                camber1 = camber1 * -1
                camber6 = camber6 * -1
                rot = rot * -1 
                aoa = aoa * -1
                clew = clew * -1
            
            item = {}
            item["time"] = round(float(second), 2)
            item["tws_kph"] = round(float(tws), 2) * 1.852
            item["bsp_kph"] = round(float(bs), 2) * 1.852
            item["camber1_deg"] = round(float(camber1), 2)
            item["camber6_deg"] = round(float(camber6), 2)
            item["total_twist_deg"] = round(float(twist), 2)
            item["wing_rotation_deg"] = round(float(rot), 2)
            item["wing_aoa_deg"] = round(float(aoa), 2)
            item["clew_position_mm"] = round(float(clew), 2) 
            item["jib_sheet_load_kgf"] = round(float(jib_sheet_load), 2)  
            item["jib_sheet_pct"] = round(float(jib_sheet), 2)  
            item["jib_cunno_load_kgf"] = round(float(jib_cunno), 2)
            item["jib_lead_ang_deg"] = round(float(jib_lead), 2)
            item["rig_load_tf"] = round(float(rig_load), 2)

            items.append(item)

    if type == 'Basics':
        charts = ['tws_kph', 'bsp_kph', 'cwa_n_deg', 'vmg_perc', 'heel_n_deg', 'pitch_deg', 'yaw_rate_n_dps', 'accel_rate_mps2', 'total_turn_angle_deg', 'vmg_loss_m', 'vmg_loss_tgt_m', 'mmg_m']
    elif type == 'Foils':
        charts = ['tws_kph', 'bsp_kph', 'rud_ang_deg', 'rud_rake_deg', 'rud_diff_deg', 'rud_imm_lwd_mm', 'rud_imm_wwd_mm', 'db_ext_lwd_mm', 'db_ext_wwd_mm', 'db_stow_lwd', 'db_stow_wwd', 'db_cant_lwd_deg', 'db_cant_wwd_deg', 'db_rake_lwd_deg', 'db_rake_wwd_deg', 'db_rake_aoa_lwd_deg', 'db_rake_aoa_wwd_deg']
    elif type == 'Aero':
        charts = ['tws_kph', 'bsp_kph', 'camber1_deg', 'camber6_deg', 'total_twist_deg', 'wing_rotation_deg', 'wing_aoa_deg', 'clew_position_mm', 'jib_sheet_pct', 'jib_sheet_load_kgf', 'jib_cunno_load_kgf', 'jib_lead_ang_deg', 'rig_load_tf']

    dataoutput["charts"] = charts
    dataoutput["values"] = items
    output_str = json.dumps(dataoutput)

    #INSERT DATA
    if len(output_str) > 50: 
        jsondata = {"class_name": class_name,"project_id": project_id, "event_id": event_id, "table": "events_timeseries", "desc": desc+"_"+type, "json": str(output_str)}
        res = u.post_api_data(api_token, ":8059/api/events/object", jsondata)

        if (res['success'] == False):
            u.log(api_token, "tacks.py", "warning", "Time Series "+desc+" Failed!", "")
            print("Time Series "+desc+" Failed!", flush=True)