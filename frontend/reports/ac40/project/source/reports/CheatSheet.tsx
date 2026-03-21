import { createSignal, onMount, onCleanup, createEffect, Show, For, createMemo } from "solid-js";
import * as d3 from "d3";
import { persistantStore } from "../../../../../store/persistantStore";
import { sourcesStore } from "../../../../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { getData, setupMediaContainerScaling } from "../../../../../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../../utils/logging";
import { log, debug as logDebug, error as logError } from "../../../../../utils/console";
import Loading from "../../../../../components/utilities/Loading";
import DropDownButton from "../../../../../components/buttons/DropDownButton";

const { selectedClassName, selectedProjectId, selectedSourceId } = persistantStore;

/** TWS options for group by Channel (single value; backend uses tws ± 2.5 for band). Default = 30. */
const TWS_OPTIONS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const TWS_DEFAULT_INDEX = 4; // 30

/** Metric options for group by Wind (display label -> API value); first = default BSP */
const METRIC_OPTIONS: { label: string; value: string }[] = [
  { label: "BSP", value: "bsp" },
  { label: "TWA", value: "twa" },
  { label: "VMG", value: "vmg" },
  { label: "HEEL_N", value: "heel_n" },
  { label: "PITCH", value: "pitch" },
  { label: "RH_LWD", value: "rh_lwd" },
  { label: "RUD_RAKE", value: "rud_rake" },
  { label: "RUD_DIFF", value: "rud_diff" },
  { label: "DB_CANT", value: "db_cant" },
  { label: "DB_CANT_EFF", value: "db_cant_eff" },
  { label: "DB_CANT_STOW", value: "db_cant_stow" },
  { label: "WING_CA1", value: "wing_ca1" },
  { label: "WING_TWIST", value: "wing_twist" },
  { label: "WING_CLEW", value: "wing_clew" },
  { label: "JIB_SHT", value: "jib_sht" },
  { label: "JIB_CUNNO", value: "jib_cunno" },
  { label: "JIB_LEAD", value: "jib_lead" },
];

/** Custom column headers when grouping by Channel (API key -> display label). Same set as METRIC_OPTIONS + CONFIG. */
const CHANNEL_COLUMN_HEADERS: Record<string, string> = {
    config: "CONFIG",
    bsp: "BSP [KPH]",
    twa: "TWA [DEG]",
    vmg: "VMG [KPH]",
    heel_n: "HEEL_N [DEG]",
    pitch: "PITCH [DEG]",
    rh_lwd: "RH_LWD [MM]",
    rud_rake: "RUD_RAKE [DEG]",
    rud_diff: "RUD_DIFF [DEG]",
    db_cant: "DB_CANT [DEG]",
    db_cant_eff: "DB_CANT_EFF [DEG]",
    db_cant_stow: "DB_CANT_STOW [DEG]",
    wing_ca1: "WING_CA1 [DEG]",
    wing_twist: "WING_TWIST [DEG]",
    wing_clew: "WING_CLEW [MM]",
    jib_sht: "JIB_SHT [KGF]",
    jib_cunno: "JIB_CUNNO [KGF]",
    jib_lead: "JIB_LEAD [DEG]",
  };

type GroupBy = "channel" | "wind";
type LegType = "upwind" | "downwind" | "reaching";
type ManeuverType = "tack" | "gybe" | "roundup" | "bearaway";

/** Maneuver cheat sheet: metric options for group by Wind (display label -> API value). */
const MANEUVER_METRIC_OPTIONS: { label: string; value: string }[] = [
  { label: "Drop time", value: "drop_time" },
  { label: "Bsp drop", value: "bsp_drop" },
  { label: "Turn rate max", value: "turn_rate_max" },
  { label: "Twa exit", value: "twa_exit" },
  { label: "Overshoot angle", value: "overshoot_angle" },
  { label: "Raise time", value: "raise_time" },
  { label: "Time two boards", value: "time_two_boards" },
  { label: "Pitch accmax", value: "pitch_accmax" },
  { label: "Heel accmax", value: "heel_accmax" },
  { label: "Cant eff accmax", value: "cant_eff_accmax" },
  { label: "Wing twist accmax", value: "wing_twist_accmax" },
  { label: "Wing clew pos accmax", value: "wing_clew_pos_accmax" },
  { label: "Jib sheet pct accmax", value: "jib_sheet_pct_accmax" },
  { label: "Jib lead ang accmax", value: "jib_lead_ang_accmax" },
  { label: "Loss inv tgt", value: "loss_inv_tgt" },
  { label: "Loss turn tgt", value: "loss_turn_tgt" },
  { label: "Loss build tgt", value: "loss_build_tgt" },
  { label: "Loss total tgt", value: "loss_total_tgt" },
];

