import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import * as d3 from "d3";

import { tooltip, setTooltip } from "../../store/globalStore";
import { applyDataFilter } from "../../utils/dataFiltering";
import { 
  triggerUpdate as selectionTriggerUpdate, 
  isSelectionLoading
} from "../../store/selectionStore";
import { error as logError, info, debug, warn } from "../../utils/console";
import LoadingOverlay from "../utilities/Loading";
import { useChartCleanup } from "../../utils/d3Cleanup";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";

interface PolarPlotProps {
  chart?: any;
  displayMode?: number;
  polarData?: { red: any[]; green: any[]; blue: any[] };
  polarNames?: { red: string; green: string; blue: string };
  selectedTWS?: number;
  selectedPolar?: number;
  editMode?: boolean;
  scatterData?: any[];
  onDisplayModeChange?: (mode: number) => void;
  onTWSChange?: (tws: number) => void;
  onPolarChange?: (color: string, targetName: string) => void;
}

function PolarPlot(props: PolarPlotProps) {
  let containerRef: HTMLElement | null = null;
  let chartRef: SVGSVGElement | null = null;

  // Initialize D3 cleanup
  const { addSelection, addEventListener, addTimer, addObserver, cleanup } = useChartCleanup();

  // Use defaultChannelsStore for channel names
  const { bspName, vmgName } = defaultChannelsStore;

  // Chart state
  const [isLoading, setIsLoading] = createSignal(false);
  const [maxValue, setMaxValue] = createSignal(30);
  const [processedScatterData, setProcessedScatterData] = createSignal([]);

  // Chart dimensions - matching original polar.js exactly
  const width = 775;
  const height = 775;
  const radius = Math.min(width, height) / 2 - 50;

  // Process scatter data similar to the original polar.js
  const processScatterData = (data: any[]): any[] => {
    if (!data || data.length === 0) return [];

    const processedData = data.map(d => {
      // Try multiple field name variations (API stores in lowercase, but check uppercase too)
      const cwa = d.Cwa ?? d.cwa ?? d.twa ?? d.Twa ?? d.TWA ?? 0;
      const bsp = d.Bsp ?? d.bsp ?? d.BSP ?? 0;
      const vmg = d.Vmg ?? d.vmg ?? d.VMG ?? Math.abs(Math.cos(cwa * Math.PI / 180) * bsp);
      
      return {
        ...d,
        Cwa: cwa,
        Bsp: bsp,
        Vmg: vmg,
        Cwa_n: Math.abs(cwa)
      };
    });

    // Filter data similar to original logic
    const angles = [30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160];
    const deviations = [];
    
    angles.forEach(a => {
      const scatter = processedData.filter(d => d.Cwa_n >= a - 5 && d.Cwa_n <= a + 5);
      
      if (scatter.length > 0) {
        const yAxisName = props.displayMode === 0 ? bspName() : vmgName();
        const data_array = scatter.map(obj => obj[yAxisName]);
        
        const mean = d3.mean(data_array);
        const squaredDifferences = data_array.map(value => Math.pow(value - mean, 2));
        const meanSquaredDifferences = d3.mean(squaredDifferences);
        const stdev = Math.sqrt(meanSquaredDifferences);
        
        const min = mean;
        const max = mean + (stdev * 2);
        
        deviations.push([min, max]);
      } else {
        deviations.push([0, 0]);
      }
    });

    let filteredData = [];
    let i = 0;
    angles.forEach(a => {
      const dev = deviations[i];
      
      if (dev[0] !== 0 || dev[1] !== 0) {
        const yAxisName = props.displayMode === 0 ? bspName() : vmgName();
        const scatter = processedData.filter(d => 
          d.Cwa_n >= a - 5 && 
          d.Cwa_n <= a + 5 && 
          d[yAxisName] > dev[0] && 
          d[yAxisName] < (dev[1] * 1.5)
        );
        filteredData = filteredData.concat(scatter);
      }
      
      i += 1;
    });

    return filteredData;
  };

  // Initialize polar chart - matching original polar.js exactly
  const initPolarChart = () => {
    if (!chartRef) return;

    d3.select(chartRef).selectAll("*").remove();

    const svg = d3.select(chartRef)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("transform", "translate(0, 0)");

    addSelection(svg);

    const g = svg.append("g")
      .attr("transform", `translate(${width / 2}, ${height / 2})`);

    addSelection(g);

    // Bin TWS values with interval of 4 for matching
    const binTWS = (tws: number): number => {
      if (tws <= 0) return 4;
      return Math.ceil(tws / 4) * 4;
    };

    // Compute dynamic ymax like polar.js: prefer scatter max, else polar max for selected TWS
    const getBspVal = (d) => (d.Bsp ?? d.bsp ?? d.BSP ?? 0);
    const getCwaVal = (d) => (d.Cwa ?? d.cwa ?? d.twa ?? d.Twa ?? d.TWA ?? 0);
    const getVmgVal = (d) => {
      const pre = d.Vmg ?? d.vmg ?? d.VMG;
      if (pre != null) return Math.abs(pre);
      const cwa = getCwaVal(d);
      const bsp = getBspVal(d);
      return Math.abs(Math.cos(cwa * Math.PI / 180) * bsp);
    };
    const getTwsVal = (d) => (d.Tws ?? d.tws ?? d.TWS ?? null);
    const getYVal = (d) => (props.displayMode === 0 ? getBspVal(d) : getVmgVal(d));

    let ymax = 30;
    const scatter = processedScatterData();
    if (scatter && scatter.length > 0) {
      const smax = d3.max(scatter, d => getYVal(d));
      ymax = (smax ?? 30);
    } else {
      // check polar data for selected TWS (using binned matching)
      const selectedTws = props.selectedTWS;
      let pmax = undefined;
      if (props.polarData) {
        Object.keys(props.polarData).forEach(k => {
          const arr = props.polarData[k];
          if (Array.isArray(arr) && arr.length) {
            const filtered = selectedTws != null
              ? arr.filter(d => {
                  const v = getTwsVal(d);
                  if (v == null) return false;
                  const a = Number(v);
                  const b = Number(selectedTws);
                  // Bin both values and compare
                  const binnedA = binTWS(a);
                  const binnedB = binTWS(b);
                  return !Number.isNaN(a) && !Number.isNaN(b) && binnedA === binnedB;
                })
              : arr;
            const m = d3.max(filtered, d => getYVal(d));
            if (m != null) {
              pmax = pmax == null ? m : Math.max(pmax, m);
            }
          }
        });
      }
      if (pmax != null) ymax = pmax; else ymax = 30;
    }

    // Add padding (15% or minimum 5 units) to ensure data fits nicely
    const padding = Math.max(ymax * 0.15, 5);
    const ymaxWithPadding = ymax + padding;

    // Create radial scale - matching original polar.js
    const yScale = d3.scaleLinear()
      .domain([0, ymaxWithPadding])
      .range([0, radius]);

    // Radial grid circles - matching original polar.js exactly
    const radialTicks = yScale.ticks(5);
    const radialGroup = g.append("g").attr("class", "r axis");
    radialTicks.forEach(t => {
      const rr = yScale(t);
      radialGroup.append("circle")
        .attr("r", rr);
      
      // Tick labels - matching original polar.js style exactly
      radialGroup.append("text")
        .attr("y", -rr - 4)
        .attr("transform", "rotate(20)")
        .style("text-anchor", "middle")
        .text(t);
    });

    // Angular grid lines - matching original polar.js exactly
    const angularValues = Array.from({ length: 8 }, (_, i) => i * 45); // 0, 45, 90, 135, 180, 225, 270, 315
    const angularGroup = g.append("g").attr("class", "a axis");
    angularValues.forEach(a => {
      // Create a per-angle group so both line and label share the same rotation
      const tick = angularGroup.append("g").attr("transform", `rotate(${a - 90})`);

      tick.append("line")
        .attr("x1", 0).attr("y1", 0)
        .attr("x2", radius);

      // Place label at the end of the ray; flip for >180° to keep upright
      const flip = a > 180 && a < 360;
      const text = tick.append("text")
        .attr("x", radius + 6)
        .attr("dy", ".35em")
        .style("text-anchor", flip ? "end" : null);

      if (flip) {
        text.attr("transform", `rotate(180 ${radius + 6}, 0)`);
      }

      text.text(() => {
        if (a > 180) {
          return Math.abs(a - 360) + "°";
        } else {
          return (a * -1) + "°";
        }
      });
    });

    return { svg, g, yScale };
  };

  // Draw scatter data - matching original polar.js exactly
  const drawScatterData = (g, yScale) => {
    const data = processedScatterData();
    if (data.length === 0) return;

    const tt = d3.select("#polar-tooltip");

    const mouseover = function(event, d) {
      tt.transition().duration(200);
      tt.style("opacity", 1);
    };

    const mousemove = function(event, d) {
      const html = `
        <table class='table-striped' style='border-collapse: collapse'>
          <tr><td>CWA:</td><td>${d.Cwa.toFixed(2)}</td></tr>
          <tr><td>BSP:</td><td>${d.Bsp.toFixed(2)}</td></tr>
          <tr><td>VMG:</td><td>${d.Vmg.toFixed(2)}</td></tr>
        </table>
      `;

      tt.html(html)
        .style("left", (event.pageX) + 15 + "px")
        .style("top", (event.pageY) + "px")
        .style("width", "120px")
        .style("height", "auto");
    };

    const mouseout = function() {
      tt.transition().duration(200);
      tt.style("opacity", 0);
    };

    const cScale = d3.scaleLinear()
      .domain([-180, -1, 1, 180])
      .range(['red', 'red', 'green', 'green']);

    const yAxisName = props.displayMode === 0 ? bspName() : vmgName();

    // SCATTER - matching original polar.js exactly
    g.selectAll(".point")
      .data(data)
      .enter()
      .append("circle")
      .attr("class", "point")
      .attr("transform", d => {
        // Match original polar.js transform exactly
        const an = (d.Cwa * -1) - 90;
        const ra = yScale(d[yAxisName]);
        const x = ra * Math.cos(an * Math.PI / 180);
        const y = ra * Math.sin(an * Math.PI / 180);
        return `translate(${x}, ${y})`;
      })
      .attr("r", 2)
      .style("fill", "transparent")
      .style("stroke", d => cScale(d.Cwa))
      .on("mouseover", mouseover)
      .on("mouseout", mouseout)
      .on("mousemove", mousemove);
  };

  // Draw polar curves - matching original polar.js exactly
  const drawPolarCurves = (g, yScale) => {
    const polarDataValue = props.polarData;
    if (!polarDataValue) {
      debug('PolarPlot: No polarData provided');
      return;
    }
    
    const colors = ["Red", "Green", "Blue"]; // Match original capitalization
    
    Object.keys(polarDataValue).forEach((color, index) => {
      const data = polarDataValue[color];
      if (!data || !Array.isArray(data) || data.length === 0) {
        debug(`PolarPlot: No data for ${color}`, { data, isArray: Array.isArray(data), length: data?.length });
        return;
      }
      
      debug(`PolarPlot: Drawing ${color} polar with ${data.length} points`);

      const thickness = props.editMode && index !== props.selectedPolar ? 1 : 
                       props.editMode && index === props.selectedPolar ? 4 : 2;
      const pointRadius = props.editMode && index !== props.selectedPolar ? 2 :
                         props.editMode && index === props.selectedPolar ? 6 : 5;

      // Normalize data access (API fields may be lowercase); compute VMG if needed
      const getCwa = (d) => (d.Cwa ?? d.cwa ?? d.twa ?? d.Twa ?? d.TWA ?? 0);
      const getBsp = (d) => (d.Bsp ?? d.bsp ?? d.BSP ?? 0);
      const getVmg = (d) => {
        const cwa = getCwa(d);
        const bsp = getBsp(d);
        const precomputed = d.Vmg ?? d.vmg ?? d.VMG;
        return precomputed != null ? Math.abs(precomputed) : Math.abs(Math.cos(cwa * Math.PI / 180) * bsp);
      };
      const getY = (d) => (props.displayMode === 0 ? getBsp(d) : getVmg(d));

      // Filter to selected TWS (if provided)
      const getTws = (d) => (d.Tws ?? d.tws ?? d.TWS ?? d.wind ?? d.speed ?? null);
      const selectedTws = props.selectedTWS;
      
      // Bin TWS values with interval of 4 for matching
      const binTWS = (tws: number): number => {
        if (tws <= 0) return 4;
        return Math.ceil(tws / 4) * 4;
      };
      
      // Get unique TWS values in data for debugging
      const uniqueTws = [...new Set(data.map(d => getTws(d)).filter(v => v != null))].slice(0, 10);
      
      debug(`PolarPlot: Filtering ${color} data for TWS ${selectedTws}`, {
        totalDataPoints: data.length,
        firstDataPoint: data[0],
        firstTws: data[0] ? getTws(data[0]) : null,
        uniqueTwsValues: uniqueTws,
        selectedTws: selectedTws
      });
      
      const twsFiltered = selectedTws != null
        ? data.filter(d => {
            const v = getTws(d);
            if (v == null) return false;
            const a = Number(v);
            const b = Number(selectedTws);
            // Bin both values and compare
            const binnedA = binTWS(a);
            const binnedB = binTWS(b);
            const matches = !Number.isNaN(a) && !Number.isNaN(b) && binnedA === binnedB;
            return matches;
          })
        : data;
      
      debug(`PolarPlot: ${color} filtered to ${twsFiltered.length} points for TWS ${selectedTws}`, {
        filteredSample: twsFiltered.slice(0, 3).map(d => ({
          tws: getTws(d),
          cwa: getCwa(d),
          bsp: getBsp(d)
        }))
      });
      
      if (!twsFiltered.length) {
        warn(`PolarPlot: No data points for ${color} after TWS filtering (TWS=${selectedTws}). Available TWS values: ${uniqueTws.join(', ')}`);
        return;
      }

      // TARGETS BSP SCATTER - only show points in edit mode
      if (props.editMode) {
        g.selectAll(".point")
          .data(twsFiltered)
          .enter()
          .append("circle")
          .attr("class", "point")
          .attr("transform", d => {
            // Match original polar.js BSP transform exactly
            const an = getCwa(d) - 90;
            const ra = yScale(getY(d));
            const x = ra * Math.cos(an * Math.PI / 180);
            const y = ra * Math.sin(an * Math.PI / 180);
            return `translate(${x}, ${y})`;
          })
          .attr("r", pointRadius)
          .style("fill", colors[index])
          .style("stroke", "Dark" + colors[index])
          .style("stroke-width", thickness);
      }

      // TARGETS VMG SCATTER - matching original polar.js exactly
      if (props.editMode) {
        g.selectAll(".point")
          .data(twsFiltered)
          .enter()
          .append("circle")
          .attr("class", "point")
          .attr("transform", d => {
            // Match original polar.js VMG transform exactly
            const an = (getCwa(d) * -1) - 90;
            const ra = yScale(getY(d));
            const x = ra * Math.cos(an * Math.PI / 180);
            const y = ra * Math.sin(an * Math.PI / 180);
            return `translate(${x}, ${y})`;
          })
          .attr("r", pointRadius)
          .style("fill", colors[index])
          .style("stroke", "Dark" + colors[index])
          .style("stroke-width", thickness);
      }

      // SPEED LINE - matching original polar.js exactly
      const speedLineGenerator = d3.line()
        .x(d => {
          const an = getCwa(d) - 90;
          const ra = yScale(getY(d));
          return ra * Math.cos(an * Math.PI / 180);
        })
        .y(d => {
          const an = getCwa(d) - 90;
          const ra = yScale(getY(d));
          return ra * Math.sin(an * Math.PI / 180);
        })
        .curve(d3.curveCatmullRom);

      const speedPathData = speedLineGenerator(twsFiltered);
      g.append("path")
        .attr("d", speedPathData)
        .attr("fill", "none")
        .attr("stroke", colors[index])
        .attr("stroke-width", thickness);

      // VMG LINE - matching original polar.js exactly
      const vmgLineGenerator = d3.line()
        .x(d => {
          const an = (getCwa(d) * -1) - 90;
          const ra = yScale(getY(d));
          return ra * Math.cos(an * Math.PI / 180);
        })
        .y(d => {
          const an = (getCwa(d) * -1) - 90;
          const ra = yScale(getY(d));
          return ra * Math.sin(an * Math.PI / 180);
        })
        .curve(d3.curveCatmullRom);

      const vmgPathData = vmgLineGenerator(twsFiltered);
      g.append("path")
        .attr("d", vmgPathData)
        .attr("fill", "none")
        .attr("stroke", colors[index])
        .attr("stroke-width", thickness);
    });
  };

  // Main rendering effect - reactive to data and prop changes
  createEffect(() => {
    if (!chartRef) return;
    
    // Track props to make effect reactive
    const polarDataValue = props.polarData;
    const selectedTws = props.selectedTWS;
    const displayModeValue = props.displayMode;
    const editModeValue = props.editMode;
    const selectedPolarValue = props.selectedPolar;
    
    debug('PolarPlot: Rendering effect triggered', {
      hasPolarData: !!polarDataValue,
      polarDataKeys: polarDataValue ? Object.keys(polarDataValue) : [],
      redLength: polarDataValue?.red?.length || 0,
      greenLength: polarDataValue?.green?.length || 0,
      blueLength: polarDataValue?.blue?.length || 0,
      selectedTWS: selectedTws,
      displayMode: displayModeValue
    });

    const { g, yScale } = initPolarChart();
    // drawScatterData(g, yScale);
    drawPolarCurves(g, yScale);
  });

  // Watch for data changes
  createEffect(() => {
    if (props.scatterData && props.scatterData.length > 0) {
      const processedData = processScatterData(props.scatterData);
      setProcessedScatterData(processedData);
      
      // Update max value for scaling
      const yAxisName = props.displayMode === 0 ? bspName() : vmgName();
      const maxVal = d3.max(processedData, d => d[yAxisName]) || 30;
      setMaxValue(maxVal + 10);
    }
  });

  // Watch for selection changes
  createEffect(() => {
    const shouldTrigger = selectionTriggerUpdate();
    
    if (shouldTrigger && props.scatterData && props.scatterData.length > 0) {
      const filteredData = applyDataFilter(props.scatterData);
      const processedData = processScatterData(filteredData);
      setProcessedScatterData(processedData);
    }
  });

  onCleanup(() => {
    cleanup();
  });

  return (
    <div ref={el => (containerRef = el)} class="polar-plot-container w-full h-full flex flex-col justify-center items-center">
      
      {/* Tooltip */}
      <div
        id="polar-tooltip"
        class="polar-plot-tooltip"
        style={{
          opacity: 0,
          position: "absolute",
          "pointer-events": "none",
          "z-index": 1000
        }}
      ></div>

      {/* Chart Container */}
      <Show when={!isLoading()}>
        <div ref={(el) => (chartRef = el)} class="polar-plot-chart-container"></div>
      </Show>

      <Show when={isLoading()}>
        <LoadingOverlay message="Loading polar plot data..." />
      </Show>
    </div>
  );
}

export default PolarPlot;
