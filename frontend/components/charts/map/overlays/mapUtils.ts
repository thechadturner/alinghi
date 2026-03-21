/**
 * Shared map/geo utilities for overlay components (Bad Air, Mark Wind, etc.)
 */

/** Normalize angle to 0-360 range. */
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a < 0) a += 360;
  while (a >= 360) a -= 360;
  return a;
}

/** Normalize angle difference to -180..180 (for bearing deltas). */
export function normalizeAngleDiff(angle: number): number {
  let a = angle;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

/**
 * Calculate destination point from origin, distance, and bearing.
 * Uses Haversine formula for great circle navigation.
 */
export function calculateDestination(
  lat: number,
  lng: number,
  distanceMeters: number,
  bearingDegrees: number
): { lat: number; lng: number } | null {
  if (isNaN(lat) || isNaN(lng) || isNaN(distanceMeters) || isNaN(bearingDegrees)) {
    return null;
  }
  const R = 6371000; // Earth radius in meters
  const bearing = (bearingDegrees * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const d = distanceMeters / R;
  const newLat = Math.asin(
    Math.sin(latRad) * Math.cos(d) +
      Math.cos(latRad) * Math.sin(d) * Math.cos(bearing)
  );
  const newLng =
    lngRad +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(latRad),
      Math.cos(d) - Math.sin(latRad) * Math.sin(newLat)
    );
  return {
    lat: (newLat * 180) / Math.PI,
    lng: (newLng * 180) / Math.PI
  };
}

/** Bearing in degrees from (fromLat, fromLon) to (toLat, toLon), 0-360. */
export function bearing(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLon = toRad(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(toRad(toLat));
  const x =
    Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat)) -
    Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(dLon);
  const b = (Math.atan2(y, x) * 180) / Math.PI;
  return normalizeAngle(b);
}