/** Maneuver cheat sheet: column headers when grouping by Channel. */
const MANEUVER_CHANNEL_COLUMN_HEADERS: Record<string, string> = {
  config: "CONFIG",
  bsp_drop: "Bsp_drop",
  drop_time: "Drop_time",
  turn_rate_max: "Turn_rate_max",
  twa_exit: "Twa_exit",
  overshoot_angle: "Overshoot_angle",
  raise_time: "Raise_time",
  time_two_boards: "Time_two_boards",
  pitch_accmax: "Pitch_accmax",
  heel_accmax: "Heel_accmax",
  cant_eff_accmax: "Cant_eff_accmax",
  wing_twist_accmax: "Wing_twist_accmax",
  wing_clew_pos_accmax: "Wing_clew_pos_accmax",
  jib_sheet_pct_accmax: "Jib_sheet_pct_accmax",
  jib_lead_ang_accmax: "Jib_lead_ang_accmax",
  loss_inv_tgt: "Loss_inv_tgt",
  loss_turn_tgt: "Loss_turn_tgt",
  loss_build_tgt: "Loss_build_tgt",
  loss_total_tgt: "Loss_total_tgt",
};

function formatNum(value: number): string {
  if (Number.isNaN(value)) return "—";
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(2);
  const rounded = Math.round(value * 10) / 10;
  return rounded === value ? String(value) : rounded.toFixed(1);
}

