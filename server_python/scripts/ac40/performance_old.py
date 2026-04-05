import numpy as np
import pandas as pd
import math as m
from datetime import timedelta, datetime
import json

import lunarossa as lr
import global_functions as g

print("Initialized!")
         
def computeStats(event_type, dfm):
    print('Computing stats: '+str(event_type))
            
    #COMPUTE STATS 
    print("/getDatasetEventInfo/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/"+str(event_type))
    res = g.get("/getDatasetEventInfo/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/"+str(event_type))
    
    if res.json() != None:
        for period in res.json(): 
            eid = period['event_id']
            starttime = lr.getDateTimeValue(period['start_time'])
            endtime = lr.getDateTimeValue(period['end_time'])
            
            if starttime != False and endtime != False:                
                df = dfm.loc[(dfm['Datetime'] >= starttime) & (dfm['Datetime'] < endtime)].copy()
                
                if isinstance(df, pd.DataFrame):
                    if len(df) > 0: 
                        df = df.fillna(0)  
                        
                        Cwa_Avg = df['AC40_CWA'].mean()
                        
                        df['AC40_BowWand_AWS_kts'] = df['AC40_BowWand_AWS'] * 1.94384449 #convert to Knots
                        df['AC40_Loads_MainSheetLoad'] = df['AC40_Loads_MainSheetLoad'] / 1000
                        df['AC40_Loads_MainCunninghamLoad_n'] = df['AC40_Loads_MainCunninghamLoad_n'] / 1000
                        df['AC40_Loads_MastRotationLoad'] = df['AC40_Loads_MastRotationLoad'] / 1000
                        
                        df['AC40_Loads_JibSheetLoad'] = df['AC40_Loads_JibSheetLoad'] / 1000
                        df['AC40_Loads_JibCunninghamLoad'] = df['AC40_Loads_JibCunninghamLoad'] / 1000 
                        
                        #ADD COMPUTED CHANNELS
                        if Cwa_Avg > 0:
                            df['AC40_Heel_n'] = df['AC40_Heel'] 
                            df['MainTravAng_n'] = df['PLC_Traveller_Angle'] * -1
                            df['MastSpannerAng_n'] = df['PLC_MastRotation_Angle__output'] 
                                                    
                            df['FoilLwdSink'] = df['AC40_FoilPort_Sink']
                            df['FlapLwdAng'] = df['PLC_FoilFlap_AnglePort']
                            df['CantLwdAng'] = df['AC40_FoilPort_Cant'] - 41.41
                            df['CantLwdAng_eff'] = df['CantLwdAng'] - df['AC40_Heel']
                            df['FoilLwdMCant'] = df['AC40_Loads_FoilPort_MCant'] / 1000
                            df['FoilLwdCantLoad'] = df['PLC_FCS_RamPort__load_kgf'] / 1000
                            
                            df['TravWwdLoad'] = df['AC40_Loads_MainTravellerLoad_Stbd'] / 1000
                            df['TravLwdLoad'] = df['AC40_Loads_MainTravellerLoad_Port'] / 1000
                            df['SpannerWwdLoad'] = df['AC40_Loads_MastRotationLoad_Stbd'] / 1000
                            
                            df['MainOuthaulWwdRamLoad'] = df['AC40_Loads_MainClewLoad_Stbd'] / 1000
                            df['MainOuthaulLwdRamLoad'] = df['AC40_Loads_MainClewLoad_Port'] / 1000
                            
                            df['MainOuthaulWwdStroke'] = (df['AC40_StrokeSensors_ClewAdjuster_StrokeStbd'] / 0.3) * 100
                            df['MainOuthaulLwdStroke'] = (df['AC40_StrokeSensors_ClewAdjuster_StrokePort'] / 0.3) * 100
                        else:    
                            df['AC40_Heel_n'] = df['AC40_Heel'] * -1                     
                            df['MainTravAng_n'] = df['PLC_Traveller_Angle']
                            df['MastSpannerAng_n'] = df['PLC_MastRotation_Angle__output'] * -1
                        
                            df['FoilLwdSink'] = df['AC40_FoilStbd_Sink']
                            df['FlapLwdAng'] = df['PLC_FoilFlap_AngleStbd']
                            df['CantLwdAng'] = df['AC40_FoilStbd_Cant'] - 41.41
                            df['CantLwdAng_eff'] = df['CantLwdAng'] + df['AC40_Heel']
                            df['FoilLwdMCant'] = df['AC40_Loads_FoilStbd_MCant'] / 1000
                            df['FoilLwdCantLoad'] = df['PLC_FCS_RamStbd__load_kgf'] / 1000
                            
                            df['TravWwdLoad'] = df['AC40_Loads_MainTravellerLoad_Port'] / 1000
                            df['TravLwdLoad'] = df['AC40_Loads_MainTravellerLoad_Stbd'] / 1000
                            df['SpannerWwdLoad'] = df['AC40_Loads_MastRotationLoad_Port'] / 1000
                            
                            df['MainOuthaulWwdRamLoad'] = df['AC40_Loads_MainClewLoad_Port'] / 1000
                            df['MainOuthaulLwdRamLoad'] = df['AC40_Loads_MainClewLoad_Stbd'] / 1000
                            
                            df['MainOuthaulWwdStroke'] = (df['AC40_StrokeSensors_ClewAdjuster_StrokePort'] / 0.3) * 100
                            df['MainOuthaulLwdStroke'] = (df['AC40_StrokeSensors_ClewAdjuster_StrokeStbd'] / 0.3) * 100
                            
                        df['BotAngle_n'] = (df['MastSpannerAng_n']  * -1) - df['MainTravAng_n'] 
                        df['MastAOA'] = (df['PLC_MastRotation_Angle__output'] * -1) - df['AC40_BowWand_AWA']
                                               
                        df['MainOuthaulLoadTotal'] = df['MainOuthaulWwdRamLoad'] + df['MainOuthaulLwdRamLoad'] 
                        df['MainOuthaulLoadDiff'] = df['MainOuthaulWwdRamLoad'] - df['MainOuthaulLwdRamLoad']        
                                                           
                        df['MainOuthaulRamStrokeDiff'] = df['MainOuthaulWwdStroke'] - df['MainOuthaulLwdStroke']
                        
                        df['Bsp_Perc'] = (df['AC40_Speed_kts'] / df['AC40_Tgt_Speed_kts']) * 100
                        df['Vmg_Perc'] = abs((df['AC40_VMG_kts'] / df['AC40_Tgt_VMG_kts']) * 100)
                                                        
                        #CALCULATE MEAN VALUES                         
                        avg_dt = str(df['Datetime'].mean()) 
                        Tws = df['AC40_BowWand_TWS_kts'].mean()
                        Swh = df['AC40_SignificantWaveHeight'].mean()
                        Twd  = lr.getMean360(list(df['AC40_BowWand_TWD']))
                        Awa = df['AC40_BowWand_AWA'].mean()
                        Aws = df['AC40_BowWand_AWS_kts'].mean()
                        Bsp = df['AC40_Speed_kts'].mean()
                        Bsp_Perc = df['AC40_Speed_kts_pc'].mean()
                        Vmg = abs(df['AC40_VMG_kts'].mean())
                        Vmg_Perc = abs(df['Vmg_Perc'].mean())
                        Twa = df['AC40_TWA'].mean()
                        Cwa = df['AC40_CWA'].mean()
                        Heel = df['AC40_Heel'].mean()
                        Trim = df['AC40_Trim'].mean()
                        Lwy = df['AC40_Leeway'].mean()
                        
                        HullSinkMin = df['AC40_HullAltitude'].mean()
                        ElevatorDraft = df['AC40_Rudder_Draft'].mean()
                        FoilLwdSink = df['FoilLwdSink'].mean()

                        LwdCantAng = df['CantLwdAng'].mean()
                        LwdCantAng_Eff = df['CantLwdAng_eff'].mean()
                        LwdCantMom = df['FoilLwdMCant'].mean()
                        LwdCantRamLoad = df['FoilLwdCantLoad'].mean()
                        
                        RudderYawAng = df['AC40_Rudder_Yaw'].mean()
                        RudderRakeAng = df['AC40_Rudder_Rake'].mean()
                        RudderMom = df['AC40_Rudder_MomentEstimate'].mean()

                        MastAOA = df['MastAOA'].mean()
                        BotAngle_n = df['BotAngle_n'].mean()
                        MainSheetRamLoad = df['AC40_Loads_MainSheetLoad'].mean() 
                        MainCunnRamLoad = df['AC40_Loads_MainCunninghamLoad_n'].mean() 
                        MastSpannerRamLoad = df['AC40_Loads_MastRotationLoad'].mean() 

                        JibSheetRamLoad = df['AC40_Loads_JibSheetLoad'].mean() 
                        JibCunnRamLoad = df['AC40_Loads_JibCunninghamLoad'].mean()
                                                   
                        MainTravAng_n = df['MainTravAng_n'].mean()
                        MainTravLoad = df['TravWwdLoad'].mean()
                        MastSpannerAng_n = df['MastSpannerAng_n'].mean()
                        
                        FlapLwdIBAng = df['FlapLwdAng'].mean()
                        FlapLwdOBAng = df['FlapLwdAng'].mean()
                        
                        MainOuthaulWwdStroke = df['MainOuthaulWwdStroke'].mean()
                        MainOuthaulLwdStroke = df['MainOuthaulLwdStroke'].mean()
                        
                        MainOuthaulWwdLoad = df['MainOuthaulWwdRamLoad'].mean()
                        MainOuthaulLwdLoad = df['MainOuthaulLwdRamLoad'].mean()
                                                                       
                        MainOuthaulLoadTotal = df['MainOuthaulLoadTotal'].mean()
                        MainOuthaulLoadDiff = df['MainOuthaulLoadDiff'].mean()
                        MainOuthaulLoadRatio = MainOuthaulWwdLoad / MainOuthaulLoadTotal
                        
                        MainOuthaulRamStrokeDiff = df['MainOuthaulRamStrokeDiff'].mean()
                        MainOuthaulRamStrokeAvg = df['AC40_AverageClewPC'].mean()
                       
                        if Cwa_Avg > 0:
                            RudderMom_n = RudderMom
                            Heel_n = Heel
                            Lwy_n = Lwy

                            MastAOA_n = MastAOA
                            RudderAng_n = RudderYawAng
                            MastSpannerRamLoad_n = MastSpannerRamLoad
                        else:
                            RudderMom_n = RudderMom * -1
                            Heel_n = Heel * -1
                            Lwy_n = Lwy * -1

                            MastAOA_n = MastAOA * -1
                            RudderAng_n = RudderYawAng * -1
                            MastSpannerRamLoad_n = MastSpannerRamLoad * -1

                        channelinfo_avg = {}
                        channelinfo_avg['Datetime'] = avg_dt
                        channelinfo_avg['Tws'] = round(Tws, 3)
                        channelinfo_avg['Twd'] = round(Twd, 3)
                        channelinfo_avg['Swh'] = round(Swh, 3)
                        channelinfo_avg['Awa'] = round(Awa, 3)
                        channelinfo_avg['Aws'] = round(Aws, 3)
                        channelinfo_avg['Bsp'] = round(Bsp, 3)
                        channelinfo_avg['Twa'] = round(Twa, 3)
                        channelinfo_avg['Cwa'] = round(Cwa, 3)
                        channelinfo_avg['Vmg'] = round(Vmg, 3)
                        channelinfo_avg['Vmg_percent'] = round(Vmg_Perc, 3)
                        channelinfo_avg['Bsp_percent'] = round(Bsp_Perc, 3)
                        channelinfo_avg['Heel_n'] = round(Heel_n, 3)
                        channelinfo_avg['Trim'] = round(Trim, 3)
                        channelinfo_avg['Lwy_n'] = round(Lwy_n, 3)
                        
                        channelinfo_avg['HullSinkMin'] = round(HullSinkMin, 3)
                        channelinfo_avg['RudderBladeSink'] = round(ElevatorDraft, 3)
                        channelinfo_avg['FoilLwdJunctionSink'] = round(FoilLwdSink, 3)
                        channelinfo_avg['FoilLwdCantAng'] = round(LwdCantAng, 3)
                        channelinfo_avg['FoilLwdCantAng_eff'] = round(LwdCantAng_Eff, 3)
                        channelinfo_avg['FoilLwdCantMom'] = round(LwdCantMom, 3)
                        channelinfo_avg['FoilLwdCantRamLoad'] = round(LwdCantRamLoad, 3)

                        channelinfo_avg['FoilLwdFlapAvgAng'] = round(FlapLwdOBAng, 3)
                        channelinfo_avg['FoilLwdFlapIbAng'] = round(FlapLwdIBAng, 3)
                        channelinfo_avg['FoilLwdFlapObAng'] = round(FlapLwdOBAng, 3)
                        channelinfo_avg['FoilLwdFlapDiffAng'] = 0

                        channelinfo_avg['RudderRakeAng'] = round(RudderRakeAng, 3)
                        channelinfo_avg['RudderAng_n'] = round(RudderAng_n, 3)
                        channelinfo_avg['RudderMom_n'] = round(RudderMom_n, 3)
                        
                        channelinfo_avg['TravelerLoad'] = round(MainTravLoad, 3)
                        channelinfo_avg['TravelerAng_n'] = round(MainTravAng_n, 3)
                        channelinfo_avg['SpannerAng_n'] = round(MastSpannerAng_n, 3)
                        channelinfo_avg['BotAng_n'] = round(BotAngle_n, 3)
                        channelinfo_avg['MastAoa_n'] = round(MastAOA_n, 3)
                        channelinfo_avg['MainSheetLoad'] = round(MainSheetRamLoad, 3)
                        channelinfo_avg['MainCunnLoadTotal'] = round(MainCunnRamLoad, 3)
                        channelinfo_avg['MastSpannerRamLoad_n'] = round(MastSpannerRamLoad_n, 3)

                        channelinfo_avg['MainLwdOuthaulPos'] = round(MainOuthaulLwdStroke, 3)
                        channelinfo_avg['MainWwdOuthaulPos'] = round(MainOuthaulWwdStroke, 3)
                        channelinfo_avg['MainOuthaulPosAvg'] = round(MainOuthaulRamStrokeAvg, 3)
                        channelinfo_avg['MainOuthaulPosDiff'] = round(MainOuthaulRamStrokeDiff, 3)
                                                
                        channelinfo_avg['MainLwdOuthaulLoad'] = round(MainOuthaulLwdLoad, 3)
                        channelinfo_avg['MainWwdOuthaulLoad'] = round(MainOuthaulWwdLoad, 3)
                        channelinfo_avg['MainOuthaulLoadTotal'] = round(MainOuthaulLoadTotal, 3)
                        channelinfo_avg['MainOuthaulLoadDiff'] = round(MainOuthaulLoadDiff, 3)
                        channelinfo_avg['MainOuthaulLoadRatio'] = round(MainOuthaulLoadRatio, 3)

                        channelinfo_avg['JibSheetLoad'] = round(JibSheetRamLoad, 3)
                        channelinfo_avg['JibCunnLoad'] = round(JibCunnRamLoad, 3)
                                                                                                                
                        #INSERT AVG
                        eventinfo_str = json.dumps(channelinfo_avg)
                        
                        jsondata = {}
                        jsondata["authid"] = str(g.authid)
                        jsondata["pid"] = int(g.pid)
                        jsondata["eid"] = int(eid)
                        jsondata["table"] = "events_avg"
                        jsondata["json"] = eventinfo_str 
                        
                        res = g.post("/addEventRow", jsondata)
                        
                        #CALCULATE STANDARD DEVIATION VALUES                              
                        avg_dt = str(df['Datetime'].mean())
                        Tws = df['AC40_BowWand_TWS_kts'].std()
                        Twd = lr.getStd360(list(df['AC40_BowWand_TWD']))
                        Swh = df['AC40_SignificantWaveHeight'].std()
                        Bsp = df['AC40_Speed_kts'].std()
                        Bsp_Perc = df['AC40_Speed_kts_pc'].std()
                        Awa = df['AC40_BowWand_AWA'].std()
                        Aws = df['AC40_BowWand_AWS_kts'].std()
                        Twa = df['AC40_TWA'].std()
                        Cwa = df['AC40_CWA'].std()
                        Heel_n = df['AC40_Heel'].std()
                        Trim = df['AC40_Trim'].std()
                        Lwy_n = df['AC40_Leeway'].std()
                        Vmg = df['AC40_VMG_kts'].std()
                        Vmg_Perc = df['AC40_VMG_pc'].std()
                        
                        AP_HullSinkMin = df['AC40_HullAltitude'].std()
                        AP_ElevatorRideHeight = df['AC40_Rudder_Draft'].std()
                        AP_BulbLwdRideHeight = df['FoilLwdSink'].std()
                        CantLwdAng_eff = df['CantLwdAng_eff'].std()
                        RudderAng_n = df['AC40_Rudder_Yaw'].std()           

                        channelinfo_dev = {}
                        channelinfo_dev['Datetime'] = avg_dt
                        channelinfo_dev['Tws'] = round(Tws, 3)
                        channelinfo_dev['Twd'] = round(Twd, 3)
                        channelinfo_dev['Swh'] = round(Swh, 3)
                        channelinfo_dev['Awa'] = round(Awa, 3)
                        channelinfo_dev['Aws'] = round(Aws, 3)
                        channelinfo_dev['Bsp'] = round(Bsp, 3)
                        channelinfo_dev['Twa'] = round(Twa, 3)
                        channelinfo_dev['Cwa'] = round(Cwa, 3)
                        channelinfo_dev['Vmg'] = round(Vmg, 3)
                        channelinfo_dev['Vmg_percent'] = round(Vmg_Perc, 3)
                        channelinfo_dev['Bsp_percent'] = round(Bsp_Perc, 3)
                        channelinfo_dev['Heel_n'] = round(Heel_n, 3)
                        channelinfo_dev['Trim'] = round(Trim, 3)
                        channelinfo_dev['Lwy_n'] = round(Lwy_n, 3)
                        
                        channelinfo_dev['HullSinkMin'] = round(AP_HullSinkMin, 3)
                        channelinfo_dev['RudderBladeSink'] = round(AP_ElevatorRideHeight, 3)
                        channelinfo_dev['FoilLwdJunctionSink'] = round(AP_BulbLwdRideHeight, 3)
                        channelinfo_dev['FoilLwdCantAng_eff'] = round(CantLwdAng_eff, 3)

                        channelinfo_dev['RudderAng_n'] = round(RudderAng_n, 3)
                                                
                        #INSERT DEVIATIONS
                        eventinfo_str = json.dumps(channelinfo_dev)
                        
                        jsondata = {}
                        jsondata["authid"] = str(g.authid)
                        jsondata["pid"] = int(g.pid)
                        jsondata["eid"] = int(eid)
                        jsondata["table"] = "events_dev"
                        jsondata["json"] = eventinfo_str 
                        
                        res = g.post("/addEventRow", jsondata)
                        
                        # CALCULATE AAV                           
                        Tws = lr.getAav(df['AC40_BowWand_TWS_kts'], 20)
                        Swh = lr.getAav(df['AC40_SignificantWaveHeight'], 20)
                        Awa = lr.getAav(df['AC40_BowWand_AWA'], 20)
                        Aws = lr.getAav(df['AC40_BowWand_AWS_kts'], 20)
                        Bsp = lr.getAav(df['AC40_Speed_kts'], 20)
                        Vmg = lr.getAav(df['AC40_VMG_kts'], 20)
                        Vmg_Perc = lr.getAav(df['AC40_VMG_pc'], 20)
                        Twa = lr.getAav(df['AC40_TWA'], 20)
                        Cwa = lr.getAav(df['AC40_CWA'], 20)
                        Heel = lr.getAav(df['AC40_Heel_n'], 20)
                        Trim = lr.getAav(df['AC40_Trim'], 20)
                        Lwy = lr.getAav(df['AC40_Leeway'], 20)

                        HullSinkMin = lr.getAav(df['AC40_HullAltitude'], 20)
                        ElevatorDraft = lr.getAav(df['AC40_Rudder_Draft'], 20)
                        FoilLwdSink = lr.getAav(df['FoilLwdSink'], 20)

                        LwdCantAng = lr.getAav(df['CantLwdAng'], 20)
                        LwdCantAng_Eff = lr.getAav(df['CantLwdAng_eff'], 20)
                        LwdCantMom = lr.getAav(df['FoilLwdMCant'], 20)
                        LwdCantRamLoad = lr.getAav(df['FoilLwdCantLoad'], 20)
                        
                        RudderYawAng = lr.getAav(df['AC40_Rudder_Yaw'], 20)
                        RudderRakeAng = lr.getAav(df['AC40_Rudder_Rake'], 20)
                        RudderMom = lr.getAav(df['AC40_Rudder_MomentEstimate'], 20)

                        MastAOA = lr.getAav(df['MastAOA'], 20)
                        BotAngle_n = lr.getAav(df['BotAngle_n'], 20)
                        MainSheetRamLoad = lr.getAav(df['AC40_Loads_MainSheetLoad'], 20)
                        MainCunnRamLoad = lr.getAav(df['AC40_Loads_MainCunninghamLoad_n'], 20)
                        MastSpannerRamLoad = lr.getAav(df['AC40_Loads_MastRotationLoad'], 20)

                        JibSheetRamLoad = lr.getAav(df['AC40_Loads_JibSheetLoad'], 20) 
                        JibCunnRamLoad = lr.getAav(df['AC40_Loads_JibCunninghamLoad'], 20)
                                                   
                        MainTravAng_n = lr.getAav(df['PLC_Traveller_Angle'], 20)
                        MainTravLoad = lr.getAav(df['TravWwdLoad'], 20)
                        MastSpannerAng_n = lr.getAav(df['MastSpannerAng_n'], 20)
                        
                        FlapLwdIBAng = lr.getAav(df['FlapLwdAng'], 20)
                        FlapLwdOBAng = lr.getAav(df['FlapLwdAng'], 20)
                        
                        MainOuthaulWwdStroke = lr.getAav(df['MainOuthaulWwdStroke'], 20)
                        MainOuthaulLwdStroke = lr.getAav(df['MainOuthaulLwdStroke'], 20)
                        
                        MainOuthaulWwdLoad = lr.getAav(df['MainOuthaulWwdRamLoad'], 20)
                        MainOuthaulLwdLoad = lr.getAav(df['MainOuthaulLwdRamLoad'], 20)
                                                                       
                        MainOuthaulLoadTotal = lr.getAav(df['MainOuthaulLoadTotal'], 20)
                        MainOuthaulLoadDiff = lr.getAav(df['MainOuthaulLoadDiff'], 20)
                        MainOuthaulLoadRatio = 0
                        
                        MainOuthaulRamStrokeDiff = lr.getAav(df['MainOuthaulRamStrokeDiff'], 20)
                        MainOuthaulRamStrokeAvg = lr.getAav(df['AC40_AverageClewPC'], 20)
                        
                        channelinfo_aav = {}
                        channelinfo_aav['Datetime'] = avg_dt
                        channelinfo_aav['Tws'] = round(Tws, 3)
                        channelinfo_aav['Swh'] = round(Swh, 3)
                        channelinfo_aav['Awa'] = round(Awa, 3)
                        channelinfo_aav['Aws'] = round(Aws, 3)
                        channelinfo_aav['Bsp'] = round(Bsp, 3)
                        channelinfo_aav['Twa'] = round(Twa, 3)
                        channelinfo_aav['Cwa'] = round(Cwa, 3)
                        channelinfo_aav['Vmg'] = round(Vmg, 3)
                        channelinfo_aav['Vmg_percent'] = round(Vmg_Perc, 3)
                        channelinfo_aav['Bsp_percent'] = round(Bsp_Perc, 3)
                        channelinfo_aav['Heel_n'] = round(Heel_n, 3)
                        channelinfo_aav['Trim'] = round(Trim, 3)
                        channelinfo_aav['Lwy_n'] = round(Lwy_n, 3)
                        
                        channelinfo_aav['HullSinkMin'] = round(HullSinkMin, 3)
                        channelinfo_aav['RudderBladeSink'] = round(ElevatorDraft, 3)
                        channelinfo_aav['FoilLwdJunctionSink'] = round(FoilLwdSink, 3)
                        channelinfo_aav['FoilLwdCantAng'] = round(LwdCantAng, 3)
                        channelinfo_aav['FoilLwdCantAng_eff'] = round(LwdCantAng_Eff, 3)
                        channelinfo_aav['FoilLwdCantMom'] = round(LwdCantMom, 3)
                        channelinfo_aav['FoilLwdCantRamLoad'] = round(LwdCantRamLoad, 3)

                        channelinfo_aav['FoilLwdFlapAvgAng'] = round(FlapLwdOBAng, 3)
                        channelinfo_aav['FoilLwdFlapIbAng'] = round(FlapLwdIBAng, 3)
                        channelinfo_aav['FoilLwdFlapObAng'] = round(FlapLwdOBAng, 3)
                        channelinfo_aav['FoilLwdFlapDiffAng'] = 0

                        channelinfo_aav['RudderRakeAng'] = round(RudderRakeAng, 3)
                        channelinfo_aav['RudderAng_n'] = round(RudderAng_n, 3)
                        channelinfo_aav['RudderMom_n'] = round(RudderMom_n, 3)
                        
                        channelinfo_aav['TravelerLoad'] = round(MainTravLoad, 3)
                        channelinfo_aav['TravelerAng_n'] = round(MainTravAng_n, 3)
                        channelinfo_aav['SpannerAng_n'] = round(MastSpannerAng_n, 3)
                        channelinfo_aav['BotAng_n'] = round(BotAngle_n, 3)
                        channelinfo_aav['MastAoa_n'] = round(MastAOA_n, 3)
                        channelinfo_aav['MainSheetLoad'] = round(MainSheetRamLoad, 3)
                        channelinfo_aav['MainCunnLoadTotal'] = round(MainCunnRamLoad, 3)
                        channelinfo_aav['MastSpannerRamLoad_n'] = round(MastSpannerRamLoad_n, 3)

                        channelinfo_aav['MainLwdOuthaulPos'] = round(MainOuthaulLwdStroke, 3)
                        channelinfo_aav['MainWwdOuthaulPos'] = round(MainOuthaulWwdStroke, 3)
                        channelinfo_aav['MainOuthaulPosAvg'] = round(MainOuthaulRamStrokeAvg, 3)
                        channelinfo_aav['MainOuthaulPosDiff'] = round(MainOuthaulRamStrokeDiff, 3)
                                                
                        channelinfo_aav['MainLwdOuthaulLoad'] = round(MainOuthaulLwdLoad, 3)
                        channelinfo_aav['MainWwdOuthaulLoad'] = round(MainOuthaulWwdLoad, 3)
                        channelinfo_aav['MainOuthaulLoadTotal'] = round(MainOuthaulLoadTotal, 3)
                        channelinfo_aav['MainOuthaulLoadDiff'] = round(MainOuthaulLoadDiff, 3)
                        channelinfo_aav['MainOuthaulLoadRatio'] = round(MainOuthaulLoadRatio, 3)

                        channelinfo_aav['JibSheetLoad'] = round(JibSheetRamLoad, 3)
                        channelinfo_aav['JibCunnLoad'] = round(JibCunnRamLoad, 3)

                        eventinfo_str = json.dumps(channelinfo_aav)
                        
                        jsondata = {}
                        jsondata["authid"] = str(g.authid)
                        jsondata["pid"] = int(g.pid)
                        jsondata["eid"] = int(eid)
                        jsondata["table"] = "events_aav"
                        jsondata["json"] = eventinfo_str
                        res = g.post("/addEventRow", jsondata)
                        print("Adding "+str(eid))
                        
