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

import { getData, putData, postData, getDayBoundsInTimezone } from "../../utils/global";
import { startTime, endTime, setStartTime, setEndTime } from "../../store/globalStore";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { parseTargetFilename } from "../../utils/targetConfig";
const { selectedClassName, selectedProjectId, selectedDatasetId, setSelectedDatasetId, selectedSourceId } = persistantStore;

interface ConfigurationEntry {
    headsail: string;
    crew: string;
    wing: string;
    daggerboard: string;
    rudder: string;
    start: Date;
    end: Date;
}

/** Options for `executeScripts` when chaining multiple scripts on Dataset Info. */
interface DatasetExecuteScriptOptions {
    /** When false, do not navigate to the dashboard after the run finishes (success or failure). Default true. */
    navigateOnComplete?: boolean;
    /** When false, leave the waiting modal open after this run (for the next chained step). Default true. */
    dismissModalAfterRun?: boolean;
    /** When true, skip opening the waiting modal and initial delay (modal already open from a prior step). Default false. */
    skipModalOpen?: boolean;
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
    const [currentTags, setCurrentTags] = createSignal(null);
    const [mast, setMast] = createSignal("");
    const [foils, setFoils] = createSignal("");
    const [rudder, setRudder] = createSignal("");

    const [availableTargets, setAvailableTargets] = createSignal<Array<{ name: string }>>([]);
    const [selectedTarget, setSelectedTarget] = createSignal("");
    const [showNotes, setShowNotes] = createSignal(false);

    const [state, setState] = createSignal("Update");
    const [showWaiting, setShowWaiting] = createSignal(false);
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

    const [unsafeCrewNotes, setUnsafeCrewNotes] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
    const safeCrewNotes = () => DOMPurify.sanitize(unsafeCrewNotes());

