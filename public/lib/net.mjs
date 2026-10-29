// Nova LiveOS network helpers — v1.0.0
// fetch with a hard timeout and one automatic retry. The v0.1 cold-load
// defect was a single slow query stalling the whole shell forever; every
// data call in v1.0 goes through here so a slow request fails visibly and
// retries once instead of hanging the boot.

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
