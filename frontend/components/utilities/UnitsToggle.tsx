import { createSignal } from "solid-js";
import { persistantStore } from "../../store/persistantStore";
import { debug } from "../../utils/console";

export default function UnitsToggle() {
    const { defaultUnits, setDefaultUnits, savePersistentSettings } = persistantStore;
    const [isSaving, setIsSaving] = createSignal(false);

    const handleUnitsToggle = () => {
        const currentUnits = defaultUnits();
        debug('Units toggle clicked - current units:', currentUnits);
        setIsSaving(true);
        
        // Toggle between knots and meters
        const newUnits = currentUnits === 'knots' ? 'meters' : 'knots';
        setDefaultUnits(newUnits);
        savePersistentSettings();
        
        debug('Units toggle completed - new units:', newUnits);
        
        // Show saving indicator for a brief moment, then show success
        setTimeout(() => {
            setIsSaving(false);
        }, 800);
    };

    return (
        <div class="units-toggle-container" style="
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: var(--color-bg-card);
            border: 1px solid var(--color-border-primary);
            border-radius: 8px;
            transition: all 0.3s ease;
        ">
            <div style="
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 1;
            ">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 2L2 7L12 12L22 7L12 2Z" 
                          stroke="var(--color-text-primary)" 
                          stroke-width="2" 
                          stroke-linecap="round" 
                          stroke-linejoin="round"/>
                    <path d="M2 17L12 22L22 17" 
                          stroke="var(--color-text-primary)" 
                          stroke-width="2" 
                          stroke-linecap="round" 
                          stroke-linejoin="round"/>
                    <path d="M2 12L12 17L22 12" 
                          stroke="var(--color-text-primary)" 
                          stroke-width="2" 
                          stroke-linecap="round" 
                          stroke-linejoin="round"/>
                </svg>
                <span style="
                    font-size: 14px;
                    font-weight: 500;
                    color: var(--color-text-primary);
                    transition: color 0.3s ease;
                ">
                    Units
                </span>
            </div>
            
            <button
                onClick={handleUnitsToggle}
                disabled={isSaving()}
                style={`position: relative;
                    width: 56px;
                    height: 24px;
                    background: var(--color-bg-tertiary);
                    border: 1px solid var(--color-border-primary);
                    border-radius: 12px;
                    cursor: ${isSaving() ? 'not-allowed' : 'pointer'};
                    transition: all 0.3s ease;
                    outline: none;
                    opacity: ${isSaving() ? '0.7' : '1'};`}
                onMouseEnter={(e: MouseEvent) => {
                    if (!isSaving()) {
                        (e.target as HTMLElement).style.transform = 'scale(1.05)';
                    }
                }}
                onMouseLeave={(e: MouseEvent) => {
                    (e.target as HTMLElement).style.transform = 'scale(1)';
                }}
            >
                <div style={`position: absolute;
                    top: 2px;
                    left: ${defaultUnits() === 'knots' ? '2px' : '34px'};
                    width: 18px;
                    height: 18px;
                    background: var(--color-bg-button);
                    border-radius: 50%;
                    transition: all 0.3s ease;
                    box-shadow: 0 2px 4px var(--color-shadow-sm);`}>
                    {defaultUnits() === 'knots' ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="
                            position: absolute;
                            top: 3px;
                            left: 3px;
                            color: var(--color-text-inverse);
                        ">
                            <path d="M3 12C3 4.5 4.5 3 12 3C19.5 3 21 4.5 21 12C21 19.5 19.5 21 12 21C4.5 21 3 19.5 3 12Z" 
                                  stroke="currentColor" 
                                  stroke-width="2"/>
                            <path d="M12 8V16M8 12H16" 
                                  stroke="currentColor" 
                                  stroke-width="2" 
                                  stroke-linecap="round"/>
                        </svg>
                    ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="
                            position: absolute;
                            top: 3px;
                            left: 3px;
                            color: var(--color-text-inverse);
                        ">
                            <rect x="3" y="3" width="18" height="18" rx="2" 
                                  stroke="currentColor" 
                                  stroke-width="2"/>
                            <path d="M8 8H16M8 12H16M8 16H16" 
                                  stroke="currentColor" 
                                  stroke-width="2" 
                                  stroke-linecap="round"/>
                        </svg>
                    )}
                </div>
            </button>
            
            <div style="
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 60px;
                justify-content: flex-end;
            ">
                {isSaving() ? (
                    <div style="
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 10px;
                        color: var(--color-text-secondary);
                    ">
                        <div style="
                            width: 8px;
                            height: 8px;
                            border: 1px solid var(--color-text-secondary);
                            border-top: 1px solid transparent;
                            border-radius: 50%;
                            animation: spin 1s linear infinite;
                        "></div>
                        Saving...
                    </div>
                ) : (
                    <span style="
                        font-size: 12px;
                        color: var(--color-text-secondary);
                        transition: color 0.3s ease;
                    ">
                        {defaultUnits() === 'knots' ? 'Knots' : 'Meters'}
                    </span>
                )}
            </div>
            
            <style>{`
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
}

