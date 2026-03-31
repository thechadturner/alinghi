import { createSignal, createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import L from "leaflet";

import { sourcesStore } from "../../../store/sourcesStore";
import { persistantStore } from "../../../store/persistantStore";
import { error as logError } from "../../../utils/console";

const { selectedClassIcon } = persistantStore;

import "leaflet/dist/leaflet.css";

const CONTAINER_ID = "prestart-report-map";
const DEFAULT_COLOR = "#888";

/** Real boat length in meters (e.g. AC40 ~15m). Used to scale boat icons to real size on the map. */
const BOAT_LENGTH_METERS = 15;

/**
 * Fixed position on earth for prestart map. Must match server_python/scripts/ac40/maneuvers/prestart.py
 * (originlat, originlon). Tracks are output in this frame; SL1, SL2, MK1, M1 are transformed to the same
 * coordinate system in rotateMarksByCourseAxis so marks and boats align.
 */
const MANEUVER_MAP_ORIGIN = { lat: 39.476984, lng: -0.291140 } as const;

/** Convert lat/lng to meters relative to (lat0, lng0). Returns [xEasting, yNorthing]. Matches backend geo_utils. */
function latlngToMeters(lat0: number, lng0: number, lat: number, lng: number): [number, number] {
  const mPerDegLat = 111132.954 - 559.822 * Math.cos(2 * (Math.PI / 180) * lat) + 1.175 * Math.cos(4 * (Math.PI / 180) * lat);
  const mPerDegLng = 111132.954 * Math.cos((Math.PI / 180) * lat);
  const x = (lng - lng0) * mPerDegLng;
  const y = (lat - lat0) * mPerDegLat;
  return [x, y];
}

/** Convert meters (northSouth, eastWest) relative to (lat0, lng0) back to lat/lng. Matches backend meters_to_latlng(lat0, lng0, yR, xR). */
function metersToLatLng(lat0: number, lng0: number, northSouthMeters: number, eastWestMeters: number): [number, number] {
  const mPerDegLat = 111132.954 - 559.822 * Math.cos(2 * (Math.PI / 180) * lat0) + 1.175 * Math.cos(4 * (Math.PI / 180) * lat0);
  const mPerDegLng = 111132.954 * Math.cos((Math.PI / 180) * lat0);
  const lat = lat0 + northSouthMeters / mPerDegLat;
  const lng = lng0 + eastWestMeters / mPerDegLng;
  return [lat, lng];
}

/**
 * Transform all marks (SL1, SL2, MK1, M1) into the same coordinate system as the backend:
 * fixed origin from server_python/scripts/ac40/maneuvers/prestart.py (originlat, originlon).
 * Same steps as backend addMapData: position relative to SL1 in meters, rotate by course axis (TWD),
 * then convert to lat/lng using MANEUVER_MAP_ORIGIN. SL1 → origin; SL2, MK1, M1 → rotated offset from origin.
 */
function rotateMarksByCourseAxis(marks: PrestartMark[], courseAxisDeg: number): PrestartMark[] {
  const sl1 = marks.find((m) => m.NAME === "SL1");
  const lat0 = sl1?.LAT;
  const lng0 = sl1?.LON;
  if (lat0 == null || lng0 == null || !Number.isFinite(lat0) || !Number.isFinite(lng0)) return marks;
  const rad = (courseAxisDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const [x0, y0] = latlngToMeters(lat0, lng0, lat0, lng0);
  const { lat: originLat, lng: originLng } = MANEUVER_MAP_ORIGIN;
  return marks.map((m) => {
    if (m.NAME === "SL1") return { NAME: "SL1", LAT: originLat, LON: originLng };
    const [x, y] = latlngToMeters(lat0, lng0, m.LAT, m.LON);
    const xT = x - x0;
    const yT = y - y0;
    const xR = cos * xT - sin * yT;
    const yR = sin * xT + cos * yT;
    const [latR, lngR] = metersToLatLng(originLat, originLng, yR, xR);
    return { NAME: m.NAME, LAT: latR, LON: lngR };
  });
}

export type PrestartTrack = {
  event_id: number;
  source_name: string;
  points: { lat: number; lng: number; time?: number; hdg?: number; note?: string }[];
};

type PointWithLatLng = { lat: number; lng: number; LatLng: L.LatLng; time?: number; hdg?: number };

/** Boat SVG path by zoom level and class icon type (match grouped Map). Empty string when zoom <= 10. */
function getBoatPathForZoom(zoomLevel: number, iconType?: string | null): string {
  const iconValue = iconType ?? selectedClassIcon();
  const type = (iconValue && typeof iconValue === "string" && iconValue.trim() !== "")
    ? iconValue.trim().toLowerCase()
    : "monohull";

  if (type === "multihull") {
    if (zoomLevel > 18) {
      return "M0 12 L5.332 0 L5.332 6 L6.665 12 L8 6 L8 -12 L-8 -12 L-8 6 L-6.665 12 L-5.332 6 L-5.332 0 Z";
    }
    if (zoomLevel > 14) {
      return "M0 7 L3.109 0 L3.109 3.5 L3.888 7 L4.666 3.5 L4.666 -7 L-4.666 -7 L-4.666 3.5 L-3.888 7 L-3.109 3.5 L-3.109 0 Z";
    }
    if (zoomLevel > 10) {
      return "M0 3 L1.333 0 L1.333 1.5 L1.666 3 L2 1.5 L2 -3 L-2 -3 L-2 1.5 L-1.666 3 L-1.333 1.5 L-1.333 0 Z";
    }
    return "";
  }

  if (zoomLevel > 18) {
    return "M0 -12 L-4 -12 L-4 0 L-2 8 L0 12 L2 8 L4 0 L4 -12 Z";
  }
  if (zoomLevel > 14) {
    return "M0 -7 L-2 -7 L-2 0 L-1 4 L0 7 L1 4 L2 0 L2 -7 Z";
  }
  if (zoomLevel > 10) {
    return "M0 -3 L-1 -3 L-1 0 L-0.5 1.5 L0 3 L0.5 1.5 L1 0 L1 -3 Z";
  }
  return "";
}

/** Path length in SVG path units (y-extent) for the boat icon at this zoom/type. Used to scale boat to real size. */
function getBoatPathUnitsLength(zoomLevel: number, iconType?: string | null): number {
  if (zoomLevel > 18) return 24;
  if (zoomLevel > 14) return 14;
  if (zoomLevel > 10) return 6;
  return 24;
}

/** Meters per pixel at the given map center latitude and zoom (Web Mercator). */
function getMetersPerPixel(map: L.Map, lat: number): number {
  const zoom = map.getZoom();
  return (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) / Math.pow(2, zoom + 8);
}

/** Scale factor so the boat path (pathUnitsLength units) displays at BOAT_LENGTH_METERS on the map. */
function getBoatScaleFactor(map: L.Map, lat: number, zoomLevel: number, iconType?: string | null): number {
  const pathUnits = getBoatPathUnitsLength(zoomLevel, iconType);
  const mPerPx = getMetersPerPixel(map, lat);
  return BOAT_LENGTH_METERS / (pathUnits * mPerPx);
}

type PathItem = { eventId: number; source_name: string; color: string; points: PointWithLatLng[] };

export type PrestartMark = { NAME: string; LAT: number; LON: number };

export interface PrestartReportMapProps {
  tracks: PrestartTrack[];
  marks?: PrestartMark[];
  /** When true, marks are already in the track coordinate system (e.g. from backend per-track); do not apply rotateMarksByCourseAxis. */
  marksAlreadyRotated?: boolean;
  /** Course axis in degrees (TWD). When set and not marksAlreadyRotated, marks are rotated to match the track coordinate system (same as backend). */
  courseAxisDeg?: number;
  /** When non-empty, tracks with source_name in this list are shown at full opacity; others at 0.2. When empty, all full opacity. */
  selectedSourceNames?: string[];
  /** When set, trim tracks to this time (sec) and show boat positions at this time. */
  selectedTimeSec?: number | null;
  /** Star marker: source_name -> time (sec). In ACCEL/MAX BSP = that mode's time; in other views = Time_bspmax. */
  markerTimeBySource?: Record<string, number>;
  /** Golden boat marker: source_name -> time (sec) at max accel. Only used when not in ACCELERATION/MAX BSP view. */
  markerTimeBySourceBoat?: Record<string, number>;
  /** Called when user clicks a track (toggle selection by source). */
  onTrackClick?: (sourceName: string, eventId: number) => void;
  getSourceColor?: (sourceName: string | null | undefined) => string | undefined;
}

const TIME_CIRCLE_INTERVAL_SEC = 10;
/** Track stroke: 1px unselected, 3px selected. Circle radius = stroke (1px smaller than before). */
const TRACK_STROKE_UNSELECTED = 1;
const TRACK_STROKE_SELECTED = 3;
const CIRCLE_RADIUS_OFFSET = 0;

/** Pick one point per 10s tick (closest to each tick). Ticks from min to max time in steps of 10. */
function getPointsAt10sIntervals(points: PointWithLatLng[]): PointWithLatLng[] {
  const withTime = points.filter((p) => typeof p.time === "number" && Number.isFinite(p.time));
  if (withTime.length === 0) return [];
  const minT = Math.floor(Math.min(...withTime.map((p) => p.time!)) / TIME_CIRCLE_INTERVAL_SEC) * TIME_CIRCLE_INTERVAL_SEC;
  const maxT = Math.ceil(Math.max(...withTime.map((p) => p.time!)) / TIME_CIRCLE_INTERVAL_SEC) * TIME_CIRCLE_INTERVAL_SEC;
  const result: PointWithLatLng[] = [];
  for (let tick = minT; tick <= maxT; tick += TIME_CIRCLE_INTERVAL_SEC) {
    let best = withTime[0];
    let bestDist = Math.abs((best.time ?? 0) - tick);
    for (const p of withTime) {
      const d = Math.abs((p.time ?? 0) - tick);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    result.push(best);
  }
  return result;
}

/** When selectedTimeSec is set, return points with time <= selectedTimeSec (path trim). Preserves order. If none, return points up to closest to selectedTimeSec. */
function getPointsForPath(points: PointWithLatLng[], selectedTimeSec: number | null | undefined): PointWithLatLng[] {
  if (selectedTimeSec == null || !Number.isFinite(selectedTimeSec)) return points;
  const result = points.filter((p) => typeof p.time === "number" && Number.isFinite(p.time) && p.time! <= selectedTimeSec);
  if (result.length > 0) return result;
  const withTime = points.filter((p) => typeof p.time === "number" && Number.isFinite(p.time));
  if (withTime.length === 0) return points;
  const closest = withTime.reduce((a, b) =>
    Math.abs((a.time ?? 0) - selectedTimeSec) < Math.abs((b.time ?? 0) - selectedTimeSec) ? a : b
  );
  const idx = points.indexOf(closest);
  return idx >= 0 ? points.slice(0, idx + 1) : points.slice(0, 1);
}

function buildPathItems(
  tracks: PrestartTrack[],
  getColor: (sourceName: string | null | undefined) => string | undefined
): PathItem[] {
  const items: PathItem[] = [];
  for (const track of tracks) {
    const points: PointWithLatLng[] = [];
    for (const p of track.points || []) {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      points.push({
        lat,
        lng,
        LatLng: L.latLng(lat, lng),
        ...(typeof p.time === "number" && Number.isFinite(p.time) ? { time: p.time } : {}),
        ...(typeof p.hdg === "number" && Number.isFinite(p.hdg) ? { hdg: p.hdg } : {}),
      });
    }
    if (points.length < 2) continue;
    const color =
      getColor(track.source_name) ??
      sourcesStore.getSourceColor(track.source_name) ??
      DEFAULT_COLOR;
    items.push({
      eventId: track.event_id,
      source_name: track.source_name || "",
      color,
      points,
    });
  }
  return items;
}

export default function PrestartReportMap(props: PrestartReportMapProps) {
  const [containerRef, setContainerRef] = createSignal<HTMLDivElement | null>(null);
  let map: L.Map | null = null;
  let g: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let pathItems: PathItem[] = [];

  function getColor(sourceName: string | null | undefined): string {
    return (
      props.getSourceColor?.(sourceName) ??
      sourcesStore.getSourceColor(sourceName ?? "") ??
      DEFAULT_COLOR
    );
  }

  function makeLineGen(): d3.Line<PointWithLatLng> | null {
    if (!map) return null;
    return d3
      .line<PointWithLatLng>()
      .defined((d) => {
        if (!d?.LatLng) return false;
        try {
          const pt = map!.latLngToLayerPoint(d.LatLng);
          return !Number.isNaN(pt.x) && !Number.isNaN(pt.y) && Number.isFinite(pt.x) && Number.isFinite(pt.y);
        } catch {
          return false;
        }
      })
      .x((d) => {
        if (!map || !d?.LatLng) return 0;
        try {
          const pt = map.latLngToLayerPoint(d.LatLng);
          return Number.isNaN(pt.x) ? 0 : pt.x;
        } catch {
          return 0;
        }
      })
      .y((d) => {
        if (!map || !d?.LatLng) return 0;
        try {
          const pt = map.latLngToLayerPoint(d.LatLng);
          return Number.isNaN(pt.y) ? 0 : pt.y;
        } catch {
          return 0;
        }
      });
  }

  function isPathSelected(sourceName: string): boolean {
    const sel = props.selectedSourceNames;
    if (!sel || sel.length === 0) return true;
    return sel.includes(sourceName);
  }

  function getPathSelectionClass(sourceName: string): string {
    const sel = props.selectedSourceNames;
    if (!sel || sel.length === 0) return "prestart-report-path-no-selection";
    return isPathSelected(sourceName) ? "prestart-report-path-selected" : "prestart-report-path-unselected";
  }

  function updatePaths() {
    if (!map || !g) return;
    const lineGen = makeLineGen();
    if (!lineGen) return;
    const selectedTimeSec = props.selectedTimeSec;
    const pointsForItem = (item: PathItem) => getPointsForPath(item.points, selectedTimeSec);
    g.selectAll<SVGPathElement, PathItem>(".prestart-report-path")
      .attr("d", (d: PathItem) => lineGen(pointsForItem(d)) ?? "");
  }

  function updateHoverCircles() {
    if (!map || !g) return;
    g.selectAll<SVGCircleElement, PointWithLatLng>(".prestart-report-hover-circle")
      .attr("cx", (d) => {
        try {
          return map!.latLngToLayerPoint(d.LatLng).x;
        } catch {
          return 0;
        }
      })
      .attr("cy", (d) => {
        try {
          return map!.latLngToLayerPoint(d.LatLng).y;
        } catch {
          return 0;
        }
      });
  }

  type TimeCircleDatum = { point: PointWithLatLng; pathItem: PathItem };
  type TimeCircleDatumWithFinal = TimeCircleDatum & { isFinalPosition?: boolean };

  /** Circle radius = track stroke (same as track thickness). */
  function getMarkerCircleRadius(selected: boolean): number {
    const stroke = selected ? TRACK_STROKE_SELECTED : TRACK_STROKE_UNSELECTED;
    return stroke + CIRCLE_RADIUS_OFFSET;
  }

  /** Points on selected tracks at star-marker time (drawn as gold star). Only drawn when selectedTimeSec is not active or >= star time. */
  function getMarkerStarData(): TimeCircleDatum[] {
    const markerBySource = props.markerTimeBySource;
    if (!markerBySource || Object.keys(markerBySource).length === 0) return [];
    const selectedTime = props.selectedTimeSec;
    const showMarker = (markerTime: number) =>
      selectedTime == null || !Number.isFinite(selectedTime) || selectedTime >= markerTime;
    const out: TimeCircleDatum[] = [];
    for (const item of pathItems) {
      if (!isPathSelected(item.source_name)) continue;
      const targetTime = markerBySource[item.source_name];
      if (targetTime == null || !Number.isFinite(targetTime)) continue;
      if (!showMarker(targetTime)) continue;
      const withTime = item.points.filter((p) => typeof p.time === "number" && Number.isFinite(p.time));
      if (withTime.length === 0) continue;
      let best = withTime[0];
      let bestDist = Math.abs((best.time ?? 0) - targetTime);
      for (const p of withTime) {
        const d = Math.abs((p.time ?? 0) - targetTime);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      out.push({ point: best, pathItem: item });
    }
    return out;
  }

  /** Points on selected tracks at boat-marker time (drawn as golden boat icon). Only drawn when selectedTimeSec is not active or >= boat time. */
  function getMarkerBoatData(): TimeCircleDatum[] {
    const markerBySource = props.markerTimeBySourceBoat;
    if (!markerBySource || Object.keys(markerBySource).length === 0) return [];
    const selectedTime = props.selectedTimeSec;
    const showMarker = (markerTime: number) =>
      selectedTime == null || !Number.isFinite(selectedTime) || selectedTime >= markerTime;
    const out: TimeCircleDatum[] = [];
    for (const item of pathItems) {
      if (!isPathSelected(item.source_name)) continue;
      const targetTime = markerBySource[item.source_name];
      if (targetTime == null || !Number.isFinite(targetTime)) continue;
      if (!showMarker(targetTime)) continue;
      const withTime = item.points.filter((p) => typeof p.time === "number" && Number.isFinite(p.time));
      if (withTime.length === 0) continue;
      let best = withTime[0];
      let bestDist = Math.abs((best.time ?? 0) - targetTime);
      for (const p of withTime) {
        const d = Math.abs((p.time ?? 0) - targetTime);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      out.push({ point: best, pathItem: item });
    }
    return out;
  }

  const YELLOW_STAR_COLOR = "#ffd700";
  const GOLDEN_BOAT_COLOR = "#ffd700";
  const STAR_SIZE = 80;

  /** Draw max BSP (or max accel in ACCEL view) positions as gold stars. */
  function drawMarkerStars() {
    if (!map || !g) return;
    const starData = getMarkerStarData();
    const starSymbol = d3.symbol<TimeCircleDatum>().type(d3.symbolStar).size(STAR_SIZE);
    let starsGroup = g!.selectAll<SVGGElement, number>(".prestart-report-marker-stars").data([0]).join("g").attr("class", "prestart-report-marker-stars");
    starsGroup.each(function () {
      (this.parentNode as SVGElement).appendChild(this);
    });
    const sel = starsGroup.selectAll<SVGPathElement, TimeCircleDatum>(".prestart-report-marker-star").data(starData, (d) => `${d.pathItem.eventId}`);
    sel
      .enter()
      .append("path")
      .attr("class", "prestart-report-marker-star")
      .merge(sel)
      .attr("d", starSymbol)
      .attr("transform", (d) => {
        try {
          const pt = map!.latLngToLayerPoint(d.point.LatLng);
          return `translate(${pt.x},${pt.y})`;
        } catch {
          return "translate(0,0)";
        }
      })
      .style("fill", YELLOW_STAR_COLOR)
      .style("stroke", "rgba(0,0,0,0.5)")
      .style("stroke-width", 1)
      .style("pointer-events", "none");
    sel.exit().remove();
    drawMarkerBoats();
  }

  /** Draw golden boat icons at max accel time when not in ACCEL/MAX BSP view. */
  function drawMarkerBoats() {
    if (!map || !g) return;
    const boatData = getMarkerBoatData();
    const zoom = map.getZoom();
    const boatPath = getBoatPathForZoom(zoom, selectedClassIcon());
    let boatsGroup = g!.selectAll<SVGGElement, number>(".prestart-report-marker-boats").data([0]).join("g").attr("class", "prestart-report-marker-boats");
    boatsGroup.each(function () {
      (this.parentNode as SVGElement).appendChild(this);
    });
    const sel = boatsGroup.selectAll<SVGPathElement, TimeCircleDatum>(".prestart-report-marker-boat").data(boatData, (d) => `${d.pathItem.eventId}-boat`);
    sel
      .enter()
      .append("path")
      .attr("class", "prestart-report-marker-boat")
      .merge(sel)
      .attr("d", boatPath || "M0 0")
      .attr("transform", (d) => {
        try {
          const pt = map!.latLngToLayerPoint(d.point.LatLng);
          const hdg = (d.point.hdg ?? 0) - 180;
          const scale = getBoatScaleFactor(map!, d.point.lat, map!.getZoom(), selectedClassIcon());
          return `translate(${pt.x},${pt.y}) rotate(${hdg}) scale(${scale})`;
        } catch {
          return "translate(0,0)";
        }
      })
      .style("fill", GOLDEN_BOAT_COLOR)
      .style("stroke", "rgba(0,0,0,0.5)")
      .style("stroke-width", 1)
      .style("pointer-events", "none");
    sel.exit().remove();
  }

  function updateMarkerStars() {
    if (!map || !g) return;
    g.selectAll<SVGPathElement, TimeCircleDatum>(".prestart-report-marker-star").attr("transform", (d) => {
      try {
        const pt = map!.latLngToLayerPoint(d.point.LatLng);
        return `translate(${pt.x},${pt.y})`;
      } catch {
        return "translate(0,0)";
      }
    });
  }

  function updateMarkerBoats() {
    if (!map || !g) return;
    g.selectAll<SVGPathElement, TimeCircleDatum>(".prestart-report-marker-boat").attr("transform", (d) => {
      try {
        const pt = map!.latLngToLayerPoint(d.point.LatLng);
        const hdg = (d.point.hdg ?? 0) - 180;
        const scale = getBoatScaleFactor(map!, d.point.lat, map!.getZoom(), selectedClassIcon());
        return `translate(${pt.x},${pt.y}) rotate(${hdg}) scale(${scale})`;
      } catch {
        return "translate(0,0)";
      }
    });
  }

  function updateTimeCircles() {
    if (!map || !g) return;
    g.selectAll<SVGCircleElement, TimeCircleDatum>(".prestart-report-time-circle")
      .attr("cx", (d) => {
        try {
          return map!.latLngToLayerPoint(d.point.LatLng).x;
        } catch {
          return 0;
        }
      })
      .attr("cy", (d) => {
        try {
          return map!.latLngToLayerPoint(d.point.LatLng).y;
        } catch {
          return 0;
        }
      });
  }

  function updateBoats() {
    if (!map || !g) return;
    const zoom = map.getZoom();
    const boatPath = getBoatPathForZoom(zoom, selectedClassIcon());
    g.selectAll<SVGPathElement, TimeCircleDatum>(".prestart-report-boat")
      .attr("d", boatPath || "M0 0")
      .attr("transform", (d) => {
        try {
          const pt = map!.latLngToLayerPoint(d.point.LatLng);
          const hdg = (d.point.hdg ?? 0) - 180;
          const scale = getBoatScaleFactor(map!, d.point.lat, zoom, selectedClassIcon());
          return `translate(${pt.x},${pt.y}) rotate(${hdg}) scale(${scale})`;
        } catch {
          return "translate(0,0)";
        }
      });
  }

  /** Returns marks in the same coordinate system as tracks (Python fixed origin). When marksAlreadyRotated, use as-is; otherwise SL1, SL2, M1 are shifted to MANEUVER_MAP_ORIGIN frame when SL1 is present. */
  function getEffectiveMarks(): PrestartMark[] {
    const raw = props.marks ?? [];
    if (raw.length === 0) return [];
    if (props.marksAlreadyRotated) return raw;
    const course = props.courseAxisDeg;
    const sl1 = raw.find((m) => m.NAME === "SL1");
    if (sl1 && Number.isFinite(sl1.LAT) && Number.isFinite(sl1.LON)) {
      return rotateMarksByCourseAxis(raw, Number.isFinite(course) ? course : 0);
    }
    return raw;
  }

  function drawMarks() {
    if (!map || !g) return;
    const markList = getEffectiveMarks();
    const marksGroup = g.selectAll<SVGGElement, PrestartMark>(".prestart-report-marks").data(markList.length ? [markList] : []);
    marksGroup.exit().remove();
    const enter = marksGroup.enter().append("g").attr("class", "prestart-report-marks");
    const merge = enter.merge(marksGroup as d3.Selection<SVGGElement, PrestartMark[], SVGGElement, unknown>);
    merge.selectAll("*").remove();
    if (markList.length === 0) return;
    merge.each(function (d) {
      const sel = d3.select(this);
      const marks = d as unknown as PrestartMark[];
      
      // Draw dashed line between SL1 and SL2
      const sl1 = marks.find((m) => m.NAME === "SL1");
      const sl2 = marks.find((m) => m.NAME === "SL2");
      if (sl1 && sl2) {
        try {
          const pt1 = map!.latLngToLayerPoint(L.latLng(sl1.LAT, sl1.LON));
          const pt2 = map!.latLngToLayerPoint(L.latLng(sl2.LAT, sl2.LON));
          sel.append("line")
            .attr("class", "prestart-report-mark-line")
            .attr("x1", pt1.x)
            .attr("y1", pt1.y)
            .attr("x2", pt2.x)
            .attr("y2", pt2.y)
            .style("stroke", "white")
            .style("stroke-width", 2)
            .style("stroke-dasharray", "5,5");
        } catch {
          // skip if invalid
        }
      }
      
      for (const m of marks) {
        try {
          const pt = map!.latLngToLayerPoint(L.latLng(m.LAT, m.LON));
          const circle = sel.append("circle").attr("class", "prestart-report-mark-circle").attr("cx", pt.x).attr("cy", pt.y).attr("r", 6).style("fill", "white").style("stroke", "#333").style("stroke-width", 2);
          const labelY = (m.NAME === "SL2" || m.NAME === "M1") ? pt.y + 18 : pt.y - 10;
          sel.append("text").attr("class", "prestart-report-mark-label").attr("x", pt.x).attr("y", labelY).attr("text-anchor", "middle").attr("font-size", "11px").attr("font-weight", "bold").style("fill", "var(--color-text-primary, #111)").text(m.NAME);
        } catch {
          // skip invalid mark
        }
      }
    });
  }

  function updateMarks() {
    if (!map || !g) return;
    const markList = getEffectiveMarks();
    g.selectAll(".prestart-report-marks").each(function () {
      const sel = d3.select(this);
      
      // Update line between SL1 and SL2
      const sl1 = markList.find((m) => m.NAME === "SL1");
      const sl2 = markList.find((m) => m.NAME === "SL2");
      if (sl1 && sl2) {
        try {
          const pt1 = map!.latLngToLayerPoint(L.latLng(sl1.LAT, sl1.LON));
          const pt2 = map!.latLngToLayerPoint(L.latLng(sl2.LAT, sl2.LON));
          sel.selectAll(".prestart-report-mark-line")
            .attr("x1", pt1.x)
            .attr("y1", pt1.y)
            .attr("x2", pt2.x)
            .attr("y2", pt2.y);
        } catch {
          // skip if invalid
        }
      }
      
      sel.selectAll(".prestart-report-mark-circle").attr("cx", (_, i) => {
        const m = markList[i];
        if (!m) return 0;
        try {
          return map!.latLngToLayerPoint(L.latLng(m.LAT, m.LON)).x;
        } catch {
          return 0;
        }
      }).attr("cy", (_, i) => {
        const m = markList[i];
        if (!m) return 0;
        try {
          return map!.latLngToLayerPoint(L.latLng(m.LAT, m.LON)).y;
        } catch {
          return 0;
        }
      });
      sel.selectAll(".prestart-report-mark-label").attr("x", (_, i) => {
        const m = markList[i];
        if (!m) return 0;
        try {
          return map!.latLngToLayerPoint(L.latLng(m.LAT, m.LON)).x;
        } catch {
          return 0;
        }
      }).attr("y", (_, i) => {
        const m = markList[i];
        if (!m) return 0;
        try {
          const pt = map!.latLngToLayerPoint(L.latLng(m.LAT, m.LON));
          return (m.NAME === "SL2" || m.NAME === "M1") ? pt.y + 18 : pt.y - 10;
        } catch {
          return 0;
        }
      });
    });
  }

  function drawPaths() {
    if (!map || !g) return;
    pathItems = buildPathItems(props.tracks, getColor);
    const lineGen = makeLineGen();
    if (!lineGen) return;
    const selectedTimeSec = props.selectedTimeSec;
    const pointsForItem = (item: PathItem) => getPointsForPath(item.points, selectedTimeSec);

    const selectedFirst = [...pathItems].sort((a, b) => {
      const aSel = isPathSelected(a.source_name);
      const bSel = isPathSelected(b.source_name);
      return (aSel ? 1 : 0) - (bSel ? 1 : 0);
    });

    const sel = g.selectAll<SVGPathElement, PathItem>(".prestart-report-path").data(selectedFirst, (d) => d.eventId);

    sel
      .enter()
      .append("path")
      .attr("class", (d) => `prestart-report-path ${getPathSelectionClass(d.source_name)}`)
      .attr("data-event-id", (d) => d.eventId)
      .merge(sel)
      .attr("class", (d) => `prestart-report-path ${getPathSelectionClass(d.source_name)}`)
      .style("stroke", (d) => d.color)
      .style("stroke-linecap", "round")
      .style("fill", "none")
      .style("pointer-events", "none")
      .attr("d", (d) => lineGen(pointsForItem(d)) ?? "");

    sel.exit().remove();

    g.selectAll(".prestart-report-hover-circle").remove();
    const onTrackClick = props.onTrackClick;
    selectedFirst.forEach((item) => {
      const pts = pointsForItem(item);
      const hoverCircles = g!.selectAll<SVGCircleElement, PointWithLatLng>(`.prestart-report-hover-circle-${item.eventId}`).data(pts, (p) => `${p.lat}-${p.lng}`);
      const merge = hoverCircles
        .enter()
        .append("circle")
        .attr("class", `prestart-report-hover-circle prestart-report-hover-circle-${item.eventId}`)
        .attr("r", 5)
        .style("fill", "transparent")
        .style("stroke", "none")
        .style("pointer-events", onTrackClick ? "all" : "none")
        .style("cursor", onTrackClick ? "pointer" : "default")
        .merge(hoverCircles);
      merge
        .attr("cx", (d) => {
          try {
            return map!.latLngToLayerPoint(d.LatLng).x;
          } catch {
            return 0;
          }
        })
        .attr("cy", (d) => {
          try {
            return map!.latLngToLayerPoint(d.LatLng).y;
          } catch {
            return 0;
          }
        });
      if (onTrackClick) {
        merge.on("click", (event: MouseEvent) => {
          event.stopPropagation();
          onTrackClick(item.source_name, item.eventId);
        });
      } else {
        merge.on("click", null);
      }
      hoverCircles.exit().remove();
    });

    const zoom = map.getZoom();
    const boatPath = getBoatPathForZoom(zoom, selectedClassIcon());
    g.selectAll(".prestart-report-time-circle").remove();
    g.selectAll(".prestart-report-boat").remove();
    const intervalData: TimeCircleDatumWithFinal[] = [];
    for (const item of selectedFirst) {
      const intervalPoints = getPointsAt10sIntervals(pointsForItem(item));
      intervalPoints.forEach((point, idx) => {
        const isFinalPosition = idx === intervalPoints.length - 1;
        intervalData.push({ point, pathItem: item, isFinalPosition });
      });
    }
    /** Boats only at final position (when hdg available). */
    const boatData = intervalData.filter(
      (d) => d.isFinalPosition && boatPath && typeof d.point.hdg === "number" && Number.isFinite(d.point.hdg)
    );
    /** Circles for all non-final positions, and final when no boat (no hdg). */
    const circleData = intervalData.filter(
      (d) => !d.isFinalPosition || !boatPath || typeof d.point.hdg !== "number" || !Number.isFinite(d.point.hdg)
    );

    boatData.forEach((d) => {
      try {
        const pt = map!.latLngToLayerPoint(d.point.LatLng);
        const hdg = (d.point.hdg ?? 0) - 180;
        const scale = getBoatScaleFactor(map!, d.point.lat, zoom, selectedClassIcon());
        const boatClass = isPathSelected(d.pathItem.source_name) ? "prestart-report-boat-selected" : "prestart-report-boat-unselected";
        g!.append("path")
          .datum(d)
          .attr("class", `prestart-report-boat ${boatClass}`)
          .attr("d", boatPath)
          .attr("transform", `translate(${pt.x},${pt.y}) rotate(${hdg}) scale(${scale})`)
          .style("fill", d.pathItem.color)
          .style("stroke", "black")
          .style("pointer-events", "none");
      } catch {
        // skip
      }
    });

    const circles = g.selectAll<SVGCircleElement, TimeCircleDatumWithFinal>(".prestart-report-time-circle").data(circleData, (d) => `${d.pathItem.eventId}-${d.point.lat}-${d.point.lng}`);
    circles
      .enter()
      .append("circle")
      .attr("class", (d) => `prestart-report-time-circle ${isPathSelected(d.pathItem.source_name) ? "prestart-report-time-circle-selected" : "prestart-report-time-circle-unselected"}`)
      .attr("r", (d) => getMarkerCircleRadius(isPathSelected(d.pathItem.source_name)))
      .attr("cx", (d) => {
        try {
          return map!.latLngToLayerPoint(d.point.LatLng).x;
        } catch {
          return 0;
        }
      })
      .attr("cy", (d) => {
        try {
          return map!.latLngToLayerPoint(d.point.LatLng).y;
        } catch {
          return 0;
        }
      })
      .style("fill", (d) => d.pathItem.color)
      .style("stroke", "none")
      .style("pointer-events", "none");
    circles.exit().remove();
    drawMarkerStars();
  }

  function fitBoundsIfNeeded() {
    if (!map) return;
    const allLatLng: L.LatLng[] = [];
    for (const item of pathItems) {
      for (const p of item.points) allLatLng.push(p.LatLng);
    }
    const marks = getEffectiveMarks();
    for (const m of marks) {
      if (Number.isFinite(m.LAT) && Number.isFinite(m.LON)) {
        allLatLng.push(L.latLng(m.LAT, m.LON));
      }
    }
    if (allLatLng.length > 0) {
      try {
        map.fitBounds(L.latLngBounds(allLatLng));
      } catch (err) {
        logError("PrestartReportMap: fitBounds failed", err);
      }
    }
  }

  createEffect(() => {
    const el = containerRef();
    if (!el || map) return;

    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const tileLayer = L.tileLayer("", { attribution: "" });
      map = L.map(CONTAINER_ID, {
        minZoom: 0,
        maxZoom: 24,
        zoomControl: false,
        dragging: false,
        doubleClickZoom: false,
        scrollWheelZoom: false,
        touchZoom: false,
        keyboard: false,
      })
        .addLayer(tileLayer)
        .setView([0, 0], 13);

      L.svg({ interactive: true }).addTo(map);
      const svg = d3.select(map.getPanes().overlayPane).select("svg");
      svg.attr("pointer-events", "auto").attr("z-index", 900);
      svg.selectAll("g").remove();
      g = svg
        .append("g")
        .attr("width", rect.width)
        .attr("height", rect.height)
        .attr("z-index", 1000);

      d3.selectAll(".leaflet-attribution-flag").remove();

      map.on("viewreset", () => {
        updatePaths();
        updateHoverCircles();
        updateTimeCircles();
        updateBoats();
        updateMarkerStars();
        updateMarkerBoats();
        updateMarks();
      });
      map.on("zoomend", () => {
        drawPaths();
        updateTimeCircles();
        updateMarks();
      });

      pathItems = buildPathItems(props.tracks, getColor);
      drawPaths();
      drawMarks();
      fitBoundsIfNeeded();
    } catch (err) {
      logError("PrestartReportMap: init failed", err);
      if (map) {
        map.remove();
        map = null;
      }
    }
  });

  createEffect(() => {
    const _ = props.tracks;
    const _m = props.marks;
    const _c = props.courseAxisDeg;
    const _s = props.selectedSourceNames;
    const _st = props.selectedTimeSec;
    const _marker = props.markerTimeBySource;
    if (!map || !g) return;
    drawPaths();
    drawMarks();
    fitBoundsIfNeeded();
  });

  onCleanup(() => {
    if (map) {
      map.remove();
      map = null;
    }
    g = null;
  });

  return (
    <div
      id={CONTAINER_ID}
      ref={setContainerRef}
      class="prestart-report-map"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
