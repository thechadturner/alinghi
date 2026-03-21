import DropDownButton from "../../buttons/DropDownButton";
import Filters from "../../buttons/Filters";

interface MapControlsProps {
  maptypes: string[];
  maptype: string;
  onColorBy: (value: string) => void;
  twaFilterOptions: any[];
  selectedStates: string[];
  raceOptions: any[];
  setRaceOptions: (options: any[]) => void;
  legOptions: any[];
  setLegOptions: (options: any[]) => void;
  gradeOptions: any[];
  setGradeOptions: (options: any[]) => void;
  selectedRaces: string[];
  selectedLegs: string[];
  selectedGrades: string[];
  onToggleFilter: (value: string) => void;
  onToggleRaceFilter: (value: string) => void;
  onToggleLegFilter: (value: string) => void;
  onToggleGradeFilter: (value: string) => void;
}

export default function MapControls(props: MapControlsProps) {
  return (
    <div class="map-button">
      <DropDownButton
        options={props.maptypes}
        defaultText={props.maptype}
        smallLabel="COLOR BY"
        size="medium"
        handleSelection={props.onColorBy}
      />
      {/* Filters component 10px below dropdown */}
      <div style={{ "margin-top": "10px" }}>
        <Filters
          options={props.twaFilterOptions}
          selectedStates={props.selectedStates}
          raceOptions={props.raceOptions}
          setRaceOptions={props.setRaceOptions}
          legOptions={props.legOptions}
          setLegOptions={props.setLegOptions}
          gradeOptions={props.gradeOptions}
          setGradeOptions={props.setGradeOptions}
          selectedRaces={props.selectedRaces}
          selectedLegs={props.selectedLegs}
          selectedGrades={props.selectedGrades}
          toggleFilter={props.onToggleFilter}
          toggleRaceFilter={props.onToggleRaceFilter}
          toggleLegFilter={props.onToggleLegFilter}
          toggleGradeFilter={props.onToggleGradeFilter}
          groupIndex={0}
          label="TWA FILTERS"
        />
      </div>
    </div>
  );
}
