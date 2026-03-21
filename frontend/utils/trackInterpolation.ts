/**
 * Shared track interpolation utility.
 * Used by boat layers, track layers, and overlays so boat, track, and bad air stay in sync.
 */

export type GetTimestamp = (d: any) => number | Date;
export type GetNumber = (d: any) => number | undefined;

function toMs(ts: number | Date): number {
  if (typeof ts === 'number') return ts;
  return ts.getTime();
}

/** Interpolate angle (0-360) with wrapping */
export function interpolateAngle(angle1: number, angle2: number, factor: number): number {
  let diff = angle2 - angle1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  const interpolated = angle1 + diff * factor;
  return ((interpolated % 360) + 360) % 360;
}

export interface InterpolateOptions {
  getTimestamp: GetTimestamp;
  getLat: GetNumber;
  getLng: GetNumber;
  getHdg?: GetNumber;
  getTwd?: GetNumber;
  getTws?: GetNumber;
  getTwa?: GetNumber;
  getBsp?: GetNumber;
  twaName?: string;
}

/**
 * Find bracketing points for targetTime and return interpolated point, or nearest if no bracket.
 */
export function getInterpolatedPointAtTime(
  data: any[],
  targetTime: Date,
  options: InterpolateOptions
): any | null {
  if (!data || data.length === 0 || !targetTime) return null;
  const targetMs = targetTime.getTime();
  const { getTimestamp, getLat, getLng, getHdg, getTwd, getTws, getTwa, getBsp, twaName } = options;
  const getTs = (d: any) => toMs(getTimestamp(d));

  const sorted = [...data].sort((a, b) => getTs(a) - getTs(b));
  let prev: any = null;
  let next: any = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = getTs(sorted[i]);
    if (t <= targetMs) prev = sorted[i];
    if (t >= targetMs) {
      next = sorted[i];
      break;
    }
  }

  if (prev && next && prev !== next) {
    const t1 = getTs(prev);
    const t2 = getTs(next);
    if (t1 < t2 && targetMs > t1 && targetMs < t2) {
      const factor = (targetMs - t1) / (t2 - t1);
      const lat1 = getLat(prev);
      const lng1 = getLng(prev);
      const lat2 = getLat(next);
      const lng2 = getLng(next);
      if (lat1 === undefined || lng1 === undefined || lat2 === undefined || lng2 === undefined) {
        return targetMs - t1 < t2 - targetMs ? prev : next;
      }
      const twd1 = getTwd?.(prev) ?? (prev as any).Twd ?? (prev as any).twd ?? 0;
      const twd2 = getTwd?.(next) ?? (next as any).Twd ?? (next as any).twd ?? 0;
      const tws1 = getTws?.(prev) ?? (prev as any).Tws ?? (prev as any).tws ?? 0;
      const tws2 = getTws?.(next) ?? (next as any).Tws ?? (next as any).tws ?? 0;
      const h1 = getHdg?.(prev);
      const h2 = getHdg?.(next);
      const twa1 = getTwa?.(prev) ?? (twaName && (prev as any)[twaName]) ?? (prev as any).Twa ?? (prev as any).twa ?? 0;
      const twa2 = getTwa?.(next) ?? (twaName && (next as any)[twaName]) ?? (next as any).Twa ?? (next as any).twa ?? 0;
      const bsp1 = getBsp?.(prev) ?? (prev as any).Bsp ?? (prev as any).bsp ?? 0;
      const bsp2 = getBsp?.(next) ?? (next as any).Bsp ?? (next as any).bsp ?? 0;

      const interpolated: any = {
        ...prev,
        Datetime: targetTime,
        Lat: lat1 + (lat2 - lat1) * factor,
        Lng: lng1 + (lng2 - lng1) * factor,
        Twd: interpolateAngle(twd1, twd2, factor),
        Tws: tws1 + (tws2 - tws1) * factor,
        Twa: interpolateAngle(twa1, twa2, factor),
        Bsp: bsp1 + (bsp2 - bsp1) * factor,
        Hdg: h1 !== undefined && h2 !== undefined ? interpolateAngle(h1, h2, factor) : (h1 ?? h2 ?? 0),
        Grade: (prev as any).Grade != null && (next as any).Grade != null
          ? (prev as any).Grade + ((next as any).Grade - (prev as any).Grade) * factor
          : (prev as any).Grade ?? (next as any).Grade,
        Vmg_perc: (prev as any).Vmg_perc != null && (next as any).Vmg_perc != null
          ? (prev as any).Vmg_perc + ((next as any).Vmg_perc - (prev as any).Vmg_perc) * factor
          : (prev as any).Vmg_perc ?? (next as any).Vmg_perc,
      };
      return interpolated;
    }
  }

  const p = prev ?? next ?? sorted[0];
  return p ?? null;
}

/**
 * Get interpolated point per source. Data can be mixed sources; sourceKey(d) returns source id.
 */
export function getInterpolatedPointAtTimePerSource(
  data: any[],
  targetTime: Date,
  sourceKey: (d: any) => number | string | undefined,
  options: InterpolateOptions
): Map<number | string, any> {
  const result = new Map<number | string, any>();
  const bySource = new Map<number | string, any[]>();
  for (const d of data) {
    const key = sourceKey(d);
    if (key === undefined || key === null) continue;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(d);
  }
  for (const [key, points] of bySource) {
    const pt = getInterpolatedPointAtTime(points, targetTime, options);
    if (pt) result.set(key, pt);
  }
  return result;
}
