/**
 * Shims for JavaScript that pdf.js uses but iOS Safari has not shipped.
 *
 * pdf.js is built against a very recent baseline and calls these unguarded, so
 * on an iPhone a perfectly ordinary PDF fails with an opaque message like
 * "this.#methodPromises.getOrInsertComputed is not a function" before a single
 * page is rendered. That is the whole phone half of this app, so the three
 * methods it relies on are filled in here.
 *
 * Every shim is installed only when missing, and matches the specified
 * behaviour closely enough that removing it once Safari catches up is a no-op.
 * Loaded as a side effect: `import '../compat/modern'` before touching pdf.js,
 * on the main thread *and* inside its worker -- a worker has its own globals
 * and inherits nothing from the page.
 */

interface UpsertMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
  has(key: K): boolean;
  getOrInsert?(key: K, value: V): V;
  getOrInsertComputed?(key: K, callback: (key: K) => V): V;
}

/** Map/WeakMap upsert helpers (TC39 "upsert"; Safari 26+, Chrome 133+). */
function installUpsert(proto: UpsertMap<unknown, unknown>): void {
  const define = (name: 'getOrInsert' | 'getOrInsertComputed', fn: (...args: never[]) => unknown) => {
    if (typeof proto[name] === 'function') return;
    Object.defineProperty(proto, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  define('getOrInsert', function (this: UpsertMap<unknown, unknown>, key: unknown, value: unknown) {
    if (this.has(key)) return this.get(key);
    this.set(key, value);
    return value;
  } as never);

  define('getOrInsertComputed', function (
    this: UpsertMap<unknown, unknown>,
    key: unknown,
    callback: (key: unknown) => unknown,
  ) {
    if (this.has(key)) return this.get(key);
    // The callback may itself touch this map, so re-check before overwriting --
    // the specified behaviour, and pdf.js does exactly this with its font cache.
    const value = callback(key);
    if (this.has(key)) return this.get(key);
    this.set(key, value);
    return value;
  } as never);
}

installUpsert(Map.prototype as unknown as UpsertMap<unknown, unknown>);
installUpsert(WeakMap.prototype as unknown as UpsertMap<object, unknown>);

/**
 * `Promise.withResolvers` (Safari 17.4+) -- used ~40 times across pdf.js.
 *
 * Reached through a cast rather than by raising the project's `lib` to ES2024:
 * the ES2023 setting is what stops our own code from quietly picking up an API
 * that an iPhone does not have, which is the bug this whole file is here for.
 */
const PromiseCtor = Promise as PromiseConstructor & { withResolvers?: unknown };
if (typeof PromiseCtor.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
    writable: true,
    configurable: true,
  });
}

/** `URL.parse` (Safari 18.4+) -- the non-throwing URL constructor. */
if (typeof (URL as { parse?: unknown }).parse !== 'function') {
  Object.defineProperty(URL, 'parse', {
    value: function parse(url: string | URL, base?: string | URL) {
      try {
        return base === undefined ? new URL(url) : new URL(url, base);
      } catch {
        return null;
      }
    },
    writable: true,
    configurable: true,
  });
}

export {};
