import { createEffect } from "solid-js";
import * as d3 from "d3";

interface TargetLegendProps {
    elementId: string;
    redTargetName: string;
    greenTargetName: string;
    blueTargetName: string;
    onClick?: () => void;
}

function TargetLegend(props: TargetLegendProps) {
    let chartRef: HTMLDivElement | undefined;

    createEffect(() => {
        const { elementId, redTargetName, greenTargetName, blueTargetName, onClick } = props;
        const legendWidth = chartRef?.clientWidth ?? 800;
        const legendHeight = 40;

        // Remove existing SVG before re-rendering
        d3.select(`#${elementId}`).selectAll("svg").remove();

        const legend = d3.select(`#${elementId}`)
        .append("svg")
        .attr("width", legendWidth)
        .attr("height", legendHeight)
        .append("g")
        .attr("transform", "translate(0, 0)");

        // Add click event listener
        if (onClick) {
            d3.select(`#${elementId}`).on("click", onClick);
        }

        // RED
        legend.append("line")
        .attr("x1", 50).attr("y1", 21)
        .attr("x2", 100).attr("y2", 21)
        .attr("class", "tgt_port");

        legend.append("text")
        .attr("text-anchor", "left")  
        .attr("transform", "translate(125,25)")  
        .attr("font-size", "12px")
        .attr("class", "legend-text")
        .text(redTargetName.replace(/_target$/i, ''));

        // GREEN
        legend.append("line")
        .attr("x1", 375).attr("y1", 21)
        .attr("x2", 425).attr("y2", 21)
        .attr("class", "tgt_stbd");

        legend.append("text")
        .attr("text-anchor", "left")  
        .attr("transform", "translate(450,25)")  
        .attr("font-size", "12px")
        .attr("class", "legend-text")
        .text(greenTargetName.replace(/_target$/i, ''));

        // BLUE
        legend.append("line")
        .attr("x1", 700).attr("y1", 21)
        .attr("x2", 750).attr("y2", 21)
        .attr("class", "tgt_blue");

        legend.append("text")
        .attr("text-anchor", "left")  
        .attr("transform", "translate(775,25)")  
        .attr("font-size", "12px")
        .attr("class", "legend-text")
        .text(blueTargetName.replace(/_target$/i, ''));
    });

    return (
        <div class="legend" id={props.elementId}
            ref={(el) => { chartRef = el }}
            style={{ width: "100%", display: "block" }} 
        ></div>
  );
}


export default TargetLegend;
