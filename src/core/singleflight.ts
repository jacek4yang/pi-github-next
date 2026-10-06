// Singleflight (§15): concurrent identical requests coalesce onto one
// in-flight promise. State is cleaned after success, failure, and
// cancellation — no leaked promises, no permanently-rejected entries.

export class Singleflight {
  private inFlight = new Map<string, Promise<unknown>>();

  /** Number of currently coalescing keys (soak/health). */
  get size(): number {
    return this.inFlight.size;
  }

  /**
   * Run `fn` under key `key`. Concurrent callers for the same key await the
   * same promise. The key is always released — on resolve, reject, or throw.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
