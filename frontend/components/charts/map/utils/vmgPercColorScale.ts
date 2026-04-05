/**
 * VMG% color scale for map track, MapTimeSeries, and WindArrow legend.
 * Domain is VMG% (25–125). Clamp values outside in d3.
 *
 * Regions: blue ≤60%, yellow 60–90%, green 90–105%, orange 105–115%, red >115%.
 */
export const VMG_PERC_MIN = 25;
export const VMG_PERC_MAX = 125;

/** Knots where range colors apply; linear interpolation between. */
export const VMG_PERC_COLOR_DOMAIN: readonly number[] = [25, 60, 90, 105, 115, 125];

/** Colors at each domain knot (hex for SVG + d3). */
export const VMG_PERC_COLOR_RANGE: readonly string[] = [
  "#0c4a6e", // dark blue (25%)
  "#7dd3fc", // light blue (60%)
  "#facc15", // yellow (90%)
  "#22c55e", // green (105%)
  "#f97316", // orange (115%)
  "#dc2626", // red (125%)
];

/** SVG gradient stop offset 0–100% along bar (min at bottom, max at top in WindArrow). */
export function vmgPercStopOffsetPct(vmgPct: number): string {
  const span = VMG_PERC_MAX - VMG_PERC_MIN;
  return `${((vmgPct - VMG_PERC_MIN) / span) * 100}%`;
}
