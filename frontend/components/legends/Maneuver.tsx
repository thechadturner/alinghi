import { createEffect } from "solid-js";
import * as d3 from "d3";
import { error as logError } from "../../utils/console";

interface ManeuverLegendProps {
    elementId: string;
    target_info: { name?: string };
    cloudType?: string;
    groups: Array<{ name: string; color: string; isHighlight?: boolean }>;
    click?: (note: string) => void;
    colorScale?: any;
    highlights?: string[];
    onTargetClick?: () => void;
    color?: string;
}

function ManeuverLegend(props: ManeuverLegendProps) {
    let chartRef: HTMLDivElement | undefined;

    createEffect(() => {
        // Access props directly to ensure Solid.js tracks changes properly
        // Don't destructure at the top level - access props directly
        const elementId = props.elementId;
        const groups = props.groups;
        const click = props.click;
        const colorScale = props.colorScale;
        const color = props.color;

        // Explicitly track groups and color to ensure effect re-runs when they change
        // Access groups.length to ensure Solid.js tracks changes to the array
        const groupsArray = Array.isArray(groups) ? groups : [];
        const currentColor = (color || 'TWS').toUpperCase();
        
        // Force tracking by accessing array elements
        if (groupsArray.length > 0) {
            groupsArray.forEach(g => g.name); // Access to ensure tracking
        }


        const legendWidth = (chartRef?.clientWidth ?? 1000) - 100;

        // Calculate number of rows needed for sources (8 per row)
        // Deduplicate groups for row calculation (same logic as rendering)
        const uniqueGroupsForRowsMap = new Map<string, { name: string; color: string; isHighlight?: boolean }>();
        // Fixed TWS bins for legend: 15, 20, 25, 30, 35, 40, 45, 50 (excluding 10)
        const fixedTWSBinsForRows = [15, 20, 25, 30, 35, 40, 45, 50];
        
        if (groupsArray && groupsArray.length > 0) {
            groupsArray.forEach(group => {
                if (group && group.name) {
                    const groupName = String(group.name).toLowerCase();
                    // Skip 'Unknown' and empty names
                    if (groupName === 'unknown' || groupName.trim() === '') {
                        return;
                    }
                    // For TWS, only keep bins in the fixed list (15-50)
                    if (currentColor === 'TWS') {
                        const twsNum = Number(groupName);
                        if (isNaN(twsNum) || !fixedTWSBinsForRows.includes(twsNum)) {
                            return; // Skip TWS bins not in fixed list
                        }
                    }
                    if (!uniqueGroupsForRowsMap.has(groupName)) {
                        uniqueGroupsForRowsMap.set(groupName, { 
                            name: String(group.name), 
                            color: group.color || 'lightgrey',
                            isHighlight: group.isHighlight || false
                        });
                    }
                }
            });
        }
        let groupsForRows = Array.from(uniqueGroupsForRowsMap.values());
        
        // For TWS, always show all fixed bins (15-50) regardless of data presence
        if (currentColor === 'TWS') {
            // Create entries for all fixed TWS bins
            // Always get color from colorScale to match plot colors
            const allTWSBinsForRows = fixedTWSBinsForRows.map(bin => {
                const binStr = String(bin);
                const binLower = binStr.toLowerCase();
                // Check if this bin exists in the data (for isHighlight flag)
                const existingGroup = groupsForRows.find(g => 
                    String(g.name).toLowerCase() === binLower
                );
                // Always get color from colorScale to ensure it matches the plot
                let binColor = 'lightgrey';
                if (colorScale && typeof colorScale === 'function') {
                    try {
                        binColor = colorScale(bin);
                    } catch (err) {
                        // Fallback to lightgrey if scale fails
                    }
                }
                return {
                    name: binStr,
                    color: binColor,
                    isHighlight: existingGroup?.isHighlight || false
                };
            });
            groupsForRows = allTWSBinsForRows;
        } else {
            // For non-TWS, filter and sort as before
            groupsForRows = groupsForRows
                .filter(group => {
                    const groupName = String(group.name).toLowerCase();
                    return groupName !== 'unknown' && groupName.trim() !== '';
                })
                .sort((a, b) => {
                    const nameA = String(a.name).toLowerCase();
                    const nameB = String(b.name).toLowerCase();
                    return nameA.localeCompare(nameB);
                });
        }
        
        // Calculate total groups count
        const totalGroupsCount = groupsForRows.length;

        // Determine layout mode: single row if < 5 groups, multi-row if >= 5
        const useSingleRow = totalGroupsCount < 5;
        const sourcesPerRow = 8;

        // Calculate legend height based on layout mode (only groups, no target/cloud)
        let legendHeight = 50; // Base height for first row of groups
        if (useSingleRow) {
            // Single row: groups all on one row
            legendHeight = 50;
        } else {
            // Multi-row: groups on multiple rows
            const numSourceRows = groupsForRows.length > 0 ? Math.ceil(groupsForRows.length / sourcesPerRow) : 0;
            if (numSourceRows > 0) {
                // First row at 50px, subsequent rows at 45px spacing
                legendHeight = 50 + (numSourceRows - 1) * 45;
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

        // Spacing between items
        const itemSpacing = 100;

        // ROWS 2+: SOURCES (8 per row)
        // Deduplicate groups by name to ensure proper grouping
        // Filter out 'Unknown' and invalid group names
        const uniqueGroupsMap = new Map<string, { name: string; color: string; isHighlight?: boolean }>();
        // Fixed TWS bins for legend: 15, 20, 25, 30, 35, 40, 45, 50 (excluding 10)
        const fixedTWSBins = [15, 20, 25, 30, 35, 40, 45, 50];
        
        if (groupsArray && groupsArray.length > 0) {
            groupsArray.forEach(group => {
                if (group && group.name) {
                    const groupName = String(group.name).toLowerCase();
                    // Skip 'Unknown' and empty names
                    if (groupName === 'unknown' || groupName.trim() === '') {
                        return;
                    }
                    // For TWS, only keep bins in the fixed list (15-50)
                    if (currentColor === 'TWS') {
                        const twsNum = Number(groupName);
                        if (isNaN(twsNum) || !fixedTWSBins.includes(twsNum)) {
                            return; // Skip TWS bins not in fixed list
                        }
                    }
                    // Only add if not already present (first occurrence wins)
                    if (!uniqueGroupsMap.has(groupName)) {
                        uniqueGroupsMap.set(groupName, { 
                            name: String(group.name), 
                            color: group.color || 'lightgrey',
                            isHighlight: group.isHighlight || false
                        });
                    }
                }
            });
        }
        
        // Convert map back to array
        let groupsWithHighlights = Array.from(uniqueGroupsMap.values());
        
        // For TWS, always show all fixed bins (15-50) regardless of data presence
        if (currentColor === 'TWS') {
            // Create entries for all fixed TWS bins
            // Always get color from colorScale to match plot colors
            const allTWSBins = fixedTWSBins.map(bin => {
                const binStr = String(bin);
                const binLower = binStr.toLowerCase();
                // Check if this bin exists in the data (for isHighlight flag)
                const existingGroup = groupsWithHighlights.find(g => 
                    String(g.name).toLowerCase() === binLower
                );
                // Always get color from colorScale to ensure it matches the plot
                let binColor = 'lightgrey';
                if (colorScale && typeof colorScale === 'function') {
                    try {
                        binColor = colorScale(bin);
                    } catch (err) {
                        // Fallback to lightgrey if scale fails
                    }
                }
                return {
                    name: binStr,
                    color: binColor,
                    isHighlight: existingGroup?.isHighlight || false
                };
            });
            groupsWithHighlights = allTWSBins;
        } else {
            // For non-TWS, filter and sort as before
            groupsWithHighlights = groupsWithHighlights
                .filter(group => {
                    const groupName = String(group.name).toLowerCase();
                    return groupName !== 'unknown' && groupName.trim() !== '';
                })
                .sort((a, b) => {
                    const nameA = String(a.name).toLowerCase();
                    const nameB = String(b.name).toLowerCase();
                    return nameA.localeCompare(nameB);
                });
        }
        

        if (groupsWithHighlights.length > 0) {
            if (useSingleRow && groupsForRows.length > 0) {
                // SINGLE ROW LAYOUT: Render groups centered
                // Calculate total width and center
                let totalWidth = 0;
                groupsForRows.forEach((group, index) => {
                    let displayNote = String(group.name || '');
                    // Format TWS bins as single values (e.g., "10" -> "10", "15" -> "15")
                    if (currentColor === 'TWS' && displayNote !== '0' && displayNote !== undefined && displayNote !== '') {
                        const twsNum = Number(displayNote);
                        if (!isNaN(twsNum) && twsNum >= 10) {
                            displayNote = String(twsNum); // Display as single value (10, 15, 20, etc.)
                        }
                    }
                    const displayNoteFinal = (displayNote === '0' || displayNote === undefined || displayNote === '') ? 'NONE' : displayNote;
                    const circleWidth = 10;
                    const spacingBetween = 20;
                    const textWidth = displayNoteFinal.length * 7;
                    const itemWidth = circleWidth + spacingBetween + textWidth;
                    
                    if (index > 0) {
                        totalWidth += itemSpacing;
                    }
                    totalWidth += itemWidth;
                });
                
                const groupsStartX = (legendWidth - totalWidth) / 2;
                let currentX = groupsStartX;

                groupsForRows.forEach((group, itemIndex) => {
                    const note = String(group.name || '');
                    const noteLower = note.toLowerCase();
                    const isAll = noteLower === 'all';
                    const isHighlight = group.isHighlight || false;

                    // Determine color - use group.color if available, otherwise use colorScale
                    let itemColor = 'lightgrey';
                    if (isHighlight) {
                        itemColor = '#FFD700'; // Yellow for highlights
                    } else if (isAll) {
                        itemColor = 'lightgrey'; // 'ALL' gets lightgrey
                    } else if (group.color && group.color !== 'lightgrey' && group.color !== '#1f77b4') {
                        // Use the color from the groups prop if it's explicitly set (not default)
                        itemColor = group.color;
                    } else if (!isAll && note !== '0' && note !== undefined && note !== '') {
                        // Fallback to colorScale if group.color is not set or is default
                        const scale = colorScale;
                        const fallbackColorScale = d3.scaleOrdinal(d3.schemeCategory10);
                        if (scale && typeof scale === 'function') {
                            try {
                                // For TWS, use the numeric value for color scale lookup
                                const scaleValue = (currentColor === 'TWS' && !isNaN(Number(note))) ? Number(note) : noteLower;
                                itemColor = scale(scaleValue);
                            } catch (err) {
                                logError(`ManeuverLegend: Error calling scale for ${noteLower}`, err);
                                const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                const unique = Array.from(new Set(namesLower)).sort();
                                fallbackColorScale.domain(unique);
                                itemColor = fallbackColorScale(noteLower);
                            }
                        } else {
                            const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                            const unique = Array.from(new Set(namesLower)).sort();
                            fallbackColorScale.domain(unique);
                            itemColor = fallbackColorScale(noteLower);
                        }
                    }

                    // Format TWS bins as single values starting from 15 (e.g., "15" -> "15", "20" -> "20", "25" -> "25")
                    // Keep original note for click handler (filtering needs original value)
                    const originalNote = note;
                    let displayNote = (note === '0' || note === undefined || note === '') ? 'NONE' : note;
                    if (currentColor === 'TWS' && displayNote !== 'NONE' && !isAll) {
                        const twsNum = Number(displayNote);
                        if (!isNaN(twsNum) && twsNum >= 15) {
                            displayNote = String(twsNum); // Display as single value (15, 20, 25, etc.)
                        }
                    }
                    
                    // Calculate item width for positioning
                    const circleWidth = 10;
                    const spacingBetween = 20;
                    const textWidth = displayNote.length * 7;
                    const itemWidth = circleWidth + spacingBetween + textWidth;
                    
                    const circleX = currentX + 5; // Center of circle (radius is 5)
                    const textX = currentX + 10 + 20; // After circle + spacing
                    const symbolCy = 30;
                    // When colored by TACK: Port / P-S = square (red), Stbd / S-P = circle (green)
                    const isTackPort = currentColor === 'TACK' && (noteLower === 'p - s' || noteLower === 'port');

                    // Draw symbol: circle for Stbd/S-P, square for Port/P-S
                    const symbol = isTackPort
                        ? legend.append("rect")
                            .datum(displayNote)
                            .attr("x", circleX - 5)
                            .attr("y", symbolCy - 5)
                            .attr("width", 10)
                            .attr("height", 10)
                            .attr("class", "legend-square")
                            .style("fill", itemColor)
                        : legend.append("circle")
                            .datum(displayNote)
                            .attr("cx", circleX)
                            .attr("cy", symbolCy)
                            .attr("r", 5)
                            .attr("class", "legend-circle")
                            .style("fill", itemColor);
                    if (click) {
                        symbol.style("cursor", "pointer")
                            .style("pointer-events", "all")
                            .on("click", function () { click(originalNote); });
                    }

                    // Add black outline/stroke for 'ALL' or use original color stroke for highlights
                    if (isAll) {
                        symbol.style("stroke", "black")
                            .style("stroke-width", "2px");
                    } else if (isHighlight) {
                        // For highlights, use yellow fill with black stroke
                        symbol.style("fill", "#FFD700")
                            .style("stroke", "black")
                            .style("stroke-width", "1px");
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
                            .on("click", function () { click(originalNote); });
                    }

                    currentX += itemWidth;
                    if (itemIndex < groupsForRows.length - 1) {
                        currentX += itemSpacing;
                    }
                });
            } else {
                // MULTI-ROW LAYOUT: target/cloud on row 1, groups on subsequent rows
                // Add color type label before the grouped points
                // Handle special cases for maneuver color options
                let colorLabel = '';
                if (currentColor === 'SOURCE' || currentColor === 'SOURCE_NAME') {
                    colorLabel = 'SOURCES';
                } else if (currentColor === 'TWS') {
                    colorLabel = 'TWS BINS';
                } else if (currentColor === 'VMG') {
                    colorLabel = 'VMG INTERVALS';
                } else if (currentColor === 'TACK') {
                    colorLabel = 'TACKS';
                } else if (currentColor === 'MAINSAIL') {
                    colorLabel = 'MAINSAILS';
                } else if (currentColor === 'HEADSAIL') {
                    colorLabel = 'HEADSAILS';
                } else if (currentColor === 'RACE') {
                    colorLabel = 'RACES';
                } else {
                    colorLabel = currentColor + 'S';
                }
                
                // Calculate position for label (centered above first row of groups)
                const labelY = 20; // Position above first group row
                legend.append("text")
                    .attr("text-anchor", "middle")
                    .attr("transform", `translate(${legendWidth / 2},${labelY})`)
                    .attr("font-size", "12px")
                    .attr("class", "legend-text")
                    .text(colorLabel);
                // Use color scale from props, fallback to d3 scheme if not provided
                const scale = colorScale;
                const fallbackColorScale = d3.scaleOrdinal(d3.schemeCategory10);

                const sourcesPerRow = 8;

                // Recalculate numSourceRows with highlights included
                const numSourceRowsWithHighlights = groupsWithHighlights.length > 0 ? Math.ceil(groupsWithHighlights.length / sourcesPerRow) : 0;

                // Process sources into rows
                for (let rowIndex = 0; rowIndex < numSourceRowsWithHighlights; rowIndex++) {
                    const rowSources = groupsWithHighlights.slice(rowIndex * sourcesPerRow, (rowIndex + 1) * sourcesPerRow);

                    // Calculate total width needed for this row (more accurate calculation)
                    let totalWidth = 0;
                    const itemWidths: Array<{ displayNote: string; itemWidth: number }> = [];
                    const itemSpacing = 100; // Space between items

                    rowSources.forEach(group => {
                        let displayNote = String(group.name || '');
                        // Format TWS bins as intervals of 5 (e.g., "0" -> "0-5", "5" -> "5-10", "10" -> "10-15")
                        if (currentColor === 'TWS' && displayNote !== '0' && displayNote !== undefined && displayNote !== '') {
                            const twsNum = Number(displayNote);
                            if (!isNaN(twsNum)) {
                                displayNote = `${twsNum}-${twsNum + 5}`;
                            }
                        }
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

                    // Y position for this row (first row at 35, subsequent rows at 45px spacing)
                    const rowY = 35 + (rowIndex * 45);

                    rowSources.forEach((group, itemIndex) => {
                        const note = String(group.name || '');
                        const noteLower = note.toLowerCase();
                        const isAll = noteLower === 'all';
                        const isHighlight = group.isHighlight || false;

                        // Determine color - use group.color if available, otherwise use colorScale
                        let itemColor = 'lightgrey';
                        if (isHighlight) {
                            itemColor = '#FFD700'; // Yellow for highlights
                        } else if (isAll) {
                            itemColor = 'lightgrey'; // 'ALL' gets lightgrey
                        } else if (group.color && group.color !== 'lightgrey' && group.color !== '#1f77b4') {
                            // Use the color from the groups prop if it's explicitly set (not default)
                            itemColor = group.color;
                        } else if (!isAll && note !== '0' && note !== undefined && note !== '') {
                            // Fallback to colorScale if group.color is not set or is default
                            // Check if scale exists AND is a function before calling it
                            if (scale && typeof scale === 'function') {
                                try {
                                    // For TWS, use the numeric value for color scale lookup
                                    const scaleValue = (currentColor === 'TWS' && !isNaN(Number(note))) ? Number(note) : noteLower;
                                    itemColor = scale(scaleValue);
                                    // Avoid noisy logs; rely on debug if needed
                                } catch (err) {
                                    logError(`ManeuverLegend: Error calling scale for ${noteLower}`, err);
                                    // Fallback on error
                                    const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                    const unique = Array.from(new Set(namesLower)).sort();
                                    fallbackColorScale.domain(unique);
                                    itemColor = fallbackColorScale(noteLower);
                                }
                            } else {
                                // Scale not ready yet; use fallback without warning
                                // Fallback to d3 scheme while loading
                                const namesLower = groups.map(g => String(g?.name ?? '').toLowerCase());
                                const unique = Array.from(new Set(namesLower)).sort();
                                fallbackColorScale.domain(unique);
                                itemColor = fallbackColorScale(noteLower);
                            }
                        }

                        // Format TWS bins as single values starting from 15 (e.g., "15" -> "15", "20" -> "20", "25" -> "25")
                        // Keep original note for click handler (filtering needs original value)
                        const originalNote = note;
                        let displayNote = (note === '0' || note === undefined || note === '') ? 'NONE' : note;
                        if (currentColor === 'TWS' && displayNote !== 'NONE' && !isAll) {
                            const twsNum = Number(displayNote);
                            if (!isNaN(twsNum) && twsNum >= 15) {
                                displayNote = String(twsNum); // Display as single value (15, 20, 25, etc.)
                            }
                        }
                        const itemInfo = itemWidths[itemIndex];

                        // Validate itemInfo exists
                        if (!itemInfo) {
                            logError('ManeuverLegend: Missing itemInfo for item', { itemIndex, displayNote, itemWidthsLength: itemWidths.length });
                            return;
                        }

                        const circleX = currentX + 5; // Center of circle (radius is 5)
                        const textX = currentX + 10 + 20; // After circle + spacing
                        // When colored by TACK: Port / P-S = square (red), Stbd / S-P = circle (green)
                        const isTackPort = currentColor === 'TACK' && (noteLower === 'p - s' || noteLower === 'port');

                        // Draw symbol: circle for Stbd/S-P, square for Port/P-S
                        const symbol = isTackPort
                            ? legend.append("rect")
                                .datum(displayNote)
                                .attr("x", circleX - 5)
                                .attr("y", rowY - 5)
                                .attr("width", 10)
                                .attr("height", 10)
                                .attr("class", "legend-square")
                                .style("fill", itemColor)
                            : legend.append("circle")
                                .datum(displayNote)
                                .attr("cx", circleX)
                                .attr("cy", rowY)
                                .attr("r", 5)
                                .attr("class", "legend-circle")
                                .style("fill", itemColor);
                        if (click) {
                            symbol.style("cursor", "pointer")
                                .style("pointer-events", "all")
                                .on("click", function () { click(originalNote); });
                        }

                        // Add black outline/stroke for 'ALL' or use original color stroke for highlights
                        if (isAll) {
                            symbol.style("stroke", "black")
                                .style("stroke-width", "2px");
                        } else if (isHighlight) {
                            // For highlights, use yellow fill with black stroke
                            symbol.style("fill", "#FFD700")
                                .style("stroke", "black")
                                .style("stroke-width", "1px");
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
                                .on("click", function () { click(originalNote); });
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
        <div class="legend" id={props.elementId}
            ref={(el) => { chartRef = el }}
            style={{ width: "100%", display: "block" }}
        ></div>
    );
}


export default ManeuverLegend;
