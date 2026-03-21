/**
 * Compact summary of selected grade and state filters for performance reports.
 * One pill per filter value, styled like PerfSettings (grade = orange, state = green) but smaller.
 * Optional Training/Racing pill when either is selected.
 */

import { For, Show } from "solid-js";

interface PerformanceFilterSummaryProps {
  filterGrades: string;
  filterState: string;
  /** When 'TRAINING' or 'RACING', show a pill; otherwise don't show. */
  trainingRacing?: "TRAINING" | "RACING" | null;
  /** When true (e.g. maneuver page), format grade pills as ">1", ">2", etc. */
  gradeAsGreaterThan?: boolean;
}

function parseGradeValues(grades: string, prefixGreaterThan: boolean): string[] {
  const s = (grades || "").trim();
  if (!s) return ["All grades"];
  const list = s.split(",").map((g) => g.trim()).filter(Boolean);
  if (list.length === 0) return ["All grades"];
  return prefixGreaterThan ? list.map((g) => `>${g}`) : list;
}

function parseStateValues(state: string): string[] {
  const s = (state || "").trim();
  if (!s) return ["All"];
  const list = s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  return list.length > 0 ? list : ["All"];
}

export default function PerformanceFilterSummary(props: PerformanceFilterSummaryProps) {
  const gradeValues = () => parseGradeValues(props.filterGrades, !!props.gradeAsGreaterThan);
  const stateValues = () => parseStateValues(props.filterState);

  return (
    <div class="performance-filter-summary" aria-label="Active filters">
      <span class="performance-filter-summary__title">Active Filters</span>
      <div class="performance-filter-summary__row performance-filter-summary__row--inline">
        <div class="performance-filter-summary__group">
          <span class="performance-filter-summary__row-label">Grade:</span>
          <div class="performance-filter-summary__pills">
            <For each={gradeValues()}>
              {(value) => <span class="performance-filter-summary__pill performance-filter-summary__pill--grade">{value}</span>}
            </For>
          </div>
        </div>
        <div class="performance-filter-summary__group">
          <span class="performance-filter-summary__row-label">State:</span>
          <div class="performance-filter-summary__pills">
            <For each={stateValues()}>
              {(value) => <span class="performance-filter-summary__pill performance-filter-summary__pill--state">{value}</span>}
            </For>
          </div>
        </div>
        <Show when={props.trainingRacing === "TRAINING" || props.trainingRacing === "RACING"}>
          <div class="performance-filter-summary__group">
            <span class="performance-filter-summary__row-label">Type:</span>
            <div class="performance-filter-summary__pills">
              <span class="performance-filter-summary__pill performance-filter-summary__pill--trainingracing">{props.trainingRacing}</span>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
