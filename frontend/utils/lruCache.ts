/**
 * LRU (Least Recently Used) Cache Implementation
 * 
 * A generic cache that evicts the least recently used items when the cache
 * reaches its maximum size. This prevents unbounded memory growth.
 * 
 * @template K - Key type
 * @template V - Value type
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  /**
   * Creates a new LRU cache
   * @param maxSize Maximum number of items to store (default: 100)
   */
  constructor(maxSize: number = 100) {
    if (maxSize <= 0) {
      throw new Error('LRU cache maxSize must be greater than 0');
    }
    this.maxSize = maxSize;
    this.cache = new Map<K, V>();
  }

  /**
   * Get the current number of items in the cache
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get the maximum size of the cache
   */
  get max(): number {
    return this.maxSize;
  }

  /**
   * Get a value from the cache by key
   * Moves the item to the end (most recently used)
   * @param key The key to look up
   * @returns The value if found, undefined otherwise
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Set a value in the cache
   * If the key already exists, updates it and moves to end
   * If cache is full, evicts the least recently used item (first item)
   * @param key The key to store
   * @param value The value to store
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Update existing: remove and re-add to move to end
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item in Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Check if a key exists in the cache
   * Does NOT update access order (use get() if you want to mark as recently used)
   * @param key The key to check
   * @returns True if key exists, false otherwise
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete a key from the cache
   * @param key The key to delete
   * @returns True if key was deleted, false if it didn't exist
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all items from the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get all keys in the cache (in order from least to most recently used)
   * @returns Array of keys
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache (in order from least to most recently used)
   * @returns Array of values
   */
  values(): V[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get all entries in the cache (in order from least to most recently used)
   * @returns Array of [key, value] pairs
   */
  entries(): Array<[K, V]> {
    return Array.from(this.cache.entries());
  }

  /**
   * Iterate over cache entries
   * @param callback Function to call for each entry
   */
  forEach(callback: (value: V, key: K, cache: LRUCache<K, V>) => void): void {
    this.cache.forEach((value, key) => {
      callback(value, key, this);
    });
  }
}

