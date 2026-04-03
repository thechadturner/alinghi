import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import ManeuverScatter from "../../charts/ManeuverScatter";
import ManeuverLegend from "../../legends/Maneuver";
import { tabledata, color, filtered, eventType } from "../../../store/globalStore";
import { isEventHidden, setTriggerUpdate } from "../../../store/selectionStore";
import { buildColorGrouping } from "../../../utils/colorGrouping";
import { groupBy } from "../../../utils/global";
import { sourcesStore } from "../../../store/sourcesStore";
import { TAKEOFF_CHANNELS } from "../../../utils/maneuversConfig";
import * as d3 from "d3";

/** Chart order for scatter view. List channel names in desired display order; channels not listed appear after. */
const charts_order: string[] = ['mmg','vmg_perc_avg','loss_total_tgt','loss_inv_tgt','loss_turn_tgt','loss_build_tgt','bsp_drop','bsp_min','bsp_min_delta','twa_drop_n','overshoot_perc','turn_angle_max','turn_rate_max','rud_ang_max','lwy_max','decel_slope','accel_slope','turn_radius','time_two_boards','time_dropping','time_raising','pop_time','drop_time','raise_time','heel_lock','rake_min_old_turn','rake_max_new_turn','rake_raise','aoa_raise','cant_drop_tgt'];

/** Chart order for TAKEOFF scatter (same columns as big table). */
const charts_order_takeoff: string[] = TAKEOFF_CHANNELS.map((c) => c.toLowerCase());

/** Info/warning messages per channel (key = lowercase channel name). Only channels with a non-empty message show an icon. */
const scatter_info: Record<string, { type?: 'info' | 'warning'; message: string }> = {
  mmg: { message: "Meters made good into the wind for tacks, away from the wind in gybes." },
  vmg_perc_avg: { message: "VMG percent of target average." },
  loss_total_tgt: { message: "Overall maneuver loss in meters relative to target vmg." },
  loss_inv_tgt: { message: "Loss during investment phase when entering the maneuver, relative to target vmg." },
  loss_turn_tgt: { message: "Loss during the turn phase of the maneuver, relative to target vmg." },
  loss_build_tgt: { message: "Loss during the build phase of the maneuver relative to target vmg. The build is the period after min boat speed." },
  bsp_drop: { message: "Boat speed at the time of the drop button press." },
  bsp_min: { message: "Minimum boat speed during the maneuver." },
  bsp_min_delta: { message: "Drop boat speed - minimum boat speed" },
  twa_drop_n: { message: "Normalized true wind angle at the time of the drop button press." },
  overshoot_perc: { message: "Overshoot is the difference between your maximim turn angle heading and the heading when you are back up to speed. Overshoot percentage is the ratio of overshoot to max turn angle." },
  turn_angle_max: { message: "Maximum turn angle" },
  turn_rate_max: { message: "Maximum turn rate" },
  rud_ang_max: { message: "Maximum rudder angle" },
  lwy_max: { message: "Maximum leeway" },
  decel_slope: { message: "Deceleration slope.  Larger values = greater deceleration. Values of zero mean no deceleration." },
  accel_slope: { message: "Acceleration slope.  Larger values = greater acceleration. Values of zero mean no acceleration." },
  turn_radius: { message: "If the turn were represented by a circle, this value represents the radius of that circle" },
  time_two_boards: { message: "The seconds with both daggerboards nearly fully extended." },
  time_dropping: { message: "The time from when the button has been pressed to when the stow sequence is completed" },
  time_raising: { message: "The time from when the button has been pressed to when the stow sequence is completed" },
  pop_time: { message: "The time from head to wind when CA1 has inverted signs" },
  drop_time: { message: "The time from head to wind when the drop sequence was initiated" },
  raise_time: { message: "The time from head to wind when the raise sequence was initiated" },
  heel_lock: { message: "The heel when the daggerboard drop sequence completed" },
  rake_min_old_turn: { message: "The minimum rake of the outside foil through the turn" },
  rake_max_new_turn: { message: "The maximum rake of the inside foil through the turn" },
  rake_raise: { message: "The rake of the foil being raised at the time of the raise" },
  aoa_raise: { message: "The angle of attack of the foil being raised at the time of the raise." },
  cant_drop_tgt: { message: "The cant drop angle target" },
};

