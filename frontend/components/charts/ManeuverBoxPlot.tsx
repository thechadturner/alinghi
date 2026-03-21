import { createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { filtered, color, tabledata, tooltip, setTooltip } from "../../store/globalStore";
import { isDark } from "../../store/themeStore";
import { getColorByIndex } from "../../utils/colorScale";
import { buildColorGrouping } from "../../utils/colorGrouping";

interface ManeuverBoxPlotProps {
  channels: string[];
}

export default function ManeuverBoxPlot(props: ManeuverBoxPlotProps) {
  let containerRef: HTMLElement | null = null;

  // Calculate VMG intervals (5 intervals from min to max)
  const calculateVmgIntervals = (rows: any[]): { min: number; max: number; intervalSize: number; getInterval: (vmg: number) => string | null } | null => {
    const vmgValues = rows
      .map(r => parseFloat(r.vmg_perc_avg))
      .filter(v => !isNaN(v) && v !== null && v !== undefined);
    
    if (vmgValues.length === 0) return null;
    
    const min = Math.min(...vmgValues);
    const max = Math.max(...vmgValues);
    
    // Handle edge case where all values are the same
    if (min === max) {
      return {
        min,
        max,
        intervalSize: 0,
        getInterval: () => `${min.toFixed(1)}-${max.toFixed(1)}`
      };
    }
    
    const intervalSize = (max - min) / 5;
    
    return {
      min,
      max,
      intervalSize,
      getInterval: (vmg) => {
        if (vmg < min || vmg > max) return null;
        const intervalIndex = Math.min(4, Math.floor((vmg - min) / intervalSize));
        const intervalMin = min + (intervalIndex * intervalSize);
        const intervalMax = intervalIndex === 4 ? max : min + ((intervalIndex + 1) * intervalSize);
        return `${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`;
      }
    };
  };

  const groupKey = () => {
    switch (color()) {
      case 'TWS': return 'tws_bin';
      case 'VMG': return 'vmg_interval'; // Special handling for VMG intervals
      case 'TACK': return 'tack';
      case 'RACE': return 'Race_number';
      case 'SOURCE': return 'source_name';
      case 'STATE': return 'State';
      case 'CONFIG': return 'Config';
      default: return 'tws_avg';
    }
  };

  function buildGroupedValues(channel: string) {
    const key = groupKey();
    const rows = tabledata().filter(r => filtered().includes(r.event_id));
    // Use shared color grouping scale to align colors with legends/groups
    const { scale } = buildColorGrouping(rows, String(color()));
    
    // For VMG, calculate intervals first
    let vmgIntervals = null;
    if (color() === 'VMG') {
      vmgIntervals = calculateVmgIntervals(rows);
    }
    
    const by = new Map();
    // Track vmg_perc_avg values per group for performance page star
    const vmgByGroup = new Map();
    
    rows.forEach(r => {
      let k;
      if (color() === 'VMG' && vmgIntervals) {
        const vmg = parseFloat(r.vmg_perc_avg);
        k = vmgIntervals.getInterval(vmg);
        if (!k) return; // Skip invalid values
      } else {
        k = r[key];
      }
      if (!by.has(k)) by.set(k, []);
      const v = Number(r[channel]);
      if (!isNaN(v)) by.get(k).push(v);
      
      // Track vmg_perc_avg for this group
      if (!vmgByGroup.has(k)) vmgByGroup.set(k, []);
      const vmgVal = parseFloat(r.vmg_perc_avg);
      if (!isNaN(vmgVal) && vmgVal !== null && vmgVal !== undefined) {
        vmgByGroup.get(k).push(vmgVal);
      }
    });
    const groups = Array.from(by.entries()).map(([k, vals], idx) => {
      let c = getColorByIndex(idx);
      try {
        if (String(color()) === 'TACK') {
          const t = String(k);
          c = (t === 'PORT' || t === 'P - S') ? '#d62728' : (t === 'STBD' || t === 'S - P') ? '#2ca02c' : c;
        } else if (String(color()) === 'VMG' && vmgIntervals) {
          // For VMG intervals, extract the min value from the interval string for color scale
          const intervalMin = parseFloat(String(k).split('-')[0]);
          if (!isNaN(intervalMin)) {
            c = (scale && typeof scale === 'function') ? scale(intervalMin) : c;
          }
        } else {
          const valForScale = (String(color()) === 'TWS') ? Number(k) : (typeof k === 'string' ? k.toLowerCase() : k);
          c = (scale && typeof scale === 'function') ? scale(valForScale) : c;
        }
      } catch {}
      
      // Calculate mean vmg_perc_avg for this group
      let meanVmg: number | null = null;
      if (vmgByGroup.has(k)) {
        const vmgVals = vmgByGroup.get(k);
        if (vmgVals && vmgVals.length > 0) {
          meanVmg = d3.mean(vmgVals) ?? null;
        }
      }
      
      return { key: k, vals: vals.sort((a: number, b: number) => a - b), color: c, meanVmg };
    });
    // Sort groups: for VMG intervals, sort by the min value; otherwise use string/numeric comparison
    groups.sort((a: { key: any; vals: number[]; color: string }, b: { key: any; vals: number[]; color: string }) => {
      if (String(color()) === 'VMG' && vmgIntervals) {
        const aMin = parseFloat(String(a.key).split('-')[0]);
        const bMin = parseFloat(String(b.key).split('-')[0]);
        if (!isNaN(aMin) && !isNaN(bMin)) {
          return aMin - bMin;
        }
      }
      return (a.key > b.key ? 1 : -1);
    });
    return groups;
  }

  function draw() {
    if (!containerRef) return;
    const width = containerRef.clientWidth || 1200;

    // Only remove prior SVG to preserve the tooltip overlay element
    d3.select(containerRef).selectAll('svg').remove();

    const channels = props.channels;
    const margin = { top: 20, right: 60, bottom: 60, left: 60 }; // Increased right margin for mean labels
    const cols = 3;
    const colGap = 50; // horizontal spacing between plots
    const rowGap = 80; // vertical spacing between plots (further increased)
    const plotW = Math.max(260, (width - margin.left - margin.right - (cols-1)*colGap) / cols);
    const widthScale = 0.85; // reduce each plot width to make room for labels
    const plotInnerW = Math.max(200, plotW * widthScale);
    const plotH = 400;

    const svg = d3.select(containerRef)
      .append('svg')
      .attr('width', width)
      .attr('height', margin.top + margin.bottom + Math.ceil(channels.length/cols) * (plotH + rowGap));

    const textColor = isDark() ? '#ffffff' : '#000000';

    channels.forEach((channel, idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const gx = margin.left + col * (plotW + colGap) + (plotW - plotInnerW) / 2 - 50;
      const gy = margin.top + row * (plotH + rowGap);

      const g = svg.append('g').attr('transform', `translate(${gx},${gy})`);

      const groups = buildGroupedValues(channel);
      const x = d3.scaleBand().domain(groups.map(d => String(d.key))).range([0, plotInnerW]).padding(0.3);

      const allVals = groups.flatMap(gp => gp.vals);
      const rawMin = d3.min(allVals) ?? 0;
      const rawMax = d3.max(allVals) ?? 1;
      const pad = (rawMax - rawMin) * 0.1;
      const y = d3.scaleLinear().domain([rawMin - pad, rawMax + pad]).nice().range([plotH, 0]);

      g.append('g')
        .attr('class', 'x-axis')
        .attr('transform', `translate(0,${plotH})`)
        .call(d3.axisBottom(x))
        .selectAll('text')
        .attr('transform', 'rotate(-30)')
        .style('text-anchor', 'end');
      g.append('g')
        .attr('class', 'y-axis')
        .call(d3.axisLeft(y).ticks(4));

      // Axis label colors for dark/light mode
      g.selectAll('.x-axis text, .y-axis text').style('fill', textColor);

      // Calculate overall mean of all y-values and draw as grey dashed line
      const overallMean = d3.mean(allVals) ?? 0;
      g.append('line')
        .attr('class', 'subaxis')
        .attr('x1', 0)
        .attr('x2', plotInnerW)
        .attr('y1', y(overallMean))
        .attr('y2', y(overallMean))
        .attr('stroke', '#808080')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '5,5')
        .style('pointer-events', 'none');

      // Add overall mean label on the right side
      g.append('text')
        .attr('x', plotInnerW + 4)
        .attr('y', y(overallMean))
        .attr('text-anchor', 'start')
        .attr('font-size', '10px')
        .attr('fill', '#808080')
        .attr('dy', '0.35em')
        .style('pointer-events', 'none')
        .text(overallMean.toFixed(1));

      // Helpers for tooltip
      const getTooltipPosition = (event: MouseEvent) => {
        try {
          if (!containerRef) return { x: 0, y: 0 };
          const rect = containerRef.getBoundingClientRect();
          const containerX = event.clientX - rect.left;
          const containerY = event.clientY - rect.top;
          const pad = 12;            // base offset from cursor
          const estWidth = 220;      // estimated tooltip width in px
          const estHeight = 140;     // estimated tooltip height in px

          // Horizontal placement: prefer right of cursor, flip to left if overflowing
          let xPos = containerX + pad;
          if (containerX + pad + estWidth > rect.width) {
            xPos = Math.max(0, containerX - estWidth - pad);
          }

          // Vertical placement: prefer slightly above cursor, adjust for edges
          let yPos = containerY - 40;
          if (containerY - estHeight < 0) {
            yPos = Math.max(0, containerY + pad);
          } else if (containerY + pad + estHeight > rect.height) {
            yPos = Math.max(0, rect.height - estHeight - pad);
          }
          return { x: xPos, y: yPos };
        } catch {
          return { x: 0, y: 0 };
        }
      };

      const showTooltip = (event: MouseEvent, data: { group: string; min: number; q1: number; q2: number; q3: number; max: number; mean: number; count: number }) => {
        const pos = getTooltipPosition(event);
        const w = "min-width:50px;";
        const content = `<table class='table-striped'>
              <tr><td>GROUP:</td><td style='${w}'>${data.group}</td></tr>
              <tr><td>COUNT:</td><td style='${w}'>${data.count}</td></tr>
              <tr><td>MAX:</td><td style='${w}'>${(Math.round(data.max*10)/10)}</td></tr>
              <tr><td>Q3:</td><td style='${w}'>${(Math.round(data.q3*10)/10)}</td></tr>
              <tr><td>MEAN:</td><td style='${w}'>${(Math.round(data.mean*10)/10)}</td></tr>
              <tr><td>MEDIAN:</td><td style='${w}'>${(Math.round(data.q2*10)/10)}</td></tr>
              <tr><td>Q1:</td><td style='${w}'>${(Math.round(data.q1*10)/10)}</td></tr>
              <tr><td>MIN:</td><td style='${w}'>${(Math.round(data.min*10)/10)}</td></tr>
            </table>`;
        setTooltip({ visible: true, content, x: pos.x, y: pos.y });
      };

      const hideTooltip = () => {
        setTooltip({ visible: false, content: "", x: 0, y: 0 });
      };

      // Find group with highest mean vmg_perc_avg for performance page star
      let highestVmgGroup: { key: any; meanVmg: number | null } | null = null;
      const isPerformanceData = groups.some(g => g.meanVmg !== null && g.meanVmg !== undefined);
      if (isPerformanceData) {
        highestVmgGroup = groups.reduce((max, gp) => {
          if (gp.meanVmg !== null && gp.meanVmg !== undefined) {
            if (max === null || gp.meanVmg > max.meanVmg!) {
              return { key: gp.key, meanVmg: gp.meanVmg };
            }
          }
          return max;
        }, null as { key: any; meanVmg: number | null } | null);
      }

      // compute box stats and draw per group
      const boxWidth = Math.max(10, x.bandwidth() * 0.6);
      groups.forEach(gp => {
        const q1 = d3.quantile(gp.vals, 0.25) ?? 0;
        const q2 = d3.quantile(gp.vals, 0.50) ?? 0;
        const q3 = d3.quantile(gp.vals, 0.75) ?? 0;
        const min = gp.vals.length ? gp.vals[0] : 0;
        const max = gp.vals.length ? gp.vals[gp.vals.length - 1] : 0;
        const mean = gp.vals.length ? (d3.mean(gp.vals) ?? 0) : 0;
        const xCenter = (x(String(gp.key)) ?? 0) + x.bandwidth()/2;

        // group container for interaction and unified tooltip
        const boxGroup = g.append('g')
          .attr('class', 'box-group');

        // large invisible hit area to ensure mouse events trigger reliably (no hand cursor)
        boxGroup.append('rect')
          .attr('x', x(String(gp.key)) ?? 0)
          .attr('y', 0)
          .attr('width', x.bandwidth())
          .attr('height', plotH)
          .attr('fill', 'transparent')
          .style('pointer-events', 'all')
          .style('cursor', 'default');

        // vertical line (whisker) - show hand cursor
        boxGroup.append('line')
          .attr('x1', xCenter)
          .attr('x2', xCenter)
          .attr('y1', y(min))
          .attr('y2', y(max))
          .attr('stroke', '#555')
          .style('cursor', 'pointer');

        // end caps as hollow circles (white stroke, no fill) - show hand cursor
        boxGroup.append('circle')
          .attr('cx', xCenter)
          .attr('cy', y(min))
          .attr('r', 4)
          .attr('fill', 'none')
          .attr('stroke', '#ffffff')
          .attr('stroke-width', 1.5)
          .style('cursor', 'pointer')
          .on('mouseover', (event) => showTooltip(event, { group: String(gp.key), min, q1, q2, q3, max, mean, count: gp.vals.length }))
          .on('mousemove', (event) => showTooltip(event, { group: String(gp.key), min, q1, q2, q3, max, mean, count: gp.vals.length }))
          .on('mouseout', hideTooltip);

        boxGroup.append('circle')
          .attr('cx', xCenter)
          .attr('cy', y(max))
          .attr('r', 4)
          .attr('fill', 'none')
          .attr('stroke', '#ffffff')
          .attr('stroke-width', 1.5)
          .style('cursor', 'pointer')
          .on('mouseover', (event) => showTooltip(event, { group: String(gp.key), min, q1, q2, q3, max, mean, count: gp.vals.length }))
          .on('mousemove', (event) => showTooltip(event, { group: String(gp.key), min, q1, q2, q3, max, mean, count: gp.vals.length }))
          .on('mouseout', hideTooltip);

        // box - show hand cursor
        boxGroup.append('rect')
          .attr('x', xCenter - boxWidth/2)
          .attr('y', y(q3))
          .attr('width', boxWidth)
          .attr('height', Math.max(1, y(q1) - y(q3)))
          .attr('fill', gp.color)
          .attr('opacity', 0.7)
          .attr('stroke', '#333')
          .style('cursor', 'pointer')
          .on('mouseover', (event) => showTooltip(event, { group: String(gp.key), min, q1, q2, q3, max, mean, count: gp.vals.length }))
          .on('mousemove', (event) => showTooltip(event, { group: String(gp.key), min, q1, q2, q3, max, mean, count: gp.vals.length }))
          .on('mouseout', hideTooltip);

        // Add gold star above max whisker for highest vmg_perc_avg box on performance page
        // Only show star if there's more than one category
        if (groups.length > 1 && isPerformanceData && highestVmgGroup && String(gp.key) === String(highestVmgGroup.key)) {
          boxGroup.append('text')
            .attr('x', xCenter)
            .attr('y', y(max) - 15)
            .attr('text-anchor', 'middle')
            .attr('font-size', '20px')
            .attr('fill', '#FFD700')
            .style('pointer-events', 'none')
            .text('★');
        }

        // median (match theme: white in dark, black in light)
        boxGroup.append('line')
          .attr('x1', xCenter - boxWidth/2)
          .attr('x2', xCenter + boxWidth/2)
          .attr('y1', y(q2))
          .attr('y2', y(q2))
          .attr('stroke', textColor)
          .attr('stroke-width', 2);

        // mean (white in dark mode, black in light mode)
        boxGroup.append('line')
          .attr('x1', xCenter - boxWidth/2)
          .attr('x2', xCenter + boxWidth/2)
          .attr('y1', y(mean))
          .attr('y2', y(mean))
          .attr('stroke', textColor)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '4,2');
      });

      // Add mean value labels outside the box to the right of the mean line when there are less than 7 categories total
      // Add them to the main group after all boxes are drawn so they render on top
      if (groups.length < 7) {
        const boxWidth = Math.max(10, x.bandwidth() * 0.6);
        groups.forEach(gp => {
          const mean = gp.vals.length ? (d3.mean(gp.vals) ?? 0) : 0;
          const xCenter = (x(String(gp.key)) ?? 0) + x.bandwidth()/2;
          const meanY = y(mean);
          const labelX = xCenter + boxWidth/2 + 4; // Position to the right of the mean line (right edge of box + 4px)
          
          const labelText = mean.toFixed(1);
          g.append('text')
            .attr('x', labelX)
            .attr('y', meanY)
            .attr('text-anchor', 'start')
            .attr('font-size', '10px')
            .attr('fill', textColor)
            .attr('dy', '0.35em')
            .style('pointer-events', 'none')
            .style('font-weight', 'normal')
            .style('opacity', 1)
            .text(labelText);
        });
      }

      // Y-axis label in upper left (matching PerfScatter style)
      // Add to svg with absolute coordinates for consistency
      svg.append('text')
        .attr('class', 'y-label chart-element')
        .attr('text-anchor', 'left')
        .attr('transform', `translate(${gx + 50}, ${gy + 10})`)
        .attr('font-size', '16px')
        .attr('fill', textColor)
        .text(channel.toUpperCase());
    });
  }

  createEffect(() => {
    draw();
  });

  onCleanup(() => {
    d3.select(containerRef).selectAll('*').remove();
    // hide tooltip on unmount
    try { setTooltip({ visible: false, content: "", x: 0, y: 0 }); } catch {}
  });

  return (
    <div ref={el => (containerRef = el)} style={{ width: '100%', height: '100%', position: 'relative', padding: '10px 30px 20px 50px' }}>
      <div id="tt" class="tooltip" style={{
          opacity: tooltip().visible ? 1 : 0,
          left: `${tooltip().x}px`,
          top: `${tooltip().y}px`,
          position: 'absolute',
          'pointer-events': 'none',
          'z-index': 9999
        }} innerHTML={tooltip().content}>
      </div>
    </div>
  );
}


