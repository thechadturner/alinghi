import { createSignal } from "solid-js";
import { themeStore } from "../../store/themeStore";
import { debug } from "../../utils/console";

export default function ThemeToggle() {
    const { theme, toggleTheme, isDark } = themeStore;
    const [isSaving, setIsSaving] = createSignal(false);

    const handleThemeToggle = () => {
        debug('Theme toggle clicked - current theme:', theme());
        setIsSaving(true);
        toggleTheme();
        debug('Theme toggle completed - new theme:', theme());
        
        // Show saving indicator for a brief moment, then show success
        setTimeout(() => {
            setIsSaving(false);
        }, 800);
    };

    return (
        <div class="theme-toggle-container" style="
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
                    <path d="M12 3V4M12 20V21M4 12H3M6.31412 6.31412L5.5 5.5M17.6859 6.31412L18.5 5.5M6.31412 17.69L5.5 18.5M17.6859 17.69L18.5 18.5M21 12H20M16 12C16 14.2091 14.2091 16 12 16C9.79086 16 8 14.2091 8 12C8 9.79086 9.79086 8 12 8C14.2091 8 16 9.79086 16 12Z" 
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
                    Theme
                </span>
            </div>
            
            <button
                onClick={handleThemeToggle}
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
                    left: ${theme() === 'light' ? '2px' : theme() === 'medium' ? '19px' : '36px'};
                    width: 18px;
                    height: 18px;
                    background: var(--color-bg-button);
                    border-radius: 50%;
                    transition: all 0.3s ease;
                    box-shadow: 0 2px 4px var(--color-shadow-sm);`}>
                    {theme() === 'light' ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="
                            position: absolute;
                            top: 3px;
                            left: 3px;
                            color: var(--color-text-inverse);
                        ">
                            <circle cx="12" cy="12" r="5" 
                                    stroke="currentColor" 
                                    stroke-width="2"/>
                            <path d="M12 1V3M12 21V23M4.22 4.22L5.64 5.64M18.36 18.36L19.78 19.78M1 12H3M21 12H23M4.22 19.78L5.64 18.36M18.36 5.64L19.78 4.22" 
                                  stroke="currentColor" 
                                  stroke-width="2" 
                                  stroke-linecap="round"/>
                        </svg>
                    ) : theme() === 'medium' ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="
                            position: absolute;
                            top: 3px;
                            left: 3px;
                            color: var(--color-text-inverse);
                        ">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" 
                                  stroke="currentColor" 
                                  stroke-width="2" 
                                  stroke-linecap="round" 
                                  stroke-linejoin="round"/>
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
                            <path d="M9 9H15M9 15H15" 
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
                        {theme() === 'light' ? 'Light' : theme() === 'medium' ? 'Medium' : 'Dark'}
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