const ACCMAX_MSG = "Value at time of maximum acceleration.";

/** Info messages for TAKEOFF scatter channels. */
const scatter_info_takeoff: Record<string, { type?: 'info' | 'warning'; message: string }> = {
  tws_avg: { message: "True wind speed average; unit follows project speed setting." },
  mmg: { message: "Meters made good." },
  vmg_perc_avg: { message: "VMG percent of target average." },
  bsp_start: { message: "Boat speed at start." },
  twa_build: { message: "True wind angle during build phase." },
  time_accel: { message: "Time for acceleration." },
  exit_time: { message: "Pop time (exit time)." },
  bsp_exit: { message: "Boat speed at exit (pop)." },
  twa_exit: { message: "True wind angle at exit." },
  pitch_accmax: { message: ACCMAX_MSG },
  heel_accmax: { message: ACCMAX_MSG },
  rake_accmax: { message: ACCMAX_MSG },
  rud_rake_accmax: { message: ACCMAX_MSG },
  rud_diff_accmax: { message: ACCMAX_MSG },
  cant_accmax: { message: ACCMAX_MSG },
  jib_sheet_pct_accmax: { message: ACCMAX_MSG },
  jib_lead_ang_accmax: { message: ACCMAX_MSG },
  jib_cunno_load_accmax: { message: ACCMAX_MSG },
  wing_clew_pos_accmax: { message: ACCMAX_MSG },
  wing_twist_accmax: { message: ACCMAX_MSG },
  wing_ca1_accmax: { message: ACCMAX_MSG }
};

interface ScatterProps {
  context?: string;
  onLegendClick?: (legendItem: string) => void;
}

