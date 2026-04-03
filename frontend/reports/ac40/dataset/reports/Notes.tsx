import { createSignal, createMemo, onMount, Show, For } from "solid-js";
import * as d3 from "d3";
import DOMPurify from "dompurify";

import { getData } from "../../../../utils/global";
import { persistantStore } from "../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { error as logError } from "../../../../utils/console";
import { logPageLoad } from "../../../../utils/logging";
import Loading from "../../../../components/utilities/Loading";
import { speedUnitBracketUpper } from "../../../../utils/speedUnits";

const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;

/** Dataset object from API: may be string, or object with text/json */
type DatasetObject = string | { text?: string; json?: string | unknown } | null;

/** Configuration table row */
interface ConfigurationRow {
  platform?: string;
  mast?: string;
  foil?: string;
  rudder?: string;
}

/** Crew rotation row */
interface CrewRotation {
  name?: string;
  helmsman?: string;
  wing_trim?: string;
  flight?: string;
  strategy?: string;
  grind_aft?: string;
  grind_fwd?: string;
}

/** Stats table cell for D3-colored rows */
interface StatsTableCell {
  value: string | number;
  class: string;
  isFirst: boolean;
}

/** Stats table result from buildStatsTableData */
interface StatsTableData {
  headers: (string | number)[];
  rows: StatsTableCell[][];
}

