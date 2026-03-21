import { createEffect, createSignal, onMount } from "solid-js";
import * as d3 from "d3";
import { isDark } from "../../store/themeStore";
import { debug as logDebug, error as logError } from "../../utils/console";

/** Set to true to show the cloud data legend entry (Latest Scatter - Cloud / Recent History - Cloud). Hidden for now. */
const SHOW_CLOUD_LEGEND = false;

interface PerformanceLegendProps {
    elementId: string;
    target_info: { name?: string };
    cloudType?: string;
    groups: Array<{ name: string; color: string }>;
    color?: string;
    click?: (note: string) => void;
    highlights?: string[];
    onTargetClick?: () => void;
    /** Optional filter summary (e.g. Active Filters) rendered in the same div as the legend */
    filterSummary?: JSX.Element;
}

function PerformanceLegend(props: PerformanceLegendProps) {
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
        // Destructure props inside the effect so Solid.js can track changes
        const { elementId, target_info, cloudType, groups, click, highlights, onTargetClick, color } = props;

        // Ensure groups is an array and track it properly
        const currentGroups = Array.isArray(groups) ? groups : [];
        const currentColor = color || "GRADE";
        const currentTargetName = target_info?.name || "No Targets";

        logDebug('PerformanceLegend: Render start', {
            elementId,
            groupsCount: currentGroups.length,
            targetName: currentTargetName,
            cloudType,
            color: currentColor
        });

        // Use container width for responsive legend
        const rawWidth = containerWidth();
        const legendWidth = Math.max(280, Math.min(1500, rawWidth));
        const itemsPerRow = legendWidth < 500 ? 4 : legendWidth < 800 ? 6 : 8;
        const itemSpacing = legendWidth < 500 ? 30 : legendWidth < 800 ? 50 : 80;

        // Calculate total groups count including highlights
        let totalGroupsCount = currentGroups.length;
        if (highlights && Array.isArray(highlights) && highlights.length > 0) {
            totalGroupsCount += 1; // Add 1 for the highlight entry
        }

        // Determine layout mode: single row if < 5 groups and fits width, else multi-row
        let useSingleRow = totalGroupsCount < 5;

        // Calculate legend height based on layout mode
        let legendHeight = 70; // Base height for row 1 (target + cloud)
        if (useSingleRow) {
            // Single row: target, cloud, and groups all on one row
            legendHeight = 70;
        } else {
            // Multi-row: target/cloud on row 1, groups on subsequent rows
            const numGroupRows = currentGroups.length > 0 ? Math.ceil(currentGroups.length / itemsPerRow) : 0;
            if (numGroupRows > 0) {
                // First group row at 65px, subsequent rows at 45px spacing
                legendHeight = 70 + 10 + (numGroupRows - 1) * 45;
            }
        }

        // Remove existing SVG before re-rendering
        d3.select(`#${elementId}`).selectAll("svg").remove();

        const legend = d3.select(`#${elementId}`)
            .append("svg")
            .attr("width", legendWidth)
            .attr("height", legendHeight)
            .style("width", "100%")
            .style("max-width", `${legendWidth}px`)
            .append("g")
            .attr("transform", "translate(0, 0)");

        // Prepare groups with highlights
        let groupsWithHighlights: Array<{ name: string; color: string; isHighlight?: boolean }> = [];
        if (currentGroups.length > 0) {
            currentGroups.forEach((group) => {
                const text = String(group.name ?? '');
                if (text !== undefined && text !== '') {
                    groupsWithHighlights.push({ 
                        name: text === '0' ? '0 (ignore)' : text, 
                        color: group.color || 'lightgrey',
                        isHighlight: false
                    });
                }
            });
        }

        // Calculate dimensions for target item
        const targetLineWidth = 50; // Line from x1 to x2
        const targetTextWidth = (currentTargetName.length || 0) * 7 + 25; // Approximate text width + spacing
        const targetTotalWidth = targetLineWidth + targetTextWidth;

        // Calculate dimensions for cloud item (hidden when !SHOW_CLOUD_LEGEND)
        const cloudCircleRadius = 5;
        const cloudText = SHOW_CLOUD_LEGEND
            ? (cloudType === 'Latest' || cloudType === '1Hz Scatter'
                ? 'Latest Scatter - Cloud'
                : cloudType === 'Recent History' || cloudType === 'Recent'
                ? 'Recent History - Cloud'
                : '')
            : '';
        const cloudTextWidth = cloudText.length * 7 + 25; // Approximate text width + spacing
        const cloudTotalWidth = SHOW_CLOUD_LEGEND ? cloudCircleRadius * 2 + cloudTextWidth : 0;
        const targetCloudSpacing = SHOW_CLOUD_LEGEND ? 200 : 0;

        let targetLineX1: number, targetLineX2: number, targetTextX: number;
        let cloudStartX: number, cloudCircleX: number, cloudTextX: number;
        let groupsStartX: number;
        let singleRowGroupItemWidths: Array<{ displayNote: string; itemWidth: number }> = [];

        if (useSingleRow) {
            // SINGLE ROW LAYOUT: Calculate total width for all items
            let totalWidth = targetTotalWidth + targetCloudSpacing + cloudTotalWidth;

            if (groupsWithHighlights.length > 0) {
                groupsWithHighlights.forEach(group => {
                    const displayNote = String(group.name || '');
                    const displayNoteFinal = (displayNote === '0' || displayNote === undefined || displayNote === '') ? 'NONE' : displayNote;
                    const symbolWidth = 10; // Circle or square width
                    const spacingBetween = 20; // Space between symbol and text
                    const textWidth = displayNoteFinal.length * 7; // Approximate 7px per character
                    const itemWidth = symbolWidth + spacingBetween + textWidth;
                    singleRowGroupItemWidths.push({ displayNote: displayNoteFinal, itemWidth });
                    
                    totalWidth += itemSpacing; // Add spacing between items
                    totalWidth += itemWidth;
                });
            }

            // If single row would overflow, use multi-row and set multi-row positions
            if (totalWidth > legendWidth) {
                useSingleRow = false;
                const row1TotalWidth = targetTotalWidth + targetCloudSpacing + cloudTotalWidth;
                const row1StartX = (legendWidth - row1TotalWidth) / 2;
                targetLineX1 = row1StartX;
                targetLineX2 = row1StartX + targetLineWidth;
                targetTextX = row1StartX + targetLineWidth + 25;
                cloudStartX = row1StartX + targetTotalWidth + targetCloudSpacing;
                cloudCircleX = cloudStartX + cloudCircleRadius;
                cloudTextX = cloudStartX + cloudCircleRadius * 2 + 20;
                groupsStartX = 0;
            } else {
                const singleRowStartX = (legendWidth - totalWidth) / 2;
                targetLineX1 = singleRowStartX;
                targetLineX2 = singleRowStartX + targetLineWidth;
                targetTextX = singleRowStartX + targetLineWidth + 25;
                cloudStartX = singleRowStartX + targetTotalWidth + targetCloudSpacing;
                cloudCircleX = cloudStartX + cloudCircleRadius;
                cloudTextX = cloudStartX + cloudCircleRadius * 2 + 20;
                groupsStartX = groupsWithHighlights.length > 0 ? cloudStartX + cloudTotalWidth + itemSpacing : 0;
            }
        } else {
            // MULTI-ROW LAYOUT: Center target and cloud on first row
            const row1TotalWidth = targetTotalWidth + targetCloudSpacing + cloudTotalWidth;
            const row1StartX = (legendWidth - row1TotalWidth) / 2;

            // Position target
            targetLineX1 = row1StartX;
            targetLineX2 = row1StartX + targetLineWidth;
            targetTextX = row1StartX + targetLineWidth + 25;

            // Position cloud
            cloudStartX = row1StartX + targetTotalWidth + targetCloudSpacing;
            cloudCircleX = cloudStartX + cloudCircleRadius;
            cloudTextX = cloudStartX + cloudCircleRadius * 2 + 20;

            // Groups will be positioned separately in multi-row layout
            groupsStartX = 0; // Not used in multi-row
        }

        // TARGET
        const targetLine = legend.append("line")
            .attr("x1", targetLineX1).attr("y1", 31)
            .attr("x2", targetLineX2).attr("y2", 31)
            .attr("class", "tgt")
            .style("stroke", "#00ff7f")
            .style("stroke-width", 2);

        const targetText = legend.append("text")
            .attr("text-anchor", "left")
            .attr("transform", `translate(${targetTextX},35)`)
            .attr("font-size", "12px")
            .attr("class", "legend-text")
            .text(currentTargetName.replace(/_target$/i, ''));

        // Make target clickable if onTargetClick callback is provided
        const currentOnTargetClick = onTargetClick;
        if (currentOnTargetClick && typeof currentOnTargetClick === 'function') {
            logDebug('PerformanceLegend: Setting up target click handlers', { hasOnTargetClick: !!currentOnTargetClick });
            targetLine
                .style("cursor", "pointer")
                .style("pointer-events", "all")
                .on("click", function (event) {
                    event.stopPropagation();
                    event.preventDefault();
                    logDebug('PerformanceLegend: Target line clicked, calling handler');
                    try {
                        currentOnTargetClick();
                    } catch (error: any) {
                        logError('PerformanceLegend: Error calling onTargetClick', error);
                    }
                });
            targetText
                .style("cursor", "pointer")
                .style("pointer-events", "all")
                .on("click", function (event) {
                    event.stopPropagation();
                    event.preventDefault();
                    logDebug('PerformanceLegend: Target text clicked, calling handler');
                    try {
                        currentOnTargetClick();
                    } catch (error: any) {
                        logError('PerformanceLegend: Error calling onTargetClick', error);
                    }
                });
        } else {
            logDebug('PerformanceLegend: No onTargetClick handler provided', { onTargetClick: typeof currentOnTargetClick, value: currentOnTargetClick });
        }

        // CLOUD (aligned with target at y=30/31)
        if (cloudText) {
            legend.append("circle")
                .attr("cx", cloudCircleX)
                .attr("cy", 30)
                .attr("r", cloudCircleRadius)
                .attr("class", "legend-circle")
                .style("fill", isDark() ? "white" : "black")

            legend.append("text")
                .attr("text-anchor", "left")
                .attr("transform", `translate(${cloudTextX},35)`)
                .attr("font-size", "12px")
                .attr("class", "legend-text")
                .text(cloudText)
        }

        if (groupsWithHighlights.length > 0) {
            if (useSingleRow) {
                // SINGLE ROW LAYOUT: Render groups after cloud
                let currentX = groupsStartX;

                groupsWithHighlights.forEach((group, itemIndex) => {
                    const note = String(group.name || '');
                    const displayNote = (note === '0' || note === undefined || note === '') ? 'NONE' : note;
                    const isHighlight = group.isHighlight || false;
                    // Special handling: TRAINING should always be light grey
                    let color = group.color || 'lightgrey';
                    if (displayNote === 'TRAINING' || note === 'TRAINING' || note === '-1' || String(note) === '-1') {
                        color = 'lightgrey';
                    }
                    const itemInfo = singleRowGroupItemWidths[itemIndex];

                    if (!itemInfo) {
                        logError('PerformanceLegend: Missing itemInfo for item', { itemIndex, displayNote });
                        return;
                    }

                    const symbolX = currentX + 5; // Center of circle/square
                    const textX = currentX + 10 + 20; // After symbol + spacing

                    // Use square for PORT, circle for others
                    if (displayNote === 'PORT') {
                        const rect = legend.append("rect")
                            .datum(displayNote)
                            .attr("x", symbolX - 5)
                            .attr("y", 25)
                            .attr("width", 10)
                            .attr("height", 10)
                            .attr("class", "legend-circle")
                            .style("fill", color);
                        if (isHighlight) {
                            rect.style("fill", "#FFD700")
                                .style("stroke", "black")
                                .style("stroke-width", "1px");
                        } else {
                            if (click) {
                                rect.style("cursor", "pointer")
                                    .style("pointer-events", "all")
                                    .on("click", function (event) {
                                        event.stopPropagation();
                                        event.preventDefault();
                                        logDebug('PerformanceLegend: Rect clicked', { displayNote, note });
                                        try {
                                            click(displayNote);
                                        } catch (error: any) {
                                            logError('PerformanceLegend: Error calling click handler', error);
                                        }
                                    });
                            }
                        }
                    } else {
                        const circle = legend.append("circle")
                            .datum(displayNote)
                            .attr("cx", symbolX)
                            .attr("cy", 30)
                            .attr("r", 5)
                            .attr("class", "legend-circle")
                            .style("fill", color);
                        if (isHighlight) {
                            circle.style("fill", "#FFD700")
                                .style("stroke", "black")
                                .style("stroke-width", "1px");
                        } else {
                            if (click) {
                                circle.style("cursor", "pointer")
                                    .style("pointer-events", "all")
                                    .on("click", function (event) {
                                        event.stopPropagation();
                                        event.preventDefault();
                                        logDebug('PerformanceLegend: Circle clicked', { displayNote, note });
                                        try {
                                            click(displayNote);
                                        } catch (error: any) {
                                            logError('PerformanceLegend: Error calling click handler', error);
                                        }
                                    });
                            }
                        }
                    }

                    const text = legend.append("text")
                        .datum(displayNote)
                        .attr("text-anchor", "left")
                        .attr("transform", `translate(${textX},36)`)
                        .attr("font-size", "12px")
                        .attr("class", "legend-text")
                        .text(displayNote);
                    if (!isHighlight && click) {
                        text.style("cursor", "pointer")
                            .style("pointer-events", "all")
                            .on("click", function (event) {
                                event.stopPropagation();
                                event.preventDefault();
                                logDebug('PerformanceLegend: Text clicked (single row)', { displayNote, note });
                                try {
                                    click(displayNote);
                                } catch (error: any) {
                                    logError('PerformanceLegend: Error calling click handler', error);
                                }
                            });
                    }

                    currentX += itemInfo.itemWidth;
                    if (itemIndex < groupsWithHighlights.length - 1) {
                        currentX += itemSpacing;
                    }
                });
            } else {
                // MULTI-ROW LAYOUT: target/cloud on row 1, groups on subsequent rows
                const numGroupRows = groupsWithHighlights.length > 0 ? Math.ceil(groupsWithHighlights.length / itemsPerRow) : 0;

                // Process groups into rows
                for (let rowIndex = 0; rowIndex < numGroupRows; rowIndex++) {
                    const rowGroups = groupsWithHighlights.slice(rowIndex * itemsPerRow, (rowIndex + 1) * itemsPerRow);

                    // Calculate total width needed for this row
                    let totalRowWidth = 0;
                    const itemWidths: Array<{ displayNote: string; itemWidth: number }> = [];

                    rowGroups.forEach(group => {
                        const displayNote = String(group.name || '');
                        const displayNoteFinal = (displayNote === '0' || displayNote === undefined || displayNote === '') ? 'NONE' : displayNote;
                        const symbolWidth = 10;
                        const spacingBetween = 20;
                        const textWidth = displayNoteFinal.length * 7;
                        const itemWidth = symbolWidth + spacingBetween + textWidth;
                        itemWidths.push({ displayNote: displayNoteFinal, itemWidth });

                        if (totalRowWidth > 0) {
                            totalRowWidth += itemSpacing;
                        }
                        totalRowWidth += itemWidth;
                    });

                    // Center the row
                    const startX = (legendWidth - totalRowWidth) / 2;
                    let currentX = startX;

                    // Y position for this row (first row at 65, subsequent rows at 45px spacing)
                    const rowY = 65 + (rowIndex * 45);

                    rowGroups.forEach((group, itemIndex) => {
                        const note = String(group.name || '');
                        const displayNote = (note === '0' || note === undefined || note === '') ? 'NONE' : note;
                        const isHighlight = group.isHighlight || false;
                        // TRAINING must match scatter (light grey)
                        let color = group.color || 'lightgrey';
                        if (displayNote === 'TRAINING' || note === 'TRAINING' || note === '-1' || String(note) === '-1') {
                            color = 'lightgrey';
                        } else if (displayNote === 'NONE') {
                            color = "lightgrey";
                        }

                        const itemInfo = itemWidths[itemIndex];
                        if (!itemInfo) {
                            logError('PerformanceLegend: Missing itemInfo for item', { itemIndex, displayNote });
                            return;
                        }

                        const symbolX = currentX + 5;
                        const textX = currentX + 10 + 20;

                        // Use square for PORT, circle for others
                        if (displayNote === 'PORT') {
                            const rect = legend.append("rect")
                                .datum(displayNote)
                                .attr("x", symbolX - 5)
                                .attr("y", rowY - 5)
                                .attr("width", 10)
                                .attr("height", 10)
                                .attr("class", "legend-circle")
                                .style("fill", color);
                            if (isHighlight) {
                                rect.style("fill", "#FFD700")
                                    .style("stroke", "black")
                                    .style("stroke-width", "1px");
                            } else {
                                if (click) {
                                    rect.style("cursor", "pointer")
                                        .style("pointer-events", "all")
                                        .on("click", function () { click(displayNote); });
                                }
                            }
                        } else {
                            const circle = legend.append("circle")
                                .datum(displayNote)
                                .attr("cx", symbolX)
                                .attr("cy", rowY)
                                .attr("r", 5)
                                .attr("class", "legend-circle")
                                .style("fill", color);
                            if (isHighlight) {
                                circle.style("fill", "#FFD700")
                                    .style("stroke", "black")
                                    .style("stroke-width", "1px");
                                } else {
                                    if (click) {
                                        circle.style("cursor", "pointer")
                                            .style("pointer-events", "all")
                                            .on("click", function (event) {
                                                event.stopPropagation();
                                                event.preventDefault();
                                                logDebug('PerformanceLegend: Circle clicked (multi-row)', { displayNote, note });
                                                try {
                                                    click(displayNote);
                                                } catch (error: any) {
                                                    logError('PerformanceLegend: Error calling click handler', error);
                                                }
                                            });
                                    }
                                }
                        }

                        const text = legend.append("text")
                            .datum(displayNote)
                            .attr("text-anchor", "left")
                            .attr("transform", `translate(${textX},${rowY + 6})`)
                            .attr("font-size", "12px")
                            .attr("class", "legend-text")
                            .text(displayNote);
                        if (!isHighlight && click) {
                            text.style("cursor", "pointer")
                                .style("pointer-events", "all")
                                .on("click", function (event) {
                                    event.stopPropagation();
                                    event.preventDefault();
                                    logDebug('PerformanceLegend: Text clicked (multi-row)', { displayNote, note });
                                    try {
                                        click(displayNote);
                                    } catch (error: any) {
                                        logError('PerformanceLegend: Error calling click handler', error);
                                    }
                                });
                        }

                        currentX += itemInfo.itemWidth;
                        if (itemIndex < rowGroups.length - 1) {
                            currentX += itemSpacing;
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


export default PerformanceLegend;
