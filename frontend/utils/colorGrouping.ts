// Shared color-grouping utility for Maneuvers children (Map, Scatter, TimeSeries, Tables)
// Builds a color scale and groups data by the current color dimension
import * as d3 from 'd3';
import { getColorByIndex } from './colorScale';
import { sourcesStore } from '../store/sourcesStore';
import { warn as logWarning, debug as logDebug } from './console';

type Group<T> = { key: string | number; items: T[] };

function extractValue(item: any, colorName: string): number | string {
  switch (colorName) {
    case 'TWS':
      return item.tws_bin;
    case 'VMG':
      return item.vmg_perc_avg;
    case 'TACK':
      return item.tack;
    case 'RACE':
      // Use normalized field name first (unifiedDataStore normalizes metadata)
      const raceValue = item.race_number ?? item.race ?? item.Race_number ?? item.Race ?? item.RACE;
      if (raceValue === -1 || raceValue === '-1' || String(raceValue) === '-1') {
        return 'TRAINING';
      }
      return raceValue;
    case 'SOURCE':
      return item.source_name ?? '';
    case 'STATE':
      // Use normalized field name first
      return item.state ?? item.State ?? item.STATE ?? '';
    case 'CONFIG':
      return item.config ?? item.Config ?? item.CONFIG ?? '';
    case 'YEAR':
      return item.year ?? item.Year ?? item.YEAR ?? '';
    case 'EVENT':
      return item.event ?? item.Event ?? item.EVENT ?? item.event_type ?? '';
    default:
      return '';
  }
}

/** Returns the group key for an item under the given color dimension (same rules as extractValue, including RACE -1 → 'TRAINING'). */
export function getGroupKeyFromItem(item: any, colorName: string): string | number {
  const v = extractValue(item, colorName);
  return v === undefined || v === null ? '' : v;
}

/**
 * Converts legend display text (as passed from ManeuverLegend click) to the same key format
 * used by getGroupKeyFromItem, so legend clicks can toggle selectedGroupKeys correctly.
 */
export function legendTextToGroupKey(legendItem: string, colorName: string): string | number {
  const s = String(legendItem).trim();
  if (s === '') return '';
  switch (colorName) {
    case 'TWS': {
      const n = Number(s);
      return isNaN(n) ? s : n;
    }
    case 'VMG':
      // VMG legend shows intervals like "1.2-3.4"; keep as string
      return s;
    case 'TACK':
      return s;
    case 'RACE':
      if (s === '-1' || s.toLowerCase() === 'training') return 'TRAINING';
      const rn = Number(s);
      return isNaN(rn) ? s : rn;
    case 'SOURCE':
      return s.toLowerCase();
    case 'STATE':
    case 'CONFIG':
    default:
      return s;
  }
}

/**
 * Converts legend display text to the exact key format used by getGroupKeyFromItem (e.g. in the grouped DataTable).
 * Use this for legend clicks so selection matches the table: same key format, same includes() check.
 * Differs from legendTextToGroupKey for SOURCE (no lowercase) so keys match table row keys.
 */
export function legendTextToGroupKeyTable(legendItem: string, colorName: string): string | number {
  const s = String(legendItem).trim();
  if (s === '') return '';
  switch (colorName) {
    case 'TWS': {
      const n = Number(s);
      return isNaN(n) ? s : n;
    }
    case 'VMG':
      return s;
    case 'TACK':
      return s;
    case 'RACE':
      if (s === '-1' || s.toLowerCase() === 'training') return 'TRAINING';
      const rn = Number(s);
      return isNaN(rn) ? s : rn;
    case 'SOURCE':
    case 'STATE':
    case 'CONFIG':
    default:
      return s;
  }
}

/** Returns true if two group keys are equivalent (e.g. 15 and "15" for TWS). */
export function groupKeyEquals(a: string | number, b: string | number): boolean {
  if (a === b) return true;
  if (String(a) === String(b)) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && na === nb) return true;
  return false;
}

