import pandas as pd
import numpy as np
import sys
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import utilities as u 

def get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts, verbose):
    df = pd.DataFrame()
    try:
        channels = [
            {'name': 'Datetime', 'type': 'datetime'},
            {'name': 'ts', 'type': 'float'},

            # Corrected wind (fused); rename to standard names
            {'name': 'Tws_cor_kph', 'type': 'float'},
            {'name': 'Twd_cor_deg', 'type': 'angle360'},
            {'name': 'Twa_cor_deg', 'type': 'angle180'},
            {'name': 'Twa_n_cor_deg', 'type': 'angle180'},
            {'name': 'Awa_cor_deg', 'type': 'angle180'},
            {'name': 'Awa_n_cor_deg', 'type': 'angle180'},
            {'name': 'Aws_cor_kph', 'type': 'float'},
            {'name': 'Lwy_cor_deg', 'type': 'float'},
            {'name': 'Lwy_n_cor_deg', 'type': 'float'},
            {'name': 'Cwa_cor_deg', 'type': 'angle180'},
            {'name': 'Cwa_n_cor_deg', 'type': 'angle180'},
            {'name': 'Cse_cor_deg', 'type': 'angle180'},

            # Per-sensor corrected (bow/mhu)
            {'name': 'Tws_bow_cor_kph', 'type': 'float'},
            {'name': 'Tws_mhu_cor_kph', 'type': 'float'},
            {'name': 'Twd_bow_cor_deg', 'type': 'angle360'},
            {'name': 'Twd_mhu_cor_deg', 'type': 'angle360'},
            {'name': 'Awa_bow_cor_deg', 'type': 'angle180'},
            {'name': 'Awa_mhu_cor_deg', 'type': 'angle180'},
            {'name': 'Aws_bow_cor_kph', 'type': 'float'},
            {'name': 'Aws_mhu_cor_kph', 'type': 'float'},
            
            {'name': 'Cur_rate_est_kph', 'type': 'float'},
            {'name': 'Cur_dir_est_deg', 'type': 'angle360'},

            {'name': 'Twa_tgt_deg', 'type': 'angle180'},

            {'name': 'Hdg_deg', 'type': 'angle360'},
            {'name': 'Cog_deg', 'type': 'angle360'},

            {'name': 'Sog_kph', 'type': 'float'},
            {'name': 'Bsp_kts', 'type': 'float'},
            {'name': 'Bsp_kph', 'type': 'float'},
            {'name': 'Bsp_tgt_cor_kph', 'type': 'float'},
            {'name': 'Bsp_perc', 'type': 'float'},
            {'name': 'Polar_perc', 'type': 'float'},

            {'name': 'Vmg_cor_kph', 'type': 'float'},
            {'name': 'Vmg_tgt_kph', 'type': 'float'},
            {'name': 'Vmg_cor_perc', 'type': 'float'},

            {'name': 'Pitch_deg', 'type': 'float'},
            {'name': 'Heel_n_deg', 'type': 'float'},

            {'name': 'Pitch_rate_dps', 'type': 'float'},
            {'name': 'Yaw_rate_n_dps', 'type': 'float'},
            {'name': 'Roll_rate_n_dps', 'type': 'float'},
            {'name': 'Accel_rate_mps2', 'type': 'float'},

            {'name': 'RH_lwd_mm', 'type': 'float'},
            {'name': 'RH_wwd_mm', 'type': 'float'},
            {'name': 'RH_bow_mm', 'type': 'float'},

            {'name': 'RUD_ang_n_deg', 'type': 'float'},
            {'name': 'RUD_rake_ang_deg', 'type': 'float'},
            {'name': 'RUD_diff_ang_deg', 'type': 'float'},
            {'name': 'DB_rake_ang_lwd_deg', 'type': 'float'},
            {'name': 'DB_rake_aoa_lwd_deg', 'type': 'float'},
            {'name': 'DB_cant_lwd_deg', 'type': 'float'},
            {'name': 'DB_cant_eff_lwd_deg', 'type': 'float'},

            {'name': 'DB_imm_lwd_mm', 'type': 'float'},
            {'name': 'DB_piercing_lwd_mm', 'type': 'float'},
            {'name': 'RUD_imm_lwd_mm', 'type': 'float'},
            {'name': 'RUD_imm_wwd_mm', 'type': 'float'},
            {'name': 'RUD_imm_tot_mm', 'type': 'float'},

            {'name': 'CA1_ang_n_deg', 'type': 'float'},
            {'name': 'CA2_ang_n_deg', 'type': 'float'},
            {'name': 'CA3_ang_n_deg', 'type': 'float'},
            {'name': 'CA4_ang_n_deg', 'type': 'float'},
            {'name': 'CA5_ang_n_deg', 'type': 'float'},
            {'name': 'CA6_ang_n_deg', 'type': 'float'},
            {'name': 'WING_twist_n_deg', 'type': 'float'},
            {'name': 'WING_rot_n_deg', 'type': 'float'},
            {'name': 'WING_aoa_n_deg', 'type': 'float'},
            {'name': 'WING_clew_pos_n_mm', 'type': 'float'},

            {'name': 'JIB_sheet_load_kgf', 'type': 'float'},
            {'name': 'JIB_cunno_load_kgf', 'type': 'float'},
            {'name': 'JIB_lead_ang_deg', 'type': 'float'},
            {'name': 'JIB_sheet_pct', 'type': 'float'},

            {'name': 'BOBSTAY_load_tf', 'type': 'float'},
            {'name': 'SHRD_lwr_lwd_tf', 'type': 'float'},
            {'name': 'SHRD_lwr_wwd_tf', 'type': 'float'},
            {'name': 'SHRD_upr_lwd_tf', 'type': 'float'},
            {'name': 'SHRD_upr_wwd_tf', 'type': 'float'},
            {'name': 'RIG_load_tf', 'type': 'float'},

            {'name': 'ANGLE_CANT_STOW_TARG_UW_deg', 'type': 'float'},
            {'name': 'ANGLE_CANT_STOW_TARG_DW_deg', 'type': 'float'},

            {'name': 'Phase_id', 'type': 'int'},
            {'name': 'Period_id', 'type': 'int'},
            {'name': 'Race_number', 'type': 'int'},
            {'name': 'Leg_number', 'type': 'int'},
            {'name': 'Wing_code', 'type': 'string'},
            {'name': 'Headsail_code', 'type': 'string'},
            {'name': 'Daggerboard_code', 'type': 'string'},
            {'name': 'Rudder_code', 'type': 'string'},
            {'name': 'Crew_count', 'type': 'int'},
            {'name': 'Config_code', 'type': 'string'},
            {'name': 'Foiling_state', 'type': 'int'},
            {'name': 'Grade', 'type': 'int'}
        ]

        dfi = u.get_channel_values(api_token, class_name, project_id, date, source_name, channels, '100ms', start_ts, end_ts, 'UTC')

        if dfi is not None and len(dfi) > 0:
            # Rename corrected (_cor) channels to standard names so rest of code is unchanged
            cor_to_standard = {
                'Tws_cor_kph': 'Tws_kph',
                'Twd_cor_deg': 'Twd_deg',
                'Twa_cor_deg': 'Twa_deg',
                'Twa_n_cor_deg': 'Twa_n_deg',
                'Awa_cor_deg': 'Awa_deg',
                'Awa_n_cor_deg': 'Awa_n_deg',
                'Aws_cor_kph': 'Aws_kph',
                'Lwy_cor_deg': 'Lwy_deg',
                'Lwy_n_cor_deg': 'Lwy_n_deg',
                'Cwa_cor_deg': 'Cwa_deg',
                'Cwa_n_cor_deg': 'Cwa_n_deg',
                'Vmg_cor_kph': 'Vmg_kph',
                'Vmg_cor_perc': 'Vmg_perc',

                # Per-sensor corrected (bow/mhu)
                'Tws_bow_cor_kph': 'Tws_bow_kph',
                'Tws_mhu_cor_kph': 'Tws_mhu_kph',
                'Twd_bow_cor_deg': 'Twd_bow_deg',
                'Twd_mhu_cor_deg': 'Twd_mhu_deg',
                'Awa_bow_cor_deg': 'Awa_bow_deg',
                'Awa_mhu_cor_deg': 'Awa_mhu_deg',
                'Aws_bow_cor_kph': 'Aws_bow_kph',
                'Aws_mhu_cor_kph': 'Aws_mhu_kph',

                'Bsp_tgt_cor_kph': 'Bsp_tgt_kph',
            }
            rename_map = {k: v for k, v in cor_to_standard.items() if k in dfi.columns}
            if rename_map:
                dfi.rename(columns=rename_map, inplace=True)

            if 'Cur_rate_est_kph' not in dfi.columns:
                dfi['Cur_rate_est_kph'] = 0
            if 'Cur_dir_est_deg' not in dfi.columns:
                dfi['Cur_dir_est_deg'] = 0

            if 'Cwa_deg' not in dfi.columns and 'Twa_deg' in dfi.columns:
                dfi['Cwa_deg'] = dfi['Twa_deg']
            
            if verbose:
                print('data retrieved:',len(dfi),'records found', flush=True)

            return dfi
        else:
            return df
    except Exception as e:
        u.log(api_token, "Performance.py", "error", "get_data", str(e))
        return df