def computeCloud(event_type, channels_list, dfm):
    print('Exporting cloud: '+str(event_type))
    
    def clean(val):
        try:
            return round(float(val), 3)
        except:
            return 0
    
    channels = ""
    for channel in channels_list:
        if len(channels) > 0:
            channels += ',"'+channel+'"'
        else:
            channels = '"'+channel+'"'
    
    print(g.host+"/getDatasetEventInfo/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/"+str(event_type))    
    res = g.get("/getDatasetEventInfo/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/"+str(event_type))
    
    if res.json() != None:    
        for period in res.json(): 
            eid = period['event_id']
            starttime = lr.getDateTimeValue(period['start_time'])
            endtime = lr.getDateTimeValue(period['end_time'])
                       
            #REMOVE EXISTING EVENT
            jsondata = {}
            jsondata["authid"] = str(g.authid)
            jsondata["pid"] = int(g.pid)
            jsondata["eid"] = int(eid)
            jsondata["table"] = "events_cloud"
    
            res = g.post("/removeEventRows", jsondata)
            
            if starttime != False and endtime != False:                
                df = dfm.loc[(dfm['Datetime'] >= starttime) & (dfm['Datetime']< endtime)].copy()

                if isinstance(df, pd.DataFrame):
                    if len(df) > 0:  
                        df = df.fillna(0)
                        
                        df['Bsp_Perc'] = (df['AC40_Speed_kts'] / df['AC40_Tgt_Speed_kts']) * 100
                        df['AC40_BowWand_AWS_kts'] = df['AC40_BowWand_AWS'] * 1.94384449
                        
                        ts = 0   
                        jsonrows = {} 
                        jsonrows["rows"] = [] 
                        counter = 0
                                       
                        for index, row in df.iterrows():
                            dt_str = str(row['Datetime'])  
                            Cog = lr.number(row['AC40_COG'])
                            Hdg = lr.number(row['AC40_HDG'])
                            Tws = lr.number(row['AC40_BowWand_TWS_kts'])
                            Swh = lr.number(row['AC40_SignificantWaveHeight'])
                            Bsp = lr.number(row['AC40_Speed_kts'])
                            Bsp_Perc = lr.number(row['Bsp_Perc'])
                            Awa = lr.number(row['AC40_BowWand_AWA'])
                            Aws = lr.number(row['AC40_BowWand_AWS_kts']) 
                            Twa = lr.number(row['AC40_TWA'])
                            Cwa = lr.number(row['AC40_CWA'])
                            Vmg = abs(lr.number(row['AC40_VMG_kts']))
                            Vmg_Tgt = abs(lr.number(row['AC40_Tgt_VMG_kts']))
                            Heel = lr.number(row['AC40_Heel'])
                            Trim = lr.number(row['AC40_Trim'])
                            Lwy = lr.number(row['AC40_Leeway'])
                            
                            Vmg_Perc = round((Vmg / Vmg_Tgt) * 100, 1)
                        
                            AP_HullSinkMin = lr.number(row['AC40_HullAltitude'])
                            AP_ElevatorRideHeight = lr.number(row['AC40_Rudder_Draft'])
                            AP_BulbPortRideHeight = lr.number(row['AC40_FoilPort_Sink'])
                            AP_BulbStbdRideHeight = lr.number(row['AC40_FoilStbd_Sink'])

                            PortCantAng = lr.number(row['AC40_FoilPort_Cant'])
                            StbdCantAng = lr.number(row['AC40_FoilStbd_Cant'])
                            FCS_PortCantRamLoad = lr.number(row['PLC_FCS_RamPort__load_kgf']) / 1000
                            FCS_StbdCantRamLoad = lr.number(row['PLC_FCS_RamStbd__load_kgf']) / 1000
                            PortCantMom = lr.number(row['AC40_Loads_FoilPort_MCant']) / 1000
                            StbdCantMom = lr.number(row['AC40_Loads_FoilStbd_MCant']) / 1000
                            
                            FlapPortAngle = lr.number(row['PLC_FoilFlap_AnglePort'])
                            FlapStbdAngle = lr.number(row['PLC_FoilFlap_AngleStbd'])
                            
                            RudderYawAng = lr.number(row['AC40_Rudder_Yaw'])
                            RudderRakeAng = lr.number(row['AC40_Rudder_Rake'])
                            RudderMom = lr.number(row['AC40_Rudder_MomentEstimate'])
                            
                            MainTravAng = lr.number(row['PLC_Traveller_Angle'])
                            MainTravPortLoad = lr.number(row['AC40_Loads_MainTravellerLoad_Port']) / 1000
                            MainTravStbdLoad = lr.number(row['AC40_Loads_MainTravellerLoad_Stbd']) / 1000
                            MastSpannerAng = lr.number(row['PLC_MastRotation_Angle__output'])
                            MastSpannerRamLoad = lr.number(row['AC40_Loads_MastRotationLoad']) / 1000

                            MainSheetRamLoad = lr.number(row['AC40_Loads_MainSheetLoad']) / 1000
                            MainCunnRamLoad = lr.number(row['AC40_Loads_MainCunninghamLoad_n']) / 1000

                            AC40_AverageClewPC = lr.number(row['AC40_AverageClewPC'])
                            MainOuthaulPortRamStrokePerc = (lr.number(row['AC40_StrokeSensors_ClewAdjuster_StrokePort']) / 0.3) * 100
                            MainOuthaulStbdRamStrokePerc = (lr.number(row['AC40_StrokeSensors_ClewAdjuster_StrokeStbd']) / 0.3) * 100
                            MainOuthaulPortRamLoad = lr.number(row['AC40_Loads_MainClewLoad_Port']) / 1000
                            MainOuthaulStbdRamLoad = lr.number(row['AC40_Loads_MainClewLoad_Stbd']) / 1000

                            JibSheetRamLoad = lr.number(row['AC40_Loads_JibSheetLoad']) / 1000                        
                            JibCunnRamLoad = lr.number(row['AC40_Loads_JibCunninghamLoad']) / 1000
                            
                            MastAOA = (MastSpannerAng * -1) - Awa

                            if Cwa > 0:
                                RudderMom_n = RudderMom
                                
                                MainTravLoad = MainTravStbdLoad
                                Cwa_n = Cwa
                                Twa_n = Twa
                                Awa_n = Awa
                                Heel_n = Heel
                                Lwy_n = Lwy
                                MainTravAng_n = MainTravAng * -1
                                MastSpannerAng_n = MastSpannerAng
                                MastAOA_n = MastAOA
                                RudderAng_n = RudderYawAng
                                MastSpannerRamLoad_n = MastSpannerRamLoad

                                LwdCantAng = PortCantAng - 41.41
                                LwdCantAng_Eff = LwdCantAng - Heel_n
                                LwdCantMom = PortCantMom
                                LwdCantRamLoad = FCS_PortCantRamLoad

                                FlapLwdOBAng = FlapPortAngle
                                FlapLwdIBAng = FlapPortAngle

                                AP_BulbLwdRideHeight = AP_BulbPortRideHeight

                                MainOuthaulWwdRamStrokePerc = MainOuthaulStbdRamStrokePerc
                                MainOuthaulLwdRamStrokePerc = MainOuthaulPortRamStrokePerc

                                MainOuthaulWwdRamLoad  = MainOuthaulStbdRamLoad
                                MainOuthaulLwdRamLoad  = MainOuthaulPortRamLoad
                            else:
                                RudderMom_n = RudderMom * -1
                                
                                MainTravLoad = MainTravPortLoad 
                                Cwa_n = Cwa * -1
                                Twa_n = Twa * -1
                                Awa_n = Awa * -1
                                Heel_n = Heel * -1
                                Lwy_n = Lwy * -1
                                MainTravAng_n = MainTravAng 
                                MastSpannerAng_n = MastSpannerAng * -1
                                MastAOA_n = MastAOA * -1
                                RudderAng_n = RudderYawAng * -1
                                MastSpannerRamLoad_n = MastSpannerRamLoad * -1

                                LwdCantAng = StbdCantAng - 41.41
                                LwdCantAng_Eff = LwdCantAng - Heel_n
                                LwdCantMom = StbdCantMom
                                LwdCantRamLoad = FCS_StbdCantRamLoad

                                FlapLwdOBAng = FlapStbdAngle
                                FlapLwdIBAng = FlapStbdAngle

                                AP_BulbLwdRideHeight = AP_BulbStbdRideHeight

                                MainOuthaulWwdRamStrokePerc = MainOuthaulPortRamStrokePerc
                                MainOuthaulLwdRamStrokePerc = MainOuthaulStbdRamStrokePerc

                                MainOuthaulWwdRamLoad  = MainOuthaulPortRamLoad
                                MainOuthaulLwdRamLoad  = MainOuthaulStbdRamLoad
                                
                            BotAngle_n = (MastSpannerAng_n  * -1) - MainTravAng_n

                            Vmg_abs = abs(Vmg)
                            MainOuthaulLoadTotal  = MainOuthaulWwdRamLoad + MainOuthaulLwdRamLoad
                            MainOuthaulLoadDiff = MainOuthaulWwdRamLoad - MainOuthaulLwdRamLoad
                            
                            if MainOuthaulWwdRamLoad == 0:
                                MainOuthaulWwdRamLoad = 0.0000001
                            
                            if MainOuthaulLoadTotal == 0:
                                MainOuthaulLoadTotal = 0.0000001
                            
                            MainOuthaulLoadRatio = MainOuthaulWwdRamLoad / MainOuthaulLoadTotal

                            FlapLwdDiffAng = FlapLwdOBAng - FlapLwdIBAng
                            FlapLwdAvgAng = (FlapLwdOBAng + FlapLwdIBAng) / 2
                            MainOuthaulRamStrokeDiff = MainOuthaulWwdRamStrokePerc - MainOuthaulLwdRamStrokePerc

                            info = {}
                            info['Datetime'] = dt_str
                            info["Seconds"] = clean(ts)
                            info['Cse'] = round(Cog, 3)
                            info['Hdg'] = round(Hdg, 3)
                            info['Tws'] = round(Tws, 3)
                            info['Swh'] = round(Swh, 3)
                            info['Awa'] = round(Awa, 3)
                            info['Awa_n'] = round(Awa_n, 3)
                            info['Aws'] = round(Aws, 3)
                            info['Bsp'] = round(Bsp, 3)
                            info['Twa'] = round(Twa, 3)
                            info['Twa_n'] = round(Twa_n, 3)
                            info['Cwa'] = round(Cwa, 3)
                            info['Cwa_n'] = round(Cwa_n, 3)
                            info['Vmg'] = round(Vmg, 3)
                            info['Vmg_abs'] = round(Vmg_abs, 3)
                            info['Vmg_percent'] = round(Vmg_Perc, 3)
                            info['Bsp_percent'] = round(Bsp_Perc, 3)
                            info['Heel_n'] = round(Heel_n, 3)
                            info['Trim'] = round(Trim, 3)
                            info['Lwy_n'] = round(Lwy_n, 3)
                            
                            info['HullSinkMin'] = round(AP_HullSinkMin, 3)
                            info['RudderBladeSink'] = round(AP_ElevatorRideHeight, 3)
                            info['FoilLwdJunctionSink'] = round(AP_BulbLwdRideHeight, 3)
                            info['FoilLwdCantAng'] = round(LwdCantAng, 3)
                            info['FoilLwdCantAng_eff'] = round(LwdCantAng_Eff, 3)
                            info['FoilLwdCantMom'] = round(LwdCantMom, 3)
                            info['FoilLwdCantRamLoad'] = round(LwdCantRamLoad, 3)

                            info['FoilLwdFlapAvgAng'] = round(FlapLwdAvgAng, 3)
                            info['FoilLwdFlapIbAng'] = round(FlapLwdIBAng, 3)
                            info['FoilLwdFlapObAng'] = round(FlapLwdOBAng, 3)
                            info['FoilLwdFlapDiffAng'] = round(FlapLwdDiffAng, 3)

                            info['RudderRakeAng'] = round(RudderRakeAng, 3)
                            info['RudderAng_n'] = round(RudderAng_n, 3)
                            info['RudderMom_n'] = round(RudderMom_n, 3)
                            
                            info['TravelerAng_n'] = round(MainTravAng_n, 3)
                            info['TravelerLoad'] = round(MainTravLoad, 3)
                            info['SpannerAng_n'] = round(MastSpannerAng_n, 3)
                            info['BotAng_n'] = round(BotAngle_n, 3)
                            info['MastAoa_n'] = round(MastAOA_n, 3)
                            info['MainSheetLoad'] = round(MainSheetRamLoad, 3)
                            info['MainCunnLoadTotal'] = round(MainCunnRamLoad, 3)
                            info['MastSpannerRamLoad_n'] = round(MastSpannerRamLoad_n, 3)

                            info['MainLwdOuthaulPos'] = round(MainOuthaulLwdRamStrokePerc, 3)
                            info['MainWwdOuthaulPos'] = round(MainOuthaulWwdRamStrokePerc, 3)
                            info['MainOuthaulPosAvg'] = round(AC40_AverageClewPC, 3)
                            info['MainOuthaulPosDiff'] = round(MainOuthaulRamStrokeDiff, 3)

                            info['MainLwdOuthaulLoad'] = round(MainOuthaulLwdRamLoad, 3)
                            info['MainWwdOuthaulLoad'] = round(MainOuthaulWwdRamLoad, 3)
                            info['MainOuthaulLoadTotal'] = round(MainOuthaulLoadTotal, 3)
                            info['MainOuthaulLoadDiff'] = round(MainOuthaulLoadDiff, 3)
                            info['MainOuthaulLoadRatio'] = round(MainOuthaulLoadRatio, 3)
                            
                            info['JibSheetLoad'] = round(JibSheetRamLoad, 3)
                            info['JibCunnLoad'] = round(JibCunnRamLoad, 3)
                            ts += 0.2
                                            
                            jsonrows["rows"].append(info)
                            counter += 1
                            
                            if (counter >= 5) :
                                jsonrows_str = json.dumps(jsonrows) 
                                
                                jsondata = {}
                                jsondata["authid"] = str(g.authid)
                                jsondata["pid"] = int(g.pid)
                                jsondata["eid"] = int(eid)
                                jsondata["table"] = "events_cloud"
                                jsondata["json"] = jsonrows_str 
                                
                                res = g.post("/addEventRows", jsondata) 
                                print("Adding Cloud Data "+str(eid))
                                
                                jsonrows["rows"] = [] 
                                counter = 0

