import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks to avoid initialization issues
const { mockPassesBasicFilters } = vi.hoisted(() => ({
  mockPassesBasicFilters: vi.fn(() => true)
}));

const { filterChartsBySelectionRef } = vi.hoisted(() => ({ filterChartsBySelectionRef: { value: false } }));

const { selectedRangesRef } = vi.hoisted(() => ({ selectedRangesRef: { value: [] as Array<{ start_time: string; end_time: string }> } }));

// Mock persistantStore so filterChartsBySelection is controllable (default: do not filter by selection)
vi.mock('../../../store/persistantStore', () => ({
  persistantStore: {
    filterChartsBySelection: () => filterChartsBySelectionRef.value
  }
}));

// Mock selection store signals used by dataFiltering (selectedRangesRef allows tests to inject ranges)
vi.mock('../../../store/selectionStore', () => ({
  selection: () => [],
  selectedRange: () => [],
  selectedRanges: () => selectedRangesRef.value,
  selectedEvents: () => [],
  hasSelection: () => selectedRangesRef.value.length > 0,
  cutEvents: () => [],
  selectedStates: () => [],
  selectedRaces: () => [],
  selectedLegs: () => [],
  selectedGrades: () => [],
  setRaceOptions: vi.fn(),
  setLegOptions: vi.fn(),
  setGradeOptions: vi.fn()
}));

// Mock console utils
vi.mock('../../../utils/console', () => ({
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
}));

// Mock filter core used by dataFiltering
vi.mock('../../../utils/filterCore', () => ({
  createFilterConfig: (states: any[], races: any[], legs: any[], grades: any[]) => ({
    twaStates: states,
    raceNumbers: races,
    legNumbers: legs,
    grades,
  }),
  getTimestamp: (d: any) => (d?.timestamp ?? (d?.Datetime ? new Date(d.Datetime).getTime() : undefined)),
  passesBasicFilters: mockPassesBasicFilters,
}));

// Import after mocks
import { applyDataFilter, applyTimelineFilter, processSelection } from '../../../utils/dataFiltering';

const baseData = [
  { Datetime: new Date('2024-01-01T00:00:00Z'), timestamp: 1704067200000, twa: 45, bsp: 12.5, Race_number: 1, Leg_number: 1, Grade: 1 },
  { Datetime: new Date('2024-01-01T00:01:00Z'), timestamp: 1704067260000, twa: 90, bsp: 15.2, Race_number: 1, Leg_number: 2, Grade: 1 },
  { Datetime: new Date('2024-01-01T00:02:00Z'), timestamp: 1704067320000, twa: 135, bsp: 18.1, Race_number: 2, Leg_number: 1, Grade: 2 },
  { Datetime: new Date('2024-01-01T00:03:00Z'), timestamp: 1704067380000, twa: 60, bsp: 14.3, Race_number: 2, Leg_number: 2, Grade: 2 },
  { Datetime: new Date('2024-01-01T00:04:00Z'), timestamp: 1704067440000, twa: 120, bsp: 16.7, Race_number: 3, Leg_number: 1, Grade: 3 },
];

describe('dataFiltering unit tests', () => {
  beforeEach(() => {
    mockPassesBasicFilters.mockReset();
    mockPassesBasicFilters.mockImplementation(() => true);
    filterChartsBySelectionRef.value = false;
    selectedRangesRef.value = [];
  });

  it('applyDataFilter returns all when no selection/cut and filters pass', () => {
    const result = applyDataFilter(baseData);
    expect(result).toHaveLength(5);
  });

  it('applyTimelineFilter returns all when no selection and filters pass', () => {
    const result = applyTimelineFilter(baseData);
    expect(result).toHaveLength(5);
  });

  it('applyDataFilter respects a selected time range (selectedRange) when filterChartsBySelection is true', async () => {
    filterChartsBySelectionRef.value = true;
    selectedRangesRef.value = [{ start_time: '2024-01-01T00:01:00Z', end_time: '2024-01-01T00:03:00Z' }];
    vi.resetModules();
    const { applyDataFilter: applyWithRange } = await import('../../../utils/dataFiltering');
    const result = applyWithRange(baseData);
    // 00:01, 00:02, 00:03 fall in range → 3 items
    expect(result).toHaveLength(3);
    filterChartsBySelectionRef.value = false;
    selectedRangesRef.value = [];
    vi.resetModules();
  });

  it('applyDataFilter ignores selected range when filterChartsBySelection is false', async () => {
    filterChartsBySelectionRef.value = false;
    selectedRangesRef.value = [{ start_time: '2024-01-01T00:01:00Z', end_time: '2024-01-01T00:03:00Z' }];
    vi.resetModules();
    const { applyDataFilter: applyWithRange } = await import('../../../utils/dataFiltering');
    const result = applyWithRange(baseData);
    // With filterChartsBySelection false, selection is ignored → all 5 items (TWA filters pass)
    expect(result).toHaveLength(5);
    selectedRangesRef.value = [];
    vi.resetModules();
  });

  it('processSelection marks items with event_id inside selection windows', () => {
    const selection = [
      { start_time: '2024-01-01T00:00:00Z', end_time: '2024-01-01T00:01:00Z', event_id: 101 },
    ];
    const result = processSelection(selection, baseData);
    const first = result.find(d => d.timestamp === 1704067200000);
    const second = result.find(d => d.timestamp === 1704067260000);
    expect(first?.event_id).toBe(101);
    expect(second?.event_id).toBe(101);
  });

  it('applyDataFilter honors passesBasicFilters returning false for some items', () => {
    // Fail every other item
    let call = 0;
    mockPassesBasicFilters.mockImplementation(() => (call++ % 2 === 0));
    const result = applyDataFilter(baseData);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(baseData.length);
  });
});