#COMPUTE STATS 
def computeStats(api_token, verbose, class_name, project_id, dataset_id, event_type, df):
    if verbose:
        print('Computing stats: '+str(event_type), flush=True)  

    u.log(api_token, "Performance.py", "info", "computing stats", str(event_type))
                                
    res = u.get_api_data(api_token, ":8069/api/events/info?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id)+"&event_type="+str(event_type)+"&timezone=UTC")
    
    try:
        if res["success"]:
            json_data = res["data"]

            # Initialize batching for AVG
            jsonrows_avg = {} 
            jsonrows_avg["rows"] = [] 
            counter_avg = 0
            batch_avg = 0

            # Initialize batching for STD
            jsonrows_std = {} 
            jsonrows_std["rows"] = [] 
            counter_std = 0
            batch_std = 0

            # Initialize batching for AAV
            jsonrows_aav = {} 
            jsonrows_aav["rows"] = [] 
            counter_aav = 0
            batch_aav = 0

            # Initialize batching for STD
            jsonrows_rtvr = {} 
            jsonrows_rtvr["rows"] = [] 
            counter_rtvr = 0
            batch_rtvr = 0

            for index, period in enumerate(json_data): 
                event_id = period['event_id']

                start_ts = u.get_timestamp_from_str(period['start_time'], force_utc=True)
                end_ts = u.get_timestamp_from_str(period['end_time'], force_utc=True)
                
                if start_ts is not None and end_ts is not None and not pd.isna(start_ts) and not pd.isna(end_ts):
                    dff = df.loc[(df['ts'] >= start_ts) & (df['ts'] < end_ts)].copy()
                    # PERIOD and BIN 10 are defined by Grade > 2; exclude grade 0 from aggregates
                    if event_type in ('PERIOD', 'BIN 10', 'BIN 5') and 'Grade' in dff.columns:
                        dff = dff.loc[dff['Grade'] > 2].copy()
                    if isinstance(dff, pd.DataFrame):
                        if len(dff) > 0:                      
                            #CALCULATE MEAN VALUES
                            # Use ts to calculate mean timestamp, then convert to UTC datetime string
                            # This avoids timezone issues with Datetime.mean() on timezone-aware columns
                            avg_ts = dff['ts'].mean()
                            avg_dt_obj = u.get_utc_datetime_from_ts(avg_ts)
                            avg_dt = avg_dt_obj.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
                            
                            Tws = dff['Tws_kph'].mean()
                            Tws_bow = dff['Tws_bow_kph'].mean() if 'Tws_bow_kph' in dff.columns else Tws
                            Tws_mhu = dff['Tws_mhu_kph'].mean() if 'Tws_mhu_kph' in dff.columns else Tws
                            cur_rate = dff['Cur_rate_est_kph'].mean()

                            Twd  = u.mean360(list(dff['Twd_deg']))
                            Twd_bow  = u.mean360(list(dff['Twd_bow_deg'])) if 'Twd_bow_deg' in dff.columns else Twd
                            Twd_mhu  = u.mean360(list(dff['Twd_mhu_deg'])) if 'Twd_mhu_deg' in dff.columns else Twd
                            cur_dir  = u.mean360(list(dff['Cur_dir_est_deg']))

                            Tws_delta  = u.angle_subtract(Twd_mhu, Twd_bow)
                            Twa_delta  = Tws_mhu - Tws_bow

                            Hdg  = u.mean360(list(dff['Hdg_deg']))
                            Cog  = u.mean360(list(dff['Cog_deg']))

                            Aws = dff['Aws_kph'].mean()
                            Awa = dff['Awa_deg'].mean()

                            # Twa = dff['Twa_deg'].mean()
                            # Cwa = dff['Cwa_deg'].mean()
                            Twa = u.angle_subtract(Twd_bow, Hdg)
                            Cwa = u.angle_subtract(Twd_bow, Cog)

                            if abs(Twa) < 90:
                                stow_tgt = dff['ANGLE_CANT_STOW_TARG_UW_deg'].mean()
                            else:
                                stow_tgt = dff['ANGLE_CANT_STOW_TARG_DW_deg'].mean()

                            Sog = dff['Sog_kph'].mean()
                            Bsp = dff['Bsp_kph'].mean()
                            Bsp_tgt = dff['Bsp_tgt_kph'].mean()
                            Twa_tgt = dff['Twa_tgt_deg'].mean()

                            Bsp_Perc = dff['Bsp_perc'].mean()
                            Polar_Perc = dff['Polar_perc'].mean()

                            # Vmg = dff['Vmg_kph'].mean()
                            Vmg = abs(Bsp * np.cos(np.radians(Cwa)))

                            # Vmg_tgt = dff['Vmg_tgt_kph'].mean()
                            # Vmg_Perc = dff['Vmg_perc'].mean()
                            Vmg_tgt = abs(Bsp_tgt * np.cos(np.radians(Twa_tgt)))
                            Vmg_Perc = Vmg / Vmg_tgt * 100

                            if Vmg_Perc > 150:
                                Vmg_Perc = dff['Vmg_perc'].mean()

                            Pitch = dff['Pitch_deg'].mean()
                            Heel_n = dff['Heel_n_deg'].mean()
                            Lwy_n = dff['Lwy_n_deg'].mean() if 'Lwy_n_deg' in dff.columns else 0.0

                            Pitch_rate = dff['Pitch_rate_dps'].mean()
                            Yaw_rate = dff['Yaw_rate_n_dps'].mean()
                            Roll_rate = dff['Roll_rate_n_dps'].mean()
                            Accel = dff['Accel_rate_mps2'].mean()

                            RH_lwd = dff['RH_lwd_mm'].mean()
                            RH_wwd = dff['RH_wwd_mm'].mean()
                            RH_bow = dff['RH_bow_mm'].mean()

                            RUD_ang = dff['RUD_ang_n_deg'].mean()
                            RUD_rake = dff['RUD_rake_ang_deg'].mean()
                            RUD_diff = dff['RUD_diff_ang_deg'].mean()
                            DB_rake_lwd = dff['DB_rake_ang_lwd_deg'].mean()
                            DB_rake_aoa_lwd = dff['DB_rake_aoa_lwd_deg'].mean()
                            DB_cant_lwd = dff['DB_cant_lwd_deg'].mean()
                            DB_cant_eff_lwd = dff['DB_cant_eff_lwd_deg'].mean()

                            DB_imm_lwd = dff['DB_imm_lwd_mm'].mean()
                            DB_piercing_lwd = dff['DB_piercing_lwd_mm'].mean()
                            RUD_imm_lwd = dff['RUD_imm_lwd_mm'].mean()
                            RUD_imm_wwd = dff['RUD_imm_wwd_mm'].mean()
                            RUD_imm_tot = dff['RUD_imm_tot_mm'].mean()

                            CA1_ang = dff['CA1_ang_n_deg'].mean()
                            CA2_ang = dff['CA2_ang_n_deg'].mean()
                            CA3_ang = dff['CA3_ang_n_deg'].mean()
                            CA4_ang = dff['CA4_ang_n_deg'].mean()
                            CA5_ang = dff['CA5_ang_n_deg'].mean()
                            CA6_ang = dff['CA6_ang_n_deg'].mean()
                            WING_twist = dff['WING_twist_n_deg'].mean()
                            WING_rot = dff['WING_rot_n_deg'].mean()
                            WING_aoa = dff['WING_aoa_n_deg'].mean()
                            WING_clew_pos = dff['WING_clew_pos_n_mm'].mean()

                            JIB_sheet_load = dff['JIB_sheet_load_kgf'].mean()
                            JIB_cunno_load = dff['JIB_cunno_load_kgf'].mean()
                            JIB_lead_ang = dff['JIB_lead_ang_deg'].mean()
                            JIB_sheet_pct = dff['JIB_sheet_pct'].mean()

                            BOBSTAY_load = dff['BOBSTAY_load_tf'].mean()
                            SHRD_lwr_lwd = dff['SHRD_lwr_lwd_tf'].mean()
                            SHRD_lwr_wwd = dff['SHRD_lwr_wwd_tf'].mean()
                            SHRD_upr_lwd = dff['SHRD_upr_lwd_tf'].mean()
                            SHRD_upr_wwd = dff['SHRD_upr_wwd_tf'].mean()
                            RIG_load = dff['RIG_load_tf'].mean()
                            
                            Foiling = dff['Foiling_state'].max()
                            
                            channelinfo_avg = {}
                            channelinfo_avg['event_id'] = int(event_id)
                            channelinfo_avg['agr_type'] = 'AVG'
                            channelinfo_avg['Datetime'] = avg_dt
                            channelinfo_avg['Tws_kph'] = float(round(Tws, 3))
                            channelinfo_avg['Tws_bow_kph'] = float(round(Tws_bow, 3))
                            channelinfo_avg['Tws_mhu_kph'] = float(round(Tws_mhu, 3))
                            channelinfo_avg['Twd_deg'] = float(round(Twd, 3))
                            channelinfo_avg['Twd_bow_deg'] = float(round(Twd_bow, 3))
                            channelinfo_avg['Cur_rate_est_kph'] = float(round(cur_rate, 3))
                            channelinfo_avg['Cur_dir_est_deg'] = float(round(cur_dir, 3))
                            channelinfo_avg['Tws_delta_kph'] = float(round(Tws_delta, 3))
                            channelinfo_avg['Twa_delta_deg'] = float(round(Twa_delta, 3))
                            channelinfo_avg['Aws_kph'] = float(round(Aws, 3))
                            channelinfo_avg['Awa_deg'] = float(round(Awa, 3))
                            channelinfo_avg['Awa_n_deg'] = float(round(abs(Awa), 3))
                            channelinfo_avg['Twa_deg'] = float(round(Twa, 3))
                            channelinfo_avg['Twa_n_deg'] = float(round(abs(Twa), 3))
                            channelinfo_avg['Twa_tgt_deg'] = float(round(abs(Twa_tgt), 3))
                            channelinfo_avg['Cwa_deg'] = float(round(Cwa, 3))
                            channelinfo_avg['Cwa_n_deg'] = float(round(abs(Cwa), 3))
                            channelinfo_avg['Hdg_deg'] = float(round(Hdg, 3))
                            channelinfo_avg['Cog_deg'] = float(round(Cog, 3))
                            channelinfo_avg['Sog_kph'] = float(round(Sog, 3))
                            channelinfo_avg['Bsp_kph'] = float(round(Bsp, 3))
                            channelinfo_avg['Bsp_tgt_kph'] = float(round(Bsp_tgt, 3))
                            channelinfo_avg['Bsp_perc'] = float(round(Bsp_Perc, 3))
                            channelinfo_avg['Bsp_polar_perc'] = float(round(Polar_Perc, 3))
                            channelinfo_avg['Vmg_kph'] = float(round(Vmg, 3))
                            channelinfo_avg['Vmg_tgt_kph'] = float(round(Vmg_tgt, 3))
                            channelinfo_avg['Vmg_perc'] = float(round(Vmg_Perc, 3))
                            channelinfo_avg['Pitch_deg'] = float(round(Pitch, 3))
                            channelinfo_avg['Heel_n_deg'] = float(round(Heel_n, 3))
                            channelinfo_avg['Lwy_n_deg'] = float(round(Lwy_n, 3))
                            channelinfo_avg['Pitch_rate_dps'] = float(round(Pitch_rate, 3))
                            channelinfo_avg['Yaw_rate_n_dps'] = float(round(Yaw_rate, 3))
                            channelinfo_avg['Roll_rate_n_dps'] = float(round(Roll_rate, 3))
                            channelinfo_avg['Accel_rate_mps2'] = float(round(Accel, 3))
                            channelinfo_avg['RH_lwd_mm'] = float(round(RH_lwd, 3))
                            channelinfo_avg['RH_wwd_mm'] = float(round(RH_wwd, 3))
                            channelinfo_avg['RH_bow_mm'] = float(round(RH_bow, 3))
                            channelinfo_avg['RUD_ang_n_deg'] = float(round(RUD_ang, 3))
                            channelinfo_avg['RUD_rake_ang_deg'] = float(round(RUD_rake, 3))
                            channelinfo_avg['RUD_diff_ang_deg'] = float(round(RUD_diff, 3))
                            channelinfo_avg['DB_rake_ang_lwd_deg'] = float(round(DB_rake_lwd, 3))
                            channelinfo_avg['DB_rake_aoa_lwd_deg'] = float(round(DB_rake_aoa_lwd, 3))
                            channelinfo_avg['DB_cant_lwd_deg'] = float(round(DB_cant_lwd, 3))
                            channelinfo_avg['DB_cant_eff_lwd_deg'] = float(round(DB_cant_eff_lwd, 3))
                            channelinfo_avg['DB_cant_stow_tgt_deg'] = int(round(stow_tgt, 3))
                            channelinfo_avg['DB_imm_lwd_mm'] = float(round(DB_imm_lwd, 3))
                            channelinfo_avg['DB_piercing_lwd_mm'] = float(round(DB_piercing_lwd, 3))
                            channelinfo_avg['RUD_imm_lwd_mm'] = float(round(RUD_imm_lwd, 3))
                            channelinfo_avg['RUD_imm_wwd_mm'] = float(round(RUD_imm_wwd, 3))
                            channelinfo_avg['RUD_imm_tot_mm'] = float(round(RUD_imm_tot, 3))
                            channelinfo_avg['CA1_ang_n_deg'] = float(round(CA1_ang, 3))
                            channelinfo_avg['CA2_ang_n_deg'] = float(round(CA2_ang, 3))
                            channelinfo_avg['CA3_ang_n_deg'] = float(round(CA3_ang, 3))
                            channelinfo_avg['CA4_ang_n_deg'] = float(round(CA4_ang, 3))
                            channelinfo_avg['CA5_ang_n_deg'] = float(round(CA5_ang, 3))
                            channelinfo_avg['CA6_ang_n_deg'] = float(round(CA6_ang, 3))
                            channelinfo_avg['WING_twist_n_deg'] = float(round(WING_twist, 3))
                            channelinfo_avg['WING_rot_n_deg'] = float(round(WING_rot, 3))
                            channelinfo_avg['WING_aoa_n_deg'] = float(round(WING_aoa, 3))
                            channelinfo_avg['WING_clew_pos_mm'] = float(round(WING_clew_pos, 3))
                            channelinfo_avg['JIB_sheet_load_kgf'] = float(round(JIB_sheet_load, 3))
                            channelinfo_avg['JIB_cunno_load_kgf'] = float(round(JIB_cunno_load, 3))
                            channelinfo_avg['JIB_lead_ang_deg'] = float(round(JIB_lead_ang, 3))
                            channelinfo_avg['JIB_sheet_pct'] = float(round(JIB_sheet_pct, 3))
                            channelinfo_avg['BOBSTAY_load_tf'] = float(round(BOBSTAY_load, 3))
                            channelinfo_avg['SHRD_lwr_lwd_tf'] = float(round(SHRD_lwr_lwd, 3))
                            channelinfo_avg['SHRD_lwr_wwd_tf'] = float(round(SHRD_lwr_wwd, 3))
                            channelinfo_avg['SHRD_upr_lwd_tf'] = float(round(SHRD_upr_lwd, 3))
                            channelinfo_avg['SHRD_upr_wwd_tf'] = float(round(SHRD_upr_wwd, 3))
                            channelinfo_avg['RIG_load_tf'] = float(round(RIG_load, 3))
                            channelinfo_avg['Foiling_state'] = int(round(Foiling, 0))  # Foiling_state should be int
                            
                            jsonrows_avg["rows"].append(channelinfo_avg)
                            counter_avg += 1
                            
                            # Check if we should send AVG batch
                            if (counter_avg >= 10 or index == len(json_data)-1):
                                batch_avg += 1 
                                jsonrows_str_avg = json.dumps(jsonrows_avg) 

                                jsondata_avg = {}
                                jsondata_avg["class_name"] = str(class_name)
                                jsondata_avg["project_id"] = int(project_id)
                                jsondata_avg["table"] = "events_aggregate"
                                jsondata_avg["json"] = jsonrows_str_avg 

                                res_avg = u.post_api_data(api_token, ":8059/api/events/aggregates", jsondata_avg)

                                if verbose:
                                    if res_avg["success"]:
                                        print("AVG batch "+str(batch_avg)+" added!", flush=True) 
                                    else: 
                                        print("AVG batch failed!"+str(res_avg), flush=True)  

                                jsonrows_avg["rows"] = [] 
                                counter_avg = 0
                            
                            #CALCULATE STDEV VALUES
                            Tws = dff['Tws_kph'].std()
                            Twd = u.std360(list(dff['Twd_deg']))
                            Hdg = u.std360(list(dff['Hdg_deg']))

                            Bsp = dff['Bsp_kph'].std()
                            Twa = dff['Twa_n_deg'].std()
                            Vmg = dff['Vmg_kph'].std()
                            
                            Pitch = dff['Pitch_deg'].std()
                            Heel_n = dff['Heel_n_deg'].std()
                            Lwy_n = dff['Lwy_n_deg'].std() if 'Lwy_n_deg' in dff.columns else 0.0

                            RH_lwd = dff['RH_lwd_mm'].std()
                            DB_imm_lwd = dff['DB_imm_lwd_mm'].std()
                            DB_piercing_lwd = dff['DB_piercing_lwd_mm'].std()

                            Rud_ang = dff['RUD_ang_n_deg'].std()
                            Rud_rake = dff['RUD_rake_ang_deg'].std()
                            Rud_diff = dff['RUD_diff_ang_deg'].std()

                            Jib_cunno = dff['JIB_cunno_load_kgf'].std()
                            Jib_sheet = dff['JIB_sheet_pct'].std()
                            Jib_lead = dff['JIB_lead_ang_deg'].std()

                            Wing_camber = dff['CA1_ang_n_deg'].std()
                            Wing_twist = dff['WING_twist_n_deg'].std()
                            Wing_clew = dff['WING_clew_pos_n_mm'].std()

                            DB_cant = dff['DB_cant_lwd_deg'].std()
                            DB_rake = dff['DB_rake_ang_lwd_deg'].std()
                            DB_rake_aoa = dff['DB_rake_aoa_lwd_deg'].std()
                            
                            channelinfo_std = {}
                            channelinfo_std['event_id'] = int(event_id)
                            channelinfo_std['agr_type'] = 'STD'
                            channelinfo_std['Datetime'] = avg_dt
                            channelinfo_std['Tws_kph'] = float(round(Tws, 3))
                            channelinfo_std['Twd_deg'] = float(round(Twd, 3))
                            channelinfo_std['Hdg_deg'] = float(round(Hdg, 3))
                            channelinfo_std['Bsp_kph'] = float(round(Bsp, 3))
                            channelinfo_std['Vmg_kph'] = float(round(Vmg, 3))
                            channelinfo_std['Twa_n_deg'] = float(round(Twa, 3))
                            channelinfo_std['Pitch_deg'] = float(round(Pitch, 3))
                            channelinfo_std['Heel_n_deg'] = float(round(Heel_n, 3))
                            channelinfo_std['Lwy_n_deg'] = float(round(Lwy_n, 3))
                            channelinfo_std['RUD_ang_n_deg'] = float(round(Rud_ang, 3))
                            channelinfo_std['RUD_rake_ang_deg'] = float(round(Rud_rake, 3))
                            channelinfo_std['RUD_diff_ang_deg'] = float(round(Rud_diff, 3))
                            channelinfo_std['RH_lwd_mm'] = float(round(RH_lwd, 3))
                            channelinfo_std['DB_imm_lwd_mm'] = float(round(DB_imm_lwd, 3))
                            channelinfo_std['DB_piercing_lwd_mm'] = float(round(DB_piercing_lwd, 3))
                            channelinfo_std['JIB_cunno_load_kgf'] = float(round(Jib_cunno, 3))
                            channelinfo_std['JIB_sheet_pct'] = float(round(Jib_sheet, 3))
                            channelinfo_std['JIB_lead_ang_deg'] = float(round(Jib_lead, 3))
                            channelinfo_std['CA1_ang_n_deg'] = float(round(Wing_camber, 3))
                            channelinfo_std['WING_twist_n_deg'] = float(round(Wing_twist, 3))
                            channelinfo_std['WING_clew_pos_mm'] = float(round(Wing_clew, 3))
                            channelinfo_std['DB_cant_lwd_deg'] = float(round(DB_cant, 3))
                            channelinfo_std['DB_rake_ang_lwd_deg'] = float(round(DB_rake, 3))
                            channelinfo_std['DB_rake_aoa_lwd_deg'] = float(round(DB_rake_aoa, 3))
                            
                            jsonrows_std["rows"].append(channelinfo_std)
                            counter_std += 1
                            
                            # Check if we should send STD batch
                            if (counter_std >= 10 or index == len(json_data)-1):
                                batch_std += 1 
                                jsonrows_str_std = json.dumps(jsonrows_std) 

                                jsondata_std = {}
                                jsondata_std["class_name"] = str(class_name)
                                jsondata_std["project_id"] = int(project_id)
                                jsondata_std["table"] = "events_aggregate"
                                jsondata_std["json"] = jsonrows_str_std 

                                res_std = u.post_api_data(api_token, ":8059/api/events/aggregates", jsondata_std)

                                if verbose:
                                    if res_std["success"]:
                                        print("STD batch "+str(batch_std)+" added!", flush=True) 
                                    else: 
                                        print("STD batch failed!"+str(res_std), flush=True)  

                                jsonrows_std["rows"] = [] 
                                counter_std = 0

                            #CALCULATE AAV VALUES
                            Tws = u.aav(list(dff['Tws_kph']), 10)
                            Twd = u.aav(list(dff['Twd_deg']), 10)
                            Hdg = u.aav(list(dff['Hdg_deg']), 10)

                            Bsp = u.aav(list(dff['Bsp_kph']), 10)
                            Twa = u.aav(list(dff['Twa_n_deg']), 10)
                            Vmg = u.aav(list(dff['Vmg_kph']), 10)
                            
                            Pitch = u.aav(list(dff['Pitch_deg']), 10)
                            Heel_n = u.aav(list(dff['Heel_n_deg']), 10)
                            Lwy_n = u.aav(list(dff['Lwy_n_deg']), 10) if 'Lwy_n_deg' in dff.columns else 0.0

                            RH_lwd = u.aav(list(dff['RH_lwd_mm']), 10)
                            DB_imm_lwd = u.aav(list(dff['DB_imm_lwd_mm']), 10)
                            DB_piercing_lwd = u.aav(list(dff['DB_piercing_lwd_mm']), 10)

                            Rud_ang = u.aav(list(dff['RUD_ang_n_deg']), 10)
                            Rud_rake = u.aav(list(dff['RUD_rake_ang_deg']), 10)
                            Rud_diff = u.aav(list(dff['RUD_diff_ang_deg']), 10)

                            Jib_cunno = u.aav(list(dff['JIB_cunno_load_kgf']), 10)
                            Jib_sheet = u.aav(list(dff['JIB_sheet_pct']), 10)
                            Jib_lead = u.aav(list(dff['JIB_lead_ang_deg']), 10)

                            Wing_camber = u.aav(list(dff['CA1_ang_n_deg']), 10)
                            Wing_twist = u.aav(list(dff['WING_twist_n_deg']), 10)
                            Wing_clew = u.aav(list(dff['WING_clew_pos_n_mm']), 10)

                            DB_cant = u.aav(list(dff['DB_cant_lwd_deg']), 10)
                            DB_rake = u.aav(list(dff['DB_rake_ang_lwd_deg']), 10)
                            DB_rake_aoa = u.aav(list(dff['DB_rake_aoa_lwd_deg']), 10)
                            
                            channelinfo_aav = {}
                            channelinfo_aav['event_id'] = int(event_id)
                            channelinfo_aav['agr_type'] = 'AAV'
                            channelinfo_aav['Datetime'] = avg_dt
                            channelinfo_aav['Tws_kph'] = float(round(Tws, 3))
                            channelinfo_aav['Twd_deg'] = float(round(Twd, 3))
                            channelinfo_aav['Hdg_deg'] = float(round(Hdg, 3))
                            channelinfo_aav['Bsp_kph'] = float(round(Bsp, 3))
                            channelinfo_aav['Vmg_kph'] = float(round(Vmg, 3))
                            channelinfo_aav['Twa_n_deg'] = float(round(Twa, 3))
                            channelinfo_aav['Pitch_deg'] = float(round(Pitch, 3))
                            channelinfo_aav['Heel_n_deg'] = float(round(Heel_n, 3))
                            channelinfo_aav['Lwy_n_deg'] = float(round(Lwy_n, 3))
                            channelinfo_aav['RUD_ang_n_deg'] = float(round(Rud_ang, 3))
                            channelinfo_aav['RUD_rake_ang_deg'] = float(round(Rud_rake, 3))
                            channelinfo_aav['RUD_diff_ang_deg'] = float(round(Rud_diff, 3))
                            channelinfo_aav['RH_lwd_mm'] = float(round(RH_lwd, 3))
                            channelinfo_aav['DB_imm_lwd_mm'] = float(round(DB_imm_lwd, 3))
                            channelinfo_aav['DB_piercing_lwd_mm'] = float(round(DB_piercing_lwd, 3))
                            channelinfo_aav['JIB_cunno_load_kgf'] = float(round(Jib_cunno, 3))
                            channelinfo_aav['JIB_sheet_pct'] = float(round(Jib_sheet, 3))
                            channelinfo_aav['JIB_lead_ang_deg'] = float(round(Jib_lead, 3))
                            channelinfo_aav['CA1_ang_n_deg'] = float(round(Wing_camber, 3))
                            channelinfo_aav['WING_twist_n_deg'] = float(round(Wing_twist, 3))
                            channelinfo_aav['WING_clew_pos_mm'] = float(round(Wing_clew, 3))
                            channelinfo_aav['DB_cant_lwd_deg'] = float(round(DB_cant, 3))
                            channelinfo_aav['DB_rake_ang_lwd_deg'] = float(round(DB_rake, 3))
                            channelinfo_aav['DB_rake_aoa_lwd_deg'] = float(round(DB_rake_aoa, 3))
                            
                            jsonrows_aav["rows"].append(channelinfo_aav)
                            counter_aav += 1
                            
                            # Check if we should send AAV batch
                            if (counter_aav >= 10 or index == len(json_data)-1):
                                batch_aav += 1 
                                jsonrows_str_aav = json.dumps(jsonrows_aav) 

                                jsondata_aav = {}
                                jsondata_aav["class_name"] = str(class_name)
                                jsondata_aav["project_id"] = int(project_id)
                                jsondata_aav["table"] = "events_aggregate"
                                jsondata_aav["json"] = jsonrows_str_aav 

                                res_aav = u.post_api_data(api_token, ":8059/api/events/aggregates", jsondata_aav)

                                if verbose:
                                    if res_aav["success"]:
                                        print("AAV batch "+str(batch_aav)+" added!", flush=True) 
                                    else: 
                                        print("AAV batch failed!"+str(res_aav), flush=True)  

                                jsonrows_aav["rows"] = [] 
                                counter_aav = 0

                            #CALCULATE ROBUST TOTAL VARIATIONS VALUES (rTVR)
                            Tws = u.rtvr(list(dff['Tws_kph']), 10)
                            Twd = u.rtvr(list(dff['Twd_deg']), 10)
                            Hdg = u.rtvr(list(dff['Hdg_deg']), 10)

                            Bsp = u.rtvr(list(dff['Bsp_kph']), 10)
                            Twa = u.rtvr(list(dff['Twa_n_deg']), 10)
                            Vmg = u.rtvr(list(dff['Vmg_kph']), 10)
                            
                            Pitch = u.rtvr(list(dff['Pitch_deg']), 10)
                            Heel_n = u.rtvr(list(dff['Heel_n_deg']), 10)
                            Lwy_n = u.rtvr(list(dff['Lwy_n_deg']), 10) if 'Lwy_n_deg' in dff.columns else 0.0

                            RH_lwd = u.rtvr(list(dff['RH_lwd_mm']), 10)
                            DB_imm_lwd = u.rtvr(list(dff['DB_imm_lwd_mm']), 10)
                            DB_piercing_lwd = u.rtvr(list(dff['DB_piercing_lwd_mm']), 10)

                            Rud_ang = u.rtvr(list(dff['RUD_ang_n_deg']), 10)
                            Rud_rake = u.rtvr(list(dff['RUD_rake_ang_deg']), 10)
                            Rud_diff = u.rtvr(list(dff['RUD_diff_ang_deg']), 10)

                            Jib_cunno = u.rtvr(list(dff['JIB_cunno_load_kgf']), 10)
                            Jib_sheet = u.rtvr(list(dff['JIB_sheet_pct']), 10)
                            Jib_lead = u.rtvr(list(dff['JIB_lead_ang_deg']), 10)

                            Wing_camber = u.rtvr(list(dff['CA1_ang_n_deg']), 10)
                            Wing_twist = u.rtvr(list(dff['WING_twist_n_deg']), 10)
                            Wing_clew = u.rtvr(list(dff['WING_clew_pos_n_mm']), 10)

                            DB_cant = u.rtvr(list(dff['DB_cant_lwd_deg']), 10)
                            DB_rake = u.rtvr(list(dff['DB_rake_ang_lwd_deg']), 10)
                            DB_rake_aoa = u.rtvr(list(dff['DB_rake_aoa_lwd_deg']), 10)
                            
                            channelinfo_rtvr = {}
                            channelinfo_rtvr['event_id'] = int(event_id)
                            channelinfo_rtvr['agr_type'] = 'RTVR'
                            channelinfo_rtvr['Datetime'] = avg_dt
                            channelinfo_rtvr['Tws_kph'] = float(round(Tws, 3))
                            channelinfo_rtvr['Twd_deg'] = float(round(Twd, 3))
                            channelinfo_rtvr['Hdg_deg'] = float(round(Hdg, 3))
                            channelinfo_rtvr['Bsp_kph'] = float(round(Bsp, 3))
                            channelinfo_rtvr['Vmg_kph'] = float(round(Vmg, 3))
                            channelinfo_rtvr['Twa_n_deg'] = float(round(Twa, 3))
                            channelinfo_rtvr['Pitch_deg'] = float(round(Pitch, 3))
                            channelinfo_rtvr['Heel_n_deg'] = float(round(Heel_n, 3))
                            channelinfo_rtvr['Lwy_n_deg'] = float(round(Lwy_n, 3))
                            channelinfo_rtvr['RUD_ang_n_deg'] = float(round(Rud_ang, 3))
                            channelinfo_rtvr['RUD_rake_ang_deg'] = float(round(Rud_rake, 3))
                            channelinfo_rtvr['RUD_diff_ang_deg'] = float(round(Rud_diff, 3))
                            channelinfo_rtvr['RH_lwd_mm'] = float(round(RH_lwd, 3))
                            channelinfo_rtvr['DB_imm_lwd_mm'] = float(round(DB_imm_lwd, 3))
                            channelinfo_rtvr['DB_piercing_lwd_mm'] = float(round(DB_piercing_lwd, 3))
                            channelinfo_rtvr['JIB_cunno_load_kgf'] = float(round(Jib_cunno, 3))
                            channelinfo_rtvr['JIB_sheet_pct'] = float(round(Jib_sheet, 3))
                            channelinfo_rtvr['JIB_lead_ang_deg'] = float(round(Jib_lead, 3))
                            channelinfo_rtvr['CA1_ang_n_deg'] = float(round(Wing_camber, 3))
                            channelinfo_rtvr['WING_twist_n_deg'] = float(round(Wing_twist, 3))
                            channelinfo_rtvr['WING_clew_pos_mm'] = float(round(Wing_clew, 3))
                            channelinfo_rtvr['DB_cant_lwd_deg'] = float(round(DB_cant, 3))
                            channelinfo_rtvr['DB_rake_ang_lwd_deg'] = float(round(DB_rake, 3))
                            channelinfo_rtvr['DB_rake_aoa_lwd_deg'] = float(round(DB_rake_aoa, 3))
                            
                            jsonrows_rtvr["rows"].append(channelinfo_rtvr)
                            counter_rtvr += 1
                            
                            # Check if we should send RTVR batch
                            if (counter_rtvr >= 10 or index == len(json_data)-1):
                                batch_rtvr += 1 
                                jsonrows_str_rtvr = json.dumps(jsonrows_rtvr) 

                                jsondata_rtvr = {}
                                jsondata_rtvr["class_name"] = str(class_name)
                                jsondata_rtvr["project_id"] = int(project_id)
                                jsondata_rtvr["table"] = "events_aggregate"
                                jsondata_rtvr["json"] = jsonrows_str_rtvr 

                                res_rtvr = u.post_api_data(api_token, ":8059/api/events/aggregates", jsondata_rtvr)

                                if verbose:
                                    if res_rtvr["success"]:
                                        print("RTVR batch "+str(batch_rtvr)+" added!", flush=True) 
                                    else: 
                                        print("RTVR batch failed!"+str(res_rtvr), flush=True)  

                                jsonrows_rtvr["rows"] = [] 
                                counter_rtvr = 0
    except Exception as e:
        u.log(api_token, "Performance.py", "error", "computeStats", str(e))

#COMPUTE CLOUD 
def computeCloud(api_token, verbose, class_name, project_id, dataset_id, event_type, df):
    if verbose:
        print('Computing Cloud: '+str(event_type), flush=True)  

    u.log(api_token, "Performance.py", "info", "computing cloud", str(event_type)) 
                                
    res = u.get_api_data(api_token, ":8069/api/events/info?class_name="+str(class_name)+"&project_id="+str(project_id)+"&dataset_id="+str(dataset_id)+"&event_type="+str(event_type)+"&timezone=UTC")
    
    try:
        if res["success"]:
            json_data = res["data"]

            batch = 0
            for period in json_data: 
                event_id = period['event_id']

                start_ts = u.get_timestamp_from_str(period['start_time'], force_utc=True)
                end_ts = u.get_timestamp_from_str(period['end_time'], force_utc=True)
                
                if start_ts is not None and end_ts is not None and not pd.isna(start_ts) and not pd.isna(end_ts):
                    dff = df.loc[(df['ts'] >= start_ts) & (df['ts'] < end_ts)].copy()
                                
                    if isinstance(dff, pd.DataFrame):
                        if len(dff) > 0:     
                            jsonrows = {} 
                            jsonrows["rows"] = [] 
                            counter = 0

                            for index, row in dff.iterrows():
                                dt_str = str(row['Datetime'])                           
                            
                                channelinfo = {}
                                channelinfo['Datetime'] = dt_str
                                channelinfo['Tws_kph'] = float(round(row.get('Tws_kph', 0), 3))
                                channelinfo['Tws_bow_kph'] = float(round(row.get('Tws_bow_kph', 0), 3))
                                channelinfo['Tws_mhu_kph'] = float(round(row.get('Tws_mhu_kph', 0), 3))
                                channelinfo['Twd_deg'] = float(round(row.get('Twd_deg', 0), 3))
                                channelinfo['Twd_bow_deg'] = float(round(row.get('Twd_bow_deg', 0), 3))
                                channelinfo['Twd_mhu_deg'] = float(round(row.get('Twd_mhu_deg', 0), 3))
                                channelinfo['Tws_delta_kph'] = float(round(row.get('Tws_delta_kph', 0), 3))
                                channelinfo['Twa_delta_deg'] = float(round(row.get('Twa_delta_deg', 0), 3))
                                channelinfo['Aws_kph'] = float(round(row.get('Aws_kph', 0), 3))
                                channelinfo['Awa_deg'] = float(round(row.get('Awa_n_deg', 0), 3))
                                channelinfo['Awa_n_deg'] = float(round(abs(row.get('Awa_n_deg', 0)), 3))
                                channelinfo['Twa_deg'] = float(round(row.get('Twa_deg', 0), 3))
                                channelinfo['Twa_n_deg'] = float(round(abs(row.get('Twa_deg', 0)), 3))
                                channelinfo['Cwa_deg'] = float(round(row.get('Cwa_deg', 0), 3))
                                channelinfo['Cwa_n_deg'] = float(round(abs(row.get('Cwa_deg', 0)), 3))
                                channelinfo['Hdg_deg'] = float(round(row.get('Hdg_deg', 0), 3))
                                channelinfo['Cog_deg'] = float(round(row.get('Cog_deg', 0), 3))
                                channelinfo['Sog_kph'] = float(round(row.get('Sog_kph', 0), 3))
                                channelinfo['Bsp_kph'] = float(round(row.get('Bsp_kph', 0), 3))
                                channelinfo['Bsp_tgt_kph'] = float(round(row.get('Bsp_tgt_kph', 0), 3))
                                channelinfo['Bsp_perc'] = float(round(row.get('Bsp_perc', 0), 3))
                                channelinfo['Vmg_kph'] = float(round(row.get('Vmg_kph', 0), 3))
                                channelinfo['Vmg_tgt_kph'] = float(round(row.get('Vmg_tgt_kph', 0), 3))
                                channelinfo['Vmg_perc'] = float(round(row.get('Vmg_perc', 0), 3))
                                channelinfo['Pitch_deg'] = float(round(row.get('Pitch_deg', 0), 3))
                                channelinfo['Heel_n_deg'] = float(round(row.get('Heel_n_deg', 0), 3))
                                channelinfo['Lwy_n_deg'] = float(round(row.get('Lwy_n_deg', 0), 3))
                                channelinfo['Pitch_rate_dps'] = float(round(row.get('Pitch_rate_dps', 0), 3))
                                channelinfo['Yaw_rate_n_dps'] = float(round(row.get('Yaw_rate_n_dps', 0), 3))
                                channelinfo['Roll_rate_n_dps'] = float(round(row.get('Roll_rate_n_dps', 0), 3))
                                channelinfo['Accel_rate_mps2'] = float(round(row.get('Accel_rate_mps2', 0), 3))
                                channelinfo['RH_lwd_mm'] = float(round(row.get('RH_lwd_mm', 0), 3))
                                channelinfo['RH_wwd_mm'] = float(round(row.get('RH_wwd_mm', 0), 3))
                                channelinfo['RH_bow_mm'] = float(round(row.get('RH_bow_mm', 0), 3))
                                channelinfo['RUD_ang_n_deg'] = float(round(row.get('RUD_ang_n_deg', 0), 3))
                                channelinfo['RUD_rake_ang_deg'] = float(round(row.get('RUD_rake_ang_deg', 0), 3))
                                channelinfo['RUD_diff_ang_deg'] = float(round(row.get('RUD_diff_ang_deg', 0), 3))
                                channelinfo['DB_rake_ang_lwd_deg'] = float(round(row.get('DB_rake_ang_lwd_deg', 0), 3))
                                channelinfo['DB_rake_aoa_lwd_deg'] = float(round(row.get('DB_rake_aoa_lwd_deg', 0), 3))
                                channelinfo['DB_cant_lwd_deg'] = float(round(row.get('DB_cant_lwd_deg', 0), 3))
                                channelinfo['DB_cant_eff_lwd_deg'] = float(round(row.get('DB_cant_eff_lwd_deg', 0), 3))
                                channelinfo['DB_imm_lwd_mm'] = float(round(row.get('DB_imm_lwd_mm', 0), 3))
                                channelinfo['DB_piercing_lwd_mm'] = float(round(row.get('DB_piercing_lwd_mm', 0), 3))
                                channelinfo['RUD_imm_lwd_mm'] = float(round(row.get('RUD_imm_lwd_mm', 0), 3))
                                channelinfo['RUD_imm_wwd_mm'] = float(round(row.get('RUD_imm_wwd_mm', 0), 3))
                                channelinfo['RUD_imm_tot_mm'] = float(round(row.get('RUD_imm_tot_mm', 0), 3))
                                channelinfo['CA1_ang_n_deg'] = float(round(row.get('CA1_ang_n_deg', 0), 3))
                                channelinfo['CA2_ang_n_deg'] = float(round(row.get('CA2_ang_n_deg', 0), 3))
                                channelinfo['CA3_ang_n_deg'] = float(round(row.get('CA3_ang_n_deg', 0), 3))
                                channelinfo['CA4_ang_n_deg'] = float(round(row.get('CA4_ang_n_deg', 0), 3))
                                channelinfo['CA5_ang_n_deg'] = float(round(row.get('CA5_ang_n_deg', 0), 3))
                                channelinfo['CA6_ang_n_deg'] = float(round(row.get('CA6_ang_n_deg', 0), 3))
                                channelinfo['WING_twist_n_deg'] = float(round(row.get('WING_twist_n_deg', 0), 3))
                                channelinfo['WING_rot_n_deg'] = float(round(row.get('WING_rot_n_deg', 0), 3))
                                channelinfo['WING_aoa_n_deg'] = float(round(row.get('WING_aoa_n_deg', 0), 3))
                                channelinfo['WING_clew_pos_mm'] = float(round(row.get('WING_clew_pos_n_mm', 0), 3))
                                channelinfo['JIB_sheet_load_kgf'] = float(round(row.get('JIB_sheet_load_kgf', 0), 3))
                                channelinfo['JIB_cunno_load_kgf'] = float(round(row.get('JIB_cunno_load_kgf', 0), 3))
                                channelinfo['JIB_lead_ang_deg'] = float(round(row.get('JIB_lead_ang_deg', 0), 3))
                                channelinfo['JIB_sheet_pct'] = float(round(row.get('JIB_sheet_pct', 0), 3))
                                channelinfo['BOBSTAY_load_tf'] = float(round(row.get('BOBSTAY_load_tf', 0), 3))
                                channelinfo['SHRD_lwr_lwd_tf'] = float(round(row.get('SHRD_lwr_lwd_tf', 0), 3))
                                channelinfo['SHRD_lwr_wwd_tf'] = float(round(row.get('SHRD_lwr_wwd_tf', 0), 3))
                                channelinfo['SHRD_upr_lwd_tf'] = float(round(row.get('SHRD_upr_lwd_tf', 0), 3))
                                channelinfo['SHRD_upr_wwd_tf'] = float(round(row.get('SHRD_upr_wwd_tf', 0), 3))
                                channelinfo['RIG_load_tf'] = float(round(row.get('RIG_load_tf', 0), 3))
                                channelinfo['Foiling_state'] = int(round(row.get('Foiling_state', 0), 0))

                                jsonrows["rows"].append(channelinfo)
                                counter += 1
                                
                                if (counter >= 10 or index == len(dff)-1):
                                    batch += 1
                                    jsonrows_str = json.dumps(jsonrows) 

                                    jsondata = {}
                                    jsondata["class_name"] = str(class_name)
                                    jsondata["project_id"] = int(project_id)
                                    jsondata["table"] = "events_cloud"
                                    jsondata["event_id"] = int(event_id)
                                    jsondata["agr_type"] = str('NONE')
                                    jsondata["json"] = jsonrows_str 

                                    res = u.post_api_data(api_token, ":8059/api/events/rows", jsondata)
                                    if verbose:
                                        if res["success"]:
                                            print("Cloud batch "+str(batch)+" added!", flush=True) 
                                        else: 
                                            print("Cloud batch failed!"+str(res), flush=True)  

                                    jsonrows["rows"] = [] 
                                    counter = 0  
    except Exception as e:
        print('computeCloud exception: '+str(e), flush=True)
        u.log(api_token, "Performance.py", "error", "computeCloud", str(e))

# Helper function for batch event creation
def post_events_array(api_token, class_name, project_id, dataset_id, events_array):
    """Post an array of events to the API using the /array endpoint"""
    jsondata = {
        "class_name": class_name,
        "project_id": project_id,
        "dataset_id": dataset_id,
        "events": events_array
    }
    
    res = u.post_api_data(api_token, ":8059/api/events/array", jsondata)
    return res
                                               
#IDENTIFY EVENTS
def identifyEvents(api_token, verbose, class_name, project_id, dataset_id, df):  
    u.log(api_token, "Performance.py", "info", "identifying events", "starting...")

    # REMOVE EXISTING EVENTS
    jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "event_types": ["PHASE","PERIOD","BIN 5","BIN 10"]}
    res = u.delete_api_data(api_token, ":8059/api/events/by_event_type", jsondata)

    # Collect all events in arrays for bulk processing
    all_events = []

    # 5 SECOND BINS
    # if verbose:
    #     print("Working on BIN 5...", flush=True)

    # interval = 5

    # start_ts = df['ts'].min()
    # end_ts = df['ts'].max()
    # start_time = u.get_utc_datetime_from_ts(start_ts)
    # end_time = u.get_utc_datetime_from_ts(end_ts)      
    # seconds = (end_time-start_time).total_seconds()
    # bincount = int(seconds / interval)
    
    # new_start = start_time
    # if (bincount > 1):
    #     diff = seconds - (interval * bincount)
    #     for b in range(bincount):                       
    #         if (b == 0):
    #             trim = int(diff / 2)
    #         else:
    #             trim += interval

    #         startnew = new_start + u.td(seconds=trim)
    #         endnew = startnew + u.td(seconds=interval)
    #         mid_time = endnew - u.td(seconds=interval/2)
    #         mid_ts = mid_time.timestamp()

    #         eventinfo = u.getMetadata(df, mid_ts, class_name)
    #         grade_value = df[df['ts'] == mid_ts]['Grade'].values[0] if len(df[df['ts'] == mid_ts]) > 0 else 2
    #         eventinfo["GRADE"] = min(grade_value, 2)

    #         event_data = {
    #             "event_type": "BIN "+str(interval),
    #             "start_time": str(startnew),
    #             "end_time": str(endnew),
    #             "tags": eventinfo
    #         }
            
    #         all_events.append(event_data)
    
    dff = df.loc[(df['Phase_id'] > 0)].copy() 
    phases = dff.groupby('Phase_id')['Datetime'].agg(['min', 'max']).reset_index().values.tolist()
        
    event_count = 0
    if len(phases) > 0:
        if verbose:
            print("Working on PHASES...", flush=True)
        
        for phase in phases:
            if phase[0] > 0:
                start_time = u.get_datetime_obj(phase[1], force_utc=True)
                end_time = u.get_datetime_obj(phase[2], force_utc=True)
                
                seconds = (end_time-start_time).total_seconds()
                
                if seconds > 5:
                    if (seconds > 56 and seconds < 60):
                        new_start = start_time - u.td(seconds=2)
                        new_end = end_time + u.td(seconds=2)
                    else:
                        new_start = start_time
                        new_end = end_time
                        
                    offset = (new_end-new_start).total_seconds() / 2
                    mid_time = new_start + u.td(seconds=offset)
                    start_ts = new_start.timestamp()
                    end_ts = new_end.timestamp()
                    mid_ts = mid_time.timestamp()
                    
                    eventinfo = u.getMetadata(df, mid_ts, class_name)
                    foiling_state = u.getFoilingState(df, mid_ts)
                    
                    eventinfo["FOILING_STATE"] = foiling_state

                    grade_value = u.getMostLikelyValue(df, 'Grade', start_ts, end_ts, default=0)
                    eventinfo["GRADE"] = min(grade_value, 2)

                    event_data = {
                        "event_type": "PHASE",
                        "start_time": str(new_start),
                        "end_time": str(new_end),
                        "tags": eventinfo
                    }
                    
                    all_events.append(event_data)
    
    # Check if Period_id column exists before accessing it
    # Period boundaries must match 2_processing: only Grade > 2 (so BIN 10 never spans grade 0)
    periods = []
    if 'Period_id' in df.columns:
        dff = df.loc[(df['Period_id'] > 0) & (df['Grade'] > 2)].copy()
        periods = dff.groupby('Period_id')['Datetime'].agg(['min', 'max']).reset_index().values.tolist()
    else:
        u.log(api_token, "Performance.py", "warning", "identifyEvents", "Period_id column not found in dataframe - skipping PERIOD events")
        if verbose:
            print("Warning: Period_id column not found - skipping PERIOD events", flush=True)
        
    if len(periods) > 0:
        if verbose:
            print("Working on PERIODS...", flush=True)
        
        for period in periods:
            if period[0] > 0:
                start_time = u.get_datetime_obj(period[1], force_utc=True)
                end_time = u.get_datetime_obj(period[2], force_utc=True)
                
                seconds = (end_time-start_time).total_seconds()
                
                if seconds > 10:
                    if (seconds > 56 and seconds < 60):
                        new_start = start_time - u.td(seconds=2)
                        new_end = end_time + u.td(seconds=2)
                    else:
                        new_start = start_time
                        new_end = end_time
                        
                    offset = (new_end-new_start).total_seconds() / 2
                    mid_time = new_start + u.td(seconds=offset)
                    start_ts = new_start.timestamp()
                    end_ts = new_end.timestamp()
                    mid_ts = mid_time.timestamp()
                    
                    eventinfo = u.getMetadata(df, mid_ts, class_name)
                    foiling_state = u.getFoilingState(df, mid_ts)

                    eventinfo["FOILING_STATE"] = foiling_state
                    eventinfo["GRADE"] = 2

                    event_data = {
                        "event_type": "PERIOD",
                        "start_time": str(new_start),
                        "end_time": str(new_end),
                        "tags": eventinfo
                    }
                    
                    all_events.append(event_data)
                                
        # 10 SECOND BINS
        if verbose:
            print("Working on BIN 10...", flush=True)

        interval = 10
        
        for period in periods:
            if period[0] > 0:
                start_time = u.get_datetime_obj(period[1], force_utc=True)
                end_time = u.get_datetime_obj(period[2], force_utc=True)
                    
                seconds = (end_time-start_time).total_seconds()
                
                if (seconds > 56 and seconds < 60):
                    new_start = start_time - u.td(seconds=2)
                    new_end = end_time + u.td(seconds=2)
                else:
                    new_start = start_time
                    new_end = end_time
                
                seconds = (new_end-new_start).total_seconds()
                bincount = int(seconds / interval)
                
                if (bincount == 1):     
                    diff = int(seconds - interval)
                    
                    if diff > 0:
                        trim = int(diff / 2)
                    else:
                        trim = 0
                    
                    startnew = new_start + u.td(seconds=trim)
                    endnew = startnew + u.td(seconds=interval)
                    mid_time = endnew - u.td(seconds=interval/2)
                    start_ts = new_start.timestamp()
                    end_ts = new_end.timestamp()
                    mid_ts = mid_time.timestamp()

                    eventinfo = u.getMetadata(df, mid_ts, class_name)
                    foiling_state = u.getFoilingState(df, mid_ts)
                    
                    eventinfo["FOILING_STATE"] = foiling_state
                    eventinfo["GRADE"] = 2
 
                    event_data = {
                        "event_type": "BIN "+str(interval),
                        "start_time": str(startnew),
                        "end_time": str(endnew),
                        "tags": eventinfo
                    }
                    
                    all_events.append(event_data)
                        
                elif (bincount > 1):
                    diff = seconds - (interval * bincount)
                    for b in range(bincount):                       
                        if (b == 0):
                            trim = int(diff / 2)
                        else:
                            trim += interval

                        startnew = new_start + u.td(seconds=trim)
                        endnew = startnew + u.td(seconds=interval)
                        mid_time = endnew - u.td(seconds=interval/2)
                        start_ts = startnew.timestamp()
                        end_ts = endnew.timestamp()
                        mid_ts = mid_time.timestamp()
                        
                        eventinfo = u.getMetadata(df, mid_ts, class_name)
                        foiling_state = u.getFoilingState(df, mid_ts)
                
                        eventinfo["FOILING_STATE"] = foiling_state
                        eventinfo["GRADE"] = 2

                        event_data = {
                            "event_type": "BIN "+str(interval),
                            "start_time": str(startnew),
                            "end_time": str(endnew),
                            "tags": eventinfo
                        }
                        
                        all_events.append(event_data)

    # Send all events in batches of 10
    if len(all_events) > 0:
        event_count = len(all_events)
        batch_size = 10

        if verbose:
            print(f"Posting {event_count} events to API in batches of {batch_size}...", flush=True)

        # Process events in batches
        for i in range(0, len(all_events), batch_size):
            batch = all_events[i:i + batch_size]
            batch_num = (i // batch_size) + 1
            total_batches = (len(all_events) + batch_size - 1) // batch_size
            
            if verbose:
                print(f"Posting batch {batch_num}/{total_batches} ({len(batch)} events)...", flush=True)
            
            res = post_events_array(api_token, class_name, project_id, dataset_id, batch)

            if verbose:
                if res["success"]:
                    print(f"Successfully added batch {batch_num}/{total_batches} ({len(batch)} events)!", flush=True)
                else:
                    print(f"Failed to add batch {batch_num}/{total_batches}: {res}", flush=True)

        if verbose:
            print(f"Completed posting all {event_count} events!", flush=True)

    u.log(api_token, "Performance.py", "info", "identifying events", str(event_count)+" events generated...")

def start(api_token, project_id, dataset_id, class_name, date, source_name, start_time, end_time, verbose):
    try:
        if len(api_token) > 0 and int(project_id) > 0 and int(dataset_id) > 0 and len(class_name) > 0:
            u.log(api_token, "Performance.py", "info", "starting", "retrieving data...")

            # Convert start_time and end_time to timestamps
            if start_time == None:
                start_ts = None
            elif len(start_time) == 0:
                start_ts = None
            else:
                start_ts = u.get_timestamp_from_str(start_time)

            if end_time == None:
                end_ts = None
            elif len(end_time) == 0:
                end_ts = None
            else:
                end_ts = u.get_timestamp_from_str(end_time)

            if verbose:
                print('Retrieving data...', flush=True)
                
            df = get_data(api_token, project_id, class_name, date, source_name, start_ts, end_ts, verbose)

            u.log(api_token, "Performance.py", "info", "data retrieved", str(len(df))+" records found")
            identifyEvents(api_token, verbose, class_name, project_id, dataset_id, df)
            
            # Run computeStats in parallel
            with ThreadPoolExecutor(max_workers=4) as executor:
                # Submit all tasks
                futures = []
                
                # computeStats tasks
                futures.append(executor.submit(computeStats, api_token, verbose, class_name, project_id, dataset_id, "PHASE", df))
                futures.append(executor.submit(computeStats, api_token, verbose, class_name, project_id, dataset_id, "PERIOD", df))
                futures.append(executor.submit(computeStats, api_token, verbose, class_name, project_id, dataset_id, "BIN 10", df))
                # futures.append(executor.submit(computeStats, api_token, verbose, class_name, project_id, dataset_id, "BIN 5", df))

                # Wait for all tasks to complete and handle any exceptions
                for future in as_completed(futures):
                    try:
                        future.result()  # This will raise any exceptions that occurred
                    except Exception as e:
                        u.log(api_token, "Performance.py", "error", "parallel execution", str(e))
                        print(f"Error in parallel execution: {e}", flush=True)
                        return False

            # # PREPARE FOR RESAMPLING
            # # Define desired columns, but only select those that actually exist in the dataframe
            # desired_columns = ['ts','Datetime', 'Tws_kph', 'Tws_bow_kph', 'Tws_mhu_kph', 'Twd_deg', 'Twd_bow_deg', 'Twd_mhu_deg', 'Tws_delta_kph', 'Twa_delta_deg', 'Aws_kph', 'Awa_n_deg', 'Twa_deg', 'Cwa_deg', 'Hdg_deg', 'Cog_deg', 'Sog_kph', 'Bsp_kph', 'Bsp_tgt_kph', 'Bsp_perc', 'Vmg_kph', 'Vmg_tgt_kph', 'Vmg_perc', 'Pitch_deg', 'Heel_n_deg', 'Lwy_n_deg', 'Pitch_rate_dps', 'Yaw_rate_n_dps', 'Roll_rate_n_dps', 'Accel_rate_mps2', 'RH_lwd_mm', 'RH_wwd_mm', 'RH_bow_mm', 'RUD_ang_n_deg', 'RUD_rake_ang_deg', 'RUD_diff_ang_deg', 'DB_rake_ang_lwd_deg', 'DB_rake_aoa_lwd_deg', 'DB_cant_lwd_deg', 'DB_cant_eff_lwd_deg', 'DB_imm_lwd_mm', 'DB_piercing_lwd_mm', 'RUD_imm_lwd_mm', 'RUD_imm_wwd_mm', 'RUD_imm_tot_mm', 'CA1_ang_n_deg', 'CA2_ang_n_deg', 'CA3_ang_n_deg', 'CA4_ang_n_deg', 'CA5_ang_n_deg', 'CA6_ang_n_deg', 'WING_twist_n_deg', 'WING_rot_n_deg', 'WING_aoa_n_deg', 'WING_clew_pos_n_mm', 'JIB_sheet_load_kgf', 'JIB_cunno_load_kgf', 'JIB_lead_ang_deg', 'JIB_sheet_pct', 'BOBSTAY_load_tf', 'SHRD_lwr_lwd_tf', 'SHRD_lwr_wwd_tf', 'SHRD_upr_lwd_tf', 'SHRD_upr_wwd_tf', 'RIG_load_tf', 'Foiling_state', 'Cur_dir_est_deg', 'Cur_rate_est_kph']
            # # Filter to only include columns that exist in the dataframe
            # available_columns = [col for col in desired_columns if col in df.columns]
            # missing_columns = [col for col in desired_columns if col not in df.columns]
            # if missing_columns:
            #     u.log(api_token, "Performance.py", "warning", "resampling", f"Missing columns (will be skipped): {missing_columns}")
            # dff = df[available_columns].copy()
            
            # # Validate and clean Datetime column before setting as index
            # if 'Datetime' not in dff.columns:
            #     u.log(api_token, "Performance.py", "error", "resampling", "Datetime column not found")
            #     raise ValueError("Datetime column not found in dataframe")
            
            # # Convert to datetime if not already datetime type
            # initial_len = len(dff)
            # if not pd.api.types.is_datetime64_any_dtype(dff['Datetime']):
            #     dff['Datetime'] = pd.to_datetime(dff['Datetime'], errors='coerce', utc=True)
            
            # # Remove rows with invalid datetime values (NaT, None, etc.)
            # dff = dff.dropna(subset=['Datetime'])
            # # Double-check for any remaining NaT values
            # dff = dff[~pd.isna(dff['Datetime'])]
            
            # if len(dff) == 0:
            #     u.log(api_token, "Performance.py", "error", "resampling", "No valid datetime values after cleaning")
            #     raise ValueError("No valid datetime values in dataframe")
            
            # if initial_len != len(dff):
            #     u.log(api_token, "Performance.py", "warn", "resampling", f"Removed {initial_len - len(dff)} rows with invalid datetime values")
            
            # # Sort by Datetime to ensure proper ordering
            # dff = dff.sort_values('Datetime')
            
            # # Filter datetimes to be within the expected date range
            # # Parse date string (format: YYYYMMDD or YYYY-MM-DD)
            # date_clean = date.replace('-', '') if date and '-' in date else date
            # if date_clean and len(date_clean) == 8:
            #     try:
            #         # Create date range: start of day to end of day for the specified date
            #         date_obj = pd.to_datetime(date_clean, format='%Y%m%d', utc=True)
            #         date_start = date_obj.replace(hour=0, minute=0, second=0, microsecond=0)
            #         date_end = date_obj.replace(hour=23, minute=59, second=59, microsecond=999999)
                    
            #         # Filter to only include datetimes within this date
            #         before_filter = len(dff)
            #         dff = dff[(dff['Datetime'] >= date_start) & (dff['Datetime'] <= date_end)]
                    
            #         if len(dff) != before_filter:
            #             removed = before_filter - len(dff)
            #             u.log(api_token, "Performance.py", "warn", "resampling", f"Removed {removed} rows with datetimes outside date range ({date_clean})")
                    
            #         if len(dff) == 0:
            #             u.log(api_token, "Performance.py", "error", "resampling", f"No data within date range {date_clean}")
            #             raise ValueError(f"No data within date range {date_clean}")
            #     except Exception as e:
            #         u.log(api_token, "Performance.py", "warn", "resampling", f"Could not parse date {date_clean} for filtering: {str(e)}")
            
            # # Remove duplicate timestamps (keep first occurrence)
            # duplicates_before = len(dff)
            # dff = dff.drop_duplicates(subset=['Datetime'], keep='first')
            # if len(dff) != duplicates_before:
            #     u.log(api_token, "Performance.py", "warn", "resampling", f"Removed {duplicates_before - len(dff)} duplicate timestamps")
            
            # # Validate time range is reasonable (not more than 1 year, but should be within 1 day for a single date)
            # time_range = (dff['Datetime'].max() - dff['Datetime'].min()).total_seconds()
            # max_expected_seconds = 365 * 24 * 3600  # 1 year
            # if time_range > max_expected_seconds:
            #     u.log(api_token, "Performance.py", "error", "resampling", f"Time range too large: {time_range/3600:.2f} hours")
            #     raise ValueError(f"Time range too large for resampling: {time_range/3600:.2f} hours")
            
            # # Set Datetime as index
            # dff.set_index('Datetime', inplace=True)
            # dff['Datetime'] = dff.index 

            # dff['sin_Twd'] = np.sin(np.deg2rad(dff['Twd_deg']))
            # dff['cos_Twd'] = np.cos(np.deg2rad(dff['Twd_deg']))
            # dff['sin_Twd_bow'] = np.sin(np.deg2rad(dff['Twd_bow_deg']))
            # dff['cos_Twd_bow'] = np.cos(np.deg2rad(dff['Twd_bow_deg']))
            # dff['sin_Twd_mhu'] = np.sin(np.deg2rad(dff['Twd_mhu_deg']))
            # dff['cos_Twd_mhu'] = np.cos(np.deg2rad(dff['Twd_mhu_deg']))

            # dff['sin_Awa'] = np.sin(np.deg2rad(dff['Awa_n_deg']))
            # dff['cos_Awa'] = np.cos(np.deg2rad(dff['Awa_n_deg']))

            # dff['sin_Twa'] = np.sin(np.deg2rad(dff['Twa_deg']))
            # dff['cos_Twa'] = np.cos(np.deg2rad(dff['Twa_deg']))
            
            # dff['sin_Cwa'] = np.sin(np.deg2rad(dff['Cwa_deg']))
            # dff['cos_Cwa'] = np.cos(np.deg2rad(dff['Cwa_deg']))

            # dff['sin_Hdg'] = np.sin(np.deg2rad(dff['Hdg_deg']))
            # dff['cos_Hdg'] = np.cos(np.deg2rad(dff['Hdg_deg']))

            # dff['sin_Cog'] = np.sin(np.deg2rad(dff['Cog_deg']))
            # dff['cos_Cog'] = np.cos(np.deg2rad(dff['Cog_deg']))

            # dff['sin_Cur_dir'] = np.sin(np.deg2rad(dff['Cur_dir_est_deg']))
            # dff['cos_Cur_dir'] = np.cos(np.deg2rad(dff['Cur_dir_est_deg']))

            # # PERFORM RESAMPLING
            # try:
            #     # Validate dataframe size before resampling
            #     if len(dff) > 10_000_000:  # 10 million rows
            #         u.log(api_token, "Performance.py", "warn", "resampling", f"Large dataframe detected: {len(dff)} rows. This may take a while.")
                
            #     dfs = dff.resample('1s').mean()
            # except MemoryError as e:
            #     u.log(api_token, "Performance.py", "error", "resampling", f"Memory error during resampling: {str(e)}")
            #     u.log(api_token, "Performance.py", "error", "resampling", f"Dataframe size: {len(dff)} rows, time range: {(dff.index.max() - dff.index.min()).total_seconds():.2f} seconds")
            #     raise
            # except Exception as e:
            #     u.log(api_token, "Performance.py", "error", "resampling", f"Error during resampling: {str(e)}")
            #     u.log(api_token, "Performance.py", "error", "resampling", f"Dataframe size: {len(dff)} rows, time range: {(dff.index.max() - dff.index.min()).total_seconds():.2f} seconds")
            #     raise

            # # CALCULATE MEAN VALUES
            # dfs['Twd_deg'] = np.rad2deg(np.arctan2(dfs['sin_Twd'], dfs['cos_Twd']))
            # dfs['Twd_deg'] = (dfs['Twd_deg'] + 360) % 360
            # dfs.drop(['sin_Twd', 'cos_Twd'], axis=1, inplace=True)
            
            # dfs['Twd_bow_deg'] = np.rad2deg(np.arctan2(dfs['sin_Twd_bow'], dfs['cos_Twd_bow']))
            # dfs['Twd_bow_deg'] = (dfs['Twd_bow_deg'] + 360) % 360
            # dfs.drop(['sin_Twd_bow', 'cos_Twd_bow'], axis=1, inplace=True)
            
            # dfs['Twd_mhu_deg'] = np.rad2deg(np.arctan2(dfs['sin_Twd_mhu'], dfs['cos_Twd_mhu']))
            # dfs['Twd_mhu_deg'] = (dfs['Twd_mhu_deg'] + 360) % 360
            # dfs.drop(['sin_Twd_mhu', 'cos_Twd_mhu'], axis=1, inplace=True)

            # dfs['Hdg_deg'] = np.rad2deg(np.arctan2(dfs['sin_Hdg'], dfs['cos_Hdg']))
            # dfs['Hdg_deg'] = (dfs['Hdg_deg'] + 360) % 360
            # dfs.drop(['sin_Hdg', 'cos_Hdg'], axis=1, inplace=True)

            # dfs['Cog_deg'] = np.rad2deg(np.arctan2(dfs['sin_Cog'], dfs['cos_Cog']))
            # dfs['Cog_deg'] = (dfs['Cog_deg'] + 360) % 360
            # dfs.drop(['sin_Cog', 'cos_Cog'], axis=1, inplace=True)

            # dfs['Cur_dir_est_deg'] = np.rad2deg(np.arctan2(dfs['sin_Cur_dir'], dfs['cos_Cur_dir']))
            # dfs['Cur_dir_est_deg'] = (dfs['Cur_dir_est_deg'] + 360) % 360
            # dfs.drop(['sin_Cur_dir', 'cos_Cur_dir'], axis=1, inplace=True)

            # dfs['Awa_n_deg'] = np.rad2deg(np.arctan2(dfs['sin_Awa'], dfs['cos_Awa']))
            # dfs['Awa_n_deg'] = (dfs['Awa_n_deg'] + 180) % 360 - 180
            # dfs.drop(['sin_Awa', 'cos_Awa'], axis=1, inplace=True)

            # dfs['Twa_deg'] = np.rad2deg(np.arctan2(dfs['sin_Twa'], dfs['cos_Twa']))
            # dfs['Twa_deg'] = (dfs['Twa_deg'] + 180) % 360 - 180
            # dfs.drop(['sin_Twa', 'cos_Twa'], axis=1, inplace=True)
            
            # dfs['Cwa_deg'] = np.rad2deg(np.arctan2(dfs['sin_Cwa'], dfs['cos_Cwa']))
            # dfs['Cwa_deg'] = (dfs['Cwa_deg'] + 180) % 360 - 180
            # dfs.drop(['sin_Cwa', 'cos_Cwa'], axis=1, inplace=True)
            
            # computeCloud(api_token, verbose, class_name, project_id, dataset_id, "BIN 10", dfs) 

            jsondata = {"class_name": class_name,"project_id": project_id, "dataset_id": dataset_id, "page_name": "PERFORMANCE"}
            res = u.post_api_data(api_token, ":8059/api/datasets/page", jsondata)

            if (res["success"]):
                u.log(api_token, "Performance.py", "info", "Page Loaded!", "page_name: PERFORMANCE")
            else:
                u.log(api_token, "Performance.py", "error", "Page load failed!", "page_name: PERFORMANCE")

            # Day-page upsert for day-mode sidebar (additive)
            date_norm = str(date).replace("-", "").replace("/", "").strip() if date else None
            if date_norm and len(date_norm) == 8:
                day_page_payload = {"class_name": class_name, "project_id": project_id, "date": date_norm, "page_name": "PERFORMANCE"}
                day_res = u.post_api_data(api_token, ":8059/api/datasets/day-page", day_page_payload)
                if day_res.get("success"):
                    u.log(api_token, "Performance.py", "info", "Day page upserted", "page_name: PERFORMANCE")
                else:
                    u.log(api_token, "Performance.py", "warning", "Day page upsert failed", day_res.get("message", "unknown"))

            u.log(api_token, "Performance.py", "info", "Performance Data Loaded!", "Success!")

            # Update dataset date_modified to trigger cache refresh
            u.update_dataset_date_modified(api_token, class_name, project_id, dataset_id=dataset_id)

            return True
        else:
            error_msg = f"Invalid parameters - api_token: {'set' if api_token and len(api_token) > 0 else 'missing'}, project_id: {project_id}, dataset_id: {dataset_id}, class_name: {class_name}"
            print(f"ERROR: {error_msg}", flush=True)
            u.log(api_token, "Performance.py", "error", "Invalid parameters", error_msg)
            return False
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"ERROR in Performance.start(): {str(e)}", flush=True)
        print(f"Full traceback:\n{error_details}", flush=True)
        u.log(api_token, "Performance.py", "error", "Performance Data Failed!", f"{str(e)}\n{error_details}")
        return False

# start()


    
