/**
 * Shared reorder logic for builder series rows (drag-and-drop).
 * Returns a new array with the item at fromIndex moved to toIndex.
 * Caller is responsible for updating the correct store (chartObjects or groupObjects).
 */
export function reorderSeries<T>(array: T[], fromIndex: number, toIndex: number): T[] {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= array.length || toIndex >= array.length) {
        return array;
    }
    const next = [...array];
    const [moved] = next.splice(fromIndex, 1);
    const adjustedTarget = fromIndex < toIndex ? toIndex - 1 : toIndex;
    next.splice(adjustedTarget, 0, moved);
    return next;
}