def start():   
    g.getSettings()
         
    status = False
    print("Aquiring data...")

    channels_list = [    
        'AC40_HDG',
        'AC40_COG',
        'AC40_BowWand_TWS_kts',
        'AC40_SignificantWaveHeight',
        'AC40_Speed_kts',
        'AC40_Tgt_Speed_kts',
        'AC40_BowWand_AWA',
        'AC40_BowWand_AWS',
        'AC40_BowWand_TWD',
        'AC40_TWA',
        'AC40_CWA',
        'AC40_Tgt_CWA_n',
        'AC40_VMG_kts',
        'AC40_VMG_pc',
        'AC40_Heel',
        'AC40_Trim',
        'AC40_Leeway',
        
        'AC40_HullAltitude',
        'AC40_FoilPort_Sink',
        'AC40_FoilStbd_Sink',
        
        'AC40_FoilPort_Cant',
        'AC40_FoilStbd_Cant',
        'AC40_Loads_FoilPort_MCant',
        'AC40_Loads_FoilStbd_MCant',
        'PLC_FCS_RamPort__load_kgf',
        'PLC_FCS_RamStbd__load_kgf',
        
        'PLC_FoilFlap_AnglePort',
        'PLC_FoilFlap_AngleStbd',
        
        'AC40_Rudder_Draft',
        'AC40_Rudder_Yaw',
        'AC40_Rudder_MomentEstimate',
        'AC40_Rudder_Rake',
        
        'PLC_Traveller_Angle',
        'AC40_Loads_MainTravellerLoad_Port',
        'AC40_Loads_MainTravellerLoad_Stbd',
        'AC40_Loads_MainSheetLoad',
        'AC40_Loads_MainCunninghamLoad_n',
        
        'PLC_ClewAdjuster_ActualFootCamber',
        'AC40_Loads_MainClewLoad_Port',
        'AC40_Loads_MainClewLoad_Stbd',
        'AC40_StrokeSensors_ClewAdjuster_StrokePort',
        'AC40_StrokeSensors_ClewAdjuster_StrokeStbd',
        'AC40_AverageClewPC',
        
        'PLC_MastRotation_Angle__output',
        'AC40_Loads_MastRotationLoad_Port',
        'AC40_Loads_MastRotationLoad_Stbd',
        'AC40_Loads_MastRotationLoad',
        
        'AC40_Loads_JibSheetLoad',
        'AC40_Loads_JibCunninghamLoad',
        'AC40_Loads_JibTrackLoad'
    ]
           
    df = pd.DataFrame()
    df = lr.getAPIChannelValues(g.denis_classname, g.date, ['Session','Session01','Session02'], channels_list, '50ms', g.start_time, g.end_time)

    if len(df) == 0:
        g.denis_classname = '2Boats'
        df = lr.getAPIChannelValues(g.denis_classname, g.date, ['Session','Session01','Session02'], channels_list, '50ms', g.start_time, g.end_time)
        
        if len(df) > 0:
            g.saveSettings()

    if len(df) > 0:
        df['Datetime'] = pd.to_datetime(df['Datetime'], format='%Y-%m-%d %H:%M:%S.%f')
        print(df['Datetime'].max())
        
        df['AC40_Tgt_VMG_kts'] = 0.00
        df['AC40_Speed_kts_pc'] = 0.00
        
        for index, row in df.iterrows():
            Cwa_Tgt = lr.number(row['AC40_Tgt_CWA_n'])
            Bsp_Tgt = lr.number(row['AC40_Tgt_Speed_kts'])
            Bsp = lr.number(row['AC40_Speed_kts'])
            
            df.loc[index,'AC40_Tgt_VMG_kts'] = abs(m.cos(Cwa_Tgt * m.pi/180) * Bsp_Tgt)
            
            if Bsp_Tgt > 0:
                df.loc[index,'AC40_Speed_kts_pc'] = round((Bsp / Bsp_Tgt) * 100, 1)
            else:
                df.loc[index,'AC40_Speed_kts_pc'] = 0

        computeStats('PHASE', df)
        computeStats('TEST', df)
        computeStats('BIN 20', df)
        
        dfs = df.resample('500ms').mean()
        dfs['Datetime'] = dfs.index 
            
        dfs['AC40_Tgt_VMG_kts'] = 0.00
        dfs['AC40_Speed_kts_pc'] = 0.00
        
        for index, row in dfs.iterrows():
            Cwa_Tgt = lr.number(row['AC40_Tgt_CWA_n'])
            Bsp_Tgt = lr.number(row['AC40_Tgt_Speed_kts'])
            Bsp = lr.number(row['AC40_Speed_kts'])
            
            dfs.loc[index,'AC40_Tgt_VMG_kts'] = abs(m.cos(Cwa_Tgt * m.pi/180) * Bsp_Tgt)
            
            if Bsp_Tgt > 0:
                dfs.loc[index,'AC40_Speed_kts_pc'] = round((Bsp / Bsp_Tgt) * 100, 1)
            else:
                dfs.loc[index,'AC40_Speed_kts_pc'] = 0
        
        computeCloud('BIN 20', channels_list, dfs)
        status = True

    if (status == True):
        res = g.get("/datasetPageExists/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/performance")

        if (res.text == 'true'):
            res = g.get("/updatePageModified/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/performance")
        else:
            res = g.get("/addDatasetPage/"+str(g.authid)+"/"+str(g.pid)+"/"+str(g.did)+"/performance")
            
        print("Data Load Successful!")
    else:
        print("Data Load Failed!")  

print("Exiting Performance...")


# start()