import { createSignal, createMemo } from "solid-js";
import { FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight } from "solid-icons/fi";

export interface PaginationControlsProps {
  currentPage?: number;
  totalPages?: number;
  totalRecords?: number;
  limit?: number;
  onPageChange?: (page: number) => void;
}

export default function PaginationControls(props: PaginationControlsProps) {
  // Use createMemo to ensure reactivity to prop changes
  const currentPage = createMemo(() => props.currentPage || 1);
  const totalPages = createMemo(() => props.totalPages || 1);
  const totalRecords = createMemo(() => props.totalRecords || 0);
  const limit = createMemo(() => props.limit || 100);
  const onPageChange = props.onPageChange || (() => {});

  const [pageInput, setPageInput] = createSignal(currentPage());

  // Update page input when currentPage changes
  createMemo(() => {
    setPageInput(currentPage());
  });

  const handlePageInputChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const value = parseInt(target.value);
    if (!isNaN(value) && value >= 1 && value <= totalPages()) {
      setPageInput(value);
    }
  };

  const handlePageInputKeyPress = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const value = parseInt(pageInput().toString());
      if (!isNaN(value) && value >= 1 && value <= totalPages()) {
        onPageChange(value);
      } else {
        setPageInput(currentPage());
      }
    }
  };

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages()) {
      onPageChange(page);
    }
  };

  const getVisiblePages = (): (number | string)[] => {
    const delta = 2;
    const range: number[] = [];
    const rangeWithDots: (number | string)[] = [];

    for (let i = Math.max(2, currentPage() - delta); i <= Math.min(totalPages() - 1, currentPage() + delta); i++) {
      range.push(i);
    }

    if (currentPage() - delta > 2) {
      rangeWithDots.push(1, '...');
    } else {
      rangeWithDots.push(1);
    }

    rangeWithDots.push(...range);

    if (currentPage() + delta < totalPages() - 1) {
      rangeWithDots.push('...', totalPages());
    } else if (totalPages() > 1) {
      rangeWithDots.push(totalPages());
    }

    return rangeWithDots;
  };

  const startRecord = (currentPage() - 1) * limit() + 1;
  const endRecord = Math.min(currentPage() * limit(), totalRecords());

  return (
    <div class="flex flex-col sm:flex-row justify-between items-center gap-4 p-4 rounded-lg" style={{ "background-color": "var(--color-bg-primary)", "transition": "background-color 0.3s ease" }}>
      {/* Records Info */}
      <div class="text-sm" style={{ "color": "var(--color-text-secondary)", "transition": "color 0.3s ease" }}>
        Showing {startRecord} to {endRecord} of {totalRecords()} entries
      </div>

      {/* Pagination Controls */}
      <div class="flex items-center gap-2">
        {/* First Page */}
        <button
          onClick={() => goToPage(1)}
          disabled={currentPage() === 1}
          class="p-2 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          style={{ 
            "border": "1px solid var(--color-border-primary)",
            "background-color": "var(--color-bg-card)",
            "color": "var(--color-text-primary)",
            "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
          }}
          onMouseEnter={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-tertiary)"}
          onMouseLeave={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-card)"}
          title="First page"
        >
          <FiChevronsLeft size={16} />
        </button>

        {/* Previous Page */}
        <button
          onClick={() => goToPage(currentPage() - 1)}
          disabled={currentPage() === 1}
          class="p-2 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          style={{ 
            "border": "1px solid var(--color-border-primary)",
            "background-color": "var(--color-bg-card)",
            "color": "var(--color-text-primary)",
            "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
          }}
          onMouseEnter={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-tertiary)"}
          onMouseLeave={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-card)"}
          title="Previous page"
        >
          <FiChevronLeft size={16} />
        </button>

        {/* Page Numbers */}
        <div class="flex items-center gap-1">
          {getVisiblePages().map((page, index) => (
            page === '...' ? (
              <span key={`dots-${index}`} class="px-3 py-2" style={{ "color": "var(--color-text-tertiary)", "transition": "color 0.3s ease" }}>...</span>
            ) : (
              <button
                key={page}
                onClick={() => goToPage(page as number)}
                class="px-3 py-2 rounded-md border text-sm font-medium transition-all duration-200"
                style={page === currentPage() ? {
                  "background-color": "var(--color-bg-button)",
                  "color": "var(--color-text-inverse)",
                  "border-color": "var(--color-bg-button)",
                  "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
                } : {
                  "background-color": "var(--color-bg-card)",
                  "color": "var(--color-text-primary)",
                  "border-color": "var(--color-border-primary)",
                  "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
                }}
                onMouseEnter={(e) => {
                  if (page !== currentPage()) {
                    (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-tertiary)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (page !== currentPage()) {
                    (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-card)";
                  }
                }}
              >
                {page}
              </button>
            )
          ))}
        </div>

        {/* Next Page */}
        <button
          onClick={() => goToPage(currentPage() + 1)}
          disabled={currentPage() === totalPages()}
          class="p-2 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          style={{ 
            "border": "1px solid var(--color-border-primary)",
            "background-color": "var(--color-bg-card)",
            "color": "var(--color-text-primary)",
            "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
          }}
          onMouseEnter={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-tertiary)"}
          onMouseLeave={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-card)"}
          title="Next page"
        >
          <FiChevronRight size={16} />
        </button>

        {/* Last Page */}
        <button
          onClick={() => goToPage(totalPages())}
          disabled={currentPage() === totalPages()}
          class="p-2 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          style={{ 
            "border": "1px solid var(--color-border-primary)",
            "background-color": "var(--color-bg-card)",
            "color": "var(--color-text-primary)",
            "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
          }}
          onMouseEnter={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-tertiary)"}
          onMouseLeave={(e) => (e.target as HTMLElement).style.backgroundColor = "var(--color-bg-card)"}
          title="Last page"
        >
          <FiChevronsRight size={16} />
        </button>
      </div>

      {/* Page Input */}
      <div class="flex items-center gap-2">
        <span class="text-sm" style={{ "color": "var(--color-text-secondary)", "transition": "color 0.3s ease" }}>Go to page:</span>
        <input
          type="number"
          min="1"
          max={totalPages()}
          value={pageInput()}
          onInput={handlePageInputChange}
          onKeyPress={handlePageInputKeyPress}
          class="w-16 px-2 py-1 text-sm rounded-md focus:outline-none transition-all duration-200"
          style={{ 
            "border": "1px solid var(--color-border-primary)",
            "background-color": "var(--color-bg-input)",
            "color": "var(--color-text-primary)",
            "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
          }}
          onFocus={(e) => (e.target as HTMLElement).style.borderColor = "var(--color-border-focus)"}
          onBlur={(e) => (e.target as HTMLElement).style.borderColor = "var(--color-border-primary)"}
        />
      </div>

    </div>
  );
}

