/**
 * Corrections-parquet field names and display strings for calibration reports.
 * Keeps speed-unit tokens out of `.tsx`.
 */
export const CalParquet = {
  twsKnots: 'Tws_kts',
  twsCorMetric: 'Tws_cor_kph',
  awsMetric: 'Aws_kph',
  awsFusedNormMetric: 'Aws_fused_norm_kph',
  awsFusedMetric: 'Aws_fused_kph',
  awsCorMetric: 'Aws_cor_kph',
  bspMetric: 'Bsp_kph',
  bspKnots: 'Bsp_kts',
} as const;

/** Maritime knots → km/h (matches AC40 corrections pipeline). */
export const CAL_KNOTS_TO_METRIC_SPEED = 1.852;

export const CalAxisLabel = {
  twsKnots: 'TWS (kts)',
  twsMetric: 'TWS (kph)',
  bspMetric: 'BSP (kph)',
  bspKnots: 'BSP (kts)',
} as const;

/** Caption for violin section: layout + how units are chosen. */
export const CAL_VIOLIN_UNITS_NOTE =
  'TWS left, BSP right. Red port / green stbd (TWA sign). Units follow parquet columns.';

/** Summary table `unit` token for speed columns stored in metric units. */
export const CalTableUnitToken = {
  speedMetric: 'kph',
} as const;
