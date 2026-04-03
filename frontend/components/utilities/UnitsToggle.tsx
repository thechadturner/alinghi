import { createSignal } from "solid-js";
import { persistantStore } from "../../store/persistantStore";
import { debug } from "../../utils/console";
import { metricSpeedPreference, nauticalSpeedPreference, speedUnitShortLabel } from "../../utils/speedUnits";

export default function UnitsToggle() {
    const { defaultUnits, setDefaultUnits, savePersistentSettings } = persistantStore;
    const [isSaving, setIsSaving] = createSignal(false);

    const handleUnitsToggle = () => {
        const currentUnits = defaultUnits();
        debug('Speed units toggle clicked - current:', currentUnits);
        setIsSaving(true);

        const newUnits = currentUnits === nauticalSpeedPreference ? metricSpeedPreference : nauticalSpeedPreference;
        setDefaultUnits(newUnits);
        savePersistentSettings();

        debug('Speed units toggle completed - new:', newUnits);

        setTimeout(() => {
            setIsSaving(false);
        }, 800);
    };

    const isKnotsUnit = () => defaultUnits() === nauticalSpeedPreference;

    return (
        <div class="units-toggle-container">
            <div class="units-toggle-label-row">
                <svg class="units-toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="units-toggle-title">Speed units</span>
            </div>

            <button
                type="button"
                class="units-toggle-track"
                onClick={handleUnitsToggle}
                disabled={isSaving()}
                aria-label={isKnotsUnit() ? 'Switch to kilometers per hour' : 'Switch to knots'}
            >
                <span class="units-toggle-knob" classList={{ 'units-toggle-knob--end': !isKnotsUnit() }} />
            </button>

            <div class="units-toggle-value-col">
                {isSaving() ? (
                    <div class="units-toggle-saving">
                        <span class="units-toggle-spinner" aria-hidden="true" />
                        <span>Saving...</span>
                    </div>
                ) : (
                    <span class="units-toggle-value-text">
                        {speedUnitShortLabel(defaultUnits()).toUpperCase()}
                    </span>
                )}
            </div>
        </div>
    );
}