export default function Scatter(props: ScatterProps) {
  onMount(() => {
    requestAnimationFrame(() => {
      if (tabledata().length > 0) {
        setTriggerUpdate(true);
      }
    });
  });

  const channels = createMemo((): string[] => {
    const rows = tabledata();
    if (!rows || rows.length === 0) return [];
    const isTakeoff = (eventType() || '').toUpperCase() === 'TAKEOFF';

    // TAKEOFF: use exact same channel list as big table (TAKEOFF_CHANNELS) so Pop Time, Pop Bsp, Pop Twa always show
    if (isTakeoff) {
      return [...charts_order_takeoff];
    }

    const sample = rows[0];
    const orderToUse = charts_order;

    // Create exclude set with lowercase versions for case-insensitive matching
    // Exclude State and Config as they are color-by channels, not visualization channels
    const excludeLower = new Set(['datetime','event_id','tws_avg','tws_bin','twa_entry','twa_entry_n','tack','race_number','leg_number','event','year','source_name','config','state','time','sink_min','grade','tack_side','row_num','twd_delta']);
    
    // Normalize channel names to lowercase and deduplicate using a Set
    // This prevents duplicates from case variations like "Source_name" and "source_name"
    const seenLowercase = new Set<string>();
    const normalizedChannels: string[] = [];
    
    for (const key of Object.keys(sample)) {
      const keyLower = key.toLowerCase();
      // Skip if excluded (case-insensitive) or already seen
      if (excludeLower.has(keyLower) || seenLowercase.has(keyLower)) {
        // Mark as seen even if excluded, to prevent duplicates
        seenLowercase.add(keyLower);
        continue;
      }
      // Add to seen set and include in channels
      seenLowercase.add(keyLower);
      // Use the original case from the first occurrence
      normalizedChannels.push(key);
    }
    
    // When charts_order is set: only draw those channels, in that order. Otherwise draw all.
    if (orderToUse.length > 0) {
      const byLower = new Map(normalizedChannels.map(c => [c.toLowerCase(), c]));
      const ordered: string[] = [];
      for (const name of orderToUse) {
        const key = name.toLowerCase();
        // Use exact key from first row when present; otherwise use lowercase name so scatter can resolve
        // via case-insensitive lookup (API may return e.g. "bsp_min_delta" while order uses "bsp_min_delta")
        const channelKey = byLower.get(key) ?? key;
        ordered.push(channelKey);
      }
      return ordered;
    }
    return normalizedChannels;
  });

  // Zoom state management
  const [zoom, setZoom] = createSignal(false);
  const [selectedChannel, setSelectedChannel] = createSignal<string | null>(null);

  const handleZoom = (channel: string | null): void => {
    if (channel) {
      setSelectedChannel(channel);
      setZoom(true);
    } else {
      setSelectedChannel(null);
      setZoom(false);
    }
  };

  // Calculate VMG intervals (5 intervals from min to max) - same logic as ManeuverBoxPlot
  const calculateVmgIntervals = (rows: any[]): { min: number; max: number; intervalSize: number; getInterval: (vmg: number) => string | null } | null => {
    const vmgValues = rows
      .map(r => parseFloat(r.vmg_perc_avg))
      .filter(v => !isNaN(v) && v !== null && v !== undefined);
    
    if (vmgValues.length === 0) return null;
    
    const min = Math.min(...vmgValues);
    const max = Math.max(...vmgValues);
    
    if (min === max) {
      return {
        min,
        max,
        intervalSize: 0,
        getInterval: () => `${min.toFixed(1)}-${max.toFixed(1)}`
      };
    }
    
    const intervalSize = (max - min) / 5;
    
    return {
      min,
      max,
      intervalSize,
      getInterval: (vmg) => {
        if (vmg < min || vmg > max) return null;
        const intervalIndex = Math.min(4, Math.floor((vmg - min) / intervalSize));
        const intervalMin = min + (intervalIndex * intervalSize);
        const intervalMax = intervalIndex === 4 ? max : min + ((intervalIndex + 1) * intervalSize);
        return `${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`;
      }
    };
  };

  // Get groups and color scale for legend - adapted from ManeuverScatter
  const getLegendGroups = createMemo(() => {
    const rows = tabledata().filter((r: any) => filtered().includes(r.event_id) && !isEventHidden(r.event_id));
    if (!rows || rows.length === 0) return { groups: [], colorScale: null };
    
    const currentColor = String(color() || 'TWS').toUpperCase();
    
    // Access sourcesStore to make memo reactive to source changes (for SOURCE coloring)
    if (currentColor === 'SOURCE') {
      sourcesStore.sources();
      sourcesStore.isReady();
    }
    
    let groups: Array<{ name: string; color: string }> = [];
    let colorScale: any = null;
    
    if (currentColor === 'TWS') {
      const uniques = groupBy(rows, 'tws_bin');
      uniques.sort((a, b) => Number(a) - Number(b));
      // @ts-ignore - D3 scaleThreshold accepts string ranges for color scales
      colorScale = d3.scaleThreshold().domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]).range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"] as any);
      groups = uniques.map(tws => ({
        name: String(tws),
        color: String(colorScale ? colorScale(Number(tws)) : 'grey')
      }));
    } else if (currentColor === 'VMG') {
      const vmgIntervals = calculateVmgIntervals(rows);
      if (vmgIntervals) {
        // Create 5 interval groups
        const intervalGroups: string[] = [];
        for (let i = 0; i < 5; i++) {
          const intervalMin = vmgIntervals.min + (i * vmgIntervals.intervalSize);
          const intervalMax = i === 4 ? vmgIntervals.max : vmgIntervals.min + ((i + 1) * vmgIntervals.intervalSize);
          intervalGroups.push(`${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`);
        }
        // @ts-ignore - D3 scaleLinear accepts string ranges for color scales
        colorScale = d3.scaleLinear().domain([vmgIntervals.min, (vmgIntervals.min + vmgIntervals.max) / 2, vmgIntervals.max]).range(["blue","lightgrey","red"]);
        groups = intervalGroups.map(interval => {
          const intervalMin = parseFloat(interval.split('-')[0]);
          return {
            name: interval,
            color: String(colorScale(intervalMin))
          };
        });
      }
    } else if (currentColor === 'TACK') {
      const uniques = groupBy(rows, 'tack');
      const evt = (eventType() || '').toUpperCase();
      const usePortStbdLabels = evt === 'TAKEOFF' || evt === 'BEARAWAY' || evt === 'ROUNDUP';
      groups = uniques.map(tack => {
        const isStbd = tack === 'STBD' || tack === 'S - P';
        const displayName = usePortStbdLabels ? (isStbd ? 'STBD' : 'PORT') : String(tack);
        return {
          name: displayName,
          color: isStbd ? '#2ca02c' : '#d62728'
        };
      });
    } else if (currentColor === 'RACE' || currentColor === 'SOURCE' || currentColor === 'STATE' || currentColor === 'CONFIG') {
      const { groups: colorGroups, scale, getItemColor } = buildColorGrouping(rows, currentColor);
      colorScale = scale;
      groups = colorGroups.map(group => {
        let itemColor = 'grey';
        if (getItemColor) {
          const dummyItem: any = {};
          if (currentColor === 'RACE') {
            dummyItem.race = group.key;
            dummyItem.Race_number = group.key;
          } else if (currentColor === 'SOURCE') {
            dummyItem.source_name = group.key;
          } else if (currentColor === 'STATE') {
            dummyItem.State = group.key;
            dummyItem.state = group.key;
            dummyItem.STATE = group.key;
          } else if (currentColor === 'CONFIG') {
            dummyItem.Config = group.key;
            dummyItem.config = group.key;
            dummyItem.CONFIG = group.key;
          }
          itemColor = getItemColor(dummyItem);
        }
        return {
          name: String(group.key),
          color: String(itemColor)
        };
      });
    }
    
    return { groups, colorScale };
  });

  return (
    <>
      <Show when={!zoom()}>
        <div id="maneuver-scatter" style={{
          "width": "100%",
          "height": "100%",
          "display": "flex",
          "flex-direction": "column"
        }}>
          <ManeuverLegend
            elementId="maneuver-legend-scatter"
            target_info={{}}
            groups={getLegendGroups().groups}
            colorScale={getLegendGroups().colorScale}
            color={color() || 'TWS'}
            click={props.onLegendClick}
          />
          <div id="maneuver-plots" class="maneuver-plots-performance-layout">
            <For each={channels()}>{(ch) => (
              <div class="maneuver-scatter-chart-wrapper">
                <ManeuverScatter
                  channel={ch}
                  eventType={eventType() ?? undefined}
                  zoom={false}
                  handleZoom={handleZoom}
                  infoMessage={((eventType() || '').toUpperCase() === 'TAKEOFF' ? scatter_info_takeoff[ch.toLowerCase()] : scatter_info[ch.toLowerCase()])?.message ?? ""}
                  infoType={((eventType() || '').toUpperCase() === 'TAKEOFF' ? scatter_info_takeoff[ch.toLowerCase()] : scatter_info[ch.toLowerCase()])?.type ?? "info"}
                />
              </div>
            )}</For>
          </div>
        </div>
      </Show>
      <Show when={zoom() && selectedChannel()}>
        <div class="zoom-container" style={{ "display": "flex", "flex-direction": "column", "min-height": "800px", "margin-top": "50px" }}>
          <ManeuverLegend
            elementId="maneuver-legend-zoom"
            target_info={{}}
            groups={getLegendGroups().groups}
            colorScale={getLegendGroups().colorScale}
            color={color() || 'TWS'}
            click={props.onLegendClick}
          />
          <div class="flex w-full h-full" style={{ height: "800px", width: "calc(100% - 25px)" }}>
            <div style={{ width: "100%", height: "100%" }}>
              <ManeuverScatter
              channel={selectedChannel()!}
              eventType={eventType() ?? undefined}
              zoom={true}
              handleZoom={handleZoom}
              infoMessage={((eventType() || '').toUpperCase() === 'TAKEOFF' ? scatter_info_takeoff[selectedChannel()!.toLowerCase()] : scatter_info[selectedChannel()!.toLowerCase()])?.message ?? ""}
              infoType={((eventType() || '').toUpperCase() === 'TAKEOFF' ? scatter_info_takeoff[selectedChannel()!.toLowerCase()] : scatter_info[selectedChannel()!.toLowerCase()])?.type ?? "info"}
            />
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
