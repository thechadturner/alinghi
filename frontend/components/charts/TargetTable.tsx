import { createMemo, For, Show } from "solid-js";
import { round } from "../../utils/global";

interface TargetTableProps {
  xaxis: string;
  yaxis: string;
  filters: string[];
  green: Record<string, any[]>;
  red: Record<string, any[]>;
  blue: Record<string, any[]>;
  handleZoom?: (info: any[]) => void;
}

interface DataPoint {
  X: number;
  Y: number;
}

interface ReducedData {
  green: DataPoint[];
  red: DataPoint[];
  blue: DataPoint[];
}

export default function TargetTable(props: TargetTableProps) {
  const { xaxis, yaxis, filters, green, red, blue } = props;

  const reducedData = createMemo(() => {
    // Resolve actual field names from data (match TargetScatter's reduceData logic)
    const resolveFields = (collection: any[] | undefined): { xField: string; yField: string } | null => {
      if (!collection || collection.length === 0) return null;
      const first = collection[0];
      const availableFields = Object.keys(first);
      const xLower = xaxis.toLowerCase();
      const yLower = yaxis.toLowerCase();
      const xBase = xLower.replace(/[_\s]*(kph|kts|deg|perc)$/i, "").replace(/[_\s]/g, "");
      const yBase = yLower.replace(/[_\s]*(kph|kts|deg|perc)$/i, "").replace(/[_\s]/g, "");

      const resolve = (name: string, lower: string, base: string): string => {
        if (name in first) return name;
        if (lower in first) return lower;
        if (base in first) return base;
        const match = availableFields.find(
          (f) =>
            f.toLowerCase() === base ||
            f.toLowerCase().replace(/[_\s]*(kph|kts|deg|perc)$/i, "").replace(/[_\s]/g, "") === base
        );
        return match ?? name;
      };
      return { xField: resolve(xaxis, xLower, xBase), yField: resolve(yaxis, yLower, yBase) };
    };

    const processData = (collection: any[] | undefined): DataPoint[] => {
      if (!collection || collection.length === 0) return [];
      const fields = resolveFields(collection);
      if (!fields || !(fields.xField in collection[0]) || !(fields.yField in collection[0])) return [];
      const { xField, yField } = fields;
      return collection
        .filter((d) => d[yField] != null)
        .map((d) => ({
          X: +d[xField] || 0,
          Y: +d[yField] || 0,
        }));
    };

    // Default to UPWIND when filters empty (match TargetScatter behavior)
    const useUpwind =
      filters.length === 0 || filters.includes("upwind");
    const greenData = useUpwind ? green?.["UPWIND"] : green?.["DOWNWIND"];
    const redData = useUpwind ? red?.["UPWIND"] : red?.["DOWNWIND"];
    const blueData = useUpwind ? blue?.["UPWIND"] : blue?.["DOWNWIND"];

    return {
      green: processData(greenData),
      red: processData(redData),
      blue: processData(blueData),
    };
  });

  const xBounds = createMemo(() => {
    const allData = [...reducedData().green, ...reducedData().red, ...reducedData().blue];
    if (allData.length === 0) return { min: 0, max: 0 };
    const xValues = allData.map((d) => d.X);
    return {
      min: Math.floor(Math.min(...xValues) - 0.5),
      max: Math.ceil(Math.max(...xValues) + 0.5),
    };
  });

  const groups = createMemo(() => {
    const groupNames: string[] = [];
    if (reducedData().red.length > 0) groupNames.push("RED");
    if (reducedData().blue.length > 0) groupNames.push("BLUE");
    if (reducedData().green.length > 0) groupNames.push("GREEN");
    return groupNames;
  });

  const tableRows = createMemo(() => {
    // Aggregate by TWS rounded to zero decimals: group by Math.round(X), show average Y per bucket
    const roundedXSet = new Set<number>();
    [reducedData().red, reducedData().blue, reducedData().green].forEach((data) => {
      data.forEach((point) => roundedXSet.add(Math.round(point.X)));
    });
    const sortedXValues = Array.from(roundedXSet).sort((a, b) => a - b);

    const rows: Array<{ x: number; values: (number | string)[] }> = [];
    sortedXValues.forEach((xRounded) => {
      const row: { x: number; values: (number | string)[] } = { x: xRounded, values: [] };

      [reducedData().red, reducedData().blue, reducedData().green].forEach((data) => {
        if (data.length === 0) {
          row.values.push("-");
          return;
        }
        const inBucket = data.filter((point) => Math.round(point.X) === xRounded);
        if (inBucket.length === 0) {
          row.values.push("-");
          return;
        }
        const avgY = inBucket.reduce((sum, p) => sum + p.Y, 0) / inBucket.length;
        row.values.push(round(avgY, 1));
      });

      rows.push(row);
    });

    return rows;
  });


  return (
    <div class="col-span-4 mt-4">
      {/* <h2 class="text-xl font-bold centered mb-2">VALUES</h2> */}
      <div class="modern-table-container">
        <table class="modern-table compact target-table">
          <thead>
            <tr>
              <th class="target-table-header">{xaxis.toUpperCase()}</th>
              <For each={groups()}>{(group) => (
                <th class="target-table-header">
                  <span class="inline-block w-3 h-3 rounded-full mr-2" style={{
                    "background-color": group === 'RED' ? 'red' : group === 'BLUE' ? 'blue' : 'green'
                  }}></span>
                  {group}
                </th>
              )}</For>
              <Show when={groups().length === 2}>
                <th class="target-table-header">&#916;</th>
              </Show>
            </tr>
          </thead>
          <tbody>
            <For each={tableRows()}>
              {(row) => (
                <tr>
                  <td><strong>{row.x}</strong></td>
                  <For each={row.values}>{(value) => <td>{value}</td>}</For>
                  <Show when={groups().length === 2}>
                    <td>
                      {row.values[0] !== "-" && row.values[1] !== "-"
                        ? round(row.values[0] - row.values[1], 1)
                        : "-"}
                    </td>
                  </Show>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="text-center mt-4">
        <a href="#" onClick={(e) => { e.preventDefault(); props.handleZoom?.([]); }} class="text-blue-500 underline">
          Go Back to Multiple Charts
        </a>
      </div>
    </div>
  );
}



