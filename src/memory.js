/**
 * A map that keeps only the most recently written entries.
 * @template V
 */
export class BoundedMap {
  /** @type {Map<string, V>} */
  #entries = new Map();
  #limit;

  /** @param {number} limit */
  constructor(limit) {
    this.#limit = limit;
  }

  /** @param {string} key */
  get(key) {
    return this.#entries.get(key);
  }

  /** @param {string} key */
  has(key) {
    return this.#entries.has(key);
  }

  /** @param {string} key @param {V} value */
  set(key, value) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#limit) this.#entries.delete(this.#entries.keys().next().value);
    return value;
  }

  /**
   * Merge `patch` into the entry for `key`.
   * @param {string} key
   * @param {Partial<V>} patch
   */
  update(key, patch) {
    return this.set(key, { ...this.#entries.get(key), ...patch });
  }
}

/**
 * Tokens a conversation holds after a call, from that call's usage.
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
 */
export function contextTokensOf(usage) {
  if (Number.isFinite(usage?.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  const sum = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .reduce((total, key) => total + (Number.isFinite(usage?.[key]) ? usage[key] : 0), 0);
  return sum > 0 ? sum : undefined;
}
