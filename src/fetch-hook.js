const SLOT = Symbol.for('dsh-fastcel.fetch');

/**
 * @callback FetchHook
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @param {typeof fetch} forward The fetch the wrapper replaced; sends the request unchanged.
 * @returns {Promise<Response>}
 */

/**
 * Route the process's `fetch` through `hook` until the returned disposer runs.
 *
 * pi-ai builds a new SDK client for every model call, and the SDK reads the global `fetch` when it does,
 * so wrapping the global is what lets fastcel see a provider request. One wrapper is installed per process
 * and kept across plugin reloads; the latest hook wins, and with no hook set the wrapper forwards every
 * call unchanged.
 * @param {FetchHook} hook
 * @returns {() => void}
 */
export function hookFetch(hook) {
  let state = globalThis[SLOT];
  if (!state) {
    const original = globalThis.fetch;
    state = { original, hook: undefined, wrapper: undefined };
    const shared = state;
    state.wrapper = function fetch(input, init) {
      const current = shared.hook;
      return current ? current(input, init, shared.original) : shared.original(input, init);
    };
    globalThis.fetch = state.wrapper;
    globalThis[SLOT] = state;
  }
  const installed = state;
  installed.hook = hook;
  return () => {
    if (installed.hook !== hook) return;
    installed.hook = undefined;
    // Unwrap only when nothing wrapped fetch after fastcel; otherwise the idle wrapper keeps forwarding.
    if (globalThis.fetch === installed.wrapper && globalThis[SLOT] === installed) {
      globalThis.fetch = installed.original;
      delete globalThis[SLOT];
    }
  };
}

/**
 * Send a request without passing it through fastcel's hook.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export function directFetch(input, init) {
  const state = globalThis[SLOT];
  return (state ? state.original : globalThis.fetch)(input, init);
}
