/**
 * Shared drag handle icon for builder row reorder (6-dot grip).
 * Use in the first column of draggable table rows.
 */
export default function DragHandleIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="9" cy="5" r="1.5"/>
            <circle cx="15" cy="5" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/>
            <circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="19" r="1.5"/>
            <circle cx="15" cy="19" r="1.5"/>
        </svg>
    );
}
