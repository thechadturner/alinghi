import { createSignal, createEffect, untrack } from "solid-js";
import { error as logError } from "../../utils/console";

interface DropDownButtonProps {
  options?: string[];
  defaultText?: string;
  handleSelection?: (item: string) => void;
  size?: "auto" | "big" | "medium" | "small" | "xlarge";
  smallLabel?: string;
}

function DropDownButton(props: DropDownButtonProps) {
  const [selected, setSelected] = createSignal(props.defaultText || "Select one");
  const [dropdownVisible, setDropdownVisible] = createSignal(false);
  let collapseTimeout: ReturnType<typeof setTimeout> | null = null; // Variable to hold the timeout ID

  createEffect(() => {
    if (!props.options || props.options.length === 0) {
      setSelected("ALL");
    } else if (props.options.length === 1) {
      setSelected(props.options[0]);
    } else {
      setSelected(props.defaultText);
    }
  });

  const toggleDropdown = (): void => {
    const options = untrack(() => props.options);
    if (!options || options.length === 0) {
      return;
    }

    // If there are exactly 2 options, toggle between them
    if (options.length === 2) {
      const currentSelected = selected();
      // Find the option that's not currently selected
      const otherOption = options.find(opt => opt !== currentSelected);
      // If current selection is not in options, default to first option
      const nextOption = otherOption || options[0];
      handleSelection(nextOption);
    } else if (options.length > 2) {
      // For more than 2 options, show/hide dropdown
      setDropdownVisible(!dropdownVisible());
    }
  };

  const handleSelection = (item: string): void => {
    if (typeof props.handleSelection === "function") {
      props.handleSelection(item);
    } else {
      logError("handleSelection is not a function");
    }

    setSelected(item);
    setDropdownVisible(false);
  };

  const handleMouseLeave = (e: MouseEvent): void => {
    const relatedTarget = (e as MouseEvent).relatedTarget;
    if (relatedTarget && !(e.currentTarget as HTMLElement).contains(relatedTarget as Node)) {
      // Set a timer to delay collapse
      collapseTimeout = setTimeout(() => {
        setDropdownVisible(false);
      }, 200); // 200ms delay
    }
  };

  const handleMouseEnter = (): void => {
    // Clear the timeout if the user moves the mouse back in
    if (collapseTimeout) {
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
  };

  const getWidthClass = (): string | undefined => {
    if (props.size === "auto") {
      return "w-auto";
    } else if (props.size === "xlarge") {
      return "forced-xlarge";
    } else if (props.size === "big") {
      return "forced-big";
    } else if (props.size === "medium") {
      return "forced-medium";
    } else if (props.size === "small") {
      return "forced-small";
    }
  };

  return (
    <div
      class={`relative inline-block text-left ${getWidthClass()}`}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter} // Prevent collapse when the mouse moves back in
    >
      {/* Main Button */}
      <button
        onClick={toggleDropdown}
        onContextMenu={(e) => e.preventDefault()}
        class={`dropdown py-2 px-3 rounded-md flex flex-col items-center ${getWidthClass()}`}
        style="background: var(--color-bg-button); color: var(--color-text-inverse); transition: all 0.3s ease;"
      >
        <span class="self-start text-xs font-medium">{props.smallLabel}</span>
        <span class="text-sm font-bold">{selected()}</span>
      </button>

      {/* Dropdown - only show when there are more than 2 options */}
      {dropdownVisible() && props.options && props.options.length > 2 && (
        <div class="dropdown absolute mt-1 w-full shadow-lg rounded-md" style="background: var(--color-bg-card); border: 1px solid var(--color-border-primary);">
          <ul>
            {props.options.map((item, index) => (
              <li
                class="block px-3 py-1 text-sm w-full text-left focus:outline-none cursor-pointer transition: background-color 0.3s ease;"
                style="color: var(--color-text-primary);"
                onClick={() => handleSelection(item)}
                onContextMenu={(e) => e.preventDefault()}
                onMouseEnter={(e) => ((e.target as HTMLElement).style.backgroundColor = 'var(--color-bg-tertiary)')}
                onMouseLeave={(e) => ((e.target as HTMLElement).style.backgroundColor = 'transparent')}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Default props
DropDownButton.defaultProps = {
  options: [],
  defaultText: "Select one",
  smallLabel: "Small Label",
  size: "auto",
  handleSelection: () => {},
};

export default DropDownButton;