export function buildColorGrouping<T extends Record<string, any>>(data: T[], colorName: string) {
  const values = (data || []).map(d => extractValue(d, colorName)).filter(v => v !== undefined && v !== null);

  let scale: d3.ScaleLinear<number, string> | d3.ScaleThreshold<number, string> | d3.ScaleOrdinal<string | number, string>;

  if (colorName === 'TWS') {
    // Fixed TWS bins: 10, 15, 20, 25, 30, 35, 40, 45, 50
    // Use scaleThreshold with 8 thresholds to create 9 color ranges (one for each bin)
    const twsScale = d3.scaleThreshold<number, string>();
    twsScale.domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]);
    twsScale.range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"]);
    scale = twsScale;
  } else if (colorName === 'VMG') {
    const nums: number[] = values.map(v => Number(v)).filter((v): v is number => !isNaN(v) && isFinite(v));
    if (nums.length === 0) {
      const vmgScale = d3.scaleLinear<number, string>();
      vmgScale.domain([0, 50, 100]);
      (vmgScale as any).range(["blue","lightgrey","red"]);
      scale = vmgScale;
    } else {
      // Use 1-sigma range (mean ± 1 std) for VMG coloring
      const mean = d3.mean(nums) || 0;
      const std = d3.deviation(nums) || 0;
      const min = mean - std;
      const max = mean + std;
      const mid = (min + max) / 2;
      const vmgScale = d3.scaleLinear<number, string>();
      vmgScale.domain([min, mid, max]);
      (vmgScale as any).range(["blue","lightgrey","red"]);
      scale = vmgScale;
    }
  } else if (colorName === 'TACK') {
    scale = d3.scaleThreshold<number, string>().domain([-180,-1,1,180]).range(["red","red","#64ed64","#64ed64"]);
  } else if (colorName === 'SOURCE') {
    // Use fleet source colors from store (matching FleetPerformance approach)
    const sources = sourcesStore.sources();
    const isReady = sourcesStore.isReady();
    
    if (sources.length > 0) {
      // Use source names (lowercase) as domain and their colors as range
      // This matches how FleetPerformance creates its color scale
      const sourceNames = sources.map(s => String(s.source_name).toLowerCase());
      const colors = sources.map(s => s.color || '#1f77b4');
      
      const ordinalScale = d3.scaleOrdinal<string | number, string>()
        .domain(sourceNames)
        .range(colors);
      (ordinalScale as any).unknown('#1f77b4');
      scale = ordinalScale;
    } else if (!isReady) {
      // Sources are empty and store is not ready - trigger refresh
      // This happens when app loads fresh and sources haven't been fetched yet
      logDebug('buildColorGrouping: Sources empty and store not ready, triggering refresh');
      sourcesStore.refresh().catch((error) => {
        logWarning('buildColorGrouping: Failed to refresh sources', error);
      });
      
      // Fallback to index-based colors while sources are loading
      const cats = Array.from(new Set(values as (string | number)[]));
      const fallbackColors: string[] = [];
      let i = 0;
      cats.forEach(() => {
        fallbackColors.push(getColorByIndex(i));
        i += 1;
      });
      scale = d3.scaleOrdinal<string | number, string>().domain(cats).range(fallbackColors);
    } else {
      // Sources are empty but store is ready - this means there are no sources for this project
      // Use fallback colors
      logDebug('buildColorGrouping: Sources empty but store is ready - no sources for this project');
      const cats = Array.from(new Set(values as (string | number)[]));
      const fallbackColors: string[] = [];
      let i = 0;
      cats.forEach(() => {
        fallbackColors.push(getColorByIndex(i));
        i += 1;
      });
      scale = d3.scaleOrdinal<string | number, string>().domain(cats).range(fallbackColors);
    }
  } else if (colorName === 'MAINSAIL' || colorName === 'HEADSAIL') {
    // Custom color mapping for sail codes: J1=blue, J1.5=lightblue, J2=green, J3=orange, J4=red
    const sailColorMap: Record<string, string> = {
      'J1': 'blue',
      'j1': 'blue',
      'J1.5': 'lightblue',
      'j1.5': 'lightblue',
      'J2': 'green',
      'j2': 'green',
      'J3': 'orange',
      'j3': 'orange',
      'J4': 'red',
      'j4': 'red'
    };
    
    const cats = Array.from(new Set(values as (string | number)[]));
    const colors: string[] = [];
    cats.forEach(v => {
      const sailCode = String(v);
      // Check if we have a custom color for this sail code
      if (sailColorMap[sailCode]) {
        colors.push(sailColorMap[sailCode]);
      } else {
        // Fallback to index-based color for unknown sail codes
        const index = cats.indexOf(v);
        colors.push(getColorByIndex(index));
      }
    });
    scale = d3.scaleOrdinal<string | number, string>().domain(cats).range(colors);
  } else if (colorName === 'RACE') {
    const cats = Array.from(new Set(values as (string | number)[]));
    // Sort RACE values consistently to ensure same colors across all components
    // Handle 'TRAINING' and numeric values specially
    const sortedCats = cats.sort((a, b) => {
      const aStr = String(a);
      const bStr = String(b);
      // Put 'TRAINING' first, then sort others
      if (aStr === 'TRAINING' || aStr === '-1') return -1;
      if (bStr === 'TRAINING' || bStr === '-1') return 1;
      // Sort numeric values numerically, strings alphabetically
      const aNum = Number(a);
      const bNum = Number(b);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return aNum - bNum;
      }
      return aStr.localeCompare(bStr);
    });
    const colors: string[] = [];
    let i = 0;
    sortedCats.forEach(v => {
      if (String(v) === '0' || String(v) === 'TRAINING' || String(v) === '-1') {
        colors.push('lightgrey');
      } else {
        colors.push(getColorByIndex(i));
      }
      i += 1;
    });
    scale = d3.scaleOrdinal<string | number, string>().domain(sortedCats).range(colors);
  } else if (colorName === 'STATE') {
    const cats = Array.from(new Set(values as (string | number)[]));
    // Sort State values consistently to ensure same colors across all components
    const sortedCats = cats.sort((a, b) => {
      const aStr = String(a);
      const bStr = String(b);
      return aStr.localeCompare(bStr);
    });
    const colors: string[] = [];
    let i = 0;
    sortedCats.forEach(() => {
      colors.push(getColorByIndex(i));
      i += 1;
    });
    scale = d3.scaleOrdinal<string | number, string>().domain(sortedCats).range(colors);
  } else if (colorName === 'CONFIG') {
    const cats = Array.from(new Set(values as (string | number)[]));
    // Sort CONFIG values consistently to ensure same colors across all components
    const sortedCats = cats.sort((a, b) => {
      const aStr = String(a);
      const bStr = String(b);
      return aStr.localeCompare(bStr);
    });
    const colors: string[] = [];
    let i = 0;
    sortedCats.forEach(() => {
      colors.push(getColorByIndex(i));
      i += 1;
    });
    scale = d3.scaleOrdinal<string | number, string>().domain(sortedCats).range(colors);
  } else if (colorName === 'YEAR') {
    const cats = Array.from(new Set(values as (string | number)[]));
    const sortedCats = cats.sort((a, b) => String(a).localeCompare(String(b)));
    const colors: string[] = [];
    let i = 0;
    sortedCats.forEach(() => {
      colors.push(getColorByIndex(i));
      i += 1;
    });
    scale = d3.scaleOrdinal<string | number, string>().domain(sortedCats).range(colors);
  } else if (colorName === 'EVENT') {
    const cats = Array.from(new Set(values as (string | number)[]));
    const sortedCats = cats.sort((a, b) => String(a).localeCompare(String(b)));
    const colors: string[] = [];
    let i = 0;
    sortedCats.forEach(() => {
      colors.push(getColorByIndex(i));
      i += 1;
    });
    scale = d3.scaleOrdinal<string | number, string>().domain(sortedCats).range(colors);
  } else {
    // Default fallback
    const defaultScale = d3.scaleLinear<number, string>();
    // defaultScale.domain([4, 8, 14, 18, 22]);
    defaultScale.domain([8, 16, 28, 36, 44]);
    (defaultScale as any).range(["yellow","orange","red"]);
    scale = defaultScale;
  }

  const groups = new Map<string | number, T[]>();
  (data || []).forEach(item => {
    const k = extractValue(item, colorName);
    const key = (k === undefined || k === null) ? '' : (k as any);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  });

  const grouped: Group<T>[] = Array.from(groups.entries()).map(([key, items]) => ({ key, items }));

  const getItemColor = (item: T): string => {
    if (colorName === 'TACK') {
      // TACK handled by thresholds
      const v = extractValue(item, colorName);
      if (v === 'PORT' || v === 'S - P') return '#d62728';
      if (v === 'STBD' || v === 'P - S') return '#2ca02c';
      return 'grey';
    }
    const v = extractValue(item, colorName) as any;
    // For SOURCE, normalize to lowercase for lookup
    if (colorName === 'SOURCE' && typeof v === 'string') {
      // @ts-ignore
      return (scale as any)(v.toLowerCase());
    }
    // @ts-ignore
    return (scale as any)(v);
  };

  return { scale, groups: grouped, getItemColor };
}