    const [unsafeMaximumsNotes, setUnsafeMaximumsNotes] = createSignal("<script>alert('XSS!')</script><p>Safe Content</p>");
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
                    const raceNumbers = races.map(race => race.races);
                    
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
            if (event_info?.start_time && event_info?.end_time) {
                setStartTime(event_info.start_time);
                setEndTime(event_info.end_time);
            } else {
                // No DATASET event yet (e.g. first run after upload): use full day for dataset date so processing can run
                const dateVal = data.date;
                const tz = dbTimezone ?? "UTC";
                if (dateVal && tz) {
                    const dateStr = typeof dateVal === "string" && dateVal.length >= 8
                        ? dateVal.includes("-")
                            ? dateVal
                            : `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
                        : "";
                    if (dateStr) {
                        const { startMs, endMs } = getDayBoundsInTimezone(dateStr, tz);
                        setStartTime(new Date(startMs).toISOString());
                        setEndTime(new Date(endMs).toISOString());
                        debug("[DatasetInfo] No DATASET event; using full day for date", dateStr, "timezone", tz);
                    } else {
                        setStartTime("");
                        setEndTime("");
                        warn("[DatasetInfo] No event info and could not derive day bounds; start_time/end_time not set");
                    }
                } else {
                    setStartTime("");
                    setEndTime("");
                    if (!event_info) {
                        warn("[DatasetInfo] No event info for dataset; start_time/end_time not set");
                    }
                }
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
                debug('[DatasetInfo] No existing configuration, starting with empty values');
            }

            // Load project object target for this date so we can preselect Target combo
            // Use data.date from the response (not date() signal) so we have the value immediately
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
                                if (!matchingOption) {
                                    setAvailableTargets([...current, { name: projectTargetName }].sort((a, b) => a.name.localeCompare(b.name)));
                                }
                                debug('[DatasetInfo] Loaded project target for date:', projectTargetName, 'combo value:', valueToSelect);
                            }
                            break;
                        }
                    } catch (err) {
                        debug('[DatasetInfo] Project target fetch failed for date', d, err);
                    }
                }
            }

            await logPageLoad('DatasetInfo.tsx', 'Dataset Info Page')
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

        debug('[DatasetInfo] Built tags object:', tags);
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
                debug('[DatasetInfo] Loaded targets:', targets.length);
            } else {
                setAvailableTargets([]);
            }
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'name' in err && (err as Error).name !== 'AbortError') {
                logError('[DatasetInfo] Error fetching targets:', err);
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
                debug('[DatasetInfo] Target selected, set config from target:', parsed);
            }
        }
    };

    const handleUpdateNotes = async() => {
        const controller = new AbortController();
        
        try {
            const summary_obj = {'text': safeSummary().replaceAll("'", "")}
            const summary_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': selectedDatasetId(), 'parent_name': 'dataset', 'object_name': 'summary', 'json': JSON.stringify(summary_obj)}
            const summary_status = await postData(apiEndpoints.admin.datasets + '/object', summary_json, controller.signal)

            const notes_obj = {'text': safeNotes().replaceAll("'", "")}
            const notes_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': selectedDatasetId(), 'parent_name': 'dataset', 'object_name': 'notes', 'json': JSON.stringify(notes_obj)}
            const notes_status = await postData(apiEndpoints.admin.datasets + '/object', notes_json, controller.signal)

            const daytype_obj = {'text': safeDayTypeNotes().replaceAll("'", "")}
            const daytype_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': selectedDatasetId(), 'parent_name': 'dataset', 'object_name': 'day_type_notes', 'json': JSON.stringify(daytype_obj)}
            const daytype_status = await postData(apiEndpoints.admin.datasets + '/object', daytype_json, controller.signal)

            const technique_obj = {'text': safeTechniqueNotes().replaceAll("'", "")}
            const technique_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': selectedDatasetId(), 'parent_name': 'dataset', 'object_name': 'technique', 'json': JSON.stringify(technique_obj)}
            const technique_status = await postData(apiEndpoints.admin.datasets + '/object', technique_json, controller.signal)

            const winning_obj = {'text': safeWinningNotes().replaceAll("'", "")}
            const winning_json = {'class_name': selectedClassName(), 'project_id': selectedProjectId(),'dataset_id': selectedDatasetId(), 'parent_name': 'dataset', 'object_name': 'how_to_win', 'json': JSON.stringify(winning_obj)}
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

    const handleUpdateConfiguration = async() => {
        const controller = new AbortController();
        
        try {
            // Build configuration object with uppercase keys
            const configuration_obj = {};
            if (mast() && mast().trim() !== "") {
                // Try to parse as number, otherwise keep as string
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

            // Only save if there's at least one configuration value
            if (Object.keys(configuration_obj).length > 0) {
                const configuration_json = {
                    'class_name': selectedClassName(), 
                    'project_id': selectedProjectId(),
                    'dataset_id': selectedDatasetId(), 
                    'parent_name': 'dataset', 
                    'object_name': 'configuration', 
                    'json': JSON.stringify(configuration_obj)
                };
                const configuration_status = await postData(apiEndpoints.admin.datasets + '/object', configuration_json, controller.signal);
                
                if (configuration_status.success) {
                    debug('[DatasetInfo] Configuration updated successfully:', configuration_obj);
                    return true;
                } else {
                    logError('Failed to update configuration:', configuration_status.message || 'Unknown error');
                    return false;
                }
            } else {
                // No configuration values to save, consider it successful
                debug('[DatasetInfo] No configuration values to save');
                return true;
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return false;
            } else {
                logError("Error updating configuration:", error);
                return false;
            }
        }
    }

    const handleUpdateDataset = async (e: Event) => {
        e.preventDefault();
        
        const controller = new AbortController();

        try {
            let shared_int = 0
            if (shared() == true) {
                shared_int = 1
            } else {
                shared_int = 0
            }
                
            const response_json = await putData(`${apiEndpoints.app.datasets}`, {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                dataset_id: selectedDatasetId(),
                event_name: eventName(),
                report_name: reportName(),
                description: description(),
                timezone: timezone(),
                tws: tws() || "", // Backend validation will JSON stringify this
                twd: twd() || "", // Backend validation will JSON stringify this
                shared: shared_int
            }, controller.signal)

            if (!response_json.success) {
                // Let backend sendResponse handle error logging
                logError('Failed to update dataset:', response_json.message || 'Unknown error');
            } else {
                // Build and save tags object according to template
                const tagsObject = buildTagsObject();
                const tags_json = await putData(`${apiEndpoints.app.datasets}/tags`, {
                    class_name: selectedClassName(),
                    project_id: selectedProjectId(),
                    dataset_id: selectedDatasetId(),
                    tags: JSON.stringify(tagsObject)
                }, controller.signal);

                if (!tags_json.success) {
                    logError('Failed to update dataset tags:', tags_json.message || 'Unknown error');
                } else {
                    debug('[DatasetInfo] Tags updated successfully');
                }

                let status = await handleUpdateNotes();

                if (!status) {
                    // Let backend sendResponse handle error logging
                    logError('Failed to update dataset:', response_json.message || 'Unknown error');
                } else {
                    // Update configuration
                    const configStatus = await handleUpdateConfiguration();
                    if (!configStatus) {
                        logError('Failed to update configuration');
                    }

                    if (selectedTarget()?.trim()) {
                        const targetSaved = await saveTargetsToProject();
                        if (!targetSaved) logError('[DatasetInfo] Failed to save project target');
                        const configSaved = await saveTargetConfigurationsToProject();
                        if (!configSaved) logError('[DatasetInfo] Failed to save target configurations');
                    }

                    // Save AC40 configurations if we have them (before logPageLoad)
                    if (fromEvents() && configurations().length > 0) {
                        const configSaveStatus = await saveConfigurationObject();
                        if (!configSaveStatus) {
                            logError('Failed to save configuration object');
                        } else {
                            debug('[DatasetInfo] AC40 configurations saved successfully');
                        }
                    }

                    await logPageLoad('DatasetInfo.tsx', 'Dataset Info Page', 'Updated')

                    if (state()==="Save") {
                        handleExecution()
                    } else {
                        navigate("/dashboard")
                    }
                }
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
                logError("Error updating dataset:", error);
            }
        }
    };

    const handleMap = async () => {
        try {
            debug('[DatasetInfo] handleMap called');
            await executeScripts("0_map.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleMap:', error);
        }
    };

    const handleManeuvers = async () => {
        try {
            debug('[DatasetInfo] handleManeuvers called');
            await executeScripts("0_maneuvers.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleManeuvers:', error);
        }
    };

    const handlePerformance = async () => {
        try {
            debug('[DatasetInfo] handlePerformance called');
            await executeScripts("0_performance.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handlePerformance:', error);
        }
    };

    const handleCorrections = async () => {
        try {
            debug('[DatasetInfo] handleCorrections called');
            await executeScripts("3_corrections.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleCorrections:', error);
        }
    };

    const handleRaces = async () => {
        try {
            debug('[DatasetInfo] handleRaces called');
            await executeScripts("0_race.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleRaces:', error);
        }
    };

    const handleCleanup = async () => {
        try {
            debug('[DatasetInfo] handleCleanup called');
            await executeScripts("4_cleanup.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleCleanup:', error);
        }
    };

    const handleProcessing = async () => {
        try {
            debug('[DatasetInfo] handleProcessing called');
            await executeScripts("2_processing.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleProcessing:', error);
        }
    };

    /** Run processing, then corrections, then map, in order; one dashboard navigation after the last step. */
    const handleProcessingCorrectionsMap = async () => {
        try {
            debug('[DatasetInfo] handleProcessingCorrectionsMap called');
            const chainOpts: DatasetExecuteScriptOptions = {
                navigateOnComplete: false,
                dismissModalAfterRun: false,
            };
            const okProcessing = await executeScripts("2_processing.py", chainOpts);
            if (!okProcessing) return;
            const okCorrections = await executeScripts("3_corrections.py", {
                ...chainOpts,
                skipModalOpen: true,
            });
            if (!okCorrections) return;
            await executeScripts("0_map.py", { skipModalOpen: true });
        } catch (error) {
            logError('[DatasetInfo] Error in handleProcessingCorrectionsMap:', error);
        }
    };

    const handleExecution = async () => {
        try {
            debug('[DatasetInfo] handleExecution called');
            await executeScripts("3_execute.py");
        } catch (error) {
            logError('[DatasetInfo] Error in handleExecution:', error);
        }
    };

    const handleReviewEvents = async () => {
        const className = selectedClassName() || 'ac40';
        const pid = selectedProjectId();
        const datasetId = selectedDatasetId();
        navigate(`/events/${className}?pid=${pid}&dataset_id=${datasetId}`);
    };

    // Helper function to check for running processes
    const checkRunningProcesses = async (): Promise<{ running_count: number; processes: any[] } | null> => {
        try {
            const response = await getData(apiEndpoints.python.running_processes);
            if (response.success && response.data) {
                return response.data;
            }
            return null;
        } catch (error) {
            debug('[DatasetInfo] Error checking running processes:', error);
            return null;
        }
    };

    // Helper function to cancel a running process
    const cancelRunningProcess = async (processId: string): Promise<boolean> => {
        try {
            const response = await postData(apiEndpoints.python.cancel_process(processId), {});
            return response.success === true;
        } catch (error) {
            warn('[DatasetInfo] Error cancelling process:', error);
            return false;
        }
    };

    const executeScripts = async (
        filename: string,
        options?: DatasetExecuteScriptOptions
    ): Promise<boolean> => {
        const navigateOnComplete = options?.navigateOnComplete !== false;
        const dismissModalAfterRun = options?.dismissModalAfterRun !== false;
        const skipModalOpen = options?.skipModalOpen === true;

        debug('[DatasetInfo] executeScripts called with filename:', filename);

        // Validate required parameters before proceeding
        const projectId = selectedProjectId();
        const className = selectedClassName();
        const datasetId = selectedDatasetId();
        const dateValue = date();
        const sourceNameValue = sourceName();
        const startTimeValue = startTime();
        const endTimeValue = endTime();
        
        debug('[DatasetInfo] Script execution parameters:', {
            projectId,
            className,
            datasetId,
            date: dateValue,
            sourceName: sourceNameValue,
            startTime: startTimeValue,
            endTime: endTimeValue
        });
        
        if (!projectId || projectId <= 0) {
            logError('[DatasetInfo] Cannot execute script: projectId is missing or invalid', projectId);
            alert('Cannot execute script: Project ID is missing or invalid. Please navigate back and try again.');
            return false;
        }
        
        if (!className) {
            logError('[DatasetInfo] Cannot execute script: className is missing');
            alert('Cannot execute script: Class name is missing. Please navigate back and try again.');
            return false;
        }
        
        if (!datasetId || datasetId <= 0) {
            logError('[DatasetInfo] Cannot execute script: datasetId is missing or invalid', datasetId);
            alert('Cannot execute script: Dataset ID is missing or invalid. Please navigate back and try again.');
            return false;
        }
        
        if (!dateValue) {
            logError('[DatasetInfo] Cannot execute script: date is missing');
            alert('Cannot execute script: Date is missing. Please wait for the dataset to load.');
            return false;
        }
        
        if (!sourceNameValue) {
            logError('[DatasetInfo] Cannot execute script: sourceName is missing');
            alert('Cannot execute script: Source name is missing. Please wait for the dataset to load.');
            return false;
        }
        
        if (!startTimeValue || !endTimeValue) {
            logError('[DatasetInfo] Cannot execute script: start_time or end_time is missing', { startTime: startTimeValue, endTime: endTimeValue });
            alert('No active range event for this dataset. Open the Events page for this dataset to set the active range, then run processing.');
            return false;
        }
        
        debug('[DatasetInfo] All parameters validated, proceeding with script execution');
        
        // Check for running processes before starting
        const runningInfo = await checkRunningProcesses();
        if (runningInfo && runningInfo.running_count > 0) {
            const processList = runningInfo.processes.map(p => 
                `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
            ).join('\n');
            
            const message = `A process is already running:\n\n${processList}\n\nWould you like to cancel it and start the new process?`;
            const confirmed = window.confirm(message);
            
            if (!confirmed) {
                debug('[DatasetInfo] User cancelled - not starting new process');
                return false;
            }
            
            // Cancel all running processes
            for (const proc of runningInfo.processes) {
                const cancelled = await cancelRunningProcess(proc.process_id);
                if (cancelled) {
                    debug('[DatasetInfo] Cancelled process:', proc.process_id);
                } else {
                    warn('[DatasetInfo] Failed to cancel process:', proc.process_id);
                }
            }
            
            // Wait a moment for processes to cancel
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Show modal immediately (skip when continuing a chained run)
        if (!skipModalOpen) {
            debug('[DatasetInfo] Setting showModal to true');
            setShowModal(true);
            // Add a small delay to ensure the modal renders before making the request
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const controller = new AbortController();
        const sanitizedDate = date().replace(/[-/]/g, "");
        // 2_processing.py expects ISO 8601 strings (e.g. 2026-01-17T01:20:40.000Z) for start_time/end_time and events[].Start/End
        const startIso = startTimeValue ? (typeof startTimeValue === 'string' ? new Date(startTimeValue).toISOString() : (startTimeValue as Date).toISOString?.() ?? String(startTimeValue)) : '';
        const endIso = endTimeValue ? (typeof endTimeValue === 'string' ? new Date(endTimeValue).toISOString() : (endTimeValue as Date).toISOString?.() ?? String(endTimeValue)) : '';
        let parameters = {
            project_id: selectedProjectId().toString(),
            class_name: selectedClassName().toString(),
            dataset_id: selectedDatasetId().toString(),
            date: sanitizedDate,
            source_name: sourceName(),
            start_time: startIso,
            end_time: endIso,
            events: [{
                Event: "Active",
                Start: startIso,
                End: endIso,
                EventType: "Dataset"
            }],
            day_type: ['TRAINING', 'RACING'],
            race_type: ['INSHORE', 'COASTAL', 'OFFSHORE']
        };

        let payload = {
            project_id: selectedProjectId().toString(),
            class_name: selectedClassName().toString(),
            script_name: filename,
            parameters: parameters,
        };

        if (filename === "2_processing.py") {
            info("[DatasetInfo] 2_processing.py request body (for manual testing):", JSON.stringify(payload, null, 2));
            info("[DatasetInfo] 2_processing.py argv[1] (parameters only, for: python3 -u 2_processing.py '<this>'):", JSON.stringify(parameters));
        }

        // Pre-establish SSE connection for script execution before making the request
        debug('[DatasetInfo] Connecting to SSE server...');
        try {
            await sseManager.connectToServer(8049);
            debug('[DatasetInfo] SSE connection established');
        } catch (sseError) {
            warn('[DatasetInfo] Failed to connect to SSE server, continuing anyway:', sseError);
        }
      
        try {
            debug('[DatasetInfo] Making POST request to execute script:', {
                url: apiEndpoints.python.execute_script,
                payload: payload
            });
            
            // Add a timeout to prevent hanging
            // Increased to 2 minutes to allow for server load and network latency
            // The server should return process_id quickly, but under load it may take longer
            const timeoutId = setTimeout(() => {
                debug('[DatasetInfo] Request timeout reached, aborting...');
                controller.abort();
            }, 120000); // 2 minute timeout
            
            let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
            clearTimeout(timeoutId);
            
            debug('[DatasetInfo] Received response from server:', response_json);
            
            // Debug: Log the server response to see what we're getting
            debug('[DatasetInfo] Server response:', response_json);
            
            // Check if server returned "process already running" status
            if (response_json?.data?.process_already_running) {
                const runningProcesses = response_json.data.running_processes || [];
                const processList = runningProcesses.map((p: any) => 
                    `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
                ).join('\n');
                
                const message = `A process is already running:\n\n${processList}\n\nWould you like to cancel it and start the new process?`;
                const confirmed = window.confirm(message);
                
                if (!confirmed) {
                    debug('[DatasetInfo] User cancelled - not starting new process');
                    setShowModal(false);
                    return false;
                }
                
                // Cancel all running processes
                for (const proc of runningProcesses) {
                    const cancelled = await cancelRunningProcess(proc.process_id);
                    if (cancelled) {
                        debug('[DatasetInfo] Cancelled process:', proc.process_id);
                    } else {
                        warn('[DatasetInfo] Failed to cancel process:', proc.process_id);
                    }
                }
                
                // Wait a moment for processes to cancel, then retry
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Retry the script execution
                const retryResponse = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
                response_json = retryResponse;
            }
            
            // If request failed, close modal and abort without creating a phantom process
            if (!response_json?.success) {
                logError('[DatasetInfo] Script start failed:', response_json?.message || 'Unknown error');
                setShowModal(false);
                return false;
            }

            // Extract process_id and store
            let pid = null;
            if (response_json.process_id) {
                pid = response_json.process_id;
            } else if (response_json?.data?.process_id) {
                pid = response_json.data.process_id;
            }

            if (!pid) {
                // If server did not return a process id, treat as failure (avoid fallback to prevent phantom process)
                warn('[DatasetInfo] No process_id in successful server response');
                setShowModal(false);
                return false;
            }

            debug('[DatasetInfo] Using process_id:', pid);
            setProcessId(pid);
            debug('[DatasetInfo] Modal should be visible, showModal:', showModal(), 'processId:', pid);
            
            // CRITICAL: Start the process IMMEDIATELY and synchronously before any SSE messages can arrive
            // The server sends "Starting script" message immediately, which creates the process with showToast: false
            // We must call startProcess synchronously to set showToast: true before that message arrives
            processStore.startProcess(pid, 'script_execution', true);
            
            // Wait for the process to complete before navigating (or resolving when chaining)
            const processStartTime = Date.now();
            const minModalDisplayTime = 2000; // Minimum 2 seconds to ensure user sees the modal

            const completionPromise = new Promise<boolean>((resolve) => {
                let settled = false;
                const finish = (success: boolean) => {
                    if (settled) return;
                    settled = true;
                    resolve(success);
                };

                const maxTimeout = setTimeout(() => {
                    if (dismissModalAfterRun) setShowModal(false);
                    debug("Script execution timeout - navigating to dashboard");
                    if (navigateOnComplete) navigate("/dashboard");
                    finish(false);
                }, 300000); // 5 minute timeout

                const waitForCompletion = () => {
                    const process = processStore.getProcess(pid);
                    if (process) {
                        if (process.status === 'complete') {
                            clearTimeout(maxTimeout);
                            const elapsed = Date.now() - processStartTime;
                            const remainingTime = Math.max(0, minModalDisplayTime - elapsed);
                            debug('[DatasetInfo] Process completed, waiting', remainingTime, 'ms before closing modal');
                            setTimeout(() => {
                                if (dismissModalAfterRun) setShowModal(false);
                                if (navigateOnComplete) {
                                    setTimeout(() => navigate("/dashboard"), 500);
                                }
                                finish(true);
                            }, remainingTime);
                        } else if (process.status === 'error' || process.status === 'timeout') {
                            clearTimeout(maxTimeout);
                            const elapsed = Date.now() - processStartTime;
                            const remainingTime = Math.max(0, minModalDisplayTime - elapsed);
                            debug("Script execution failed:", process.status, "waiting", remainingTime, "ms before closing modal");
                            setTimeout(() => {
                                if (dismissModalAfterRun) setShowModal(false);
                                if (navigateOnComplete) {
                                    setTimeout(() => navigate("/dashboard"), 500);
                                }
                                finish(false);
                            }, remainingTime);
                        } else {
                            setTimeout(waitForCompletion, 500);
                        }
                    } else {
                        setTimeout(waitForCompletion, 500);
                    }
                };

                waitForCompletion();
            });

            return await completionPromise;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                // Request was aborted due to timeout
                logError('[DatasetInfo] Script start timed out');
                alert('Script execution timed out. The request took too long to start. Please try again.');
            } else {
                logError("Error executing script:", error);
                const errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
                alert(`Error executing script: ${errorMessage}\n\nCheck the browser console for more details.`);
            }
            // Close modal on error to avoid hanging UI
            setShowModal(false);
            return false;
        }
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
        const targetName = selectedTarget()?.trim();
        const parsedTarget = targetName ? parseTargetFilename(targetName) : null;
        const nameFromTarget = parsedTarget?.name ?? '';

        configs.forEach(config => {
            if (config.wing && config.daggerboard && config.rudder) {
                const configString = `${nameFromTarget || ''}-${config.headsail}-${config.crew}`.replace(/-+/g, '-').replace(/^-|-$/g, '');
                result.push({
                    time: config.start.toISOString(),
                    configuration: {
                        name: nameFromTarget,
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

    const saveTargetsToProject = async (): Promise<boolean> => {
        const targetName = selectedTarget()?.trim();
        if (!targetName) return true;
        let dateStr = date();
        if (!dateStr) {
            logError('[DatasetInfo] No date available for saving target object');
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
                debug('[DatasetInfo] Target object saved for date:', dateStr);
                return true;
            }
            logError('[DatasetInfo] Failed to save target object:', response.message);
            return false;
        } catch (err: unknown) {
            logError('[DatasetInfo] Error saving target object:', err);
            return false;
        }
    };

    const saveTargetConfigurationsToProject = async (): Promise<boolean> => {
        const targetName = selectedTarget()?.trim();
        if (!targetName) return true;
        const parsed = parseTargetFilename(targetName);
        if (!parsed) {
            debug('[DatasetInfo] Could not parse target for configurations, skipping');
            return true;
        }
        let dateStr = date();
        if (!dateStr) {
            logError('[DatasetInfo] No date for saving target configurations');
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
                debug('[DatasetInfo] Target configurations saved for date:', dateNorm);
                return true;
            }
            logError('[DatasetInfo] Failed to save target configurations:', response.message);
            return false;
        } catch (err: unknown) {
            logError('[DatasetInfo] Error saving target configurations:', err);
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
        
        // First, check if dataset_id and events were passed via navigation state
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
        
        if (navState?.dataset_id && navState.dataset_id > 0) {
            setSelectedDatasetId(navState.dataset_id);
            debug('[DatasetInfo] Using dataset_id from navigation state:', navState.dataset_id);
        }
        
        // Wait for selectedDatasetId to be set if it was just updated via navigation
        // This handles the case where navigate() is called immediately after setSelectedDatasetId()
        let attempts = 0;
        const maxAttempts = 20; // Increased attempts
        
        // Wait for datasetId to be set and be > 0 (not the default 0 value)
        while ((!selectedDatasetId() || selectedDatasetId() === 0) && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
        
        const datasetId = selectedDatasetId();
        if (!datasetId || datasetId === 0) {
            logError("selectedDatasetId is not set or is 0 after waiting", { datasetId, attempts, navState });
            // Try to get datasetId from URL params as fallback
            const urlParams = new URLSearchParams(window.location.search);
            const urlDatasetId = urlParams.get('dataset_id');
            if (urlDatasetId && parseInt(urlDatasetId) > 0) {
                setSelectedDatasetId(parseInt(urlDatasetId));
                debug('[DatasetInfo] Using dataset_id from URL params:', urlDatasetId);
            } else {
                logError("No valid dataset_id found. Cannot load dataset info.");
                return;
            }
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
                <WaitingModal />
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
                    <h1>Dataset Info</h1>
                    <form onSubmit={handleUpdateDataset}>
                    <div class="info-container">
                        <div class="info-item-50">
                            <label class="label_bold" for="source_name">Source Name</label>
                            <input type="text" id="source_name" value={sourceName()} readOnly class="grey-background" />
                        </div>
                        <div class="info-item-25">
                            <label class="label_bold" for="date">Date</label>
                            <input type="text" id="date" value={date()} readOnly class="grey-background" />
                        </div>
                        <div class="info-item-25">
                            <label class="label_bold" for="shared">Share Anonymously</label>
                            <select id="shared" value={shared() ? "true" : "false"} onChange={(e) => setShared((e.target as HTMLSelectElement).value === "true")}>
                                <option value="true">True</option>
                                <option value="false">False</option>
                            </select>
                        </div>
                    </div>
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
                            <label class="label_bold" for="report_name">Wind Speed</label><label class="label_italic">example: 10-15 knots</label>
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

                    <div class="indi-container">
                        <Show when={state()==="Update"}>
                        <div class="dataset-info-script-rows">
                            <div class="dataset-info-script-row dataset-info-script-row--four">
                                <button type="button" class="builder-form-button dataset-info-script-btn" onclick={handleProcessing}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                                    </svg>
                                    Re-Process
                                </button>
                                <button type="button" class="builder-form-button dataset-info-script-btn" onclick={handleCorrections}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                                    </svg>
                                    Corrections
                                </button>
                                <button type="button" class="builder-form-button dataset-info-script-btn" onclick={handleMap}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path>
                                    </svg>
                                    Map
                                </button>
                                <button type="button" class="builder-form-button dataset-info-script-btn dataset-info-pipeline-btn" onclick={handleProcessingCorrectionsMap}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                                    </svg>
                                    Process → Map
                                </button>
                            </div>
                            <div class="dataset-info-script-row dataset-info-script-row--second">
                                <button type="button" class="builder-form-button dataset-info-script-btn" onclick={handleManeuvers}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                                    </svg>
                                    Maneuvers
                                </button>
                                <button type="button" class="builder-form-button dataset-info-script-btn" onclick={handlePerformance}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                                    </svg>
                                    Performance
                                </button>
                                <button type="button" class="builder-form-button dataset-info-script-btn" onclick={handleRaces}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                                    </svg>
                                    Run Races
                                </button>
                                <button type="button" class="builder-form-button builder-form-button-success dataset-info-script-btn dataset-info-run-all-btn" onclick={handleExecution}>
                                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                                    </svg>
                                    Map → Races
                                </button>
                            </div>
                        </div>
                        </Show>
                    </div>

                    <div class="exec-container">
                        <Show when={state()==="Update"}>
                        <button type="button" class="builder-form-button builder-form-button-secondary" onclick={handleCleanup}>
                            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                            Cleanup
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
