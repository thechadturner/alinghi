import { createEffect, onMount, onCleanup, Show } from "solid-js";
import * as d3 from "d3";
import { myTickFormat } from "../../utils/global";

import { setTooltip } from "../../store/globalStore";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import { isDark } from "../../store/themeStore";
import { warn } from "../../utils/console";

import infoIconUrl from "../../assets/info.svg";
import warningIconUrl from "../../assets/warning.svg";

interface TargetScatterProps {
  xaxis: string;
  yaxis: string;
  filters: string[];
  green: Record<string, any[]>;
  red: Record<string, any[]>;
  blue: Record<string, any[]>;
  infoType?: string;
  infoMessage?: string;
  mouseID?: number | null;
  setMouseID?: (id: number | null) => void;
  zoom?: boolean;
  handleZoom?: (info: any[]) => void;
  class_name?: string;
}

interface DataPoint {
  ID: number;
  X: number;
  Y: number;
}

export default function TargetScatter(props: TargetScatterProps) {
  let containerRef: HTMLElement | null = document.getElementById('main-content')
  let chartRef: HTMLDivElement | null = null;

  let xMin = 9999999
  let xMax = -9999999
  let yMin = 9999999
  let yMax = -9999999 

  let margin = {top: 10, right: 10, bottom: 60, left: 50},
  chartWidth = 1000 - margin.left - margin.right,
  chartHeight = 800 - margin.top - margin.bottom;

  let xScale = d3.scaleLinear().range([0, chartWidth]).domain([xMin, xMax])
  let yScale = d3.scaleLinear().range([0, chartHeight]).domain([0, 1])

  const {xaxis, yaxis, filters, green, red, blue} = props;
  
  // Use defaultChannelsStore for channel names
  const { bspName } = defaultChannelsStore; 

  function assignID(data: any[] | undefined, prefix: string): any[] | undefined {
    try {
        if (data != undefined) {
            let id = prefix + 1
            data.forEach(d => {
                d.ID = id
                id += 1
            })
    
            return data
        }
    } catch {
        return undefined
    }
  }

  function reduceData(collection: any[] | undefined, x: string, y: string): DataPoint[] {
    if (collection != undefined && collection.length > 0) {
        // Try both original case and lowercase - data fields may be in either format
        const xFieldLower = x.toLowerCase();
        const yFieldLower = y.toLowerCase();
        
        // For target data, fields are typically lowercase without suffix (e.g., "tws", "bsp")
        // But channel names from defaultChannelsStore may have suffix (e.g., "Tws_kph", "Bsp_kph")
        // Extract base field name by removing common suffixes
        const xBaseField = xFieldLower.replace(/[_\s]*(kph|kts|deg|perc)$/i, '').replace(/[_\s]/g, '');
        const yBaseField = yFieldLower.replace(/[_\s]*(kph|kts|deg|perc)$/i, '').replace(/[_\s]/g, '');
        
        // Filter data where y field is not null (try multiple field name variations)
        let data = collection.filter(d => {
            return (d[y] !== null && d[y] !== undefined) || 
                   (d[yFieldLower] !== null && d[yFieldLower] !== undefined) ||
                   (d[yBaseField] !== null && d[yBaseField] !== undefined);
        });

        if (data.length > 0) {
            // Determine which field names actually exist in the data
            const firstItem = data[0];
            const availableFields = Object.keys(firstItem);
            
            // Try to find x field: try exact match, then lowercase, then base field
            let xField = x;
            if (x in firstItem) {
                xField = x;
            } else if (xFieldLower in firstItem) {
                xField = xFieldLower;
            } else if (xBaseField in firstItem) {
                xField = xBaseField;
            } else {
                // Try to find by partial match (e.g., "tws" in "Tws_kph" or vice versa)
                const xMatch = availableFields.find(f => 
                    f.toLowerCase() === xBaseField || 
                    f.toLowerCase().replace(/[_\s]*(kph|kts|deg|perc)$/i, '').replace(/[_\s]/g, '') === xBaseField
                );
                if (xMatch) {
                    xField = xMatch;
                }
            }
            
            // Try to find y field: try exact match, then lowercase, then base field
            let yField = y;
            if (y in firstItem) {
                yField = y;
            } else if (yFieldLower in firstItem) {
                yField = yFieldLower;
            } else if (yBaseField in firstItem) {
                yField = yBaseField;
            } else {
                // Try to find by partial match
                const yMatch = availableFields.find(f => 
                    f.toLowerCase() === yBaseField || 
                    f.toLowerCase().replace(/[_\s]*(kph|kts|deg|perc)$/i, '').replace(/[_\s]/g, '') === yBaseField
                );
                if (yMatch) {
                    yField = yMatch;
                }
            }
            
            // Check if both x and y fields exist in the data
            if (xField in firstItem && yField in firstItem) {
                data.forEach(d => {
                    if (d[yField] == undefined || d[yField] == null) {
                        d[yField] = 0
                    }

                    if (d[xField] == undefined || d[xField] == null) {
                        d[xField] = 0
                    }
                })

                return data.map(d => ({
                    ID: +d.ID,
                    X: +d[xField] || 0,
                    Y: +d[yField] || 0
                }))
            } else {
                // Log warning if fields don't exist
                warn(`TargetScatter: Fields not found in data. Looking for x: "${x}" (tried: ${x}, ${xFieldLower}, ${xBaseField}), y: "${y}" (tried: ${y}, ${yFieldLower}, ${yBaseField}). Found xField: "${xField}", yField: "${yField}". Available fields:`, availableFields);
                return []
            }
        } else {
            return []
        }
    } else {
        return []
    }
  }

  function getXBounds(targets: DataPoint[][]) {
      xMin = 9999999
      xMax = -9999999

      targets.forEach(targetArray => {
          if (targetArray && targetArray.length > 0) {
              targetArray.forEach(d => {
                  if (d.X > xMax) {
                      xMax = d.X;
                  }

                  if (d.X < xMin) {
                      xMin = d.X;
                  }
              });
          }
      });

      xMax = Number((xMax + 0.5).toFixed(0));
      xMin = Number((xMin - 0.5).toFixed(0));
  }

  function getYBounds(targets: DataPoint[][]) {
      yMin = 9999999;
      yMax = -9999999;

      targets.forEach(targetArray => {
          if (targetArray && targetArray.length > 0) {
              targetArray.forEach(d => {
                  if (d.Y > yMax) {
                      yMax = d.Y;
                  }

                  if (d.Y < yMin) {
                      yMin = d.Y;
                  }
              });
          }
      });

      let int = Number((Math.abs(yMax - yMin) / 2).toFixed(1));
      if (int == 0) {
          int = 0.2
      }

      yMax = Number((yMax + int).toFixed(1));
      yMin = Number((yMin - int).toFixed(1));
  }

  function drawAxes() {
    const xymargin = { top: 20, right: 30, bottom: 50, left: 60 }; // Margins
    let chartWidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right;
    // When zoomed, use parent height if container has no height yet (layout not ready)
    const containerHeight = props.zoom && chartRef ? (chartRef.clientHeight || chartRef.parentElement?.clientHeight || 0) : chartRef?.clientHeight ?? 0;
    let chartHeight = props.zoom
      ? Math.max(400, containerHeight * 0.9 - xymargin.top - xymargin.bottom)
      : 400;

    if (props.class_name == 'col1') {
      chartWidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right;
      chartHeight = props.zoom
        ? (chartRef?.parentElement?.clientHeight ?? containerHeight) * 0.9 - xymargin.top - xymargin.bottom
        : (chartRef?.clientHeight ?? 0) - xymargin.top - xymargin.bottom;
      if (props.zoom && chartHeight < 400) chartHeight = Math.max(400, chartHeight);
    } else if (props.class_name == 'col2') {
      chartWidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right;
      chartHeight = props.zoom ? (chartRef?.parentElement?.clientHeight ?? 0) * 0.9 - xymargin.top - xymargin.bottom : 600 - xymargin.top - xymargin.bottom;
    } else if (props.class_name == 'col3') {
      chartWidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right;
      chartHeight = props.zoom ? (chartRef?.parentElement?.clientHeight ?? 0) * 0.9 - xymargin.top - xymargin.bottom : (chartRef?.clientHeight ?? 0) - xymargin.top - xymargin.bottom;
    } 

    // Use default channel names to determine axis label
    const bspChannel = bspName().toLowerCase();
    const xaxisLower = xaxis.toLowerCase();
    
    let xaxisLabel = 'TWS [KPH]';
    if (xaxisLower === bspChannel || xaxisLower === 'bsp') {
      xaxisLabel = 'BSP [KPH]';
    }

    let make_x_gridlines = (xScale) => {
      return d3.axisBottom(xScale).ticks(5).tickFormat(myTickFormat)
    }

    let make_y_gridlines = (yScale) => {
      return d3.axisLeft(yScale).ticks(5).tickFormat(myTickFormat)
    }

    //start with clean slate
    d3.select(chartRef).selectAll("svg").remove();

    // append the svg object to the body of the page
    let chart = d3.select(chartRef)
      .append("svg")
          .attr("width", chartWidth + margin.left + margin.right)
          .attr("height", chartHeight + margin.top + margin.bottom)
          .on("dblclick", function() {
            props.handleZoom([props.xaxis, props.yaxis, props.filters, props.green, props.red, props.blue]);
          })
      .append("g")
          .attr("transform","translate(" + margin.left + "," + margin.top + ")");
             
    // Add X axis
    xScale = d3.scaleLinear().range([0, chartWidth])
      .domain([xMin, xMax]) 

    chart.append("g")
      .attr("class","axes")
      .attr("transform", "translate(0," + chartHeight + ")")
      .call(d3.axisBottom(xScale))

    // Add Y axis
    yScale = d3.scaleLinear().range([chartHeight, 0])
      .domain([yMin, yMax]) 

    chart.append("g") 
      .attr("class","axes")
      .call(d3.axisLeft(yScale))
    
    //Add Axis Labels
    chart.append("text")
      .attr("class", "y-label chart-element")
      .attr("text-anchor", "left")  
      .attr("transform", "translate(35,20)")  // Offset 15px to the right (was 20, now 35)
      .attr("font-size", "14px")
      .attr("user-select", "none")
      .attr("pointer-events", "none")
      .text(yaxis.toUpperCase()) 

    chart.append("text")
      .attr("class", "x-label chart-element")
      .attr("text-anchor", "middle")  
      .attr("transform", "translate("+ (chartWidth/2) +","+(chartHeight + 40)+")")  
      .attr("font-size", "14px")
      .attr("user-select", "none")
      .attr("pointer-events", "none")
      .text(xaxisLabel)

    chart.append("g")
      .attr("class","grid")
      .attr("transform","translate(0," + chartHeight + ")")
      .style("stroke-dasharray",("3,3"))
      .call(make_x_gridlines(xScale)
          .tickSize(-chartHeight)
          .tickFormat("")
        )

    chart.append("g")
      .attr("class","grid")
      .style("stroke-dasharray",("3,3"))
      .call(make_y_gridlines(yScale)
          .tickSize(-chartWidth)
          .tickFormat("")
        )
  }

  function drawSpline(data, class_name) {
      // append the svg object to the body of the page
      let chart = d3.select(chartRef).select("svg").select("g")

      if (data != undefined) {
          //Filter Data Bounds - include points at boundaries
          let xfiltered = data
              .filter(d => d.X >= xMin && d.X <= xMax)
              
          let yfiltered = xfiltered
              .filter(d => d.Y >= yMin && d.Y <= yMax)

          let filtereddata = yfiltered
          let valueline = d3.line()
              .curve(d3.curveMonotoneX)
              .x(d => xScale(d['X']))
              .y(d => yScale(d['Y']))

          chart.append("path")
              .datum(filtereddata)
              .attr("d", valueline)
              .attr("class", class_name)
      }
  }

  function drawScatter(red_targets_r, blue_targets_r, green_targets_r) {
    try {
      let chart = d3.select(chartRef).select("svg").select("g");

      const { mouseID, setMouseID } = props; // Optional shared hover state

      const handleMouseOver = (event, d) => {
        if (typeof setMouseID === "function") setMouseID(d.ID);

        // Tooltip functionality
        const tooltipContent = getTooltipContent(d);
        const containerRect = containerRef.getBoundingClientRect();
        const containerX = event.clientX - containerRect.left;
        const containerY = event.clientY - containerRect.top;

        setTooltip({
          visible: true,
          content: tooltipContent,
          x: containerX,
          y: containerY,
        });
      };

      const handleMouseOut = () => {
        if (typeof setMouseID === "function") setMouseID(null);

        // Hide tooltip
        setTooltip({
          visible: false,
          content: "",
          x: 0,
          y: 0,
        });
      };

      const scatterPoints = [
        { data: red_targets_r, color: "red" },
        { data: blue_targets_r, color: "blue" },
        { data: green_targets_r, color: "green" },
      ];

      scatterPoints.forEach(({ data, color }) => {
        chart
          .append("g")
          .selectAll("circle")
          .data(data)
          .join("circle")
          .attr("cx", (d) => xScale(d.X))
          .attr("cy", (d) => yScale(d.Y))
          .attr("r", (d) => (mouseID === d.ID ? 8 : 4)) 
          .style("fill", color)
          .style("stroke", "black")
          .style("cursor", "pointer")
          .on("mouseover", handleMouseOver)
          .on("mouseout", handleMouseOut)
          .transition()
          .duration(200) 
          .attr("r", (d) => (mouseID === d.ID ? 8 : 4));
      });
    } catch {

    }
  }

  const getTooltipContent = (point) => {
    if (!point) return "";

    return `<table class='table-striped'>
              <tr><td>${props.xaxis.toUpperCase()}</td><td>${parseFloat(point.X).toFixed(1)}</td></tr>
              <tr><td>${props.yaxis.toUpperCase()}</td><td>${parseFloat(point.Y).toFixed(1)}</td></tr>
            </table>`;
  };

  const drawChart = () => {
    let green_data = []
    let red_data = []
    let blue_data = []

    if (filters.length > 0) {
      filters.forEach((filter) => {
        if (filter == 'upwind') {
          green_data = assignID(green['UPWIND'],0)
          red_data = assignID(red['UPWIND'],20)
          blue_data = assignID(blue['UPWIND'],30)
        } else if (filter == 'downwind') {
          green_data = assignID(green['DOWNWIND'],0)
          red_data = assignID(red['DOWNWIND'],20)
          blue_data = assignID(blue['DOWNWIND'],30)
        }
      })
    } else {
      green_data = assignID(green['UPWIND'],0)
      red_data = assignID(red['UPWIND'],20)
      blue_data = assignID(blue['UPWIND'],30)
    }

    var red_data_r = reduceData(red_data, xaxis, yaxis)
    var blue_data_r = reduceData(blue_data, xaxis, yaxis)
    var green_data_r = reduceData(green_data, xaxis, yaxis)

    getYBounds([red_data_r, blue_data_r, green_data_r])
    getXBounds([red_data_r, blue_data_r, green_data_r])
    drawAxes()

    drawSpline(red_data_r, "tgt_port")
    drawSpline(blue_data_r, "tgt_blue")
    drawSpline(green_data_r, "tgt_stbd")

    drawScatter(red_data_r, blue_data_r, green_data_r)
  };

  createEffect(() => drawChart());
  onMount(() => drawChart());

  onCleanup(() => {
    d3.select(chartRef).selectAll("*").remove(); // Ensure cleanup on unmount
  });

  const infoType = () => props.infoType ?? "";
  const infoMessage = () => (props.infoMessage ?? "").trim();
  const showInfoIcon = () => infoType() === "info" && infoMessage().length > 0;
  const showWarningIcon = () => infoType() === "warning" && infoMessage().length > 0;
  const showInfoOrWarning = () => showInfoIcon() || showWarningIcon();

  const INFO_TOOLTIP_OFFSET = 15;
  const INFO_TOOLTIP_MAX_WIDTH = 280;
  const INFO_TOOLTIP_SHIFT_LEFT = INFO_TOOLTIP_MAX_WIDTH / 2;

  const getInfoTooltipPosition = (e: MouseEvent) => {
    try {
      const x = e.clientX + INFO_TOOLTIP_OFFSET;
      const y = e.clientY + INFO_TOOLTIP_OFFSET;
      const shiftLeft = x + INFO_TOOLTIP_MAX_WIDTH > window.innerWidth;
      return {
        x: shiftLeft ? e.clientX - INFO_TOOLTIP_SHIFT_LEFT - INFO_TOOLTIP_OFFSET : x,
        y,
      };
    } catch {
      return { x: e.clientX + INFO_TOOLTIP_OFFSET, y: e.clientY + INFO_TOOLTIP_OFFSET };
    }
  };

  const onInfoIconMouseEnter = (e: MouseEvent) => {
    const msg = infoMessage();
    if (msg.length === 0) return;
    const position = getInfoTooltipPosition(e);
    const escaped = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    setTooltip({
      visible: true,
      content: `<span class="advanced-scatter-info-tooltip">${escaped}</span>`,
      x: position.x,
      y: position.y,
    });
  };
  const onInfoIconMouseMove = (e: MouseEvent) => {
    if (infoMessage().length === 0) return;
    const position = getInfoTooltipPosition(e);
    setTooltip((prev) => (prev.visible ? { ...prev, x: position.x, y: position.y } : prev));
  };
  const onInfoIconMouseLeave = () => {
    setTooltip({ visible: false, content: "", x: 0, y: 0 });
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <div
        ref={(el) => { chartRef = el }}
        style={{ width: "100%", height: "100%", display: "block" }}
      ></div>
      <Show when={showInfoOrWarning()}>
        <div
          class="advanced-scatter-info-icon-wrap"
          role="img"
          aria-label={infoType() === "warning" ? "Warning" : "Info"}
          onMouseEnter={onInfoIconMouseEnter}
          onMouseMove={onInfoIconMouseMove}
          onMouseLeave={onInfoIconMouseLeave}
        >
          <Show when={showInfoIcon()}>
            <img
              src={infoIconUrl}
              alt="Info"
              class="advanced-scatter-info-icon"
              classList={{ "advanced-scatter-info-icon-dark": isDark() }}
            />
          </Show>
          <Show when={showWarningIcon()}>
            <img
              src={warningIconUrl}
              alt="Warning"
              class="advanced-scatter-info-icon"
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}

