import { speedUnitBracket, speedUnitBracketUpper, type SpeedDisplayUnit } from '../../utils/speedUnits';

/** Channel-group column headers for dataset cheat sheet (wind speed bracket follows user preference). */
export function cheatSheetDatasetChannelHeaders(unit: SpeedDisplayUnit): Record<string, string> {
  const U = speedUnitBracketUpper(unit);
  return {
    config: 'CONFIG',
    bsp: `BSP ${U}`,
    twa: 'TWA [DEG]',
    vmg: `VMG ${U}`,
    heel_n: 'HEEL_N [DEG]',
    pitch: 'PITCH [DEG]',
    rh_lwd: 'RH_LWD [MM]',
    rud_rake: 'RUD_RAKE [DEG]',
    rud_diff: 'RUD_DIFF [DEG]',
    db_cant: 'DB_CANT [DEG]',
    db_cant_eff: 'DB_CANT_EFF [DEG]',
    db_cant_stow: 'DB_CANT_STOW [DEG]',
    wing_ca1: 'WING_CA1 [DEG]',
    wing_twist: 'WING_TWIST [DEG]',
    wing_clew: 'WING_CLEW [MM]',
    jib_sht: 'JIB_SHT [KGF]',
    jib_cunno: 'JIB_CUNNO [KGF]',
    jib_lead: 'JIB_LEAD [DEG]',
  };
}

export function cheatSheetWindColumnsHint(unit: SpeedDisplayUnit): string {
  return ` Columns are bins of TWS ${speedUnitBracket(unit)}.`;
}
