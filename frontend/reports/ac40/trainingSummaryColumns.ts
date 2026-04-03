import { speedUnitBracketUpper, type SpeedDisplayUnit } from '../../utils/speedUnits';
import { RaceSummaryColumnKeys, RaceSetupApiKeys } from '../../constants/raceApiFieldNames';

export type RaceSummaryTableVariant = 'training' | 'raceDay';

/** Race summary grid: keys match race-summary API. `raceDay` adds start speed; `training` adds distance. */
export function buildRaceSummaryTableColumns(
  unit: SpeedDisplayUnit,
  variant: RaceSummaryTableVariant = 'training'
): { key: string; header: string }[] {
  const U = speedUnitBracketUpper(unit);
  const K = RaceSummaryColumnKeys;
  const speedBlock =
    variant === 'raceDay'
      ? [
          { key: K.twsAvg, header: `TWS ${U}` },
          { key: K.bspAvg, header: `BSP ${U}` },
          { key: K.startSpeed, header: `START SPEED ${U}` },
          { key: K.maxSpeed, header: `MAX SPEED ${U}` },
        ]
      : [
          { key: K.twsAvg, header: `TWS ${U}` },
          { key: K.bspAvg, header: `BSP ${U}` },
          { key: 'distance_m', header: 'DISTANCE [KM]' },
          { key: K.maxSpeed, header: `MAX SPEED ${U}` },
        ];
  return [
    { key: 'source_name', header: 'TEAM' },
    { key: 'vmg_perc_avg', header: 'VMG [%]' },
    ...speedBlock,
    { key: 'rh300_perc', header: 'RH < 300 [%]' },
    { key: 'rh750_perc', header: 'RH > 300 < 750 [%]' },
    { key: 'rhgood_perc', header: 'RH > 750 < 1400 [%]' },
    { key: 'rh1400_perc', header: 'RH > 1400 [%]' },
    { key: 'foiling_perc', header: 'FOILING [%]' },
    { key: 'phase_dur_avg_sec', header: 'AVG PHASE DUR [SEC]' },
    { key: 'maneuver_count', header: 'MANEUVER COUNT' },
    { key: 'tack_loss_avg', header: 'TACK LOSS [M]' },
    { key: 'gybe_loss_avg', header: 'GYBE LOSS [M]' },
    { key: 'roundup_loss_avg', header: 'ROUNDUP LOSS [M]' },
    { key: 'bearaway_loss_avg', header: 'BEARAWAY LOSS [M]' },
  ];
}

export function buildAveragesColumnsUpwindDownwind(unit: SpeedDisplayUnit): { key: string; header: string }[] {
  const U = speedUnitBracketUpper(unit);
  const V = RaceSetupApiKeys.avgVmg;
  return [
    { key: 'avg_tws', header: `TWS ${U}` },
    { key: 'avg_bsp', header: `BSP ${U}` },
    { key: 'avg_twa', header: 'TWA [DEG]' },
    { key: V, header: `VMG ${U}` },
    { key: 'avg_vmg_perc', header: 'VMG [%]' },
    { key: 'avg_heel', header: 'HEEL_N [DEG]' },
    { key: 'avg_pitch', header: 'PITCH [DEG]' },
    { key: 'avg_rh', header: 'RH LWD [MM]' },
    { key: 'avg_cant', header: 'CANT [DEG]' },
    { key: 'avg_cant_eff', header: 'CANT_EFF [DEG]' },
    { key: 'avg_rud_rake', header: 'RUD_RAKE [DEG]' },
    { key: 'avg_wing_clew', header: 'WING CLEW [MM]' },
    { key: 'avg_wing_ca1', header: 'CA1 [DEG]' },
    { key: 'avg_wing_twist', header: 'TOTAL TWIST [DEG]' },
    { key: 'avg_jib_sheet', header: 'JIB SHT LOAD [KGF]' },
    { key: 'avg_jib_lead', header: 'JIB LEAD [DEG]' },
    { key: 'avg_jib_cunno', header: 'JIB CUN LOAD [KGF]' },
  ];
}

export function buildAveragesColumnsReaching(unit: SpeedDisplayUnit): { key: string; header: string }[] {
  const U = speedUnitBracketUpper(unit);
  return [
    { key: 'avg_tws', header: `TWS ${U}` },
    { key: 'avg_bsp', header: `BSP ${U}` },
    { key: 'avg_twa', header: 'TWA [DEG]' },
    { key: 'avg_polar_perc', header: 'POLAR [%]' },
    { key: 'avg_heel', header: 'HEEL_N [DEG]' },
    { key: 'avg_pitch', header: 'PITCH [DEG]' },
    { key: 'avg_rh', header: 'RH LWD [MM]' },
    { key: 'avg_cant', header: 'CANT [DEG]' },
    { key: 'avg_cant_eff', header: 'CANT_EFF [DEG]' },
    { key: 'avg_rud_rake', header: 'RUD_RAKE [DEG]' },
    { key: 'avg_wing_clew', header: 'WING CLEW [MM]' },
    { key: 'avg_wing_ca1', header: 'CA1 [DEG]' },
    { key: 'avg_wing_twist', header: 'TOTAL TWIST [DEG]' },
    { key: 'avg_jib_sheet', header: 'JIB SHT LOAD [KGF]' },
    { key: 'avg_jib_lead', header: 'JIB LEAD [DEG]' },
    { key: 'avg_jib_cunno', header: 'JIB CUN LOAD [KGF]' },
  ];
}
