const { validationResult } = require('express-validator');
const { check_permissions } = require("../middleware/auth_jwt");
const { sendResponse } = require('../middleware/helpers');
const db = require("../middleware/db");
const { logMessage } = require('../middleware/logging');
const { log } = require('../../shared');

exports.updateEventTags = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'updateEventTags' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null), true;
    }

    try {
        const { class_name, project_id, events, event_types, key, value } = req.body;

        // Validate inputs
        if (!events || !Array.isArray(events) || events.length === 0) {
            return sendResponse(res, info, 400, false, 'events must be a non-empty array', null, true);
        }

        if (!event_types || !Array.isArray(event_types) || event_types.length === 0) {
            return sendResponse(res, info, 400, false, 'event_types must be a non-empty array', null, true);
        }

        if (!key) {
            return sendResponse(res, info, 400, false, 'key is required', null, true);
        }

        let result = await check_permissions(req, 'write', project_id)

        if (!result) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Get all events with their start_time, end_time, and dataset_id
        const eventPlaceholders = events.map((_, index) => `$${index + 1}`).join(',');
        const getEventsSql = `SELECT event_id, dataset_id, start_time, end_time, tags 
                              FROM ${class_name}.dataset_events 
                              WHERE event_id IN (${eventPlaceholders})`;
        const eventRows = await db.GetRows(getEventsSql, events);

        if (!eventRows || eventRows.length === 0) {
            return sendResponse(res, info, 404, false, 'No events found', null, true);
        }

        // Process each event
        const updatePromises = [];

        for (const event of eventRows) {
            // Calculate mid_time: use existing mid_time from tags if available, otherwise calculate average
            let midTime;
            if (event.tags && event.tags.mid_time) {
                midTime = new Date(event.tags.mid_time);
            } else {
                const startTime = new Date(event.start_time);
                const endTime = new Date(event.end_time);
                midTime = new Date((startTime.getTime() + endTime.getTime()) / 2);
            }

            // Find matching events (from event_types) that contain this mid_time
            const findMatchingEventSql = `SELECT event_id, event_type 
                                          FROM ${class_name}.dataset_events 
                                          WHERE event_type = ANY($1::text[])
                                          AND start_time <= $2
                                          AND end_time >= $2
                                          AND dataset_id = $3
                                          ORDER BY start_time DESC
                                          LIMIT 1`;

            const matchingEvent = await db.GetRow(findMatchingEventSql, [event_types, midTime.toISOString(), event.dataset_id]);

            if (matchingEvent) {
                // Update the event's tags with the key-value pair
                // Merge the new key-value into existing tags
                const currentTags = event.tags || {};
                const updatedTags = {
                    ...currentTags,
                    [key]: value
                };

                const updateSql = `UPDATE ${class_name}.dataset_events 
                                   SET tags = $1::jsonb 
                                   WHERE event_id = $2`;
                updatePromises.push(db.ExecuteCommand(updateSql, [JSON.stringify(updatedTags), event.event_id]));
            }
        }

        // Execute all updates
        const updateResults = await Promise.all(updatePromises);
        const successCount = updateResults.filter(r => r === true).length;

        if (successCount === eventRows.length) {
            return sendResponse(res, info, 200, true, `Successfully updated ${successCount} event(s)`, { updated: successCount }, false);
        } else {
            return sendResponse(res, info, 207, false, `Partially updated: ${successCount} of ${eventRows.length} events`, { updated: successCount, total: eventRows.length }, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

/**
 * Merge tags into the DATASET event for a given dataset_id.
 * Used to set Dataset_type and Race_type after processing.
 */
exports.mergeDatasetEventTags = async (req, res) => {
    const info = { auth_token: req.cookies?.auth_token, location: 'server_admin/events', function: 'mergeDatasetEventTags' };

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, tags: tagsToMerge } = req.body;

        if (!class_name || !project_id || !dataset_id || !tagsToMerge || typeof tagsToMerge !== 'object') {
            return sendResponse(res, info, 400, false, 'class_name, project_id, dataset_id, and tags (object) are required', null, true);
        }

        const result = await check_permissions(req, 'write', project_id);
        if (!result) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        const getEventSql = `SELECT event_id, tags FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND event_type = 'DATASET' LIMIT 1`;
        const eventRow = await db.GetRow(getEventSql, [dataset_id]);

        if (!eventRow || !eventRow.event_id) {
            return sendResponse(res, info, 404, false, 'DATASET event not found for this dataset', null, true);
        }

        const currentTags = eventRow.tags && typeof eventRow.tags === 'object' ? eventRow.tags : {};
        const mergedTags = { ...currentTags, ...tagsToMerge };

        // Normalize to canonical keys only (Race_type, Dataset_type); remove legacy keys so we don't persist RACE_TYPE
        const legacyRaceKeys = ['RACE_TYPE', 'raceType'];
        const legacyDatasetKeys = ['DATASET_TYPE', 'datasetType'];
        for (const k of legacyRaceKeys) {
            if (mergedTags[k] != null && mergedTags.Race_type == null) mergedTags.Race_type = mergedTags[k];
            delete mergedTags[k];
        }
        for (const k of legacyDatasetKeys) {
            if (mergedTags[k] != null && mergedTags.Dataset_type == null) mergedTags.Dataset_type = mergedTags[k];
            delete mergedTags[k];
        }

        const updateSql = `UPDATE ${class_name}.dataset_events SET tags = $1::jsonb WHERE event_id = $2`;
        const updateResult = await db.ExecuteCommand(updateSql, [JSON.stringify(mergedTags), eventRow.event_id]);

        if (updateResult) {
            return sendResponse(res, info, 200, true, 'DATASET event tags updated', { event_id: eventRow.event_id }, false);
        } else {
            return sendResponse(res, info, 500, false, 'Failed to update DATASET event tags', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

/**
 * Sync dataset events: diff payload (Headsail/CrewCount) against current CREW/HEADSAIL,
 * then UPDATE/INSERT/DELETE only changed ranges. Optionally update CONFIGURATION events
 * with CONFIG and CONFIGURATION tags matching race_utils.getMetadata shape.
 */
exports.syncDatasetEvents = async (req, res) => {
    const info = { auth_token: req.cookies?.auth_token, location: 'server_admin/events', function: 'syncDatasetEvents' };

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, events } = req.body;

        if (!class_name || !project_id || !dataset_id) {
            return sendResponse(res, info, 400, false, 'class_name, project_id, and dataset_id are required', null, true);
        }
        if (!events || !Array.isArray(events)) {
            return sendResponse(res, info, 400, false, 'events must be an array', null, true);
        }

        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        const normalizeTs = (t) => {
            const str = preserveTimezone(t);
            const withTz = ensureExplicitTimezone(typeof str === 'string' ? str : (t && t.toISOString ? t.toISOString() : String(t)));
            return withTz.replace('Z', '+00:00');
        };

        const toTime = (t) => new Date(ensureExplicitTimezone(typeof t === 'string' ? t : (t && t.toISOString ? t.toISOString() : String(t)))).getTime();

        const desiredHeadsail = [];
        const desiredCrew = [];
        const desiredRace = [];
        const desiredPrestart = [];
        for (const ev of events) {
            if (!ev.EventType || !ev.Start || !ev.End) continue;
            const start = normalizeTs(ev.Start);
            const end = normalizeTs(ev.End);
            const startMs = toTime(ev.Start);
            const endMs = toTime(ev.End);
            const duration = (endMs - startMs) / 1000;
            if (ev.EventType === 'Headsail') {
                desiredHeadsail.push({ start, end, duration, Headsail_code: ev.Event != null ? String(ev.Event) : '' });
            } else if (ev.EventType === 'CrewCount') {
                const countVal = ev.Event;
                const count = (countVal === 'NA' || countVal === '' || countVal == null) ? 0 : (parseInt(countVal, 10) || 0);
                desiredCrew.push({ start, end, duration, Count: count });
            } else if (ev.EventType === 'Race' && ev.Event != null && typeof ev.Event === 'object' && ev.Event.Race_number != null) {
                const raceNumber = parseInt(ev.Event.Race_number, 10);
                if (!isNaN(raceNumber)) {
                    desiredRace.push({ start, end, duration, Race_number: raceNumber });
                }
            } else if (ev.EventType === 'Prestart' && ev.Event != null && typeof ev.Event === 'object' && ev.Event.Race_number != null) {
                const raceNumber = parseInt(ev.Event.Race_number, 10);
                if (!isNaN(raceNumber)) {
                    desiredPrestart.push({ start, end, duration, Race_number: raceNumber });
                }
            }
        }

        const getSql = `SELECT event_id, event_type, start_time, end_time, duration, tags FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND event_type IN ('CREW','HEADSAIL','RACE','PRESTART') ORDER BY start_time`;
        const existingRows = await db.GetRows(getSql, [dataset_id]) || [];

        const existingHeadsail = existingRows.filter((r) => r.event_type === 'HEADSAIL');
        const existingCrew = existingRows.filter((r) => r.event_type === 'CREW');
        const existingRace = existingRows.filter((r) => r.event_type === 'RACE');
        const existingPrestart = existingRows.filter((r) => r.event_type === 'PRESTART');

        function overlapMs(aStart, aEnd, bStart, bEnd) {
            const aS = toTime(aStart);
            const aE = toTime(aEnd);
            const bS = toTime(bStart);
            const bE = toTime(bEnd);
            if (aS >= bE || bS >= aE) return 0;
            return Math.min(aE, bE) - Math.max(aS, bS);
        }

        function midTime(start, end) {
            return (toTime(start) + toTime(end)) / 2;
        }

        const toUpdate = [];
        const toInsertHeadsail = [];
        const toInsertCrew = [];
        const toDelete = [];

        const matchedHeadsail = new Set();
        const matchedCrew = new Set();

        for (const des of desiredHeadsail) {
            const desMid = midTime(des.start, des.end);
            let found = null;
            for (let i = 0; i < existingHeadsail.length; i++) {
                if (matchedHeadsail.has(existingHeadsail[i].event_id)) continue;
                const ex = existingHeadsail[i];
                if (overlapMs(des.start, des.end, ex.start_time, ex.end_time) > 0) {
                    found = ex;
                    matchedHeadsail.add(ex.event_id);
                    break;
                }
            }
            if (found) {
                const exStart = normalizeTs(found.start_time);
                const exEnd = normalizeTs(found.end_time);
                const exCode = (found.tags && found.tags.Headsail_code != null) ? String(found.tags.Headsail_code) : '';
                if (exStart !== des.start || exEnd !== des.end || exCode !== des.Headsail_code) {
                    toUpdate.push({ event_id: found.event_id, event_type: 'HEADSAIL', start: des.start, end: des.end, duration: des.duration, tags: { ...(found.tags || {}), Headsail_code: des.Headsail_code } });
                }
            } else {
                toInsertHeadsail.push(des);
            }
        }
        for (const ex of existingHeadsail) {
            if (matchedHeadsail.has(ex.event_id)) continue;
            let anyOverlap = false;
            for (const des of desiredHeadsail) {
                if (overlapMs(des.start, des.end, ex.start_time, ex.end_time) > 0) { anyOverlap = true; break; }
            }
            if (!anyOverlap) toDelete.push(ex.event_id);
        }

        for (const des of desiredCrew) {
            const desMid = midTime(des.start, des.end);
            let found = null;
            for (let i = 0; i < existingCrew.length; i++) {
                if (matchedCrew.has(existingCrew[i].event_id)) continue;
                const ex = existingCrew[i];
                if (overlapMs(des.start, des.end, ex.start_time, ex.end_time) > 0) {
                    found = ex;
                    matchedCrew.add(ex.event_id);
                    break;
                }
            }
            if (found) {
                const exStart = normalizeTs(found.start_time);
                const exEnd = normalizeTs(found.end_time);
                const exCount = (found.tags && found.tags.Count != null) ? Number(found.tags.Count) : 0;
                if (exStart !== des.start || exEnd !== des.end || exCount !== des.Count) {
                    toUpdate.push({ event_id: found.event_id, event_type: 'CREW', start: des.start, end: des.end, duration: des.duration, tags: { ...(found.tags || {}), Count: des.Count } });
                }
            } else {
                toInsertCrew.push(des);
            }
        }
        for (const ex of existingCrew) {
            if (matchedCrew.has(ex.event_id)) continue;
            let anyOverlap = false;
            for (const des of desiredCrew) {
                if (overlapMs(des.start, des.end, ex.start_time, ex.end_time) > 0) { anyOverlap = true; break; }
            }
            if (!anyOverlap) toDelete.push(ex.event_id);
        }

        // RACE: match by Race_number in tags
        const toUpdateRace = [];
        const toInsertRace = [];
        const matchedRace = new Set();
        for (const des of desiredRace) {
            const found = existingRace.find((ex) => !matchedRace.has(ex.event_id) && (ex.tags && ex.tags.Race_number === des.Race_number));
            if (found) {
                matchedRace.add(found.event_id);
                const exStart = normalizeTs(found.start_time);
                const exEnd = normalizeTs(found.end_time);
                if (exStart !== des.start || exEnd !== des.end) {
                    toUpdateRace.push({ event_id: found.event_id, start: des.start, end: des.end, duration: des.duration, tags: { ...(found.tags || {}), Race_number: des.Race_number } });
                }
            } else {
                toInsertRace.push(des);
            }
        }

        // PRESTART: match by Race_number in tags
        const toUpdatePrestart = [];
        const toInsertPrestart = [];
        const matchedPrestart = new Set();
        for (const des of desiredPrestart) {
            const found = existingPrestart.find((ex) => !matchedPrestart.has(ex.event_id) && (ex.tags && ex.tags.Race_number === des.Race_number));
            if (found) {
                matchedPrestart.add(found.event_id);
                const exStart = normalizeTs(found.start_time);
                const exEnd = normalizeTs(found.end_time);
                if (exStart !== des.start || exEnd !== des.end) {
                    toUpdatePrestart.push({ event_id: found.event_id, start: des.start, end: des.end, duration: des.duration, tags: { ...(found.tags || {}), Race_number: des.Race_number } });
                }
            } else {
                toInsertPrestart.push(des);
            }
        }

        let updated = 0;
        let inserted = 0;
        let deleted = 0;

        for (const u of toUpdate) {
            const sql = `UPDATE ${class_name}.dataset_events SET start_time = $1::timestamptz, end_time = $2::timestamptz, duration = $3, tags = $4::jsonb WHERE event_id = $5`;
            const ok = await db.ExecuteCommand(sql, [u.start, u.end, u.duration, JSON.stringify(u.tags), u.event_id]);
            if (ok) updated++;
        }

        for (const d of toInsertHeadsail) {
            const sql = `INSERT INTO ${class_name}.dataset_events (dataset_id, event_type, start_time, end_time, duration, tags) VALUES ($1, 'HEADSAIL', $2::timestamptz, $3::timestamptz, $4, $5::jsonb)`;
            const ok = await db.ExecuteCommand(sql, [dataset_id, d.start, d.end, d.duration, JSON.stringify({ Headsail_code: d.Headsail_code })]);
            if (ok) inserted++;
        }
        for (const d of toInsertCrew) {
            const sql = `INSERT INTO ${class_name}.dataset_events (dataset_id, event_type, start_time, end_time, duration, tags) VALUES ($1, 'CREW', $2::timestamptz, $3::timestamptz, $4, $5::jsonb)`;
            const ok = await db.ExecuteCommand(sql, [dataset_id, d.start, d.end, d.duration, JSON.stringify({ Count: d.Count })]);
            if (ok) inserted++;
        }

        for (const u of toUpdateRace) {
            const sql = `UPDATE ${class_name}.dataset_events SET start_time = $1::timestamptz, end_time = $2::timestamptz, duration = $3, tags = $4::jsonb WHERE event_id = $5`;
            const ok = await db.ExecuteCommand(sql, [u.start, u.end, u.duration, JSON.stringify(u.tags), u.event_id]);
            if (ok) updated++;
        }
        for (const d of toInsertRace) {
            const sql = `INSERT INTO ${class_name}.dataset_events (dataset_id, event_type, start_time, end_time, duration, tags) VALUES ($1, 'RACE', $2::timestamptz, $3::timestamptz, $4, $5::jsonb)`;
            const ok = await db.ExecuteCommand(sql, [dataset_id, d.start, d.end, d.duration, JSON.stringify({ Race_number: d.Race_number })]);
            if (ok) inserted++;
        }

        for (const u of toUpdatePrestart) {
            const sql = `UPDATE ${class_name}.dataset_events SET start_time = $1::timestamptz, end_time = $2::timestamptz, duration = $3, tags = $4::jsonb WHERE event_id = $5`;
            const ok = await db.ExecuteCommand(sql, [u.start, u.end, u.duration, JSON.stringify(u.tags), u.event_id]);
            if (ok) updated++;
        }
        for (const d of toInsertPrestart) {
            const sql = `INSERT INTO ${class_name}.dataset_events (dataset_id, event_type, start_time, end_time, duration, tags) VALUES ($1, 'PRESTART', $2::timestamptz, $3::timestamptz, $4, $5::jsonb)`;
            const ok = await db.ExecuteCommand(sql, [dataset_id, d.start, d.end, d.duration, JSON.stringify({ Race_number: d.Race_number })]);
            if (ok) inserted++;
        }

        if (toDelete.length > 0) {
            const placeholders = toDelete.map((_, i) => `$${i + 1}`).join(',');
            const delSql = `DELETE FROM ${class_name}.dataset_events WHERE event_id IN (${placeholders})`;
            const ok = await db.ExecuteCommand(delSql, toDelete);
            if (ok) deleted = toDelete.length;
        }

        // Event types that receive CONFIG/CONFIGURATION tags from desired Headsail/Crew (same as CONFIGURATION)
        const configTagEventTypes = ['CONFIGURATION', 'PHASE', 'PERIOD', 'BIN 5', 'BIN 10', 'TACK', 'GYBE', 'ROUNDUP', 'BEARAWAY', 'TAKEOFF', 'UFO', 'JK', 'CHICAGO', 'DEANO'];

        // Dataset name and CONFIGURATION from this dataset's CONFIGURATION event; fallback to project config for this dataset's date if none
        let datasetConfigName = 'NA';
        let datasetConfigObject = null;
        const configEventSql = `SELECT tags FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND event_type = 'CONFIGURATION' ORDER BY start_time DESC LIMIT 1`;
        const configEventRows = await db.GetRows(configEventSql, [dataset_id]) || [];
        if (configEventRows.length > 0 && configEventRows[0].tags) {
            const t = configEventRows[0].tags;
            datasetConfigObject = t.CONFIGURATION || null;
            const confName = datasetConfigObject && (datasetConfigObject.Name != null || datasetConfigObject.name != null)
                ? String(datasetConfigObject.Name ?? datasetConfigObject.name).trim()
                : '';
            if (confName !== '') {
                datasetConfigName = confName;
            } else if (t.Name != null && String(t.Name).trim() !== '') {
                datasetConfigName = String(t.Name).trim();
            } else if (t.CONFIG && String(t.CONFIG) !== 'nan' && String(t.CONFIG) !== 'NA') {
                const first = String(t.CONFIG).split('-')[0];
                if (first) datasetConfigName = first;
            }
            if (datasetConfigObject && !datasetConfigObject.Name && datasetConfigObject.name != null) {
                datasetConfigObject = { ...datasetConfigObject, Name: String(datasetConfigObject.name).trim() };
            }
        }
        // When name is still NA, use project config for this dataset's date so the correct config name is applied (e.g. M14 not stale M10)
        let datasetDateStr = null;
        if (datasetConfigName === 'NA') {
            const datasetEventSql = `SELECT start_time FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND event_type = 'DATASET' ORDER BY start_time LIMIT 1`;
            const datasetEventRows = await db.GetRows(datasetEventSql, [dataset_id]) || [];
            if (datasetEventRows.length > 0 && datasetEventRows[0].start_time) {
                const st = datasetEventRows[0].start_time;
                if (typeof st === 'string' && st.length >= 10) {
                    datasetDateStr = st.slice(0, 10);
                } else if (st && st.toISOString) {
                    datasetDateStr = st.toISOString().slice(0, 10);
                }
            }
        }
        if (datasetConfigName === 'NA' && datasetDateStr) {
            const dateAlt = datasetDateStr.replace(/-/g, '');
            const projSql = `SELECT json FROM ${class_name}.project_objects WHERE project_id = $1 AND date = $2 AND object_name = 'configurations'`;
            let projRows = await db.GetRows(projSql, [project_id, datasetDateStr]) || [];
            if (projRows.length === 0 && dateAlt !== datasetDateStr) {
                projRows = await db.GetRows(projSql, [project_id, dateAlt]) || [];
            }
            if (projRows.length > 0 && projRows[0].json) {
                let configList = projRows[0].json;
                if (!Array.isArray(configList)) configList = [configList];
                if (configList.length > 0) {
                    const sorted = configList.slice().sort((a, b) => (a.time || '') < (b.time || '') ? -1 : 1);
                    const lastItem = sorted[sorted.length - 1];
                    const config = lastItem && lastItem.configuration ? lastItem.configuration : lastItem;
                    if (config) {
                        const name = (config.name || '').trim();
                        datasetConfigName = name || 'NA';
                        if (!datasetConfigObject) {
                            datasetConfigObject = {
                                Name: name,
                                Wing_code: (config.wing || '').trim(),
                                Daggerboard_code: (config.daggerboard || '').trim(),
                                Rudder_code: (config.rudder || '').trim(),
                            };
                            log(`[syncDatasetEvents] No CONFIGURATION event for dataset_id=${dataset_id}; using project config for date ${datasetDateStr}; dataset name: ${datasetConfigName}`);
                        } else {
                            if (!datasetConfigObject.Name || String(datasetConfigObject.Name).trim() === '') {
                                datasetConfigObject = { ...datasetConfigObject, Name: name };
                            }
                            log(`[syncDatasetEvents] dataset_id=${dataset_id}: name from project config for date ${datasetDateStr}: ${datasetConfigName}`);
                        }
                    }
                }
            }
        }
        log(`[syncDatasetEvents] Updating CONFIG/CONFIGURATION tags: ${desiredHeadsail.length} headsail segments, ${desiredCrew.length} crew segments; dataset name: ${datasetConfigName}`);

        // When payload has no headsail/crew segments (e.g. batch finalize with missing eventsByDatasetId), do not overwrite
        // CONFIG/CONFIGURATION on TACK/PHASE/etc. with NA/0 — only update CONFIGURATION event type to static fields
        const hasSegments = desiredHeadsail.length > 0 || desiredCrew.length > 0;

        for (const eventType of configTagEventTypes) {
            if (eventType !== 'CONFIGURATION' && !hasSegments) {
                continue; // skip tag update for TACK, PHASE, etc. when no segments so we don't wipe good data
            }
            const configSql = `SELECT event_id, start_time, end_time, tags FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND event_type = $2 ORDER BY start_time`;
            const configRows = await db.GetRows(configSql, [dataset_id, eventType]) || [];
            let typeUpdated = 0;

            for (const row of configRows) {
                const mid = midTime(row.start_time, row.end_time);
                let headsailCode = '';
                let crewCount = '';
                for (const seg of desiredHeadsail) {
                    const segStart = toTime(seg.start);
                    const segEnd = toTime(seg.end);
                    if (mid >= segStart && mid <= segEnd) { headsailCode = seg.Headsail_code; break; }
                }
                if (!headsailCode && desiredHeadsail.length > 0) {
                    let best = null;
                    for (const seg of desiredHeadsail) {
                        const segEnd = toTime(seg.end);
                        if (segEnd <= mid && (!best || segEnd > toTime(best.end))) best = seg;
                    }
                    if (best) headsailCode = best.Headsail_code;
                }
                for (const seg of desiredCrew) {
                    const segStart = toTime(seg.start);
                    const segEnd = toTime(seg.end);
                    if (mid >= segStart && mid <= segEnd) { crewCount = String(seg.Count); break; }
                }
                if (!crewCount && desiredCrew.length > 0) {
                    let best = null;
                    for (const seg of desiredCrew) {
                        const segEnd = toTime(seg.end);
                        if (segEnd <= mid && (!best || segEnd > toTime(best.end))) best = seg;
                    }
                    if (best) crewCount = String(best.Count);
                }
                const existingTags = row.tags || {};
                const existingConfig = existingTags.CONFIG != null ? String(existingTags.CONFIG) : '';
                const existingConf = row.tags?.CONFIGURATION || {};
                // Name for CONFIG: use canonical dataset name so all events (TACK, PHASE, etc.) sync to same config (e.g. M14 not M10)
                // Name only from CONFIGURATION event or project config — never from existing row (avoids propagating old name onto TACK/PHASE/BIN 10)
                const canonicalName = (datasetConfigName !== 'NA') ? datasetConfigName
                    : (datasetConfigObject?.Name != null && String(datasetConfigObject.Name).trim() !== '') ? String(datasetConfigObject.Name).trim()
                        : (datasetConfigObject?.name != null && String(datasetConfigObject.name).trim() !== '') ? String(datasetConfigObject.name).trim()
                            : 'NA';
                const nameForConfig = canonicalName;
                const staticName = canonicalName !== 'NA' ? canonicalName : '';
                const staticWing = (datasetConfigObject?.Wing_code != null && String(datasetConfigObject.Wing_code) !== '') ? String(datasetConfigObject.Wing_code) : (existingConf.Wing_code != null ? String(existingConf.Wing_code) : '');
                const staticDaggerboard = (datasetConfigObject?.Daggerboard_code != null && String(datasetConfigObject.Daggerboard_code) !== '') ? String(datasetConfigObject.Daggerboard_code) : (existingConf.Daggerboard_code != null ? String(existingConf.Daggerboard_code) : '');
                const staticRudder = (datasetConfigObject?.Rudder_code != null && String(datasetConfigObject.Rudder_code) !== '') ? String(datasetConfigObject.Rudder_code) : (existingConf.Rudder_code != null ? String(existingConf.Rudder_code) : '');

                let configStr;
                let newConf;
                if (eventType === 'CONFIGURATION') {
                    // CONFIGURATION event rows: store only static fields; never overwrite with empty (preserve existing so next sync still has name)
                    const keepName = staticName || (existingConf.Name != null && String(existingConf.Name).trim() !== '') ? String(existingConf.Name).trim() : (existingConf.name != null && String(existingConf.name).trim() !== '') ? String(existingConf.name).trim() : (existingTags.CONFIG && String(existingTags.CONFIG) !== 'nan' && String(existingTags.CONFIG) !== 'NA') ? (String(existingTags.CONFIG).split('-')[0] || '') : '';
                    const keepWing = staticWing || (existingConf.Wing_code != null ? String(existingConf.Wing_code) : '') || (existingConf.wing_code != null ? String(existingConf.wing_code) : '');
                    const keepDaggerboard = staticDaggerboard || (existingConf.Daggerboard_code != null ? String(existingConf.Daggerboard_code) : '') || (existingConf.daggerboard_code != null ? String(existingConf.daggerboard_code) : '');
                    const keepRudder = staticRudder || (existingConf.Rudder_code != null ? String(existingConf.Rudder_code) : '') || (existingConf.rudder_code != null ? String(existingConf.rudder_code) : '');
                    configStr = keepName || nameForConfig || 'NA';
                    newConf = {
                        Name: keepName,
                        Wing_code: keepWing,
                        Daggerboard_code: keepDaggerboard,
                        Rudder_code: keepRudder,
                    };
                } else {
                    // Other event types (TACK, PHASE, etc.): full CONFIG and CONFIGURATION from static + segment lookup
                    configStr = (nameForConfig + '-' + (headsailCode || 'NA') + '-C' + (crewCount || '0')).replace(/^NA-NA-C0$/, 'NA');
                    if (configStr === 'nan' || configStr === '') configStr = 'NA';
                    newConf = {
                        Name: staticName,
                        Wing_code: staticWing,
                        Headsail_code: headsailCode || 'NA',
                        Daggerboard_code: staticDaggerboard,
                        Rudder_code: staticRudder,
                        Crew_count: crewCount || '0',
                    };
                }
                if (configStr === 'nan' || configStr === '') configStr = 'NA';
                if (existingConfig !== configStr || JSON.stringify(existingConf) !== JSON.stringify(newConf)) {
                    const mergedTags = { ...existingTags, CONFIG: configStr, CONFIGURATION: newConf };
                    // Keep only CONFIG and CONFIGURATION at top level; config fields live only inside CONFIGURATION
                    delete mergedTags.Name;
                    delete mergedTags.Wing_code;
                    delete mergedTags.Rudder_code;
                    delete mergedTags.Daggerboard_code;
                    const upSql = `UPDATE ${class_name}.dataset_events SET tags = $1::jsonb WHERE event_id = $2`;
                    const ok = await db.ExecuteCommand(upSql, [JSON.stringify(mergedTags), row.event_id]);
                    if (ok) {
                        updated++;
                        typeUpdated++;
                    }
                }
            }
            if (configRows.length > 0 || typeUpdated > 0) {
                log(`[syncDatasetEvents] ${eventType}: ${configRows.length} rows, ${typeUpdated} tags updated`);
            }
        }

        return sendResponse(res, info, 200, true, 'Sync completed', { updated, inserted, deleted }, false);
    } catch (error) {
        log(`[syncDatasetEvents] Error: ${error.message}`);
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Helper function to preserve timezone information from timestamp strings
// Does NOT modify the timezone - preserves whatever timezone is in the input
function preserveTimezone(timestampInput) {
    if (!timestampInput) return timestampInput;

    // If it's already a Date object, convert to ISO string (which includes UTC 'Z')
    if (timestampInput instanceof Date) {
        return timestampInput.toISOString();
    }

    // For strings, preserve them as-is - don't modify timezone information
    // The timezone should be explicitly specified in the input (Z, +00:00, +01:00, etc.)
    return String(timestampInput).trim();
}

// If the timestamp string has no timezone (no Z, no +HH:MM, no -HH:MM), treat as UTC by appending Z.
// Prevents session/local TZ from misinterpreting datetimes (e.g. from Python pipeline sending UTC).
function ensureExplicitTimezone(timestampStr) {
    if (!timestampStr || typeof timestampStr !== 'string') return timestampStr;
    const s = timestampStr.trim();
    if (/Z$/i.test(s)) return s;
    if (/[+-]\d{2}:?\d{2}$/.test(s)) return s;
    return s.replace(/(\.\d+)?$/, (m) => (m || '') + 'Z');
}

exports.addEvent = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'addEvent' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null), true;
    }

    try {
        const { class_name, project_id, dataset_id, event_type, start_time, end_time, tags } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            // Preserve timezone information from input - don't modify it
            // If input has timezone (Z, +00:00, +01:00, etc.), it will be preserved
            // If input is a Date object, convert to ISO string
            const startTimeStr = preserveTimezone(start_time);
            const endTimeStr = preserveTimezone(end_time);
            const startWithTz = ensureExplicitTimezone(startTimeStr);
            const endWithTz = ensureExplicitTimezone(endTimeStr);

            // Parse to Date objects for duration calculation
            const startTime = new Date(startWithTz);
            const endTime = new Date(endWithTz);
            const duration = (endTime - startTime) / 1000;

            // Convert 'Z' suffix to explicit '+00:00' timezone offset
            // PostgreSQL handles explicit offsets better than 'Z'
            let startTimeForDB = startWithTz.replace('Z', '+00:00');
            let endTimeForDB = endWithTz.replace('Z', '+00:00');

            // Debug logging
            log(`[addEvent] Original timestamps: start=${startTimeStr}, end=${endTimeStr}`);
            log(`[addEvent] Timestamps for DB: start=${startTimeForDB}, end=${endTimeForDB}`);

            // For singleton-per-dataset event types (e.g. DATASET), update if exists to avoid duplicate key / sequence issues
            const singletonEventTypes = ['DATASET'];
            const eventTypeNorm = (event_type && String(event_type).toUpperCase()) || '';
            let eventIdResult = null;

            if (singletonEventTypes.includes(eventTypeNorm)) {
                const existingRow = await db.GetValue(
                    `SELECT event_id "value" FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND LOWER(event_type) = LOWER($2) ORDER BY event_id DESC LIMIT 1`,
                    [dataset_id, event_type]
                );
                if (existingRow != null) {
                    const eventIdForUpdate = typeof existingRow === 'number' ? existingRow : parseInt(existingRow, 10);
                    const updateSql = `UPDATE ${class_name}.dataset_events SET start_time = $1::timestamptz, end_time = $2::timestamptz, duration = $3, tags = $4::jsonb WHERE event_id = $5`;
                    const updateResult = await db.ExecuteCommand(updateSql, [startTimeForDB, endTimeForDB, duration, tags, eventIdForUpdate]);
                    if (updateResult) {
                        eventIdResult = eventIdForUpdate;
                    } else {
                        // Do not fall through to INSERT: row exists, would cause duplicate key
                        return sendResponse(res, info, 500, false, "Failed to update existing event (dataset_events).", null, true);
                    }
                }
            }

            if (eventIdResult == null) {
                const sql = `INSERT INTO ${class_name}.dataset_events (dataset_id, event_type, start_time, end_time, duration, tags) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb)`;
                const params = [dataset_id, event_type, startTimeForDB, endTimeForDB, duration, tags];
                const insertResult = await db.ExecuteCommand(sql, params);
                if (insertResult) {
                    eventIdResult = await db.GetValue(
                        `SELECT event_id "value" FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND event_type = $2 AND start_time = $3::timestamptz AND end_time = $4::timestamptz ORDER BY event_id DESC LIMIT 1`,
                        [dataset_id, event_type, startTimeForDB, endTimeForDB]
                    );
                }
            }

            if (eventIdResult != null) {
                return sendResponse(res, info, 200, true, "Event inserted successfully!", eventIdResult, false);
            } else {
                return sendResponse(res, info, 500, false, "Unable to insert or update event...", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.addEvents = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'addEvents' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, events } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            const singletonEventTypes = ['DATASET'];
            let status = true;
            for (let i = 0; i < events.length; i++) {
                const event = events[i];

                // Preserve timezone information from input - don't modify it
                const startTimeStr = preserveTimezone(event.start_time);
                const endTimeStr = preserveTimezone(event.end_time);
                const startWithTz = ensureExplicitTimezone(startTimeStr);
                const endWithTz = ensureExplicitTimezone(endTimeStr);

                const startTime = new Date(startWithTz);
                const endTime = new Date(endWithTz);
                const duration = (endTime - startTime) / 1000;

                let startTimeForDB = startWithTz.replace('Z', '+00:00');
                let endTimeForDB = endWithTz.replace('Z', '+00:00');

                const eventTypeNorm = (event.event_type && String(event.event_type).toUpperCase()) || '';
                let didUpsert = false;

                if (singletonEventTypes.includes(eventTypeNorm)) {
                    const existingRow = await db.GetValue(
                        `SELECT event_id "value" FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND LOWER(event_type) = LOWER($2) ORDER BY event_id DESC LIMIT 1`,
                        [dataset_id, event.event_type]
                    );
                    if (existingRow != null) {
                        const eventIdForUpdate = typeof existingRow === 'number' ? existingRow : parseInt(existingRow, 10);
                        const updateSql = `UPDATE ${class_name}.dataset_events SET start_time = $1::timestamptz, end_time = $2::timestamptz, duration = $3, tags = $4::jsonb WHERE event_id = $5`;
                        const updateResult = await db.ExecuteCommand(updateSql, [startTimeForDB, endTimeForDB, duration, event.tags || '{}', eventIdForUpdate]);
                        didUpsert = !!updateResult;
                    }
                }

                if (!didUpsert) {
                    const sql = `INSERT INTO ${class_name}.dataset_events (dataset_id, event_type, start_time, end_time, duration, tags) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb)`;
                    const params = [dataset_id, event.event_type, startTimeForDB, endTimeForDB, duration, event.tags];
                    const result = await db.ExecuteCommand(sql, params);
                    if (!result) {
                        status = false;
                        break;
                    }
                }
            }

            if (status) {
                return sendResponse(res, info, 200, true, "Events inserted successfully!", true, false);
            } else {
                log(query);
                return sendResponse(res, info, 500, false, "Unable to insert events...", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.addEventAggregates = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'addEventAggregates' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    let query = '';
    try {
        const { class_name, project_id, table, json } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables
        const allowedTables = ['events_aggregate', 'maneuver_stats', 'race_stats'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, 'Table not allowed for updates', null, true);
        }

        // Restrict updates to exclude certain columns
        const excludedColumns = ['event_id', 'agr_type'];

        let json_obj = JSON.parse(json)
        let jsonrows = json_obj["rows"]

        // Process each row in the JSON array
        for (i in jsonrows) {
            var row = jsonrows[i];

            var keys = undefined
            var values = undefined
            for (var key in row) {
                if (!excludedColumns.includes(key)) {
                    var value = row[key]
                    var isNull = value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
                    var sqlValue = isNull ? 'NULL' : "'" + String(value).replace(/'/g, "''") + "'"

                    if (keys === undefined) {
                        keys = '@#' + key + '@#'
                        values = sqlValue
                    } else {
                        keys += ', @#' + key + '@#'
                        values += ', ' + sqlValue
                    }
                }
            }

            if (table == 'events_aggregate') {
                query += db.formatSql(`INSERT INTO ${class_name}.${table} (event_id, agr_type, ${keys}) VALUES (${row.event_id},'${row.agr_type}',${values}); `)
            } else {
                // maneuver_stats, race_stats: UPSERT on event_id so re-runs update instead of failing
                const setClause = keys.split(',').map(k => k.trim()).map(k => `${k} = EXCLUDED.${k}`).join(', ')
                query += db.formatSql(`INSERT INTO ${class_name}.${table} (event_id, ${keys}) VALUES (${row.event_id},${values}) ON CONFLICT (event_id) DO UPDATE SET ${setClause}; `)
            }
        }

        // Execute query
        const action = 'insert';
        if (query.length > 0) {
            const success = await db.ExecuteCommand(query, []);

            if (success) {
                return sendResponse(res, info, 200, true, `${action} successful`, false);
            } else {
                log(query);
                logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', 'events', 'error', `${action} failed - Query: ${query}`, { query, action });
                return sendResponse(res, info, 500, false, `${action} failed`, null, true);
            }
        } else {
            return sendResponse(res, info, 500, false, `${action} failed: No valid data to insert`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//ADD EVENT JSON
exports.addEventObject = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'addEventObject' }

    // Set a longer timeout for this endpoint (5 minutes for large JSON inserts)
    req.setTimeout(300000); // 5 minutes in milliseconds
    res.setTimeout(300000); // Also set response timeout

    // Log immediately when request is received
    log(`[addEventObject] Request received - Content-Type: ${req.get('content-type')}, Content-Length: ${req.get('content-length')}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        log(`[addEventObject] Parsing request body...`);
        const { class_name, project_id, event_id, table, desc, json } = req.body;
        log(`[addEventObject] Request body parsed successfully`);

        // Log payload size for debugging
        const jsonSize = typeof json === 'string' ? json.length : JSON.stringify(json).length;
        log(`[addEventObject] Processing request: event_id=${event_id}, table=${table}, json_size=${(jsonSize / 1024 / 1024).toFixed(2)}MB`);

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables
        const allowedTables = ['events_mapdata', 'events_timeseries'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, 'Table not allowed for updates', null, true);
        }

        // Check if data exists
        const selectSQL = `SELECT event_id FROM ${class_name}.${table} WHERE event_id = $1 AND description = $2`;
        const existingData = await db.GetValue(selectSQL, [event_id, desc]);

        let query, params;
        if (existingData === null) {
            query = `INSERT INTO ${class_name}.${table} (event_id, description, json) VALUES ($1, $2, $3::jsonb)`;
            params = [event_id, desc, json];
        } else {
            query = `UPDATE ${class_name}.${table} SET json = $3::jsonb WHERE event_id = $1 AND description = $2`;
            params = [event_id, desc, json];
        }

        // Execute query with logging
        log(`[addEventObject] Executing ${existingData === null ? 'INSERT' : 'UPDATE'} query...`);
        const success = await db.ExecuteCommand(query, params);
        const action = existingData === null ? 'insert' : 'update';

        if (success) {
            log(`[addEventObject] ${action} successful for event_id=${event_id}`);
            return sendResponse(res, info, 200, true, `${action} successful`, true, false);
        } else {
            log(`[addEventObject] ${action} failed for event_id=${event_id}`);
            return sendResponse(res, info, 500, false, `${action} failed`, null, true);
        }
    } catch (error) {
        log(`[addEventObject] Error: ${error.message}`);
        log(`[addEventObject] Stack: ${error.stack}`);
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//ADD EVENT ROW - SINGLE RECORD
exports.addEventRow = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'addEventRow' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { class_name, project_id, table, event_id, agr_type, json } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables (start_stats: insert or update per event_id)
        const allowedTables = ['events_aggregate', 'events_cloud', 'maneuver_stats', 'start_stats'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, 'Table not allowed for updates', null, true);
        }

        // Restrict updates to exclude certain columns
        const excludedColumns = ['event_id', 'agr_type'];

        // Check if data exists
        let selectSQL, paramsSQL;
        if (table == 'events_aggregate') {
            selectSQL = `SELECT event_id "value" FROM ${class_name}.${table} WHERE event_id = $1 and agr_type = $2`;
            paramsSQL = [event_id, agr_type]
        } else {
            selectSQL = `SELECT event_id "value" FROM ${class_name}.${table} WHERE event_id = $1`;
            paramsSQL = [event_id]
        }

        const existingData = await db.GetValue(selectSQL, paramsSQL);

        let json_obj = JSON.parse(json)

        let query, params;
        if (existingData === null) {
            var keys = undefined
            var values = undefined
            for (var key in json_obj) {
                if (!excludedColumns.includes(key)) {
                    var value = json_obj[key]

                    if (keys === undefined) {
                        keys = '@#' + key + '@#'
                        values = "'" + value + "'"
                    } else {
                        keys += ', @#' + key + '@#'
                        values += ", '" + value + "'"
                    }
                }
            }

            if (table == 'events_aggregate') {
                query = db.formatSql(`INSERT into ${class_name}.${table} (event_id, agr_type, ${keys}) VALUES ($1, $2, ${values})`);
                params = [event_id, agr_type];
            } else {
                query = db.formatSql(`INSERT into ${class_name}.${table} (event_id, ${keys}) VALUES ($1, ${values})`);
                params = [event_id];
            }
        } else {
            var string = undefined
            var keys = undefined
            var values = undefined
            for (var key in json_obj) {
                if (!excludedColumns.includes(key)) {
                    var value = json_obj[key]

                    key_str = '@#' + key + '@#'
                    value_str = "'" + value + "'"

                    if (string === undefined) {
                        string = key_str + " = " + value_str
                    } else {
                        string += ", " + key_str + " = " + value_str
                    }
                }
            }

            if (table == 'events_aggregate') {
                query = db.formatSql(`UPDATE ${class_name}.${table} SET ${string} WHERE event_id = $1 and agr_type = $2`);
                params = [event_id, agr_type];
            } else {
                query = db.formatSql(`UPDATE ${class_name}.${table} SET ${string} WHERE event_id = $1`);
                params = [event_id];
            }
        }

        console.log(query, params);

        // Execute query
        const success = await db.ExecuteCommand(query, params);
        const action = existingData === null ? 'insert' : 'update';

        if (success) {
            return sendResponse(res, info, 200, true, `${action} successful`, true, false);
        } else {
            return sendResponse(res, info, 500, false, `${action} failed`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//ADD EVENT ROWS - BATCH
exports.addEventRows = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'addEventRows' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    let query = '';
    try {
        const { class_name, project_id, table, event_id, agr_type, json } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables
        const allowedTables = ['events_aggregate', 'events_cloud', 'maneuver_stats'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, 'Table not allowed for updates', null, true);
        }

        // Restrict updates to exclude certain columns
        const excludedColumns = ['event_id', 'agr_type'];

        // Check if data exists
        let selectSQL, paramsSQL;
        if (table == 'events_aggregate') {
            selectSQL = `SELECT event_id "value" FROM ${class_name}.${table} WHERE event_id = $1 and agr_type = $2`;
            paramsSQL = [event_id, agr_type]
        } else if (table == 'maneuver_stats') {
            selectSQL = `SELECT event_id "value" FROM ${class_name}.${table} WHERE event_id = $1`;
            paramsSQL = [event_id]
        } else {
            selectSQL = `SELECT null "value"`;
            paramsSQL = []
        }

        const existingData = await db.GetValue(selectSQL, paramsSQL);

        let json_obj = JSON.parse(json)
        let jsonrows = json_obj["rows"]

        // let query = '';
        if (existingData === null) {
            for (i in jsonrows) {
                var row = jsonrows[i];

                var keys = undefined
                var values = undefined
                for (var key in row) {
                    if (!excludedColumns.includes(key)) {
                        var value = row[key]

                        if (keys === undefined) {
                            keys = '@#' + key + '@#'
                            values = "'" + value + "'"
                        } else {
                            keys += ', @#' + key + '@#'
                            values += ", '" + value + "'"
                        }
                    }
                }

                if (table == 'events_aggregate') {
                    query += db.formatSql(`INSERT INTO ${class_name}.${table} (event_id, agr_type, ${keys}) VALUES (${event_id},${agr_type},${values}); `)
                } else {
                    query += db.formatSql(`INSERT INTO ${class_name}.${table} (event_id, ${keys}) VALUES (${event_id},${values}); `)
                }
            }
        } else {
            for (i in jsonrows) {
                var row = jsonrows[i];

                var keys = undefined
                var values = undefined
                for (var key in row) {
                    if (!excludedColumns.includes(key)) {
                        var value = row[key]

                        key_str = '@#' + key + '@#'
                        value_str = "'" + value + "'"

                        if (string === undefined) {
                            string = key_str + " = " + value_str
                        } else {
                            string += ", " + key_str + " = " + value_str
                        }
                    }
                }

                if (table == 'events_aggregate') {
                    query += db.formatSql(`UPDATE ${class_name}.${table} SET ${string} WHERE event_id = ${event_id} and agr_type = '${agr_type}'; `);
                } else if (table == 'maneuver_stats') {
                    query += db.formatSql(`UPDATE ${class_name}.${table} SET ${string} WHERE event_id = ${event_id}; `);
                } else {
                    query = ''
                }
            }
        }

        // Execute query
        if (query.length > 0) {
            const success = await db.ExecuteCommand(query, []);
            const action = existingData === null ? 'insert' : 'update';

            if (success) {
                return sendResponse(res, info, 200, true, `${action} successful`, false);
            } else {
                logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', 'events', 'error', `${action} failed - Query: ${query}`, { query, action });
                return sendResponse(res, info, 500, false, `${action} failed`, null, true);
            }
        } else {
            return sendResponse(res, info, 500, false, `${action} failed: Cannot batch update cloud..`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//UPDATE EVENT ROW
exports.updateEventRow = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'updateEventRow' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, table, event_id, agr_type, column, value } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables
        const allowedTables = ['events_aggregate', 'events_cloud', 'maneuver_stats'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, 'Table not allowed for updates', null, true);
        }

        // Restrict updates to exclude certain columns
        const excludedColumns = ['event_id', 'agr_type'];
        if (excludedColumns.includes(column)) {
            return sendResponse(res, info, 400, false, 'Column not allowed for updates', null, true);
        }

        let query;
        let params;

        if (table == 'events_aggregate') {
            query = db.formatSql(`UPDATE ${class_name}.${table} SET @#${column}@# = ${value} WHERE event_id = $1 AND agr_type = $2`);
            params = [event_id, agr_type];
        } else {
            query = db.formatSql(`UPDATE ${class_name}.${table} SET @#${column}@# = ${value} WHERE event_id = $1`);
            params = [event_id];
        }

        // Execute query
        const success = await db.ExecuteCommand(query, params);

        if (success) {
            return sendResponse(res, info, 200, true, `Update successful`, true, false);
        } else {
            return sendResponse(res, info, 500, false, `Update failed`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//UPDATE EVENT ROW - BATCH
exports.updateEventRows = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'updateEventRows' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, table, event_id, agr_type, json } = req.body;

        // Check user permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables
        const allowedTables = ['events_aggregate', 'events_cloud', 'maneuver_stats'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, `Table not allowed for updates`, null, true);
        }

        // Restrict updates to exclude certain columns
        const excludedColumns = ['event_id', 'agr_type'];

        if (!jsonrows || jsonrows.length === 0) {
            return sendResponse(res, info, 400, false, "No rows provided for update", null, true);
        }

        let json_obj = JSON.parse(json)
        let jsonrows = json_obj["rows"]

        let query = '';
        for (i in jsonrows) {
            var row = jsonrows[i];

            for (var key in row) {
                if (!excludedColumns.includes(key)) {
                    var value = row[key]

                    key_str = '@#' + key + '@#'
                    value_str = "'" + value + "'"

                    if (string === undefined) {
                        string = key_str + " = " + value_str
                    } else {
                        string += ", " + key_str + " = " + value_str
                    }
                }
            }

            if (table == 'events_aggregate') {
                query += db.formatSql(`UPDATE ${class_name}.${table} SET ${string} WHERE event_id = ${event_id} and agr_type = '${agr_type}'; `);
            } else {
                query += db.formatSql(`UPDATE ${class_name}.${table} SET ${string} WHERE event_id = ${event_id}; `);
            }
        }

        // Execute query
        const success = await db.ExecuteCommand(query, []);

        if (success) {
            return sendResponse(res, info, 200, true, `Update successful`, false);
        } else {
            return sendResponse(res, info, 500, false, `Update failed`, null, true);
        }
    } catch (error) {
        //res, info, status, success, message, data, log
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.removeEvents = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'removeEvents' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, events } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            const sql = `DELETE FROM ${class_name}.dataset_events WHERE event_id = ANY($1::int[])`;
            const params = [events];

            let result = await db.ExecuteCommand(sql, params);

            if (result) {
                return sendResponse(res, info, 200, true, "Events removed successfully!", true, false);
            } else {
                return sendResponse(res, info, 204, false, "Events not removed", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.removeEventRows = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'removeEventRows' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { class_name, project_id, event_id, table } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 400, false, 'Unauthorized', null, true);
        }

        // Restrict table updates to specified tables
        const allowedTables = ['events_aggregate', 'events_cloud', 'maneuver_stats'];
        if (!allowedTables.includes(table)) {
            return sendResponse(res, info, 400, false, 'Table not allowed for updates', null, true);
        }

        // Execute delete query
        const sql = `DELETE FROM ${class_name}.${table} WHERE event_id = $1`;
        const success = await db.ExecuteCommand(sql, [event_id]);

        if (success) {
            return sendResponse(res, info, 200, true, `Delete successful`, true, false);
        } else {
            return sendResponse(res, info, 500, false, `Delete failed`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.removeEventsByType = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'removeEventsByType' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, event_types } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            const sql = `DELETE FROM ${class_name}.dataset_events WHERE dataset_id = $1 and event_type = ANY($2::text[])`;
            const params = [dataset_id, event_types];

            let result = await db.ExecuteCommand(sql, params);

            if (result) {
                return sendResponse(res, info, 200, true, "Events removed successfully!", true, false);
            } else {
                return sendResponse(res, info, 204, false, "Events not removed", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//UPDATE MANEUVER LOSS VALUES
exports.updateManeuverLossValues = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'updateManeuverLossValues' }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, event_id, vmg_applied, loss_total_vmg, loss_inv_vmg, loss_turn_vmg, loss_build_vmg } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Update maneuver_stats table with loss values
        const sql = `UPDATE ${class_name}.maneuver_stats 
                     SET "Vmg_applied" = $1, 
                         "Loss_total_vmg" = $2, 
                         "Loss_inv_vmg" = $3, 
                         "Loss_turn_vmg" = $4, 
                         "Loss_build_vmg" = $5
                     WHERE event_id = $6`;

        const params = [vmg_applied, loss_total_vmg, loss_inv_vmg, loss_turn_vmg, loss_build_vmg, event_id];

        const success = await db.ExecuteCommand(sql, params);

        if (success) {
            return sendResponse(res, info, 200, true, 'Maneuver loss values updated successfully', true, false);
        } else {
            return sendResponse(res, info, 500, false, 'Failed to update maneuver loss values', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};
