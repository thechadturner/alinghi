// @ts-nocheck
import { createEffect, onMount, onCleanup } from "solid-js";
import * as d3 from "d3";
import { useMapInteractions } from "../hooks/useMapInteractions";

export interface TrackPoint {
  Datetime: Date;
  Lat: number;
  Lng: number;
  Twd: number;
  Twa: number;
  Tws: number;
  Bsp: number;
  Hdg: number;
  Grade: number;
  Vmg_perc: number;
  event_id: number;
  [key: string]: any;
}

export interface SelectionLayerProps {
  data: TrackPoint[];
  map: any;
  onRangeSelect?: (start: TrackPoint, end: TrackPoint) => void;
  onPointClick?: (point: TrackPoint) => void;
  showSelectionFeedback?: boolean;
}

export default function SelectionLayer(props: SelectionLayerProps) {
  const {
    isSelecting,
    selectionStart,
    selectionEnd,
    startRangeSelection,
    updateRangeSelection,
    completeRangeSelection,
    cancelRangeSelection,
    handlePointClick,
    getSelectionBounds
  } = useMapInteractions();

  let selectionOverlay: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let overlayContainer: HTMLElement | null = null;
  let isMouseDown = false;
  let dragStartPoint: TrackPoint | null = null;

  // Create selection overlay
  const createSelectionOverlay = () => {
    if (!props.map) return;

    // Remove existing overlay only within this map instance
    let container: HTMLElement | null = null;
    try {
      container = props.map.getCanvasContainer() as HTMLElement;
    } catch (_) {
      container = null;
    }
    if (!container) {
      try {
        container = props.map.getContainer() as HTMLElement;
      } catch (_) {
        container = null;
      }
    }
    if (!container) return;
    overlayContainer = container;
    d3.select(container).selectAll(".selection-overlay").remove();
    
    // Create SVG overlay
    const svg = d3.select(container)
      .append("svg")
      .attr("class", "selection-overlay")
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("pointer-events", "none")
      .style("z-index", "200");

    selectionOverlay = svg.append("g").attr("class", "selection-layer");
    
    return selectionOverlay;
  };

  // Find closest point to mouse position
  const findClosestPoint = (mouseX: number, mouseY: number): TrackPoint | null => {
    if (!props.data || props.data.length === 0) return null;

    let closestPoint = null;
    let minDistance = Infinity;

    props.data.forEach(point => {
      const mapPoint = props.map.project([point.Lng, point.Lat]);
      const distance = Math.sqrt(
        Math.pow(mouseX - mapPoint.x, 2) + Math.pow(mouseY - mapPoint.y, 2)
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        closestPoint = point;
      }
    });

    return closestPoint;
  };

  // Handle mouse down for range selection
  const handleMouseDown = (event: MouseEvent) => {
    if (!selectionOverlay) return;

    const [mouseX, mouseY] = d3.pointer(event, selectionOverlay.node());
    const closestPoint = findClosestPoint(mouseX, mouseY);
    
    if (closestPoint) {
      isMouseDown = true;
      dragStartPoint = closestPoint;
      startRangeSelection(closestPoint);
      
      // Prevent default to avoid map panning
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // Handle mouse move for range selection
  const handleMouseMove = (event: MouseEvent) => {
    if (!isMouseDown || !selectionOverlay) return;

    const [mouseX, mouseY] = d3.pointer(event, selectionOverlay.node());
    const closestPoint = findClosestPoint(mouseX, mouseY);
    
    if (closestPoint && closestPoint !== dragStartPoint) {
      updateRangeSelection(closestPoint);
      updateSelectionVisual();
    }
  };

  // Handle mouse up for range selection
  const handleMouseUp = (event: MouseEvent) => {
    if (!isMouseDown || !selectionOverlay) return;

    const [mouseX, mouseY] = d3.pointer(event, selectionOverlay.node());
    const closestPoint = findClosestPoint(mouseX, mouseY);
    
    if (closestPoint && closestPoint !== dragStartPoint) {
      // Complete range selection
      completeRangeSelection();
      
      if (props.onRangeSelect && dragStartPoint) {
        props.onRangeSelect(dragStartPoint, closestPoint);
      }
    } else if (closestPoint) {
      // Single point click
      handlePointClick(closestPoint);
      
      if (props.onPointClick) {
        props.onPointClick(closestPoint);
      }
    } else {
      // Cancel selection
      cancelRangeSelection();
    }

    isMouseDown = false;
    dragStartPoint = null;
    clearSelectionVisual();
  };

  // Handle click for single point selection
  const handleClick = (event: MouseEvent) => {
    if (isMouseDown) return; // Let mouse up handle it

    if (!selectionOverlay) return;

    const [mouseX, mouseY] = d3.pointer(event, selectionOverlay.node());
    const closestPoint = findClosestPoint(mouseX, mouseY);
    
    if (closestPoint) {
      handlePointClick(closestPoint);
      
      if (props.onPointClick) {
        props.onPointClick(closestPoint);
      }
    }
  };

  // Update selection visual feedback
  const updateSelectionVisual = () => {
    if (!selectionOverlay || !props.showSelectionFeedback) return;

    // Clear existing selection visual
    selectionOverlay.selectAll(".selection-feedback").remove();

    const bounds = getSelectionBounds();
    if (!bounds.start || !bounds.end) return;

    // Create selection rectangle or line
    const startPoint = props.map.project([bounds.start.Lng, bounds.start.Lat]);
    const endPoint = props.map.project([bounds.end.Lng, bounds.end.Lat]);

    // Add selection line
    selectionOverlay.append("line")
      .attr("class", "selection-feedback")
      .attr("x1", startPoint.x)
      .attr("y1", startPoint.y)
      .attr("x2", endPoint.x)
      .attr("y2", endPoint.y)
      .attr("stroke", "#ff6b6b")
      .attr("stroke-width", 3)
      .attr("stroke-dasharray", "5,5")
      .attr("opacity", 0.8);

    // Add start point marker
    selectionOverlay.append("circle")
      .attr("class", "selection-feedback")
      .attr("cx", startPoint.x)
      .attr("cy", startPoint.y)
      .attr("r", 6)
      .attr("fill", "#ff6b6b")
      .attr("stroke", "white")
      .attr("stroke-width", 2);

    // Add end point marker
    selectionOverlay.append("circle")
      .attr("class", "selection-feedback")
      .attr("cx", endPoint.x)
      .attr("cy", endPoint.y)
      .attr("r", 6)
      .attr("fill", "#ff6b6b")
      .attr("stroke", "white")
      .attr("stroke-width", 2);
  };

  // Clear selection visual
  const clearSelectionVisual = () => {
    if (selectionOverlay) {
      selectionOverlay.selectAll(".selection-feedback").remove();
    }
  };

  // Update selection positions when map moves
  const updateSelectionPositions = () => {
    if (!selectionOverlay || !props.map) return;

    selectionOverlay.selectAll(".selection-feedback").each(function() {
      const element = d3.select(this);
      const classList = element.attr("class");
      
      if (classList.includes("selection-feedback")) {
        // Update positions of selection elements
        // This would need to be implemented based on stored data
      }
    });
  };

  // Effect to create selection overlay when map is ready
  createEffect(() => {
    if (props.map) {
      createSelectionOverlay();
    }
  });

  // Effect to update positions when map moves
  createEffect(() => {
    if (props.map) {
      props.map.on("move", updateSelectionPositions);
      props.map.on("moveend", updateSelectionPositions);
      props.map.on("viewreset", updateSelectionPositions);
    }
  });

  onMount(() => {
    if (selectionOverlay) {
      selectionOverlay
        .on("mousedown", handleMouseDown)
        .on("mousemove", handleMouseMove)
        .on("mouseup", handleMouseUp)
        .on("click", handleClick);
    }
  });

  onCleanup(() => {
    if (selectionOverlay) {
      selectionOverlay.remove();
    }
    if (overlayContainer) {
      d3.select(overlayContainer).selectAll(".selection-overlay").remove();
      overlayContainer = null;
    }
  });

  return null; // This component doesn't render JSX, it manages D3 overlays
}