export default function CheatSheetPage() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [rows, setRows] = createSignal<Record<string, unknown>[]>([]);
  const [groupBy, setGroupBy] = createSignal<GroupBy>("channel");
  const [twsIndex, setTwsIndex] = createSignal(TWS_DEFAULT_INDEX); // 30 default
  const [selectedMetricKey, setSelectedMetricKey] = createSignal<string>("bsp"); // first in METRIC_OPTIONS
  const [legType, setLegType] = createSignal<LegType>("upwind");
  const [sortConfig, setSortConfig] = createSignal<{ key: string; direction: "asc" | "desc" }>({ key: "", direction: "asc" });
  const [columnScales, setColumnScales] = createSignal<Record<string, string>>({});
  const [formattedColumns, setFormattedColumns] = createSignal<string[]>([]);
  const [showDeltas, setShowDeltas] = createSignal(true);
  const [isHovered, setIsHovered] = createSignal(false);
  const [copySuccess, setCopySuccess] = createSignal(false);

  // Maneuvers section state
  const [loadingManeuver, setLoadingManeuver] = createSignal(true);
  const [errorManeuver, setErrorManeuver] = createSignal<string | null>(null);
  const [rowsManeuver, setRowsManeuver] = createSignal<Record<string, unknown>[]>([]);
  const [groupByManeuver, setGroupByManeuver] = createSignal<GroupBy>("channel");
  const [twsIndexManeuver, setTwsIndexManeuver] = createSignal(TWS_DEFAULT_INDEX);
  const [selectedMetricKeyManeuver, setSelectedMetricKeyManeuver] = createSignal<string>("drop_time");
  const [maneuverType, setManeuverType] = createSignal<ManeuverType>("tack");
  const [sortConfigManeuver, setSortConfigManeuver] = createSignal<{ key: string; direction: "asc" | "desc" }>({ key: "", direction: "asc" });
  const [columnScalesManeuver, setColumnScalesManeuver] = createSignal<Record<string, string>>({});
  const [formattedColumnsManeuver, setFormattedColumnsManeuver] = createSignal<string[]>([]);
  const [showDeltasManeuver, setShowDeltasManeuver] = createSignal(true);
  const [isHoveredManeuver, setIsHoveredManeuver] = createSignal(false);
  const [copySuccessManeuver, setCopySuccessManeuver] = createSignal(false);

  const getRowValue = (row: Record<string, unknown>, key: string): number | string | null => {
    const v = row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    return String(v);
  };

  const tableColumns = createMemo(() => {
    const r = rows();
    if (r.length === 0) return [];
    const keys = Object.keys(r[0]).filter((k) => k !== undefined && k !== null && String(k).trim() !== "");
    const configKey = keys.find((k) => k.toLowerCase() === "config");
    const rest = keys.filter((k) => k.toLowerCase() !== "config");
    return configKey != null ? [configKey, ...rest] : keys;
  });

  const sortedRows = createMemo(() => {
    const r = rows();
    const { key, direction } = sortConfig();
    if (!key || r.length === 0) return r;
    const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
    return [...r].sort((a, b) => {
      const aV = getVal(a);
      const bV = getVal(b);
      if (aV == null && bV == null) return 0;
      if (aV == null) return direction === "asc" ? 1 : -1;
      if (bV == null) return direction === "asc" ? -1 : 1;
      const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
      return direction === "asc" ? cmp : -cmp;
    });
  });

  const valueKeys = createMemo(() => tableColumns().filter((k) => k.toLowerCase() !== "config"));

  const tableColumnsManeuver = createMemo(() => {
    const r = rowsManeuver();
    if (r.length === 0) return [];
    const keys = Object.keys(r[0]).filter((k) => k !== undefined && k !== null && String(k).trim() !== "");
    const configKey = keys.find((k) => k.toLowerCase() === "config");
    const rest = keys.filter((k) => k.toLowerCase() !== "config");
    return configKey != null ? [configKey, ...rest] : keys;
  });

  const sortedRowsManeuver = createMemo(() => {
    const r = rowsManeuver();
    const { key, direction } = sortConfigManeuver();
    if (!key || r.length === 0) return r;
    const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
    return [...r].sort((a, b) => {
      const aV = getVal(a);
      const bV = getVal(b);
      if (aV == null && bV == null) return 0;
      if (aV == null) return direction === "asc" ? 1 : -1;
      if (bV == null) return direction === "asc" ? -1 : 1;
      const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
      return direction === "asc" ? cmp : -cmp;
    });
  });

  const valueKeysManeuver = createMemo(() => tableColumnsManeuver().filter((k) => k.toLowerCase() !== "config"));

  const sortAndFormat = (
    rowsList: Record<string, unknown>[],
    key: string,
    current: { key: string; direction: "asc" | "desc" },
    setSort: (c: { key: string; direction: "asc" | "desc" }) => void,
    getScales: () => Record<string, string>,
    setScales: (s: Record<string, string>) => void,
    getFormatted: () => string[],
    setFormatted: (cols: string[]) => void,
    vKeys: string[]
  ): void => {
    const direction = current.key === key && current.direction === "asc" ? "desc" : "asc";
    setSort({ key, direction });
    const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
    if (vKeys.includes(key)) {
      const values = rowsList.map((r) => getVal(r)).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
      const min = d3.min(values) ?? 0;
      const max = d3.max(values) ?? 0;
      const scaleStr = JSON.stringify({ domain: [min, max], range: [0, 6] });
      setScales({ ...getScales(), [key]: scaleStr });
      const formattedCols = getFormatted();
      setFormatted(formattedCols.includes(key) ? formattedCols : [...formattedCols, key]);
    }
  };

  const recomputeScalesFromData = (
    rowsList: Record<string, unknown>[],
    formattedKeys: string[],
    vKeys: string[]
  ): Record<string, string> => {
    const newScales: Record<string, string> = {};
    for (const key of formattedKeys) {
      if (!vKeys.includes(key) || rowsList.length === 0) continue;
      const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
      const values = rowsList.map((r) => getVal(r)).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
      const min = d3.min(values) ?? 0;
      const max = d3.max(values) ?? 0;
      newScales[key] = JSON.stringify({ domain: [min, max], range: [0, 6] });
    }
    return newScales;
  };

  const cellClassForScale = (
    row: Record<string, unknown>,
    key: string,
    scales: Record<string, string>,
    formatted: string[]
  ): string => {
    if (!formatted.includes(key) || !scales[key]) return "";
    try {
      const { domain, range } = JSON.parse(scales[key]) as { domain: number[]; range: number[] };
      const scale = d3.scaleLinear().domain(domain).range(range);
      const v = getRowValue(row, key);
      if (v == null || typeof v !== "number" || Number.isNaN(v)) return "";
      const x = scale(v);
      return `c${Math.round(Math.max(0, Math.min(6, x)))}`;
    } catch {
      return "";
    }
  };

  const formatDelta = (delta: number): string => {
    if (Number.isNaN(delta)) return "";
    const n = Number(delta);
    const prefix = n > 0 ? "+" : "";
    return `${prefix}${n.toFixed(1)}`;
  };

  const clearFormatting = () => {
    setFormattedColumns([]);
    setColumnScales({});
    setSortConfig({ key: "", direction: "asc" });
  };

  const clearFormattingManeuver = () => {
    setFormattedColumnsManeuver([]);
    setColumnScalesManeuver({});
    setSortConfigManeuver({ key: "", direction: "asc" });
  };

  const sortData = (key: string) => {
    sortAndFormat(
      rows(),
      key,
      sortConfig(),
      setSortConfig,
      () => columnScales(),
      setColumnScales,
      () => formattedColumns(),
      setFormattedColumns,
      valueKeys()
    );
  };

  const sortDataManeuver = (key: string) => {
    sortAndFormat(
      rowsManeuver(),
      key,
      sortConfigManeuver(),
      setSortConfigManeuver,
      () => columnScalesManeuver(),
      setColumnScalesManeuver,
      () => formattedColumnsManeuver(),
      setFormattedColumnsManeuver,
      valueKeysManeuver()
    );
  };

  const fetchData = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const sourceId = selectedSourceId();
    if (!className || !projectId) {
      setRows([]);
      setError(null);
      return;
    }
    const group = groupBy();
    const leg = legType();
    setLoading(true);
    setError(null);
    try {
      const twsVal = group === "channel" ? TWS_OPTIONS[twsIndex()] : null;
      let url = `${apiEndpoints.app.data}/cheat-sheet?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&group_by=${encodeURIComponent(group)}&leg_type=${encodeURIComponent(leg)}`;
      if (sourceId != null && Number(sourceId) > 0) {
        const sourceName = sourcesStore.getSourceName(Number(sourceId));
        if (sourceName != null) {
          url += `&source_names=${encodeURIComponent(JSON.stringify([sourceName]))}`;
        } else {
          url += `&source_id=${encodeURIComponent(Number(sourceId))}`;
        }
      }
      if (group === "channel" && twsVal != null) {
        url += `&tws=${encodeURIComponent(twsVal)}`;
      }
      if (group === "wind") {
        url += `&metric=${encodeURIComponent(selectedMetricKey())}`;
      }
      const result = await getData(url);
      if (!result?.success) {
        setError(result?.message ?? "Failed to load cheat sheet data");
        setRows([]);
        return;
      }
      const payload = result.data as { rows?: Record<string, unknown>[] };
      const raw = Array.isArray(payload?.rows) ? payload.rows : [];
      const normalized = raw.map((r) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(row)) {
          out[k.toLowerCase()] = row[k];
        }
        return out;
      });
      setRows(normalized);
      logDebug("CheatSheet: fetched rows", { count: normalized.length, groupBy: group });
    } catch (err) {
      logError("CheatSheet: fetch failed", err);
      setError(err instanceof Error ? err.message : "Failed to load cheat sheet data");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchManeuverData = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const sourceId = selectedSourceId();
    if (!className || !projectId) {
      setRowsManeuver([]);
      setErrorManeuver(null);
      return;
    }
    const group = groupByManeuver();
    const maneuver = maneuverType();
    setLoadingManeuver(true);
    setErrorManeuver(null);
    try {
      const twsVal = group === "channel" ? TWS_OPTIONS[twsIndexManeuver()] : null;
      let url = `${apiEndpoints.app.data}/maneuver-cheat-sheet?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&group_by=${encodeURIComponent(group)}&maneuver_type=${encodeURIComponent(maneuver)}`;
      if (sourceId != null && Number(sourceId) > 0) {
        const sourceName = sourcesStore.getSourceName(Number(sourceId));
        if (sourceName != null) {
          url += `&source_names=${encodeURIComponent(JSON.stringify([sourceName]))}`;
        } else {
          url += `&source_id=${encodeURIComponent(Number(sourceId))}`;
        }
      }
      if (group === "channel" && twsVal != null) {
        url += `&tws=${encodeURIComponent(twsVal)}`;
      }
      if (group === "wind") {
        url += `&metric=${encodeURIComponent(selectedMetricKeyManeuver())}`;
      }
      const result = await getData(url);
      if (!result?.success) {
        setErrorManeuver(result?.message ?? "Failed to load maneuver cheat sheet data");
        setRowsManeuver([]);
        return;
      }
      const payload = result.data as { rows?: Record<string, unknown>[] };
      const raw = Array.isArray(payload?.rows) ? payload.rows : [];
      const normalized = raw.map((r) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(row)) {
          out[k.toLowerCase()] = row[k];
        }
        return out;
      });
      setRowsManeuver(normalized);
      logDebug("CheatSheet Maneuvers: fetched rows", { count: normalized.length, groupBy: group });
    } catch (err) {
      logError("CheatSheet Maneuvers: fetch failed", err);
      setErrorManeuver(err instanceof Error ? err.message : "Failed to load maneuver cheat sheet data");
      setRowsManeuver([]);
    } finally {
      setLoadingManeuver(false);
    }
  };

  onMount(() => {
    logPageLoad("CheatSheet.tsx", "Cheat Sheet", "Loaded");
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: "CheatSheet",
      scaleToWidth: true,
    });
    onCleanup(() => cleanupScaling());
  });

  createEffect(() => {
    selectedClassName();
    selectedProjectId();
    selectedSourceId();
    groupBy();
    twsIndex();
    selectedMetricKey();
    legType();
    fetchData();
  });

  createEffect(() => {
    selectedClassName();
    selectedProjectId();
    selectedSourceId();
    groupByManeuver();
    twsIndexManeuver();
    selectedMetricKeyManeuver();
    maneuverType();
    fetchManeuverData();
  });

  createEffect(() => {
    const rowsList = rows();
    const formatted = formattedColumns();
    const vKeys = valueKeys();
    if (formatted.length === 0 || rowsList.length === 0) return;
    const newScales = recomputeScalesFromData(rowsList, formatted, vKeys);
    if (Object.keys(newScales).length > 0) setColumnScales(newScales);
  });

  createEffect(() => {
    const rowsList = rowsManeuver();
    const formatted = formattedColumnsManeuver();
    const vKeys = valueKeysManeuver();
    if (formatted.length === 0 || rowsList.length === 0) return;
    const newScales = recomputeScalesFromData(rowsList, formatted, vKeys);
    if (Object.keys(newScales).length > 0) setColumnScalesManeuver(newScales);
  });

  const legDisplay = (): string => {
    const leg = legType();
    return leg === "reaching" ? "REACH" : leg === "upwind" ? "UPWIND" : "DOWNWIND";
  };

  const maneuverDisplay = (): string => {
    const m = maneuverType();
    return m.toUpperCase();
  };

  const twsLabel = (): string => String(TWS_OPTIONS[twsIndex()] ?? 30);

  const twsLabelManeuver = (): string => String(TWS_OPTIONS[twsIndexManeuver()] ?? 30);

  /** Display label for table column: use CHANNEL_COLUMN_HEADERS when grouping by channel, else key as-is (wind: config -> CONFIG, bin numbers stay). */
  const getColumnHeader = (key: string): string => {
    if (groupBy() === "channel") {
      return CHANNEL_COLUMN_HEADERS[key.toLowerCase()] ?? key;
    }
    if (key.toLowerCase() === "config") return "CONFIG";
    return key;
  };

  /** Maneuvers section: column header for table. */
  const getColumnHeaderManeuver = (key: string): string => {
    if (groupByManeuver() === "channel") {
      return MANEUVER_CHANNEL_COLUMN_HEADERS[key.toLowerCase()] ?? key;
    }
    if (key.toLowerCase() === "config") return "CONFIG";
    return key;
  };

  /** Copy table to clipboard (values only, no deltas). */
  const copyTableToClipboard = async () => {
    try {
      const cols = tableColumns();
      const rowsList = sortedRows();
      let clipboardText = cols.map((k) => getColumnHeader(k)).join("\t") + "\n";
      for (const row of rowsList) {
        const cells = cols.map((key) => {
          const val = getRowValue(row, key);
          if (val == null) return "—";
          if (key.toLowerCase() === "config") return String(val);
          return typeof val === "number" ? formatNum(val) : String(val);
        });
        clipboardText += cells.join("\t") + "\n";
      }
      log("CheatSheet: copy table to clipboard", { textLength: clipboardText.length });
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } else {
        const ta = document.createElement("textarea");
        ta.value = clipboardText;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }
    } catch (err: unknown) {
      logError("CheatSheet: copy table failed", err);
    }
  };

  /** Copy maneuver table to clipboard. */
  const copyTableToClipboardManeuver = async () => {
    try {
      const cols = tableColumnsManeuver();
      const rowsList = sortedRowsManeuver();
      let clipboardText = cols.map((k) => getColumnHeaderManeuver(k)).join("\t") + "\n";
      for (const row of rowsList) {
        const cells = cols.map((key) => {
          const val = getRowValue(row, key);
          if (val == null) return "—";
          if (key.toLowerCase() === "config") return String(val);
          return typeof val === "number" ? formatNum(val) : String(val);
        });
        clipboardText += cells.join("\t") + "\n";
      }
      log("CheatSheet Maneuvers: copy table to clipboard", { textLength: clipboardText.length });
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        setCopySuccessManeuver(true);
        setTimeout(() => setCopySuccessManeuver(false), 2000);
      } else {
        const ta = document.createElement("textarea");
        ta.value = clipboardText;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopySuccessManeuver(true);
        setTimeout(() => setCopySuccessManeuver(false), 2000);
      }
    } catch (err: unknown) {
      logError("CheatSheet Maneuvers: copy table failed", err);
    }
  };

  return (
    <div id="media-container" class="cheat-sheet-page">
      <div class="container relative">
        <div class="performance-charts-scroll-container">
          <div class="performance-charts-scroll-inner cheat-sheet-scroll-inner">
            <h1 class="report-page-title cheat-sheet-title">Straight Line</h1>

            <Show when={loading()}>
              <Loading />
            </Show>

            <Show when={!loading() && error()}>
              <div class="cheat-sheet-error">
                {error()}
              </div>
            </Show>

            <Show when={!loading() && !error()}>
              <div class="race-summary-dropdown-section cheat-sheet-dropdowns">
                <DropDownButton
                  options={["Channel", "Wind"]}
                  defaultText={groupBy() === "channel" ? "Channel" : "Wind"}
                  smallLabel="Group by"
                  size="big"
                  handleSelection={async (item) => {
                    const val: GroupBy = item === "Wind" ? "wind" : "channel";
                    setGroupBy(val);
                    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                    await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet", `Group by changed to ${item}`);
                  }}
                />
                <Show when={groupBy() === "channel"}>
                  <DropDownButton
                    options={TWS_OPTIONS.map((v) => String(v))}
                    defaultText={twsLabel()}
                    smallLabel="TWS"
                    size="big"
                    handleSelection={async (item) => {
                      const idx = TWS_OPTIONS.indexOf(Number(item));
                      if (idx >= 0) setTwsIndex(idx);
                      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                      await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet", `TWS changed to ${item}`);
                    }}
                  />
                </Show>
                <Show when={groupBy() === "wind"}>
                  <DropDownButton
                    options={METRIC_OPTIONS.map((m) => m.label)}
                    defaultText={METRIC_OPTIONS.find((m) => m.value === selectedMetricKey())?.label ?? "BSP"}
                    smallLabel="Metric"
                    size="big"
                    handleSelection={async (item) => {
                      const opt = METRIC_OPTIONS.find((m) => m.label === item);
                      if (opt) setSelectedMetricKey(opt.value);
                      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                      await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet", `Metric changed to ${item}`);
                    }}
                  />
                </Show>
                <DropDownButton
                  options={["REACH", "UPWIND", "DOWNWIND"]}
                  defaultText={legDisplay()}
                  smallLabel="Point of Sail"
                  size="big"
                  handleSelection={async (item) => {
                    const leg: LegType = item === "REACH" ? "reaching" : item === "UPWIND" ? "upwind" : "downwind";
                    setLegType(leg);
                    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                    await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet", `Point of sail changed to ${item}`);
                  }}
                />
              </div>

              <Show when={rows().length > 0}>
                <p class="cheat-sheet-table-explanation">
                  Outliers are removed using IQR (values between the 25th and 75th percentiles). From that cleaned set we take the upper 10% by{" "}
                  {legType() === "reaching" ? "BSP polar%" : "VMG%"} and show the mean per CONFIG.
                  {groupBy() === "wind" && " Columns are bins of TWS [kph]."}
                </p>
              </Show>

              <div
                class="copy-table-hover-wrapper"
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
              >
              <div class="data-table-container">
                <Show
                  when={rows().length > 0}
                  fallback={
                    <p class="cheat-sheet-empty-message">
                      No cheat sheet data for the current filters. Try a different wind band or point of sail.
                    </p>
                  }
                >
                  <div class="scrollable-container">
                    {(() => {
                      const scales = columnScales();
                      const formatted = formattedColumns();
                      const sortedList = sortedRows();
                      const firstRow = sortedList.length > 0 ? sortedList[0] : null;
                      const deltasEnabled = showDeltas();
                      const deltaClass = (d: number) =>
                        d > 0 ? "race-summary-delta race-summary-delta-positive" : d < 0 ? "race-summary-delta race-summary-delta-negative" : "race-summary-delta";
                      return (
                        <table class="maneuvers-table">
                          <thead>
                            <tr>
                              <For each={tableColumns()}>
                                {(key) => (
                                  <th
                                    class="centered"
                                    style={{ cursor: "pointer" }}
                                    onClick={() => sortData(key)}
                                    title={`Sort by ${getColumnHeader(key)}`}
                                  >
                                    {getColumnHeader(key)} {sortConfig().key === key ? (sortConfig().direction === "asc" ? "▲" : "▼") : ""}
                                  </th>
                                )}
                              </For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={sortedList}>
                              {(row, index) => {
                                const rowIndex = index();
                                const showDelta = deltasEnabled && firstRow != null && rowIndex > 0;
                                return (
                                  <tr>
                                    <For each={tableColumns()}>
                                      {(key) => {
                                        const scaleClass = cellClassForScale(row, key, scales, formatted);
                                        const val = getRowValue(row, key);
                                        const isConfig = key.toLowerCase() === "config";
                                        if (isConfig) {
                                          return (
                                            <td class={`centered ${scaleClass}`}>
                                              {val != null ? String(val) : "—"}
                                            </td>
                                          );
                                        }
                                        const firstVal = firstRow ? getRowValue(firstRow, key) : null;
                                        const delta =
                                          showDelta &&
                                          val != null &&
                                          firstVal != null &&
                                          typeof val === "number" &&
                                          typeof firstVal === "number" &&
                                          !Number.isNaN(val) &&
                                          !Number.isNaN(firstVal)
                                            ? val - firstVal
                                            : null;
                                        const display = val != null ? (typeof val === "number" ? formatNum(val) : String(val)) : "—";
                                        const deltaText = delta != null ? formatDelta(delta) : null;
                                        return (
                                          <td class={`centered ${scaleClass}`}>
                                            {display}
                                            {deltaText != null && <span class={deltaClass(delta!)}>{deltaText}</span>}
                                          </td>
                                        );
                                      }}
                                    </For>
                                  </tr>
                                );
                              }}
                            </For>
                          </tbody>
                        </table>
                      );
                    })()}
                  </div>
                </Show>
              </div>
              {isHovered() && rows().length > 0 && (
                <div class="copy-table-data-actions">
                  <button
                    type="button"
                    class="copy-table-data-btn"
                    classList={{ "copy-table-data-btn-success": copySuccess() }}
                    onClick={copyTableToClipboard}
                  >
                    {copySuccess() ? "✓ Copied!" : "Copy Table Data"}
                  </button>
                </div>
              )}
              <Show when={rows().length > 0}>
                <div class="flex justify-between items-center mt-2 race-summary-table-actions" style={{ "margin-bottom": "1.5rem" }}>
                  <div class="race-summary-actions-left">
                    <label class="race-summary-deltas-checkbox">
                      <input
                        type="checkbox"
                        checked={showDeltas()}
                        onChange={async (e) => {
                          const checked = e.currentTarget.checked;
                          setShowDeltas(checked);
                          const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                          await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet", `Show deltas ${checked ? "on" : "off"}`);
                        }}
                      />
                      <span>Show deltas</span>
                    </label>
                  </div>
                  <div class="flex justify-end" style={{ "margin-left": "auto" }}>
                    <button class="btn" type="button" onClick={clearFormatting}>
                      Clear Formatting
                    </button>
                  </div>
                </div>
              </Show>
              </div>

              <div class="cheat-sheet-maneuvers-section">
                <h2 class="report-page-title cheat-sheet-title">Maneuvers</h2>

                <Show when={loadingManeuver()}>
                  <Loading />
                </Show>

                <Show when={!loadingManeuver() && errorManeuver()}>
                  <div class="cheat-sheet-error">
                    {errorManeuver()}
                  </div>
                </Show>

                <Show when={!loadingManeuver() && !errorManeuver()}>
                  <div class="race-summary-dropdown-section cheat-sheet-dropdowns">
                    <DropDownButton
                      options={["Channel", "Wind"]}
                      defaultText={groupByManeuver() === "channel" ? "Channel" : "Wind"}
                      smallLabel="Group by"
                      size="big"
                      handleSelection={async (item) => {
                        const val: GroupBy = item === "Wind" ? "wind" : "channel";
                        setGroupByManeuver(val);
                        const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                        await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet Maneuvers", `Group by changed to ${item}`);
                      }}
                    />
                    <Show when={groupByManeuver() === "channel"}>
                      <DropDownButton
                        options={TWS_OPTIONS.map((v) => String(v))}
                        defaultText={twsLabelManeuver()}
                        smallLabel="TWS"
                        size="big"
                        handleSelection={async (item) => {
                          const idx = TWS_OPTIONS.indexOf(Number(item));
                          if (idx >= 0) setTwsIndexManeuver(idx);
                          const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                          await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet Maneuvers", `TWS changed to ${item}`);
                        }}
                      />
                    </Show>
                    <Show when={groupByManeuver() === "wind"}>
                      <DropDownButton
                        options={MANEUVER_METRIC_OPTIONS.map((m) => m.label)}
                        defaultText={MANEUVER_METRIC_OPTIONS.find((m) => m.value === selectedMetricKeyManeuver())?.label ?? "Drop time"}
                        smallLabel="Metric"
                        size="big"
                        handleSelection={async (item) => {
                          const opt = MANEUVER_METRIC_OPTIONS.find((m) => m.label === item);
                          if (opt) setSelectedMetricKeyManeuver(opt.value);
                          const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                          await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet Maneuvers", `Metric changed to ${item}`);
                        }}
                      />
                    </Show>
                    <DropDownButton
                      options={["TACK", "GYBE", "ROUNDUP", "BEARAWAY"]}
                      defaultText={maneuverDisplay()}
                      smallLabel="Maneuver type"
                      size="big"
                      handleSelection={async (item) => {
                        const m: ManeuverType = item.toLowerCase() as ManeuverType;
                        setManeuverType(m);
                        const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                        await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet Maneuvers", `Maneuver type changed to ${item}`);
                      }}
                    />
                  </div>

                  <Show when={rowsManeuver().length > 0}>
                    <p class="cheat-sheet-table-explanation">
                      From the 25th and 75th percentiles of Loss_total_tgt we take the lowest 10% of loss and show the mean per CONFIG.
                      {groupByManeuver() === "wind" && " Columns are bins of TWS [kph]."}
                    </p>
                  </Show>

                  <div
                    class="copy-table-hover-wrapper"
                    onMouseEnter={() => setIsHoveredManeuver(true)}
                    onMouseLeave={() => setIsHoveredManeuver(false)}
                  >
                    <div class="data-table-container">
                      <Show
                        when={rowsManeuver().length > 0}
                        fallback={
                          <p class="cheat-sheet-empty-message">
                            No maneuver cheat sheet data for the current filters. Try a different wind band or maneuver type.
                          </p>
                        }
                      >
                        <div class="scrollable-container">
                          {(() => {
                            const scales = columnScalesManeuver();
                            const formatted = formattedColumnsManeuver();
                            const sortedList = sortedRowsManeuver();
                            const firstRow = sortedList.length > 0 ? sortedList[0] : null;
                            const deltasEnabled = showDeltasManeuver();
                            const deltaClass = (d: number) =>
                              d > 0 ? "race-summary-delta race-summary-delta-positive" : d < 0 ? "race-summary-delta race-summary-delta-negative" : "race-summary-delta";
                            return (
                              <table class="maneuvers-table">
                                <thead>
                                  <tr>
                                    <For each={tableColumnsManeuver()}>
                                      {(key) => (
                                        <th
                                          class="centered"
                                          style={{ cursor: "pointer" }}
                                          onClick={() => sortDataManeuver(key)}
                                          title={`Sort by ${getColumnHeaderManeuver(key)}`}
                                        >
                                          {getColumnHeaderManeuver(key)} {sortConfigManeuver().key === key ? (sortConfigManeuver().direction === "asc" ? "▲" : "▼") : ""}
                                        </th>
                                      )}
                                    </For>
                                  </tr>
                                </thead>
                                <tbody>
                                  <For each={sortedList}>
                                    {(row, index) => {
                                      const rowIndex = index();
                                      const showDelta = deltasEnabled && firstRow != null && rowIndex > 0;
                                      return (
                                        <tr>
                                          <For each={tableColumnsManeuver()}>
                                            {(key) => {
                                              const scaleClass = cellClassForScale(row, key, scales, formatted);
                                              const val = getRowValue(row, key);
                                              const isConfig = key.toLowerCase() === "config";
                                              if (isConfig) {
                                                return (
                                                  <td class={`centered ${scaleClass}`}>
                                                    {val != null ? String(val) : "—"}
                                                  </td>
                                                );
                                              }
                                              const firstVal = firstRow ? getRowValue(firstRow, key) : null;
                                              const delta =
                                                showDelta &&
                                                val != null &&
                                                firstVal != null &&
                                                typeof val === "number" &&
                                                typeof firstVal === "number" &&
                                                !Number.isNaN(val) &&
                                                !Number.isNaN(firstVal)
                                                  ? val - firstVal
                                                  : null;
                                              const display = val != null ? (typeof val === "number" ? formatNum(val) : String(val)) : "—";
                                              const deltaText = delta != null ? formatDelta(delta) : null;
                                              return (
                                                <td class={`centered ${scaleClass}`}>
                                                  {display}
                                                  {deltaText != null && <span class={deltaClass(delta!)}>{deltaText}</span>}
                                                </td>
                                              );
                                            }}
                                          </For>
                                        </tr>
                                      );
                                    }}
                                  </For>
                                </tbody>
                              </table>
                            );
                          })()}
                        </div>
                      </Show>
                    </div>
                    {isHoveredManeuver() && rowsManeuver().length > 0 && (
                      <div class="copy-table-data-actions">
                        <button
                          type="button"
                          class="copy-table-data-btn"
                          classList={{ "copy-table-data-btn-success": copySuccessManeuver() }}
                          onClick={copyTableToClipboardManeuver}
                        >
                          {copySuccessManeuver() ? "✓ Copied!" : "Copy Table Data"}
                        </button>
                      </div>
                    )}
                    <Show when={rowsManeuver().length > 0}>
                      <div class="flex justify-between items-center mt-2 race-summary-table-actions" style={{ "margin-bottom": "1.5rem" }}>
                        <div class="race-summary-actions-left">
                          <label class="race-summary-deltas-checkbox">
                            <input
                              type="checkbox"
                              checked={showDeltasManeuver()}
                              onChange={async (e) => {
                                const checked = e.currentTarget.checked;
                                setShowDeltasManeuver(checked);
                                const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                                await logActivity(project_id, dataset_id, "CheatSheet.tsx", "Cheat Sheet Maneuvers", `Show deltas ${checked ? "on" : "off"}`);
                              }}
                            />
                            <span>Show deltas</span>
                          </label>
                        </div>
                        <div class="flex justify-end" style={{ "margin-left": "auto" }}>
                          <button class="btn" type="button" onClick={clearFormattingManeuver}>
                            Clear Formatting
                          </button>
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
