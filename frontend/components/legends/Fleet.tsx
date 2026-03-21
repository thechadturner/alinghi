import { createEffect, createSignal, onMount } from "solid-js";
import * as d3 from "d3";
import { debug as logDebug, error as logError } from "../../utils/console";

interface FleetLegendProps {
    elementId: string;
    target_info: { name?: string };
    groups: Array<{ name: string; color: string }>;
    click?: (note: string) => void;
    colorScale?: any;
    onTargetClick?: () => void;
    color?: string;
    /** Optional filter summary (e.g. Active Filters) rendered in the same div as the legend */
    filterSummary?: JSX.Element;
}

function FleetLegend(props: FleetLegendProps) {
    let chartRef: HTMLDivElement | undefined;
    let svgContainerRef: HTMLDivElement | undefined;
    const [containerWidth, setContainerWidth] = createSignal(800);

    onMount(() => {
        const el = svgContainerRef;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect?.width;
            if (typeof w === "number" && w > 0) setContainerWidth(w);
        });
        ro.observe(el);
        const initial = el.getBoundingClientRect().width;
        if (initial > 0) setContainerWidth(initial);
        return () => ro.disconnect();
    });

    createEffect(() => {
        // Access props directly to ensure Solid.js tracks changes properly
        // Don't destructure at the top level - access props directly
        const elementId = props.elementId;
        const target_info = props.target_info;
        const groups = props.groups;
        const click = props.click;
        const colorScale = props.colorScale;
        const onTargetClick = props.onTargetClick;
        const color = props.color;

        // Explicitly track groups and color to ensure effect re-runs when they change
        // Access groups.length to ensure Solid.js tracks changes to the array
        const groupsArray = Array.isArray(groups) ? groups : [];
        const currentColor = color || 'SOURCE_NAME';
        
        // Force tracking by accessing array elements
        if (groupsArray.length > 0) {
            groupsArray.forEach(g => g.name); // Access to ensure tracking
        }

        // Track target_info changes explicitly - access both the object and the name property
        // Access .name to ensure Solid.js tracks changes to this property
        const currentTargetName = target_info?.name || "No Targets";

        // Use container width for responsive legend; fallback for SSR/first paint
        const rawWidth = containerWidth();
        const legendWidth = Math.max(280, Math.min(1500, rawWidth));
        const sourcesPerRow = legendWidth < 500 ? 4 : legendWidth < 800 ? 6 : 8;
        const itemSpacing = legendWidth < 500 ? 30 : legendWidth < 800 ? 50 : 80;

        // Calculate number of rows needed for sources (8 per row)
        // Deduplicate groups for row calculation (same logic as rendering)
        const uniqueGroupsForRowsMap = new Map<string, { name: string; color: string }>();
        if (groupsArray && groupsArray.length > 0) {
            groupsArray.forEach(group => {
                if (group && group.name) {
                    const groupName = String(group.name).toLowerCase();
                    // Skip 'Unknown' and empty names
                    if (groupName === 'unknown' || groupName.trim() === '') {
                        return;
                    }
                    if (!uniqueGroupsForRowsMap.has(groupName)) {
                        uniqueGroupsForRowsMap.set(groupName, { 
                            name: String(group.name), 
                            color: group.color || 'lightgrey'
                        });
                    }
                }
            });
        }
        let groupsForRows = Array.from(uniqueGroupsForRowsMap.values());
        
        // Calculate total groups count
        const totalGroupsCount = groupsForRows.length;

        // Determine layout mode: single row if < 5 groups and fits width, else multi-row
        let useSingleRow = totalGroupsCount < 5;

        // Calculate legend height based on layout mode
        let legendHeight = 70; // Base height for row 1 (target)
        if (useSingleRow) {
            // Single row: target and groups all on one row
            legendHeight = 70;
        } else {
            // Multi-row: target on row 1, groups on subsequent rows
            const numSourceRows = groupsForRows.length > 0 ? Math.ceil(groupsForRows.length / sourcesPerRow) : 0;
            if (numSourceRows > 0) {
                // First row at 65px, subsequent rows at 45px spacing
                legendHeight += 10 + (numSourceRows - 1) * 45;
            }
        }

        // Remove existing SVG before re-rendering
        d3.select(`#${elementId}`).selectAll("svg").remove();

        const legend = d3.select(`#${elementId}`)
            .append("svg")
            .attr("width", legendWidth)
            .attr("height", legendHeight)
            .append("g")
            .attr("transform", "translate(0, 0)");

        // Calculate dimensions for target item
        const targetLineWidth = 50; // Line from x1 to x2
        const targetTextWidth = (currentTargetName.length || 0) * 7 + 25; // Approximate text width + spacing
        const targetTotalWidth = targetLineWidth + targetTextWidth;

        let targetLineX1: number, targetLineX2: number, targetTextX: number;
        let groupsStartX: number;
        let singleRowGroupItemWidths: Array<{ displayNote: string; itemWidth: number }> = [];

        if (useSingleRow) {
            // SINGLE ROW LAYOUT: Calculate total width for all items
            let totalWidth = targetTotalWidth;

            if (groupsForRows.length > 0) {
                groupsForRows.forEach(group => {
                    const displayNote = String(group.name || '');
                    const displayNoteFinal = (displayNote === '0' || displayNote === undefined || displayNote === '') ? 'NONE' : displayNote;
                    const circleWidth = 10; // 2 * radius
                    const spacingBetween = 20; // Space between circle and text
                    const textWidth = displayNoteFinal.length * 7; // Approximate 7px per character
                    const itemWidth = circleWidth + spacingBetween + textWidth;
                    singleRowGroupItemWidths.push({ displayNote: displayNoteFinal, itemWidth });
                    
                    totalWidth += itemSpacing; // Add spacing between items
                    totalWidth += itemWidth;
                });
            }

            // If single row would overflow, use multi-row instead and set multi-row positions
            if (totalWidth > legendWidth) {
                useSingleRow = false;
                const row1TotalWidth = targetTotalWidth;
                const row1StartX = (legendWidth - row1TotalWidth) / 2;
                targetLineX1 = row1StartX;
                targetLineX2 = row1StartX + targetLineWidth;
                targetTextX = row1StartX + targetLineWidth + 25;
                groupsStartX = 0;
            } else {
                const singleRowStartX = (legendWidth - totalWidth) / 2;
                targetLineX1 = singleRowStartX;
                targetLineX2 = singleRowStartX + targetLineWidth;
                targetTextX = singleRowStartX + targetLineWidth + 25;
                groupsStartX = groupsForRows.length > 0 ? singleRowStartX + targetTotalWidth + itemSpacing : 0;
            }
        } else {
            // MULTI-ROW LAYOUT: Center target on first row
            const row1TotalWidth = targetTotalWidth;
            const row1StartX = (legendWidth - row1TotalWidth) / 2;

            // Position target
            targetLineX1 = row1StartX;
            targetLineX2 = row1StartX + targetLineWidth;
            targetTextX = row1StartX + targetLineWidth + 25;

            // Groups will be positioned separately in multi-row layout
            groupsStartX = 0; // Not used in multi-row
        }

        // TARGET

        const targetLine = legend.append("line")
            // Move target row down by 10px
            .attr("x1", targetLineX1).attr("y1", 31)
            .attr("x2", targetLineX2).attr("y2", 31)
            .attr("class", "tgt");

        const targetText = legend.append("text")
            .attr("text-anchor", "left")
            // Move text down by 10px
            .attr("transform", `translate(${targetTextX},35)`)
            .attr("font-size", "12px")
            .attr("class", "legend-text")
            .text(currentTargetName.replace(/_target$/i, ''));

        // Make target clickable if onTargetClick callback is provided
        // Capture onTargetClick inside the effect to get the latest value
        const currentOnTargetClick = onTargetClick;
        if (currentOnTargetClick && typeof currentOnTargetClick === 'function') {
            logDebug('FleetLegend: Setting up target click handlers', { hasOnTargetClick: !!currentOnTargetClick });
            targetLine
                .style("cursor", "pointer")
                .style("pointer-events", "all")
                .on("click", function (event) {
                    event.stopPropagation();
                    event.preventDefault();
                    logDebug('FleetLegend: Target line clicked, calling handler');
                    try {
                        currentOnTargetClick();
                    } catch (error) {
                        logError('FleetLegend: Error calling onTargetClick', error);
                    }
                });
            targetText
                .style("cursor", "pointer")
                .style("pointer-events", "all")
                .on("click", function (event) {
                    event.stopPropagation();
                    event.preventDefault();
                    logDebug('FleetLegend: Target text clicked, calling handler');
                    try {
                        currentOnTargetClick();
                    } catch (error) {
                        logError('FleetLegend: Error calling onTargetClick', error);
                    }
                });
        } else {
            logDebug('FleetLegend: No onTargetClick handler provided', { onTargetClick: typeof currentOnTargetClick, value: currentOnTargetClick });
        }

        // ROWS 2+: SOURCES (8 per row)
        // Deduplicate groups by name to ensure proper grouping
        // Filter out 'Unknown' and invalid group names
        const uniqueGroupsMap = new Map<string, { name: string; color: string }>();
        if (groupsArray && groupsArray.length > 0) {
            groupsArray.forEach(group => {
                if (group && group.name) {
                    const groupName = String(group.name).toLowerCase();
                    // Skip 'Unknown' and empty names
                    if (groupName === 'unknown' || groupName.trim() === '') {
                        return;
                    }
                    // Only add if not already present (first occurrence wins)
                    if (!uniqueGroupsMap.has(groupName)) {
                        uniqueGroupsMap.set(groupName, { 
                            name: String(group.name), 
                            color: group.color || 'lightgrey'
                        });
                    }
                }
            });
        }
        
        // Convert map back to array
        let groupsWithHighlights = Array.from(uniqueGroupsMap.values());

        if (groupsWithHighlights.length > 0) {
            if (useSingleRow && groupsForRows.length > 0) {
                // SINGLE ROW LAYOUT: Render groups after target
                // Use groupsForRows for rendering to match the width calculation
                let currentX = groupsStartX;

                groupsForRows.forEach((group, itemIndex) => {
                    const note = String(group.name || '');
                    const noteLower = note.toLowerCase();
                    const isAll = noteLower === 'all';
                    const itemInfo = singleRowGroupItemWidths[itemIndex];

                    if (!itemInfo) {
                        logError('FleetLegend: Missing itemInfo for item', { itemIndex, displayNote: note });
                        return;
                    }

                    // Determine color - prioritize group.color (especially for grades), otherwise use colorScale
                    // Special handling: TRAINING should always be light grey
                    let color = 'lightgrey';
                    if (note === 'TRAINING' || note === '-1') {
                        color = 'lightgrey';
                    } else if (isAll) {
                        color = 'lightgrey'; // 'ALL' gets lightgrey
                    } else if (group.color) {
                        // Always use group.color if it's set (for grades: 'green', 'yellow', etc.)
                        // Only skip if it's a known default/fallback value
                        if (group.color !== 'lightgrey' && group.color !== '#1f77b4') {
                            color = group.color;
                        } else if (currentColor === 'GRADE') {
                            // For grades, even if color is default, use it (grades have explicit colors)
                            color = group.color;
                        } else if (!isAll && note !== '0' && note !== undefined && note !== '') {
                            // For non-grade colors, fallback to colorScale if group.color is default
                            const scale = colorScale;
                            const fallbackColorScale = d3.scaleOrdinal(d3.schemeCategory10);
                            if (scale && typeof scale === 'function') {
                                try {
                                    color = scale(noteLower);
                                } catch (err) {
                                    logError(`FleetLegend: Error calling scale for ${noteLower}`, err);
                                    const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                    const unique = Array.from(new Set(namesLower)).sort();
                                    fallbackColorScale.domain(unique);
                                    color = fallbackColorScale(noteLower);
                                }
                            } else {
                                const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                const unique = Array.from(new Set(namesLower)).sort();
                                fallbackColorScale.domain(unique);
                                color = fallbackColorScale(noteLower);
                            }
                        }
                    } else if (!isAll && note !== '0' && note !== undefined && note !== '') {
                        // Fallback to colorScale if group.color is not set
                        const scale = colorScale;
                        const fallbackColorScale = d3.scaleOrdinal(d3.schemeCategory10);
                        if (scale && typeof scale === 'function') {
                            try {
                                color = scale(noteLower);
                            } catch (err) {
                                logError(`FleetLegend: Error calling scale for ${noteLower}`, err);
                                const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                const unique = Array.from(new Set(namesLower)).sort();
                                fallbackColorScale.domain(unique);
                                color = fallbackColorScale(noteLower);
                            }
                        } else {
                            const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                            const unique = Array.from(new Set(namesLower)).sort();
                            fallbackColorScale.domain(unique);
                            color = fallbackColorScale(noteLower);
                        }
                    }

                    const displayNote = (note === '0' || note === undefined || note === '') ? 'NONE' : note;
                    const circleX = currentX + 5; // Center of circle (radius is 5)
                    const textX = currentX + 10 + 20; // After circle + spacing

                    // Draw symbol (always circles for sources, not squares)
                    const circle = legend.append("circle")
                        .datum(displayNote)
                        .attr("cx", circleX)
                        .attr("cy", 30)
                        .attr("r", 5)
                        .attr("class", "legend-circle")
                        .style("fill", color);
                    
                    // Add black outline/stroke for 'ALL'
                    if (isAll) {
                        circle.style("stroke", "black")
                            .style("stroke-width", "2px");
                    }
                    
                    if (click) {
                        circle.style("cursor", "pointer")
                            .style("pointer-events", "all")
                            .on("click", function (event) {
                                event.stopPropagation();
                                event.preventDefault();
                                logDebug('FleetLegend: Circle clicked (single row)', { displayNote, note });
                                try {
                                    click(displayNote);
                                } catch (error: any) {
                                    logError('FleetLegend: Error calling click handler', error);
                                }
                            });
                    }

                    // Draw text
                    const text = legend.append("text")
                        .datum(displayNote)
                        .attr("text-anchor", "left")
                        .attr("transform", `translate(${textX},36)`)
                        .attr("font-size", "12px")
                        .attr("class", "legend-text")
                        .text(displayNote);
                    if (click) {
                        text.style("cursor", "pointer")
                            .style("pointer-events", "all")
                            .on("click", function (event) {
                                event.stopPropagation();
                                event.preventDefault();
                                logDebug('FleetLegend: Text clicked (single row)', { displayNote, note });
                                try {
                                    click(displayNote);
                                } catch (error: any) {
                                    logError('FleetLegend: Error calling click handler', error);
                                }
                            });
                    }

                    currentX += itemInfo.itemWidth;
                    if (itemIndex < groupsForRows.length - 1) {
                        currentX += itemSpacing;
                    }
                });
            } else {
                // MULTI-ROW LAYOUT: target on row 1, groups on subsequent rows
                // Use color scale from props, fallback to d3 scheme if not provided
                const scale = colorScale;
                const fallbackColorScale = d3.scaleOrdinal(d3.schemeCategory10);

                // Recalculate numSourceRows with highlights included (uses sourcesPerRow from outer scope)
                const numSourceRowsWithHighlights = groupsWithHighlights.length > 0 ? Math.ceil(groupsWithHighlights.length / sourcesPerRow) : 0;

                // Process sources into rows
                for (let rowIndex = 0; rowIndex < numSourceRowsWithHighlights; rowIndex++) {
                    const rowSources = groupsWithHighlights.slice(rowIndex * sourcesPerRow, (rowIndex + 1) * sourcesPerRow);

                    // Calculate total width needed for this row (more accurate calculation)
                    let totalWidth = 0;
                    const itemWidths: Array<{ displayNote: string; itemWidth: number }> = [];

                    rowSources.forEach(group => {
                        const displayNote = String(group.name || '');
                        const displayNoteFinal = (displayNote === '0' || displayNote === undefined || displayNote === '') ? 'NONE' : displayNote;
                        const circleWidth = 10; // 2 * radius
                        const spacingBetween = 20; // Space between circle and text
                        const textWidth = displayNoteFinal.length * 7; // Approximate 7px per character

                        const itemWidth = circleWidth + spacingBetween + textWidth;
                        itemWidths.push({ displayNote: displayNoteFinal, itemWidth });

                        if (totalWidth > 0) {
                            totalWidth += itemSpacing; // Add spacing between items
                        }
                        totalWidth += itemWidth;
                    });

                    // Center the row by calculating start position
                    const startX = (legendWidth - totalWidth) / 2;
                    let currentX = startX;

                    // Y position for this row (row 1 is at y≈30, source rows start at 65 with 45px spacing between rows)
                    // Added 10px more spacing: first row at 65, second row at 110 (45px spacing instead of 35px)
                    const rowY = 65 + (rowIndex * 45);

                    rowSources.forEach((group, itemIndex) => {
                        const note = String(group.name || '');
                        const noteLower = note.toLowerCase();
                        const isAll = noteLower === 'all';

                        // Determine color - prioritize group.color (especially for grades), otherwise use colorScale
                        // TRAINING must match scatter (light grey) - avoid scale lookup which can return blue
                        let color = 'lightgrey';
                        if (note === 'TRAINING' || note === '-1') {
                            color = 'lightgrey';
                        } else if (isAll) {
                            color = 'lightgrey'; // 'ALL' gets lightgrey
                        } else if (group.color) {
                            // Always use group.color if it's set (for grades: 'green', 'yellow', etc.)
                            // Only skip if it's a known default/fallback value
                            if (group.color !== 'lightgrey' && group.color !== '#1f77b4') {
                                color = group.color;
                            } else if (currentColor === 'GRADE') {
                                // For grades, even if color is default, use it (grades have explicit colors)
                                color = group.color;
                            } else if (!isAll && note !== '0' && note !== undefined && note !== '') {
                                // For non-grade colors, fallback to colorScale if group.color is default
                                // Check if scale exists AND is a function before calling it
                                if (scale && typeof scale === 'function') {
                                    try {
                                        // Use fleet color scale from database - normalize to lowercase for lookup
                                        // (Color scale normalizes internally, but normalize here for consistency)
                                        color = scale(noteLower);
                                        // Avoid noisy logs; rely on debug if needed
                                    } catch (err) {
                                        logError(`FleetLegend: Error calling scale for ${noteLower}`, err);
                                        // Fallback on error
                                        const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                        const unique = Array.from(new Set(namesLower)).sort();
                                        fallbackColorScale.domain(unique);
                                        color = fallbackColorScale(noteLower);
                                    }
                                } else {
                                    // Scale not ready yet; use fallback without warning
                                    // Fallback to d3 scheme while loading
                                    const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                    const unique = Array.from(new Set(namesLower)).sort();
                                    fallbackColorScale.domain(unique);
                                    color = fallbackColorScale(noteLower);
                                }
                            }
                        } else if (!isAll && note !== '0' && note !== undefined && note !== '') {
                            // Fallback to colorScale if group.color is not set
                            // Check if scale exists AND is a function before calling it
                            if (scale && typeof scale === 'function') {
                                try {
                                    // Use fleet color scale from database - normalize to lowercase for lookup
                                    // (Color scale normalizes internally, but normalize here for consistency)
                                    color = scale(noteLower);
                                    // Avoid noisy logs; rely on debug if needed
                                } catch (err) {
                                    logError(`FleetLegend: Error calling scale for ${noteLower}`, err);
                                    // Fallback on error
                                    const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                    const unique = Array.from(new Set(namesLower)).sort();
                                    fallbackColorScale.domain(unique);
                                    color = fallbackColorScale(noteLower);
                                }
                            } else {
                                // Scale not ready yet; use fallback without warning
                                // Fallback to d3 scheme while loading
                                const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                const unique = Array.from(new Set(namesLower)).sort();
                                fallbackColorScale.domain(unique);
                                color = fallbackColorScale(noteLower);
                            }
                        }

                        const displayNote = (note === '0' || note === undefined || note === '') ? 'NONE' : note;
                        const itemInfo = itemWidths[itemIndex];

                        // Validate itemInfo exists
                        if (!itemInfo) {
                            logError('FleetLegend: Missing itemInfo for item', { itemIndex, displayNote, itemWidthsLength: itemWidths.length });
                            return;
                        }

                        const circleX = currentX + 5; // Center of circle (radius is 5)
                        const textX = currentX + 10 + 20; // After circle + spacing

                        // Draw symbol (always circles for sources, not squares)
                        const circle = legend.append("circle")
                            .datum(displayNote)
                            .attr("cx", circleX)
                            .attr("cy", rowY)
                            .attr("r", 5)
                            .attr("class", "legend-circle")
                            .style("fill", color);
                        
                        // Add black outline/stroke for 'ALL'
                        if (isAll) {
                            circle.style("stroke", "black")
                                .style("stroke-width", "2px");
                        }
                        
                        if (click) {
                            circle.style("cursor", "pointer")
                                .style("pointer-events", "all")
                                .on("click", function (event) {
                                    event.stopPropagation();
                                    event.preventDefault();
                                    logDebug('FleetLegend: Circle clicked (multi-row)', { displayNote, note });
                                    try {
                                        click(displayNote);
                                    } catch (error: any) {
                                        logError('FleetLegend: Error calling click handler', error);
                                    }
                                });
                        }

                        // Draw text
                        const text = legend.append("text")
                            .datum(displayNote)
                            .attr("text-anchor", "left")
                            .attr("transform", `translate(${textX},${rowY + 6})`)
                            .attr("font-size", "12px")
                            .attr("class", "legend-text")
                            .text(displayNote);
                        if (click) {
                            text.style("cursor", "pointer")
                                .style("pointer-events", "all")
                                .on("click", function (event) {
                                    event.stopPropagation();
                                    event.preventDefault();
                                    logDebug('FleetLegend: Text clicked (multi-row)', { displayNote, note });
                                    try {
                                        click(displayNote);
                                    } catch (error: any) {
                                        logError('FleetLegend: Error calling click handler', error);
                                    }
                                });
                        }

                        // Move to next position: add item width, then add spacing if not last item
                        currentX += itemInfo.itemWidth;
                        if (itemIndex < rowSources.length - 1) {
                            currentX += itemSpacing; // Add spacing between items
                        }
                    });
                }
            }
        }
    });

    return (
        <div class="legend legend-with-filter" ref={(el) => { chartRef = el }}>
            {props.filterSummary}
            <div id={props.elementId} ref={(el) => { svgContainerRef = el }} class="legend-svg-container" />
        </div>
    );
}


export default FleetLegend;
