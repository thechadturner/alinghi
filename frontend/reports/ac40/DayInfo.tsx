import Quill from "quill";
import DOMPurify from "dompurify";

import { createSignal, onMount, Show, For, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { logPageLoad } from "../../utils/logging";
import { info, error as logError, debug, warn } from "../../utils/console";

import Loading from "../../components/utilities/Loading";
import BackButton from "../../components/buttons/BackButton";
import WaitingModal from "../../components/utilities/WaitingModal";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";

import { getData, getTimezoneForDate, putData, postData } from "../../utils/global";
import { setStartTime, setEndTime } from "../../store/globalStore";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { parseTargetFilename } from "../../utils/targetConfig";
const { selectedClassName, selectedProjectId, selectedDatasetId, setSelectedDatasetId, selectedSourceId, selectedDate } = persistantStore;

interface ConfigurationEntry {
    headsail: string;
    crew: string;
    wing: string;
    daggerboard: string;
    rudder: string;
    start: Date;
    end: Date;
}

interface DayDatasetRow {
    dataset_id: number;
    source_id: number;
    source_name: string;
}

import "quill/dist/quill.snow.css";

export default function DatasetInfo() {
    const navigate = useNavigate();
    const [sourceName, setSourceName] = createSignal("");
    const [date, setDate] = createSignal("");
    const [eventName, setEventName] = createSignal("");
    const [reportName, setReportName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [timezone, setTimezone] = createSignal("Europe/Madrid");
    const [timezones, setTimezones] = createSignal<string[]>([]);
    const [dbTimezoneValue, setDbTimezoneValue] = createSignal<string | null>(null);
    const [tws, setTws] = createSignal("");
    const [twd, setTwd] = createSignal("");
    const [shared, setShared] = createSignal(false);
    const [currentTags, setCurrentTags] = createSignal<Record<string, unknown> | null>(null);
    const [mast, setMast] = createSignal("");
    const [foils, setFoils] = createSignal("");
    const [rudder, setRudder] = createSignal("");

    const [availableTargets, setAvailableTargets] = createSignal<Array<{ name: string }>>([]);
    const [selectedTarget, setSelectedTarget] = createSignal("");
    const [showNotes, setShowNotes] = createSignal(false);

    const [state, setState] = createSignal("Update");
    const [showWaiting] = createSignal(false);
    const [processId, setProcessId] = createSignal('');
    const [showModal, setShowModal] = createSignal(false);

    const [unsafeSummary, setUnsafeSummary] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
    const safeSummary = () => DOMPurify.sanitize(unsafeSummary());

    const [unsafeNotes, setUnsafeNotes] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
    const safeNotes = () => DOMPurify.sanitize(unsafeNotes());

    const [unsafeDayTypeNotes, setUnsafeDayTypeNotes] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
    const safeDayTypeNotes = () => DOMPurify.sanitize(unsafeDayTypeNotes());

    const [unsafeTechniqueNotes, setUnsafeTechniqueNotes] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
    const safeTechniqueNotes = () => DOMPurify.sanitize(unsafeTechniqueNotes());

    const [unsafeWinningNotes, setUnsafeWinningNotes] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
    const safeWinningNotes = () => DOMPurify.sanitize(unsafeWinningNotes());

    const location = useLocation();
    const state_str = (location.state && typeof location.state === 'object' && location.state !== null && 'state' in location.state) ? (location.state as { state: any }).state.toString() : null;

    if (state_str != null) {
        setState(state_str)
    }

    // AC40 Configuration state
    const [configurations, setConfigurations] = createSignal<ConfigurationEntry[]>([]);
    const [headsailEvents, setHeadsailEvents] = createSignal<any[]>([]);
    const [crewCountEvents, setCrewCountEvents] = createSignal<any[]>([]);
    const [fromEvents, setFromEvents] = createSignal(false);

    // All datasets for this day (same class_name, project_id, date) - updates apply to all
    const [dayDatasets, setDayDatasets] = createSignal<DayDatasetRow[]>([]);

    let summaryEditor: Quill | undefined, notesEditor: Quill | undefined, daytypeEditor: Quill | undefined, techniqueEditor: Quill | undefined, winningEditor: Quill | undefined;

    // Custom toolbar options
    const toolbarOptions = [
        [{ 'font': [] }],
        [{ 'size': ['small', false, 'large', 'huge'] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ 'color': [] }, { 'background': [] }],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        ['clean']
    ];

    const fetchDatasetData = async () => {
        const controller = new AbortController();
        
        try {
            // Validate required parameters
            const className = selectedClassName();
            const projectId = selectedProjectId();
            const datasetId = selectedDatasetId();
            
            // Check for null/undefined specifically (not falsy, since 0 could be valid)
            // Check for null/undefined or invalid values (datasetId and projectId must be > 0)
            if (!className || !projectId || projectId <= 0 || !datasetId || datasetId <= 0) {
                logError("Missing or invalid required parameters:", { className, projectId, datasetId });
                throw new Error("Missing or invalid required parameters: class_name, project_id, or dataset_id");
            }
            
            const response_json = await getData(`${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`, controller.signal)
            
            if (!response_json.success) {
                logError("API returned unsuccessful response:", response_json);
                throw new Error(response_json.message || "Failed to fetch dataset data");
            }
            
            if (!response_json.data) {
                logError("API returned success but no data:", response_json);
                throw new Error("No dataset data returned from API. The dataset may not exist or you may not have permission to access it.");
            }

            const data = response_json.data
            info("Dataset data:", data);
            debug('[DatasetInfo] Raw timezone from database:', data.timezone, 'type:', typeof data.timezone);
            
            setSourceName(data.source_name || "");
            setDate(data.date || "");
            setEventName(data.event_name || "");
            setReportName(data.report_name || "");
            setDescription(data.description || "");
            
            // Store timezone from database, default to Europe/Madrid if not found or empty
            let dbTimezone = "Europe/Madrid"; // Default value
            if (data.timezone !== null && data.timezone !== undefined) {
                const tzStr = String(data.timezone).trim();
                if (tzStr !== "" && tzStr !== "null" && tzStr !== "undefined") {
                    dbTimezone = tzStr;
                }
            }
            
            debug('[DatasetInfo] Storing database timezone value:', dbTimezone);
            setDbTimezoneValue(dbTimezone);
            setTws(data.tws || "");
            setTwd(data.twd || "");
            setShared(data.shared || false);

            // Fetch current tags
            const tags_response = await getData(`${apiEndpoints.app.datasets}/tags?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`, controller.signal);
            if (tags_response.success && tags_response.data) {
                setCurrentTags(tags_response.data);
                debug('[DatasetInfo] Current tags loaded:', tags_response.data);
            } else {
                setCurrentTags({});
                debug('[DatasetInfo] No existing tags, starting with empty object');
            }

            const report_name_response = await getData(`${apiEndpoints.app.datasets}/day?class_name=${selectedClassName()}&project_id=${selectedProjectId()}&source_id=${selectedSourceId()}&event_name=${eventName()}`);

            let report_name = data.report_name
            if (report_name_response.success && report_name == 'NA') {
                report_name = 'Day ' + report_name_response.data;
                setReportName(report_name);
            }

            let description = data.description

            if (description == 'NA') {
                const report_desc_response = await getData(`${apiEndpoints.app.datasets}/desc?class_name=${selectedClassName()}&project_id=${selectedProjectId()}&dataset_id=${encodeURIComponent(selectedDatasetId())}`);

                if (report_desc_response.success) {
                  let races = report_desc_response.data;

                  if (races.length > 0) {
                    // Extract race numbers from objects
                    const raceNumbers = races.map((race: { races: number }) => race.races);
                    
                    if (raceNumbers.length === 1) {
                      description = "Race " + raceNumbers[0];
                    } else if (raceNumbers.length === 2) {
                      description = "Races " + raceNumbers[0] + " & " + raceNumbers[1];
                    } else if (raceNumbers.length === 3) {
                      description = "Races " + raceNumbers[0] + ", " + raceNumbers[1] + " & " + raceNumbers[2];
                    } else {
                      // 4 or more races
                      const lastRace = raceNumbers[raceNumbers.length - 1];
                      const otherRaces = raceNumbers.slice(0, -1).join(", ");
                      description = "Races " + otherRaces + " & " + lastRace;
                    }
                  }

                  setDescription(description);
                }
            }

            const event_info_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=DATASET`, controller.signal)
            if (!event_info_json.success) throw new Error("Failed to fetch dataset event: dataset");

            const event_info = event_info_json.data?.[0];
            info("Event info:", event_info);
            setStartTime(event_info?.start_time ?? "");
            setEndTime(event_info?.end_time ?? "");
            if (!event_info) {
                warn("[DayInfo] No event info for dataset; start_time/end_time not set");
            }
            const summary_json = await getData(`${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=summary`, controller.signal)
            if (summary_json.success && summary_json.data) {
                const summary = summary_json.data
                setUnsafeSummary(summary.text)
                if (summaryEditor) {
                    summaryEditor.root.innerHTML = safeSummary();
                }
            } else {
                // Dataset object doesn't exist yet, use default empty content
                setUnsafeSummary("<p>No summary available yet.</p>")
                if (summaryEditor) {
                    summaryEditor.root.innerHTML = safeSummary();
                }
            }

            const notes_json = await getData(`${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=notes`, controller.signal)
            if (notes_json.success && notes_json.data) {
                const notes = notes_json.data
                setUnsafeNotes(notes.text)
                if (notesEditor) {
                    notesEditor.root.innerHTML = safeNotes();
                }
            } else {
                // Dataset object doesn't exist yet, use default empty content
                setUnsafeNotes("<p>No notes available yet.</p>")
                if (notesEditor) {
                    notesEditor.root.innerHTML = safeNotes();
                }
            }

            const daytype_json = await getData(`${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=day_type_notes`, controller.signal)
            if (daytype_json.success && daytype_json.data) {
                const daytype = daytype_json.data
                setUnsafeDayTypeNotes(daytype.text)
                if (daytypeEditor) {
                    daytypeEditor.root.innerHTML = safeDayTypeNotes();
                }
            } else {
                // Dataset object doesn't exist yet, use default empty content
                setUnsafeDayTypeNotes("<p>No day type notes available yet.</p>")
                if (daytypeEditor) {
                    daytypeEditor.root.innerHTML = safeDayTypeNotes();
                }
            }

            const technique_json = await getData(`${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=technique`, controller.signal)
            if (technique_json.success && technique_json.data) {
                const technique = technique_json.data
                setUnsafeTechniqueNotes(technique.text)
                if (techniqueEditor) {
                    techniqueEditor.root.innerHTML = safeTechniqueNotes();
                }
            } else {
                // Dataset object doesn't exist yet, use default empty content
                setUnsafeTechniqueNotes("<p>No technique notes available yet.</p>")
                if (techniqueEditor) {
                    techniqueEditor.root.innerHTML = safeTechniqueNotes();
                }
            }

            const winning_json = await getData(`${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=how_to_win`, controller.signal)
            if (winning_json.success && winning_json.data) {
                const winning = winning_json.data
                setUnsafeWinningNotes(winning.text)
                if (winningEditor) {
                    winningEditor.root.innerHTML = safeWinningNotes();
                }
            } else {
                // Dataset object doesn't exist yet, use default empty content
                setUnsafeWinningNotes("<p>No winning notes available yet.</p>")
                if (winningEditor) {
                    winningEditor.root.innerHTML = safeWinningNotes();
                }
            }

            // Fetch configuration data
            const configuration_json = await getData(`${apiEndpoints.app.datasets}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&parent_name=dataset&object_name=configuration`, controller.signal)
            if (configuration_json.success && configuration_json.data) {
                let config = configuration_json.data;
                // Handle case where data might be a string that needs parsing
                if (typeof config === 'string') {
                    try {
                        config = JSON.parse(config);
                    } catch (e) {
                        logError('[DatasetInfo] Failed to parse configuration JSON:', e);
                        config = {};
                    }
                }
                if (config && typeof config === 'object') {
                    if (config.MAST !== undefined && config.MAST !== null) setMast(config.MAST.toString());
                    if (config.FOIL !== undefined && config.FOIL !== null) setFoils(config.FOIL.toString());
                    if (config.RUDDER !== undefined && config.RUDDER !== null) setRudder(config.RUDDER.toString());
                    debug('[DatasetInfo] Configuration loaded:', config);
                }
            } else {
                // No configuration exists yet, start with empty values
                setMast("");
                setFoils("");
                setRudder("");
                debug('[DayInfo] No existing configuration, starting with empty values');
            }

            // Load project object target for this date so we can preselect Target combo
            const dateVal = data.date || date();
            if (dateVal) {
                const dateNorm = String(dateVal).replace(/-/g, '');
                const dateWithDashes = dateNorm.length === 8 ? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}` : String(dateVal);
                for (const d of [dateNorm, dateWithDashes]) {
                    try {
                        const targetRes = await getData(
                            `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(d)}&object_name=target`,
                            controller.signal
                        );
                        if (targetRes.success && targetRes.data != null) {
                            let arr: Array<{ name?: string }> = [];
                            const raw = targetRes.data;
                            if (typeof raw === 'string') {
                                try { arr = JSON.parse(raw); } catch { arr = []; }
                            } else if (Array.isArray(raw)) {
                                arr = raw;
                            } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                                if ('value' in raw && raw.value != null) {
                                    const v = (raw as { value: unknown }).value;
                                    arr = Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : [v as { name?: string }];
                                } else if (typeof (raw as { name?: unknown }).name === 'string') {
                                    arr = [raw as { name: string }];
                                }
                            }
                            if (!Array.isArray(arr)) arr = [];
                            const name = arr[0]?.name;
                            if (name && String(name).trim()) {
                                const projectTargetName = String(name).trim();
                                const normalizeForMatch = (s: string) => (s || '').replace(/_target$/i, '');
                                const projectNormalized = normalizeForMatch(projectTargetName);
                                const current = availableTargets();
                                const matchingOption = current.find(t => normalizeForMatch((t.name || '').trim()) === projectNormalized);
                                const valueToSelect = matchingOption ? matchingOption.name : projectTargetName;
                                setSelectedTarget(valueToSelect);
                                const parsed = parseTargetFilename(projectTargetName);
                                if (parsed) {
                                    setMast(parsed.wingCode);
                                    setFoils(parsed.dbCode);
                                    setRudder(parsed.rudCode);
                                }
                                debug('[DayInfo] Loaded project target for date:', projectTargetName, 'combo value:', valueToSelect);
                                break;
                            }
                        }
                    } catch (err) {
                        debug('[DayInfo] Project target fetch failed for date', d, err);
                    }
                }
            }

            // Fetch all datasets for this day so updates apply to all (use timezone for local day)
            const dateForApi = data.date ? String(data.date).replace(/[-/]/g, "") : "";
            if (dateForApi) {
                const timezone = await getTimezoneForDate(className, Number(projectId), dateForApi);
                let dayListUrl = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateForApi)}`;
                if (timezone) dayListUrl += `&timezone=${encodeURIComponent(timezone)}`;
                const dayListRes = await getData(dayListUrl, controller.signal);
                if (dayListRes.success && Array.isArray(dayListRes.data) && dayListRes.data.length > 0) {
                    setDayDatasets(dayListRes.data as DayDatasetRow[]);
                    debug('[DayInfo] Day datasets for update:', dayListRes.data.length, dayListRes.data);
                } else {
                    setDayDatasets([]);
                }
            } else {
                setDayDatasets([]);
            }

            await logPageLoad('DayInfo.tsx', 'Day Info Page')
        } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
                logError("Error fetching dataset data:", error.message);
            }
        }
    };

    const buildTagsObject = () => {
        // Extract Day number from report_name (e.g., "Day 1" -> 1, otherwise 0)
        let dayNumber = 0;
        const reportNameValue = reportName();
        if (reportNameValue && typeof reportNameValue === 'string') {
            const dayMatch = reportNameValue.match(/Day\s+(\d+)/i);
            if (dayMatch) {
                dayNumber = parseInt(dayMatch[1], 10);
            }
        }

        // Get existing tags or start with empty object
        const existingTags = (currentTags() || {}) as { Productivity?: any; isUploaded?: boolean; [key: string]: any };

        // Build tags object according to template
        const tags = {
            Day: dayNumber,
            Source: sourceName() || "",
            Weather: {
                TWD: twd() || "",
                TWS: tws() || ""
            },
            Location: "", // Location removed, using timezone instead
            // Preserve existing Productivity if it exists, otherwise use defaults
            Productivity: existingTags.Productivity || {
                Percent: 0,
                "Total Hours": 0,
                "Sailing  Hours": 0
            },
            // Preserve existing isUploaded if it exists, otherwise default to true
            isUploaded: existingTags.isUploaded !== undefined ? existingTags.isUploaded : true
        };

        debug('[DayInfo] Built tags object:', tags);
        return tags;
    };

    const fetchTargets = async () => {
        const controller = new AbortController();
        try {
            const response = await getData(
                `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&isPolar=0`,
                controller.signal
            );
            if (response.success && response.data && Array.isArray(response.data)) {
                const targets = response.data.map((t: { name?: string } | string) =>
                    typeof t === 'object' && t && 'name' in t ? { name: (t as { name?: string }).name || String(t) } : { name: String(t) }
                ).filter(t => t.name).sort((a, b) => a.name.localeCompare(b.name));
                setAvailableTargets(targets);
                debug('[DayInfo] Loaded targets:', targets.length);
            } else {
                setAvailableTargets([]);
            }
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'name' in err && (err as Error).name !== 'AbortError') {
                logError('[DayInfo] Error fetching targets:', err);
            }
            setAvailableTargets([]);
        }
    };

    const handleTargetChange = (targetName: string) => {
        setSelectedTarget(targetName);
        if (targetName && targetName.trim() !== '') {
            const parsed = parseTargetFilename(targetName);
            if (parsed) {
                setMast(parsed.wingCode);
                setFoils(parsed.dbCode);
                setRudder(parsed.rudCode);
                debug('[DayInfo] Target selected, set config from target:', parsed);
            }
        }
    };

    const saveTargetsToProject = async (): Promise<boolean> => {
        const targetName = selectedTarget()?.trim();
        if (!targetName) return true;
        let dateStr = date();
        if (!dateStr) {
            logError('[DayInfo] No date available for saving target object');
            return false;
        }
        dateStr = dateStr.replace(/-/g, '');
        let nameToSave = targetName;
        if (nameToSave.endsWith('_target')) nameToSave = nameToSave.slice(0, -7);
        const targetsJson = [{ name: nameToSave }];
        try {
            const response = await postData(`${apiEndpoints.app.projects}/object`, {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                date: dateStr,
                object_name: 'target',
                json: JSON.stringify(targetsJson),
            });
            if (response.success) {
                debug('[DayInfo] Target object saved for date:', dateStr);
                return true;
            }
            logError('[DayInfo] Failed to save target object:', response.message);
            return false;
        } catch (err: unknown) {
            logError('[DayInfo] Error saving target object:', err);
            return false;
        }
    };

    const saveTargetConfigurationsToProject = async (): Promise<boolean> => {
        const targetName = selectedTarget()?.trim();
        if (!targetName) return true;
        const parsed = parseTargetFilename(targetName);
        if (!parsed) {
            debug('[DayInfo] Could not parse target for configurations, skipping');
            return true;
        }
        let dateStr = date();
        if (!dateStr) {
            logError('[DayInfo] No date for saving target configurations');
            return false;
        }
        const dateNorm = dateStr.replace(/-/g, '');
        const dateIso = dateNorm.length === 8 ? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}` : dateStr;
        try {
            let configList: Array<{ time: string; configuration: Record<string, string> }> = [];
            for (const d of [dateNorm, dateIso]) {
                const res = await getData(
                    `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(d)}&object_name=configurations`
                );
                if (res.success && res.data) {
                    let arr = res.data;
                    if (typeof arr === 'string') {
                        try { arr = JSON.parse(arr); } catch { arr = []; }
                    }
                    if (Array.isArray(arr)) configList = arr;
                    break;
                }
            }
            const targetFields = { name: parsed.name, wing: parsed.wingCode, rudder: parsed.rudCode, daggerboard: parsed.dbCode };
            const buildConfigString = (c: Record<string, string>) =>
                `${c.name ?? ''}-${c.jib ?? c.headsail ?? ''}-${c.crew ?? ''}`.replace(/-+/g, '-').replace(/^-|-$/g, '');
            if (configList.length > 0) {
                configList = configList.map((item: { time: string; configuration: Record<string, string> }) => {
                    const configuration = { ...item.configuration, ...targetFields };
                    configuration.config = buildConfigString(configuration);
                    return { time: item.time, configuration };
                });
            } else {
                const configuration: Record<string, string> = { ...targetFields, headsail: '', crew: '', config: '' };
                configuration.config = buildConfigString(configuration);
                configList = [{ time: `${dateIso}T10:00:00`, configuration }];
            }
            const response = await postData(`${apiEndpoints.app.projects}/object`, {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                date: dateNorm,
                object_name: 'configurations',
                json: JSON.stringify(configList),
            });
            if (response.success) {
                debug('[DayInfo] Target configurations saved for date:', dateNorm);
                return true;
            }
            logError('[DayInfo] Failed to save target configurations:', response.message);
            return false;
        } catch (err: unknown) {
            logError('[DayInfo] Error saving target configurations:', err);
            return false;
        }
    };

    const handleUpdateNotes = async (datasetId?: number) => {
        const controller = new AbortController();
        const dsId = datasetId ?? selectedDatasetId();
        if (!dsId) return false;

        try {
            const summary_obj = {'text': safeSummary().replaceAll("'", "")}
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': dsId, 'parent_name': 'dataset', 'object_name': 'summary', 'json': JSON.stringify(summary_obj)}
            const summary_status = await postData(apiEndpoints.admin.datasets + '/object', summary_json, controller.signal)

            const notes_obj = {'text': safeNotes().replaceAll("'", "")}
            const notes_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': dsId, 'parent_name': 'dataset', 'object_name': 'notes', 'json': JSON.stringify(notes_obj)}
            const notes_status = await postData(apiEndpoints.admin.datasets + '/object', notes_json, controller.signal)

            const daytype_obj = {'text': safeDayTypeNotes().replaceAll("'", "")}
            const daytype_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': dsId, 'parent_name': 'dataset', 'object_name': 'day_type_notes', 'json': JSON.stringify(daytype_obj)}
            const daytype_status = await postData(apiEndpoints.admin.datasets + '/object', daytype_json, controller.signal)

            const technique_obj = {'text': safeTechniqueNotes().replaceAll("'", "")}
            const technique_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': dsId, 'parent_name': 'dataset', 'object_name': 'technique', 'json': JSON.stringify(technique_obj)}
            const technique_status = await postData(apiEndpoints.admin.datasets + '/object', technique_json, controller.signal)

            const winning_obj = {'text': safeWinningNotes().replaceAll("'", "")}
            const winning_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': dsId, 'parent_name': 'dataset', 'object_name': 'how_to_win', 'json': JSON.stringify(winning_obj)}
            const winning_status = await postData(apiEndpoints.admin.datasets + '/object', winning_json, controller.signal)

            if (summary_status.success && notes_status.success && daytype_status.success && technique_status.success && winning_status.success) {
                return true
            } else {
                return false
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return false;
            } else {
                logError("Error updating notes:", error);
                return false;
            }
        }
    }

    const handleUpdateConfiguration = async (datasetId?: number) => {
        const controller = new AbortController();
        const dsId = datasetId ?? selectedDatasetId();
        if (!dsId) return true;

        try {
            // Build configuration object with uppercase keys
            const configuration_obj: Record<string, unknown> = {};
            if (mast() && mast().trim() !== "") {
                const mastValue = mast().trim();
                const mastNum = parseFloat(mastValue);
                configuration_obj.MAST = isNaN(mastNum) ? mastValue : mastNum;
            }
            if (foils() && foils().trim() !== "") {
                configuration_obj.FOIL = foils().trim();
            }
            if (rudder() && rudder().trim() !== "") {
                configuration_obj.RUDDER = rudder().trim();
            }

            if (Object.keys(configuration_obj).length > 0) {
                const configuration_json = {
                    'class_name': selectedClassName(),
                    'project_id': selectedProjectId(),
                    'dataset_id': dsId,
                    'parent_name': 'dataset',
                    'object_name': 'configuration',
                    'json': JSON.stringify(configuration_obj)
                };
                const configuration_status = await postData(apiEndpoints.admin.datasets + '/object', configuration_json, controller.signal);
                if (configuration_status.success) {
                    debug('[DayInfo] Configuration updated for dataset:', dsId);
                    return true;
                } else {
                    logError('Failed to update configuration:', configuration_status.message || 'Unknown error');
                    return false;
                }
            } else {
                debug('[DayInfo] No configuration values to save for dataset:', dsId);
                return true;
            }
        } catch (error: any) {
            if (error.name === 'AbortError') return false;
            logError("Error updating configuration:", error);
            return false;
        }
    }

    const handleUpdateDataset = async (e: Event) => {
        e.preventDefault();

        const controller = new AbortController();
        const datasetsToUpdate = dayDatasets().length > 0 ? dayDatasets() : [{ dataset_id: selectedDatasetId()!, source_id: 0, source_name: sourceName() }];
        if (datasetsToUpdate.length === 0 || !datasetsToUpdate[0].dataset_id) {
            logError('[DayInfo] No datasets to update');
            return;
        }

        try {
            const shared_int = shared() ? 1 : 0;
            const tagsObject = buildTagsObject();
            let allOk = true;

            for (const row of datasetsToUpdate) {
                const dsId = row.dataset_id;
                const response_json = await putData(`${apiEndpoints.app.datasets}`, {
                    class_name: selectedClassName(),
                    project_id: selectedProjectId(),
                    dataset_id: dsId,
                    event_name: eventName(),
                    report_name: reportName(),
                    description: description(),
                    timezone: timezone(),
                    tws: tws() || "",
                    twd: twd() || "",
                    shared: shared_int
                }, controller.signal);

                if (!response_json.success) {
                    logError('[DayInfo] Failed to update dataset:', dsId, response_json.message || 'Unknown error');
                    allOk = false;
                    continue;
                }

                const tags_json = await putData(`${apiEndpoints.app.datasets}/tags`, {
                    class_name: selectedClassName(),
                    project_id: selectedProjectId(),
                    dataset_id: dsId,
                    tags: JSON.stringify(tagsObject)
                }, controller.signal);

                if (!tags_json.success) {
                    logError('[DayInfo] Failed to update tags for dataset:', dsId);
                    allOk = false;
                    continue;
                }

                const notesOk = await handleUpdateNotes(dsId);
                if (!notesOk) {
                    logError('[DayInfo] Failed to update notes for dataset:', dsId);
                    allOk = false;
                }

                const configOk = await handleUpdateConfiguration(dsId);
                if (!configOk) allOk = false;
            }

            if (allOk) {
                if (selectedTarget()?.trim()) {
                    const targetSaved = await saveTargetsToProject();
                    if (!targetSaved) logError('[DayInfo] Failed to save project target');
                    const configSaved = await saveTargetConfigurationsToProject();
                    if (!configSaved) logError('[DayInfo] Failed to save target configurations');
                }
                if (fromEvents() && configurations().length > 0) {
                    const configSaveStatus = await saveConfigurationObject();
                    if (!configSaveStatus) logError('[DayInfo] Failed to save configuration object');
                }
                await logPageLoad('DayInfo.tsx', 'Day Info Page', 'Updated');
                navigate("/dashboard");
            }
        } catch (error: any) {
            if (error.name !== 'AbortError') logError("Error updating day datasets:", error);
        }
    };

    const handleCleanup = async () => {
        const projectId = selectedProjectId();
        const className = selectedClassName();
        const dateValue = date();
        if (!projectId || projectId <= 0 || !className || !dateValue) {
            logError('[DayInfo] Cannot run cleanup: missing project_id, class_name, or date');
            alert('Cannot run cleanup: Project, class, or date is missing. Please wait for the page to load.');
            return;
        }
        const sanitizedDate = dateValue.replace(/[-/]/g, "");
        setShowModal(true);
        await new Promise(resolve => setTimeout(resolve, 100));
        const controller = new AbortController();
        try {
            await sseManager.connectToServer(8049);
        } catch (sseError) {
            warn('[DayInfo] SSE connect failed, continuing:', sseError);
        }
        try {
            const payload = {
                project_id: projectId.toString(),
                class_name: className,
                script_name: "4_cleanup.py",
                parameters: {
                    class_name: className,
                    project_id: projectId.toString(),
                    date: sanitizedDate,
                    verbose: false
                }
            };
            const timeoutId = setTimeout(() => controller.abort(), 120000);
            const response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
            clearTimeout(timeoutId);
            if (!response_json?.success) {
                logError('[DayInfo] Cleanup start failed:', response_json?.message || 'Unknown error');
                setShowModal(false);
                return;
            }
            const res = response_json as { process_id?: string; data?: { process_id?: string }; success?: boolean };
            const pid = res.process_id ?? res.data?.process_id;
            if (!pid) {
                setShowModal(false);
                return;
            }
            setProcessId(pid);
            processStore.startProcess(pid, 'script_execution', true);
            const processStartTime = Date.now();
            const minModalDisplayTime = 2000;
            const maxTimeout = setTimeout(() => {
                setShowModal(false);
                navigate("/dashboard");
            }, 300000);
            const waitForCompletion = () => {
                const process = processStore.getProcess(pid);
                if (process?.status === 'complete' || process?.status === 'error' || process?.status === 'timeout') {
                    clearTimeout(maxTimeout);
                    const elapsed = Date.now() - processStartTime;
                    const remainingTime = Math.max(0, minModalDisplayTime - elapsed);
                    setTimeout(() => {
                        setShowModal(false);
                        setTimeout(() => navigate("/dashboard"), 500);
                    }, remainingTime);
                } else {
                    setTimeout(waitForCompletion, 500);
                }
            };
            waitForCompletion();
        } catch (error: any) {
            if (error.name === 'AbortError') {
                logError('[DayInfo] Cleanup start timed out');
                alert('Cleanup request timed out. Please try again.');
            } else {
                logError('[DayInfo] Error running cleanup:', error);
                alert(`Error running cleanup: ${error?.message || error}\nCheck the browser console.`);
            }
            setShowModal(false);
        }
    };

    const handleReviewEvents = async () => {
        const className = selectedClassName() || 'ac40';
        const pid = selectedProjectId();
        const dateVal = selectedDate();
        const q = dateVal ? `?pid=${pid}&date=${encodeURIComponent(dateVal)}` : `?pid=${pid}`;
        navigate(`/events/${className}${q}`);
    };

    // Build unique headsail+crew combinations from events
    const buildConfigurationEntries = () => {
        const headsails = headsailEvents();
        const crews = crewCountEvents();
        const entries: ConfigurationEntry[] = [];

        // For each headsail event, find overlapping crew events
        headsails.forEach((headsail: any) => {
            const headsailStart = new Date(headsail.Start);
            const headsailEnd = new Date(headsail.End);
            const headsailCode = headsail.Event;

            crews.forEach((crew: any) => {
                const crewStart = new Date(crew.Start);
                const crewEnd = new Date(crew.End);
                const crewCode = crew.Event;

                // Check if events overlap
                const overlapStart = headsailStart > crewStart ? headsailStart : crewStart;
                const overlapEnd = headsailEnd < crewEnd ? headsailEnd : crewEnd;
                
                if (overlapStart < overlapEnd) {
                    // Check if this combo already exists
                    const exists = entries.find(e => e.headsail === headsailCode && e.crew === crewCode);
                    if (!exists) {
                        entries.push({
                            headsail: headsailCode,
                            crew: crewCode,
                            wing: '',
                            daggerboard: '',
                            rudder: '',
                            start: overlapStart,
                            end: overlapEnd
                        });
                    }
                }
            });
        });

        setConfigurations(entries);
        debug('[DatasetInfo] Built configuration entries:', entries);
    };

    // Update configuration entry
    const updateConfiguration = (index: number, field: keyof ConfigurationEntry, value: string) => {
        const configs = [...configurations()];
        if (configs[index]) {
            (configs[index] as any)[field] = value;
            setConfigurations(configs);
        }
    };

    // Build configuration JSON for saving
    const buildConfigurationJSON = (): any[] => {
        const configs = configurations();
        const result: any[] = [];

        configs.forEach(config => {
            if (config.wing && config.daggerboard && config.rudder) {
                const configString = `${config.wing}-${config.headsail}-${config.daggerboard}-${config.rudder}-${config.crew}`;
                result.push({
                    time: config.start.toISOString(),
                    configuration: {
                        name: '',
                        jib: config.headsail,
                        headsail: config.headsail,
                        crew: config.crew,
                        wing: config.wing,
                        config: configString,
                        rudder: config.rudder,
                        daggerboard: config.daggerboard
                    }
                });
            }
        });

        return result;
    };

    // Save configuration as project object
    const saveConfigurationObject = async (): Promise<boolean> => {
        try {
            const configJson = buildConfigurationJSON();
            
            if (configJson.length === 0) {
                warn('[DatasetInfo] No valid configurations to save (all entries must have wing, daggerboard, and rudder)');
                return true; // Not an error, just nothing to save
            }

            // Get date - use date() signal or from dataset
            let dateStr = date();
            if (!dateStr) {
                logError('[DatasetInfo] No date available for saving configuration object');
                return false;
            }
            
            // Convert YYYY-MM-DD to YYYYMMDD if needed
            dateStr = dateStr.replace(/-/g, '');
            
            debug('[DatasetInfo] Saving configuration object:', {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                date: dateStr,
                config_count: configJson.length
            });
            
            const response = await postData(
                `${apiEndpoints.app.projects}/object`,
                {
                    class_name: selectedClassName(),
                    project_id: selectedProjectId(),
                    date: dateStr,
                    object_name: 'configurations',
                    json: JSON.stringify(configJson)
                }
            );

            if (response.success) {
                debug('[DatasetInfo] Configuration object saved successfully');
                return true;
            } else {
                logError('[DatasetInfo] Failed to save configuration object:', response.message);
                return false;
            }
        } catch (error: any) {
            logError('[DatasetInfo] Error saving configuration object:', error);
            return false;
        }
    };

    const fetchTimezones = async () => {
        const controller = new AbortController();
        try {
            const response = await getData(`${apiEndpoints.app.admin.timezones}?project_id=${encodeURIComponent(selectedProjectId())}`, controller.signal);
            if (response.success && response.data) {
                // Extract timezone names from the response (array of objects with 'name' property)
                const tzNames = response.data.map((tz: any) => tz.name || tz).sort();
                setTimezones(tzNames);
                debug('[DatasetInfo] Loaded timezones:', tzNames.length);
            } else {
                logError('[DatasetInfo] Failed to fetch timezones:', response.message);
                setTimezones([]);
            }
        } catch (error: any) {
            if (error.name !== 'AbortError') {
                logError('[DatasetInfo] Error fetching timezones:', error);
            }
            setTimezones([]);
        }
    };

    // Effect to sync timezone when both database value and timezones list are available
    createEffect(() => {
        const dbTz = dbTimezoneValue();
        const availableTz = timezones();
        
        if (dbTz && availableTz.length > 0) {
            // Check if the timezone from DB exists in the list (case-insensitive)
            const matchingTz = availableTz.find(tz => tz.toLowerCase() === dbTz.toLowerCase());
            if (matchingTz) {
                debug('[DatasetInfo] Setting timezone from database:', matchingTz);
                setTimezone(matchingTz); // Use the exact case from the list
            } else {
                warn('[DatasetInfo] Timezone from database not found in available timezones:', dbTz);
                // Default to Europe/Madrid if not found
                const defaultTz = availableTz.find(tz => tz.toLowerCase() === "europe/madrid".toLowerCase());
                if (defaultTz) {
                    debug('[DatasetInfo] Using default timezone:', defaultTz);
                    setTimezone(defaultTz);
                } else if (availableTz.length > 0) {
                    // Fallback to first timezone if Europe/Madrid not found
                    debug('[DatasetInfo] Using first available timezone as fallback:', availableTz[0]);
                    setTimezone(availableTz[0]);
                }
            }
        } else if (dbTz && availableTz.length === 0) {
            // Timezones not loaded yet, but we have a DB value - set it anyway
            debug('[DatasetInfo] Setting timezone before timezones list is loaded:', dbTz);
            setTimezone(dbTz);
        } else if (!dbTz && availableTz.length > 0) {
            // No DB value but timezones are loaded - use default
            const defaultTz = availableTz.find(tz => tz.toLowerCase() === "europe/madrid".toLowerCase());
            if (defaultTz) {
                debug('[DatasetInfo] No DB timezone, using default:', defaultTz);
                setTimezone(defaultTz);
            }
        }
    });

    onMount(async () => {
        // Fetch timezones and targets first
        await fetchTimezones();
        await fetchTargets();
        
        // Read navigation state and date
        const navState = location.state as { 
            dataset_id?: number; 
            headsailEvents?: any[];
            crewCountEvents?: any[];
            date?: string;
            fromEvents?: boolean;
        } | null;
        
        if (navState?.fromEvents) {
            setFromEvents(true);
            if (navState.headsailEvents) {
                setHeadsailEvents(navState.headsailEvents);
            }
            if (navState.crewCountEvents) {
                setCrewCountEvents(navState.crewCountEvents);
            }
            if (navState.date) {
                setDate(navState.date);
            }
        }
        
        // Date can come from nav state or store (DayInfo is for a day; dataset_id is optional)
        const dateValue = navState?.date || selectedDate() || '';
        if (dateValue) {
            setDate(dateValue);
        }
        
        if (navState?.dataset_id && navState.dataset_id > 0) {
            setSelectedDatasetId(navState.dataset_id);
            debug('[DayInfo] Using dataset_id from navigation state:', navState.dataset_id);
        }
        
        // Wait for selectedDatasetId to be set if it was just updated via navigation
        let attempts = 0;
        const maxAttempts = 20;
        while ((!selectedDatasetId() || selectedDatasetId() === 0) && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        
        let datasetId = selectedDatasetId();
        
        // DayInfo purpose: update all datasets for this date. If no dataset_id yet, resolve from date.
        if (!datasetId || datasetId <= 0) {
            const urlParams = new URLSearchParams(window.location.search);
            const urlDatasetId = urlParams.get('dataset_id');
            if (urlDatasetId && parseInt(urlDatasetId, 10) > 0) {
                setSelectedDatasetId(parseInt(urlDatasetId, 10));
                datasetId = parseInt(urlDatasetId, 10);
                debug('[DayInfo] Using dataset_id from URL params:', urlDatasetId);
            }
        }
        
        if (!datasetId || datasetId <= 0) {
            const className = selectedClassName();
            const projectId = selectedProjectId();
            const dateForApi = dateValue ? String(dateValue).replace(/[-/]/g, '') : '';
            if (className && projectId && projectId > 0 && dateForApi) {
                try {
                    const timezone = await getTimezoneForDate(className, Number(projectId), dateForApi);
                    let dayListUrl = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateForApi)}`;
                    if (timezone) dayListUrl += `&timezone=${encodeURIComponent(timezone)}`;
                    const dayListRes = await getData(dayListUrl);
                    if (dayListRes.success && Array.isArray(dayListRes.data) && dayListRes.data.length > 0) {
                        const first = dayListRes.data[0] as { dataset_id: number };
                        datasetId = first.dataset_id;
                        setSelectedDatasetId(datasetId);
                        debug('[DayInfo] Resolved dataset_id from date:', dateForApi, '->', datasetId);
                    }
                } catch (err) {
                    logError('[DayInfo] Failed to resolve dataset_id from date:', dateForApi, err);
                }
            }
        }
        
        if (!datasetId || datasetId <= 0) {
            logError("[DayInfo] No datasets found for this date. Need class_name, project_id, and a date that has at least one dataset.");
            return;
        }
        
        await fetchDatasetData();
        
        // Build configuration entries if we have events from Events page
        if (fromEvents() && headsailEvents().length > 0 && crewCountEvents().length > 0) {
            buildConfigurationEntries();
        }
    });

    return (
        <div class={`dataset-info-page ${themeStore.isDark() ? 'dark' : 'light'}`}>
                <Show when={showWaiting()}>
                <WaitingModal visible={true} />
                </Show>
                
                    <WaitingModal 
                        visible={showModal()}
                        process_id={processId()}
                        title="Executing Python Script"
                        subtitle="This may take a few minutes. You can close this window and continue working while the script runs in the background."
                        disableAutoNavigation={true}
                        onClose={() => {
                            info('[DatasetInfo] WaitingModal onClose called');
                            setShowModal(false);
                        }}
                    />
                <Show when={date()} fallback={<Loading />}>
                <div>
                    <div class="day-info-header">
                        <h1>Day Info</h1>
                        <Show when={dayDatasets().length > 1}>
                            <p class="day-info-subtitle">Applying to all {dayDatasets().length} datasets on this day.</p>
                        </Show>
                    </div>
                    <form onSubmit={handleUpdateDataset}>
                    <div class="info-container">
                        <div class ="info-item-50">
                            <label class="label_bold" for="event_name">Event Name</label><label class="label_italic">example: World Championships</label>
                            <input type="text" id="event_name" value={eventName()} onInput={(e) => setEventName((e.target as HTMLInputElement).value)} />
                        </div>
                        <div class ="info-item-50">
                            <label class="label_bold" for="report_name">Report Name</label><label class="label_italic">example: Day 1</label>
                            <input type="text" id="report_name" value={reportName()} onInput={(e) => setReportName((e.target as HTMLInputElement).value)} />
                        </div>
                    </div>
                    <div class="info-container">
                        <div class ="info-item-50">
                            <label class="label_bold" for="timezone">Timezone</label><label class="label_italic">Select the timezone for this dataset</label>
                            <select id="timezone" value={timezone()} onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}>
                                <option value="">-- Select Timezone --</option>
                                <For each={timezones()}>
                                    {(tz) => (
                                        <option value={tz}>{tz}</option>
                                    )}
                                </For>
                            </select>
                        </div>
                        <div class ="info-item-25">
                            <label class="label_bold" for="report_name">Wind Speed</label><label class="label_italic">example: 10-15 kts</label>
                            <input type="text" id="report_name" value={tws()} onInput={(e) => setTws((e.target as HTMLInputElement).value)} />
                        </div>
                        <div class ="info-item-25">
                            <label class="label_bold" for="report_name">Wind Direction</label><label class="label_italic">example: E-NE</label>
                            <input type="text" id="report_name" value={twd()} onInput={(e) => setTwd((e.target as HTMLInputElement).value)} />
                        </div>
                    </div>
                    <div class="info-container">
                        <div class ="info-item">
                            <label class="label_bold" for="description">Description</label><label class="label_italic">Short summary of the dataset for available datasets table</label>
                            <input type="text" id="description" value={description()} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
                        </div>
                    </div>
                    <div class="info-container">
                        <Show when={availableTargets().length > 0}>
                            <div class="info-item">
                                <label class="label_bold" for="targetSelect">Target</label>
                                <label class="label_italic">Select target to set wing, daggerboard, and rudder</label>
                                <select
                                    id="targetSelect"
                                    value={selectedTarget()}
                                    onInput={(e) => handleTargetChange((e.target as HTMLSelectElement).value)}
                                    class="dataset-info-select"
                                >
                                    <option value="">-- Select Target --</option>
                                    <For each={availableTargets()}>
                                        {(t) => (
                                            <option value={t.name}>{t.name}</option>
                                        )}
                                    </For>
                                </select>
                            </div>
                        </Show>
                        <div class="info-item">
                            <label class="label_bold" for="showNotes">Notes</label>
                            <select
                                id="showNotes"
                                value={showNotes() ? "show" : "hide"}
                                onInput={(e) => setShowNotes((e.target as HTMLSelectElement).value === "show")}
                                class="dataset-info-select"
                            >
                                <option value="hide">Hide notes</option>
                                <option value="show">Show notes</option>
                            </select>
                        </div>
                    </div>
                    <Show when={fromEvents() && configurations().length > 0}>
                        <div class="info-container">
                            <div class="info-item">
                                <label class="label_bold">AC40 Configurations</label>
                                <label class="label_italic">Enter wing, daggerboard, and rudder for each unique headsail+crew combination</label>
                                <div style="margin-top: 10px;">
                                    <table style="width: 100%; border-collapse: collapse;">
                                        <thead>
                                            <tr style="border-bottom: 1px solid #ccc;">
                                                <th style="padding: 8px; text-align: left;">Headsail</th>
                                                <th style="padding: 8px; text-align: left;">Crew</th>
                                                <th style="padding: 8px; text-align: left;">Wing</th>
                                                <th style="padding: 8px; text-align: left;">Daggerboard</th>
                                                <th style="padding: 8px; text-align: left;">Rudder</th>
                                                <th style="padding: 8px; text-align: left; min-width: 150px;">Config</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <For each={configurations()}>
                                                {(config, index) => {
                                                    const configString = config.wing && config.daggerboard && config.rudder 
                                                        ? `${config.wing}-${config.headsail}-${config.daggerboard}-${config.rudder}-${config.crew}`
                                                        : '';
                                                    return (
                                                        <tr style="border-bottom: 1px solid #eee;">
                                                            <td style="padding: 8px;">{config.headsail}</td>
                                                            <td style="padding: 8px;">{config.crew}</td>
                                                            <td style="padding: 8px;">
                                                                <input 
                                                                    type="text" 
                                                                    value={config.wing} 
                                                                    onInput={(e) => updateConfiguration(index(), 'wing', (e.target as HTMLInputElement).value)}
                                                                    placeholder="e.g., LAW"
                                                                    style="width: 100%; padding: 4px;"
                                                                />
                                                            </td>
                                                            <td style="padding: 8px;">
                                                                <input 
                                                                    type="text" 
                                                                    value={config.daggerboard} 
                                                                    onInput={(e) => updateConfiguration(index(), 'daggerboard', (e.target as HTMLInputElement).value)}
                                                                    placeholder="e.g., LAB2"
                                                                    style="width: 100%; padding: 4px;"
                                                                />
                                                            </td>
                                                            <td style="padding: 8px;">
                                                                <input 
                                                                    type="text" 
                                                                    value={config.rudder} 
                                                                    onInput={(e) => updateConfiguration(index(), 'rudder', (e.target as HTMLInputElement).value)}
                                                                    placeholder="e.g., LARW"
                                                                    style="width: 100%; padding: 4px;"
                                                                />
                                                            </td>
                                                            <td style="padding: 8px; font-family: monospace; font-size: 0.9em; min-width: 150px;">
                                                                {configString || <span style="color: #999;">-</span>}
                                                            </td>
                                                        </tr>
                                                    );
                                                }}
                                            </For>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </Show>
                    <Show when={showNotes()}>
                    <div class="quill-container">
                        <div class ="info-item">
                            <label class="label_bold" for="summary">Summary Notes</label><label class="label_italic">Summary of the day, outline objectives, accomplishments and major lessons.</label>
                            <div 
                                id="summary" 
                                ref={(el: HTMLDivElement) => {
                                    if (el) {
                                        summaryEditor = new Quill(el, {
                                        theme: 'snow',
                                        modules: {
                                            toolbar: toolbarOptions
                                        }
                                    });
                                    summaryEditor.on("text-change", () => {
                                        if (summaryEditor) {
                                            setUnsafeSummary(summaryEditor.root.innerHTML);
                                        }
                                    });
                                }
                                }}
                            ></div>
                        </div>
                    </div>
                    <div class="quill-container">
                        <div class ="info-item">
                            <label class="label_bold" for="notes">Capture Notes</label><label class="label_italic">Meeting notes, jobs lists, coach comments & sailor feedback</label>
                            <div 
                                id="notes" 
                                ref={el => {
                                    notesEditor = new Quill(el, {
                                        theme: 'snow',
                                        modules: {
                                            toolbar: toolbarOptions
                                        }
                                    });
                                    notesEditor.on("text-change", () => {
                                        if (notesEditor) {
                                            setUnsafeNotes(notesEditor.root.innerHTML);
                                        }
                                    });
                                }}
                            ></div>
                        </div>
                    </div>
                    <div class="quill-container">
                        <div class ="info-item">
                            <label class="label_bold" for="day_type_notes">Day Type</label><label class="label_italic">Weather, local knowledge & forecast related notes</label>
                            <div 
                                id="day_type_notes" 
                                ref={el => {
                                    daytypeEditor = new Quill(el, {
                                        theme: 'snow',
                                        modules: {
                                            toolbar: toolbarOptions
                                        }
                                    });
                                    daytypeEditor.on("text-change", () => {
                                        if (daytypeEditor) {
                                            setUnsafeDayTypeNotes(daytypeEditor.root.innerHTML);
                                        }
                                    });
                                }}
                            ></div>
                        </div>
                    </div>
                    <div class="quill-container">
                        <div class ="info-item">
                            <label class="label_bold" for="technique">Technique</label><label class="label_italic">Technique related lessons to carry forward from the day</label>
                            <div 
                                id="technique" 
                                ref={el => {
                                    techniqueEditor = new Quill(el, {
                                        theme: 'snow',
                                        modules: {
                                            toolbar: toolbarOptions
                                        }
                                    });
                                    techniqueEditor.on("text-change", () => {
                                        if (techniqueEditor) {
                                            setUnsafeTechniqueNotes(techniqueEditor.root.innerHTML);
                                        }
                                    });
                                }}
                            ></div>
                        </div>
                    </div>
                    <div class="quill-container">
                        <div class ="info-item">
                            <label class="label_bold" for="how_to_win">How to Win</label><label class="label_italic">Notes related to how races were won or lost</label>
                            <div 
                                id="how_to_win" 
                                ref={el => {
                                    winningEditor = new Quill(el, {
                                        theme: 'snow',
                                        modules: {
                                            toolbar: toolbarOptions
                                        }
                                    });
                                    winningEditor.on("text-change", () => {
                                        if (winningEditor) {
                                            setUnsafeWinningNotes(winningEditor.root.innerHTML);
                                        }
                                    });
                                }}
                            ></div>
                        </div>
                    </div>
                    </Show>

                    <div class="info-container">
                        <Show when={state()==="Update"}>
                        <button type="submit" class="login-button">
                            <span class="button-text">Update Dataset Info</span>
                            <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        </Show>
                        <Show when={state()==="Save"}>
                        <button type="submit" class="login-button">
                            <span class="button-text">Save & Generate Report</span>
                            <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M19 7l-7 7-7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        </Show>
                    </div>

                    <div class="review-container">
                        <Show when={state()==="Update"}>
                        <button type="button" class="builder-form-button" onclick={handleReviewEvents}>
                            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
                            </svg>
                            Review Events
                        </button>
                        </Show>
                    </div>

                    <div class="exec-container">
                        <Show when={state()==="Update"}>
                        <button type="button" class="builder-form-button-success" onclick={handleCleanup}>
                            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                            </svg>
                            Re-Run Cleanup
                        </button>
                        </Show>
                    </div>
                </form>

                <BackButton />
            </div>
            </Show>
        </div>
    );
}
