import { themeStore } from "../../store/themeStore";

export interface ColorPickerProps {
  colors: string[];
  onSelect: (color: string) => void;
}

const ColorPicker = (props: ColorPickerProps) => {
  const { colors, onSelect } = props;

  return (
    <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
      <div class="color-picker">
        {colors.map((color, index) => (
          <svg
            key={index}
            width="24"
            height="24"
            style={{
              border: "1px solid var(--color-border-primary)",
              cursor: "pointer",
            }}
            onClick={() => onSelect(color)}
          >
            <rect
              width="100%"
              height="100%"
              fill={color}
            />
          </svg>
        ))}
      </div>
    </div>
  );
};

export default ColorPicker;

