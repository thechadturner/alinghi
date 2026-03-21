import { Show } from "solid-js";

interface TextBoxProps {
    label?: string;
    /** Optional label shown next to the secondary (target) value when hasTarget is true. */
    secondaryLabel?: string;
    labelColor?: string;
    channelName?: string;
    channel2Name?: string;
    targetColor?: string;
    hasTarget?: boolean;
    height?: number;
    /** When provided (e.g. from Overlay), use this row for display instead of fetching. Pass an accessor (e.g. row) so updates when selectedTime changes. */
    dataRow?: any;
}

export default function TextBox({ 
    label, 
    secondaryLabel,
    labelColor, 
    channelName,
    channel2Name,
    targetColor,
    hasTarget = false,
    height = 60, // Default height
    dataRow: dataRowProp
}: TextBoxProps) {
    // Calculate scale factor based on height (default is 60px)
    const baseHeight = 60;
    const scaleFactor = height / baseHeight;
    
    // Calculate width based on longest channel name
    const calculateTextWidth = (text: string, fontSize: number): number => {
        // Create a temporary canvas to measure text width
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (context) {
            // Use the same font as the label
            context.font = `${fontSize}px sans-serif`;
            return context.measureText(text).width;
        }
        // Fallback: estimate ~0.6 * fontSize per character
        return text.length * fontSize * 0.4;
    };
    
    // Get the longest channel name
    const longestName = (() => {
        const names = [label, channelName, channel2Name].filter(Boolean);
        if (names.length === 0) return '';
        return names.reduce((longest, current) => 
            current && current.length > longest.length ? current : longest
        , names[0] || '');
    })();
    
    // Calculate width: text width + 5px extra padding
    const labelFontSize = 14 * scaleFactor;
    const textWidth = calculateTextWidth(longestName, labelFontSize);
    const width = textWidth + 5;

    // Get value from data point using channel name (handles lowercase field names)
    const getValueFromData = (dataPoint: any, channelName: string): number | null => {
        if (!dataPoint || !channelName) return null;
        
        // Try multiple case variations to handle different naming conventions
        const variations = [
          channelName,                    // Original case (e.g., "Tws", "Bsp")
          channelName.toLowerCase(),      // Lowercase (e.g., "tws", "bsp") - per repo rules
          channelName.toUpperCase(),      // Uppercase (e.g., "TWS", "BSP")
          channelName.charAt(0).toUpperCase() + channelName.slice(1).toLowerCase(), // Title case (e.g., "Tws", "Bsp")
        ];
        
        // Also try with underscores converted to different cases
        if (channelName.includes('_')) {
          variations.push(
            channelName.replace(/_/g, '').toLowerCase(),  // Remove underscores, lowercase (e.g., "vmgperc")
            channelName.replace(/_/g, ''),                // Remove underscores, original (e.g., "Vmgperc")
            channelName.replace(/_/g, '').toUpperCase()  // Remove underscores, uppercase (e.g., "VMGPERC")
          );
        }
        
        // Try each variation
        for (const variant of variations) {
          if (dataPoint[variant] !== undefined && dataPoint[variant] !== null) {
            const value = Number(dataPoint[variant]);
            if (!isNaN(value) && isFinite(value)) {
              return value;
            }
          }
        }
        
        // If no direct match, try case-insensitive key search
        const dataKeys = Object.keys(dataPoint);
        const matchingKey = dataKeys.find(key => 
          key.toLowerCase() === channelName.toLowerCase() ||
          key.toLowerCase().replace(/_/g, '') === channelName.toLowerCase().replace(/_/g, '')
        );
        
        if (matchingKey) {
          const value = Number(dataPoint[matchingKey]);
          if (!isNaN(value) && isFinite(value)) {
            return value;
          }
        }
        
        return null;
    };

    const formatValue = (value: any): string => {
        if (value === undefined || value === null) return "N/A";
        if (isNaN(value)) return "NaN";
        return typeof value === 'number' ? value.toFixed(1) : String(value);
    };

    const formatTargetValue = (value: any): string => {
        if (value === undefined || value === null) return "";
        if (isNaN(value)) return "";
        return typeof value === 'number' ? value.toFixed(1) : String(value);
    };

    // Display row from parent (Overlay passes dataRow; accessor so we react when selectedTime changes).
    const displayRow = (): any => {
        if (dataRowProp == null) return {};
        const row = typeof dataRowProp === 'function' ? dataRowProp() : dataRowProp;
        return row ?? {};
    };

    // Get current values from display row
    const currentValue = () => {
        const row = displayRow();
        if (!row || !channelName) return null;
        return getValueFromData(row, channelName);
    };

    const currentTargetValue = () => {
        const row = displayRow();
        if (!row || !channel2Name) return null;
        return getValueFromData(row, channel2Name);
    };

    // Loading when no dataRow prop or no value yet (parent Overlay fetches data).
    const isDataLoading = () => {
        if (dataRowProp == null) return true;
        const val = currentValue();
        return val === null || val === undefined;
    };

    // Calculate scaled dimensions
    const scaledMinHeight = 40 * scaleFactor;
    const scaledSpinnerSize = 30 * scaleFactor;
    const scaledSpinnerBorder = 2 * scaleFactor;
    const scaledSpinnerMarginTop = 6 * scaleFactor;
    const scaledSpinnerFontSize = 12 * scaleFactor;

    return (
        <div class="grid-cell" style={{ 
            "font-size": `${14 * scaleFactor}px`,
            "width": `${width}px`,
            "min-width": `${width}px`,
            "max-width": `${width}px`
        }}>
            <span class="label" style={{ 
                "color": labelColor,
                "font-size": `${12 * scaleFactor}px`
            }}>{label}</span>
            <div class="overlay-value-container" style={{ 
                "position": "relative", 
                "min-height": `${scaledMinHeight}px`,
                "width": "100%"
            }}>
                <Show when={isDataLoading()}>
                    <div style="display: flex; align-items: center; justify-content: center; height: 100%; position: absolute; top: 0; left: 0; right: 0; bottom: 0;">
                        <div style="text-align: center; display: flex; flex-direction: column; align-items: center;">
                            <div class="spinner" style={{ 
                                "width": `${scaledSpinnerSize}px`, 
                                "height": `${scaledSpinnerSize}px`, 
                                "min-width": `${scaledSpinnerSize}px`,
                                "min-height": `${scaledSpinnerSize}px`,
                                "border": `${scaledSpinnerBorder}px solid #374151`, 
                                "border-top": `${scaledSpinnerBorder}px solid #3b82f6`, 
                                "border-radius": "50%", 
                                "animation": "spin 1s linear infinite", 
                                "margin": "0 auto",
                                "aspect-ratio": "1",
                                "box-sizing": "border-box"
                            }}></div>
                            <div style={{ 
                                "margin-top": `${scaledSpinnerMarginTop}px`, 
                                "font-size": `${scaledSpinnerFontSize}px`, 
                                "color": "#9ca3af"
                            }}>Loading...</div>
                        </div>
                    </div>
                </Show>
                <Show when={!isDataLoading()}>
                    {/* Primary channel - left column */}
                    <div class={hasTarget ? "big-text" : "big-text-right"} style={{ "font-size": `${24 * scaleFactor}px` }}>
                        <span class="value" style={{ 
                            "color": labelColor,
                            "font-size": `${24 * scaleFactor}px`
                        }}>
                            {formatValue(currentValue())}
                        </span>
                    </div>
                    {/* Secondary channel - right column with smaller font and optional label */}
                    <Show when={hasTarget}>
                        <div class="small-text overlay-textbox-secondary" style={{ 
                            "display": "flex",
                            "flex-direction": "column",
                            "align-items": "flex-end",
                            "position": "relative",
                            "right": "30px"
                        }}>
                            {secondaryLabel ? (
                                <span class="overlay-textbox-secondary-label" style={{ 
                                    "font-size": `${10 * scaleFactor}px`,
                                    "color": targetColor || labelColor,
                                    "margin-right": "-5px",
                                    "margin-bottom": "2px"
                                }}>
                                    {secondaryLabel}
                                </span>
                            ) : null}
                            <span class="value" style={{ 
                                "color": targetColor || labelColor,
                                "font-size": `${10 * scaleFactor}px`,
                                "position": "relative",
                                "right": "-15px"
                            }}>
                                {formatTargetValue(currentTargetValue())}
                            </span>
                        </div>
                    </Show>
                </Show>
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
