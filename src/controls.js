const MAX_BODY_BYTES = 4096;
const KEYS = new Set(['provider', 'model', 'sessionId', 'refresh']);
/** Gateway model ids are `creator/model`; Vercel's slugs use letters, digits, dots, dashes and colons. */
const MODEL_ID = /^[a-z0-9][\w.:-]*(?:\/[\w.:-]+)+$/iu;
const MAX_MODEL_ID = 200;
const ROUTE = /^[\w.:@/-]{1,128}$/u;
const SESSION_ID = /^[\w.:-]{1,128}$/u;

class RequestError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Whether `value` reads as a Vercel AI Gateway model id.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isModelId(value) {
  return typeof value === 'string' && value.length <= MAX_MODEL_ID && MODEL_ID.test(value);
}

/**
 * Handler for `POST api/dsh-fastcel/report`: the ranking the web client shows for a session's selected model.
 * The native Fetch registry authenticates the owner and checks Host and Origin before this runs.
 * @param {import('./fastcel.js').Fastcel} fastcel
 * @param {AbortSignal} lifetime Aborts when the plugin stops.
 */
export function createReportEndpoint(fastcel, lifetime) {
  return async function report(request) {
    const signal = AbortSignal.any([request.signal, lifetime]);
    try {
      if (request.method !== 'POST') throw new RequestError(405, 'Use POST.');
      const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw new RequestError(415, 'Send a JSON request.');
      if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new RequestError(413, 'Request too large.');
      const text = await request.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new RequestError(413, 'Request too large.');
      const { provider, model, sessionId, refresh } = parsePayload(text);
      const value = provider === null || !isModelId(model)
        ? { eligible: false }
        : await fastcel.report({ route: provider, modelId: model, sessionId: sessionId ?? undefined, refresh, signal });
      signal.throwIfAborted();
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const message = signal.aborted ? 'Request cancelled.' : error instanceof RequestError ? error.message : 'fastcel could not build the ranking.';
      return Response.json(
        { ok: false, error: { message } },
        { status: error instanceof RequestError ? error.status : 500, headers: { 'cache-control': 'no-store' } },
      );
    }
  };
}

/** @param {string} text */
function parsePayload(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { throw new RequestError(400, 'Invalid JSON.'); }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || Object.keys(payload).some(key => !KEYS.has(key))) {
    throw new RequestError(400, 'Invalid request.');
  }
  const { provider = null, model = null, sessionId = null, refresh = false } = payload;
  if (provider !== null && (typeof provider !== 'string' || !ROUTE.test(provider))) throw new RequestError(400, 'Invalid provider.');
  if (model !== null && (typeof model !== 'string' || model.length > MAX_MODEL_ID)) throw new RequestError(400, 'Invalid model.');
  if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw new RequestError(400, 'Invalid session.');
  if (typeof refresh !== 'boolean') throw new RequestError(400, 'Invalid refresh flag.');
  return { provider, model, sessionId, refresh };
}
