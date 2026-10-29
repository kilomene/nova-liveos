// Nova LiveOS network helpers — v1.0.4
// fetch with a hard timeout and one automatic retry. The v0.1 cold-load
// defect was a single slow query stalling the whole shell forever; every
// data call in v1.0 goes through here so a slow request fails visibly and
// retries once instead of hanging the boot.
//
// v1.0.1 adds REAL data-layer connectivity tracking: the module-level
// state below flips only when an actual fetch succeeds or fails with a
// network error. The shell's offline banner is driven from this — never
// from navigator.onLine, which reported "offline" persistently in
// environments where every Supabase read/write was succeeding.

// ------------------------------------------------------- connectivity state
let dataOnline = true;
const connectivityListeners = new Set();

// v1.0.4 ANTI-FLAP GATE: v1.0.1 flipped the shell to "offline" on a
// SINGLE failed round trip, so any transient stall (a slow query, a
// dropped packet, a busy radio) showed the owner a disconnected state
// that flipped back on the next success — the off-and-on behaviour he
// reported. A failure now only counts toward a consecutive-failure
// counter; the state flips offline at OFFLINE_AFTER_FAILURES in a row,
// and ANY success resets the counter and flips back online immediately.
let consecutiveDataFailures = 0;
export const OFFLINE_AFTER_FAILURES = 3;
export function getConsecutiveDataFailures() { return consecutiveDataFailures; }

// A failure counts as a connectivity failure only when the request never
// got a response: fetch() TypeErrors ("Failed to fetch" / "Load failed"),
// aborts and timeouts. An HTTP error status is NOT one — the server was
// reached, so the data layer is demonstrably online.
export function isNetworkError(err) {
  if (!err) return false;
  if (typeof err.status === "number") return false;
  if (err instanceof TypeError) return true;
  if (err.name === "AbortError") return true;
  const msg = String(err.message || err);
  return /timed out|failed to fetch|load failed|network ?error|network request failed|econn|socket|dns/i.test(msg);
}

export function getDataOnline() { return dataOnline; }

function setDataOnline(next) {
  if (dataOnline === next) return;
  dataOnline = next;
  for (const fn of connectivityListeners) { try { fn(dataOnline); } catch { /* listener errors never break fetches */ } }
}

// Record a successful data-layer round trip. Any HTTP response — even a
// 4xx/5xx — proves connectivity, so fetchWithRetry calls this whenever a
// response arrives. A success also resets the anti-flap failure counter
// and restores the online state immediately.
export function noteDataSuccess() { consecutiveDataFailures = 0; setDataOnline(true); }

// Record a failed data-layer round trip. Only genuine network failures
// count, and the state flips offline only at OFFLINE_AFTER_FAILURES
// consecutive ones (v1.0.4 anti-flap gate); other errors leave both the
// state and the counter untouched.
export function noteDataFailure(err) {
  if (!isNetworkError(err)) return;
  consecutiveDataFailures += 1;
  if (consecutiveDataFailures >= OFFLINE_AFTER_FAILURES) setDataOnline(false);
}

export function onDataConnectivity(fn) {
  connectivityListeners.add(fn);
  return () => connectivityListeners.delete(fn);
}

export async function fetchWithRetry(url, options = {}, {
  timeoutMs = 8000,
  retries = 1,
  fetchImpl = globalThis.fetch,
  backoffMs = 350
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      // A response arrived: the data layer is reachable, whatever the
      // status says. (A 5xx that is about to be retried also proves it.)
      noteDataSuccess();
      // Retry once on transient gateway/server errors, never on 4xx.
      if (res.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err?.name === "AbortError"
        ? new Error(`Request timed out after ${timeoutMs}ms: ${url}`)
        : err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
    }
  }
  noteDataFailure(lastError);
  throw lastError;
}

export async function fetchJson(url, options = {}, retryOpts = {}) {
  const res = await fetchWithRetry(url, options, retryOpts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const msg = body?.message || body?.error_description || body?.error || `HTTP ${res.status}`;
    const err = new Error(`${msg} (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