export default function NotesPage() {
  // State for dataset objects
  const [introduction, setIntroduction] = createSignal<DatasetObject>(null);
  const [notes, setNotes] = createSignal<DatasetObject>(null);
  const [dayTypeNotes, setDayTypeNotes] = createSignal<DatasetObject>(null);
  const [technique, setTechnique] = createSignal<DatasetObject>(null);
  const [howToWin, setHowToWin] = createSignal<DatasetObject>(null);
  const [configuration, setConfiguration] = createSignal<ConfigurationRow | null>(null);
  const [crew, setCrew] = createSignal<CrewRotation | CrewRotation[] | null>(null);
  const [maximums, setMaximums] = createSignal<Record<string, string | number> | null>(null);
  const [usage, _setUsage] = createSignal<Record<string, string | number> | null>(null);
  const [stats, setStats] = createSignal<DatasetObject>(null);

  // State for dataset metadata (setters used; accessors reserved for future display)
  const [_datasetDate, setDatasetDate] = createSignal("");
  const [_reportName, setReportName] = createSignal("");
  const [_className, setClassName] = createSignal("");

  // Loading and error states
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [hasContent, setHasContent] = createSignal(false);

  const speedMaxColumnHeader = createMemo(() => `SPEED ${speedUnitBracketUpper(persistantStore.defaultUnits())}`);

  // Helper function to fetch a dataset object
  const fetchDatasetObject = async (objectName: string): Promise<DatasetObject> => {
    try {
      const controller = new AbortController();
      const response = await getData(
        `${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=${encodeURIComponent(objectName)}`,
        controller.signal
      );
      
      if (response?.success && response?.data != null) {
        return response.data as DatasetObject;
      }
      return null;
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        logError(`Error fetching dataset object ${objectName}:`, err);
      }
      return null;
    }
  };

  // Helper function to sanitize HTML
  const sanitizeHTML = (html: string | null | undefined): string => {
    if (html == null || html === "") return "";
    return DOMPurify.sanitize(html);
  };

  // Helper function to check if variable is array
  const isArray = (variable: unknown): variable is unknown[] => {
    return Array.isArray(variable);
  };

  // Helper function to get text content from object
  const getText = (obj: DatasetObject): string => {
    if (obj == null) return "";
    try {
      if (typeof obj === "string") return obj;
      const o = obj as { text?: string; json?: string };
      if (o.text) return o.text;
      if (o.json != null && typeof o.json === "string") return o.json;
      return "";
    } catch {
      return "";
    }
  };

  // Build stats table data
  const buildStatsTableData = (statsObj: DatasetObject): StatsTableData | null => {
    if (statsObj == null) return null;
    
    try {
      let data: Record<string, string | number>[];
      if (typeof statsObj === "string") {
        data = JSON.parse(statsObj) as Record<string, string | number>[];
      } else {
        const o = statsObj as { json?: string | Record<string, string | number>[]; text?: string | Record<string, string | number>[] };
        if (o.json != null) {
          data = typeof o.json === "string" ? (JSON.parse(o.json) as Record<string, string | number>[]) : o.json as Record<string, string | number>[];
        } else if (o.text != null) {
          data = typeof o.text === "string" ? (JSON.parse(o.text) as Record<string, string | number>[]) : o.text as Record<string, string | number>[];
        } else if (Array.isArray(statsObj)) {
          data = statsObj as Record<string, string | number>[];
        } else {
          data = (statsObj as unknown) as Record<string, string | number>[];
        }
      }
      
      if (!Array.isArray(data) || data.length === 0) return null;

      const twsScale = d3.scaleLinear().range([0, 6]).domain([0, 25]);
      const swhScale = d3.scaleLinear().range([0, 6]).domain([0, 1]);
      const distScale = d3.scaleLinear().range([0, 6]).domain([0, 35]);

      const headers: (string | number)[] = [];
      if (data[0]) {
        for (const key in data[0]) {
          headers.push(data[0][key]);
        }
      }

      const rows: StatsTableCell[][] = [];
      for (let i = 1; i < data.length; i++) {
        const row: StatsTableCell[] = [];
        let colIndex = 0;
        for (const key in data[i]) {
          const value = data[i][key];
          const numVal = typeof value === "number" ? value : parseFloat(String(value)) || 0;
          let cellClass = "centered";
          if (i === 1) {
            const scaleValue = Math.round(twsScale(numVal));
            cellClass += ` r${Math.max(0, Math.min(6, scaleValue))}`;
          } else if (i === 3) {
            const scaleValue = Math.round(swhScale(numVal));
            cellClass += ` b${Math.max(0, Math.min(6, scaleValue))}`;
          } else if (i === 4) {
            const scaleValue = Math.round(distScale(numVal));
            cellClass += ` r${Math.max(0, Math.min(6, scaleValue))}`;
          }
          row.push({
            value,
            class: cellClass,
            isFirst: colIndex === 0
          });
          colIndex++;
        }
        rows.push(row);
      }

      return { headers, rows };
    } catch (err: unknown) {
      logError("Error parsing stats data:", err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  };

  // Format date string
  const formatDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return "";
    // If date is in YYYYMMDD format, convert to YYYY-MM-DD
    if (dateStr.length === 8 && !dateStr.includes('-')) {
      return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    }
    return dateStr;
  };

  // Fetch all data on mount
  onMount(async () => {
    try {
      setLoading(true);
      setError(null);
      
      await logPageLoad('Notes.jsx', 'Dataset Notes Report');

      const classNameValue = selectedClassName();
      const projectId = selectedProjectId();
      const datasetId = selectedDatasetId();

      if (!classNameValue || !projectId || !datasetId) {
        setError("Missing required parameters: class_name, project_id, or dataset_id");
        setLoading(false);
        return;
      }

      setClassName(classNameValue);

      // Fetch dataset info for date and report name
      const controller = new AbortController();
      const datasetInfoResponse = await getData(
        `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(classNameValue)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`,
        controller.signal
      );

      if (datasetInfoResponse.success && datasetInfoResponse.data) {
        setDatasetDate(formatDate(datasetInfoResponse.data.date || ""));
      }

      const datasetIdResponse = await getData(
        `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(classNameValue)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`,
        controller.signal
      );

      if (datasetIdResponse.success && datasetIdResponse.data) {
        setReportName(datasetIdResponse.data.report_name || "");
      }

      // Fetch all dataset objects in parallel
      const [
        introData,
        notesData,
        dayTypeNotesData,
        techniqueData,
        howToWinData,
        configData,
        crewData,
        maximumsData,
        statsData
      ] = await Promise.all([
        fetchDatasetObject('summary'),
        fetchDatasetObject('notes'),
        fetchDatasetObject('day_type_notes'),
        fetchDatasetObject('technique'),
        fetchDatasetObject('how_to_win'),
        fetchDatasetObject('configuration'),
        fetchDatasetObject('crew'),
        fetchDatasetObject('maximum'),
        fetchDatasetObject('stats')
      ]);

      setIntroduction(introData);
      setNotes(notesData);
      setDayTypeNotes(dayTypeNotesData);
      setTechnique(techniqueData);
      setHowToWin(howToWinData);
      setConfiguration(configData as ConfigurationRow | null);
      setCrew(crewData as CrewRotation | CrewRotation[] | null);
      setMaximums(maximumsData as Record<string, string | number> | null);
      setStats(statsData);

      // Check if we have any content
      const hasIntro = getText(introData).length > 30;
      const hasNotes = getText(notesData).length > 30;
      const hasDayType = getText(dayTypeNotesData).length > 30 || 
                         getText(techniqueData).length > 30 || 
                         getText(howToWinData).length > 30;
      const hasConfig = configData != null;
      const hasCrew = crewData != null;
      const hasMaximums = maximumsData != null;
      const hasStats = statsData != null;

      setHasContent(hasIntro || hasNotes || hasDayType || hasConfig || hasCrew || hasMaximums || hasStats);

    } catch (err: unknown) {
      logError("Error loading notes data:", err instanceof Error ? err : new Error(String(err)));
      setError(err instanceof Error ? err.message : "Failed to load notes data");
    } finally {
      setLoading(false);
    }
  });

  // Build coach notes HTML
  const buildCoachNotesHTML = () => {
    const dayTypeText = getText(dayTypeNotes());
    const techniqueText = getText(technique());
    const howToWinText = getText(howToWin());

    let html = "";

    if (dayTypeText.length > 30) {
      html += "<h2>Weather</h2>" + dayTypeText;
    }

    if (techniqueText.length > 30) {
      html += "<h2>Technique</h2>" + techniqueText;
    }

    if (howToWinText.length > 30) {
      html += "<h2>How To Win The Day</h2>" + howToWinText;
    }

    return html;
  };

  const statsTableData = () => buildStatsTableData(stats());
  const coachNotesHTML = () => buildCoachNotesHTML();

  return (
    <div class="notes-container">
      <Show when={loading()}>
        <Loading />
      </Show>

      <Show when={!loading() && error()}>
        <div class="oops" style="text-align: center; padding: 40px;">
          <h1 class="big">Error</h1>
          <p>{error()}</p>
        </div>
      </Show>

      <Show when={!loading() && !error() && !hasContent()}>
        <article class="oops" style="text-align: center; padding: 40px;">
          <h1 class="big">Hang in there!</h1>
          <p>Looks like we haven't got around to the notes yet...</p>
        </article>
      </Show>

      <Show when={!loading() && !error() && hasContent()}>
        {/* Introduction Section */}
        <Show when={getText(introduction()).length > 30}>
          <div id="introduction-section">
            <div id="introduction-title"><h2 class="left">Introduction</h2></div>
            <div 
              id="introduction"
              innerHTML={sanitizeHTML(getText(introduction()))}
            />
          </div>
        </Show>

        {/* Capture Notes Section */}
        <Show when={getText(notes()).length > 30}>
          <div id="notes-section">
            <div id="notes-title"><h2 class="left">Capture Notes</h2></div>
            <div 
              id="notes"
              innerHTML={sanitizeHTML(getText(notes()))}
            />
          </div>
        </Show>

        {/* Coach Notes Section */}
        <Show when={coachNotesHTML().length > 0}>
          <div id="daytype-section">
            {/* <div id="daytype-title"><h2 class="left">Coach Notes</h2></div> */}
            <div 
              id="daytype"
              innerHTML={sanitizeHTML(coachNotesHTML())}
            />
          </div>
        </Show>

        {/* Configuration Table */}
        <Show when={configuration() != null}>
          <div id="configuration">
            <div id="configuration-title"><h2 class="left">Configuration</h2></div>
            <table id="configuration_table" class="table table-bordered table-striped">
              <thead class="thead-dark">
                <tr>
                  <th class="head">Platform</th>
                  <th class="head">Mast</th>
                  <th class="head">Foil</th>
                  <th class="head">Rudder</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="centered">{configuration()?.platform || ""}</td>
                  <td class="centered">{configuration()?.mast || ""}</td>
                  <td class="centered">{configuration()?.foil || ""}</td>
                  <td class="centered">{configuration()?.rudder || ""}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Crew Table */}
        <Show when={crew() != null}>
          <div id="crew">
            <div id="crew-title"><h2 class="left">Crew</h2></div>
            <table id="crew_table" class="table table-bordered table-striped">
              <thead class="thead-dark">
                <tr>
                  <th class="head">Rotation</th>
                  <th class="head">Helmsman</th>
                  <th class="head">Wing Trim</th>
                  <th class="head">Flight</th>
                  <th class="head">Strategy</th>
                  <th class="head">Grind Aft</th>
                  <th class="head">Grind Fwd</th>
                </tr>
              </thead>
              <tbody>
                <Show when={!isArray(crew())}>
                  <tr>
                    <td class="centered">ROTATION 1</td>
                    <td class="centered">{(crew() as CrewRotation | null)?.helmsman ?? ""}</td>
                    <td class="centered">{(crew() as CrewRotation | null)?.wing_trim ?? ""}</td>
                    <td class="centered">{(crew() as CrewRotation | null)?.flight ?? ""}</td>
                    <td class="centered">{(crew() as CrewRotation | null)?.strategy ?? ""}</td>
                    <td class="centered">{(crew() as CrewRotation | null)?.grind_aft ?? ""}</td>
                    <td class="centered">{(crew() as CrewRotation | null)?.grind_fwd ?? ""}</td>
                  </tr>
                </Show>
                <Show when={isArray(crew())}>
                  <For each={((crew() as CrewRotation[] | null) ?? []).slice().reverse()}>
                    {(rotation: CrewRotation) => (
                      <tr>
                        <td class="centered">{rotation.name || ""}</td>
                        <td class="centered">{rotation.helmsman || ""}</td>
                        <td class="centered">{rotation.wing_trim || ""}</td>
                        <td class="centered">{rotation.flight || ""}</td>
                        <td class="centered">{rotation.strategy || ""}</td>
                        <td class="centered">{rotation.grind_aft || ""}</td>
                        <td class="centered">{rotation.grind_fwd || ""}</td>
                      </tr>
                    )}
                  </For>
                </Show>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Summary Stats Table */}
        <Show when={statsTableData() != null}>
          <div id="stats">
            <div id="stats-title"><h2 class="left">Summary Stats</h2></div>
            <table id="stats_table" class="table table-bordered table-striped">
              <thead class="thead-dark">
                <tr>
                  <For each={statsTableData()?.headers || []}>
                    {(header) => <th class="head">{header}</th>}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={statsTableData()?.rows || []}>
                  {(row) => (
                    <tr>
                      <For each={row}>
                        {(cell) => (
                          <td class={cell.class}>{cell.value}</td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Daily Maximums Table */}
        <Show when={maximums() != null}>
          <div id="maximums">
            <div id="max-stats-title"><h2 class="left">Daily Maximums</h2></div>
            <table id="max-stats_table" class="table table-bordered table-striped">
              <thead class="thead-dark">
                <tr>
                  <th class="head">{speedMaxColumnHeader()}</th>
                  <th class="head">G-FORCE</th>
                  <th class="head">TRIM [DEG]</th>
                  <th class="head">HEEL [DEG]</th>
                  <th class="head">HULL AIR TEMP [C]</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="centered">{maximums()?.bsp || ""}</td>
                  <td class="centered">{maximums()?.gforce || ""}</td>
                  <td class="centered">{maximums()?.trim || ""}</td>
                  <td class="centered">{maximums()?.heel || ""}</td>
                  <td class="centered">{maximums()?.air_temp || ""}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Daily Usage Table */}
        <Show when={usage() != null}>
          <div id="usage">
            <div id="usage-stats-title"><h2 class="left">Daily Usage</h2></div>
            <table id="usage-stats_table" class="table table-bordered table-striped">
              <thead class="thead-dark">
                <tr>
                  <th class="head">PORT FCS CYCLES *</th>
                  <th class="head">STBD FCS CYCLES *</th>
                  <th class="head">LOCK LOADED [H] **</th>
                  <th class="head">TRAVELER [M] ***</th>
                  <th class="head">JIB CAR [M] ***</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="centered">{usage()?.port_fcs || ""}</td>
                  <td class="centered">{usage()?.stbd_fcs || ""}</td>
                  <td class="centered">{usage()?.lock_hours || ""}</td>
                  <td class="centered">{usage()?.trav_m || ""}</td>
                  <td class="centered">{usage()?.jibcar_m || ""}</td>
                </tr>
              </tbody>
            </table>
            <p class="left">* An fcs cycle includes 1 drop and 1 raise</p>
            <p class="left">** Jib lock loaded hours is with a jib lock load greater than 11 ton</p>
            <p class="left">*** Traveler and jib car movement is with a jib lock load greater than 4 ton</p>
            <p class="left">**** Power related stats combine pump cadence with pressure, over a 1 second moving average to remove presure peaks, and are normalized to represent a single cyclor where boatspeed &gt; 10 knots and mainsheet load &gt; 1 ton.</p>
            <p class="left">***** Kcals are computed from average watts at the pump multiplied by seconds, with boatspeed &gt; 10 and mainsheet load &gt; 1 ton, normalized to a single cyclor.</p>
          </div>
        </Show>
      </Show>
    </div>
  );
}
