// Nova LiveOS refresh coordination — v1.0.3
// Two guards that make state replacement MONOTONIC:
//
// 1. Cycle sequencing. Refresh cycles can overlap (realtime events, the
//    5s poll, hash changes, user actions). Each cycle takes a sequence
//    number when it begins; it may commit its results only while it is
//    still the newest begun cycle and no newer cycle has committed. A
//    slow, stale cycle that resolves late is dropped, never applied —
//    before this guard, a late-resolving older cycle overwrote newer
//    state, and the rendered counts visibly downgraded then recovered
//    (live v1.0.2: modules/records oscillating 6/25 → 4/16 → 5/20).
//
// 2. All-or-nothing candidates. Once the shell holds a complete state,
//    a refresh builds the candidate state from its whole fetch set
//    first and swaps it in only if the critical fetches (catalogue +
//    records) succeeded. A partial or failed cycle keeps the last good
//    state — and its counts — completely untouched. Secondary fetches
//    (automations, audit) fall back to the previous values inside the
//    candidate, matching the shell's historic behaviour, so they can
//    never downgrade anything either.

// Wrap a promise so it always resolves to { ok, value } or
// { ok: false, error } — lets a refresh start every fetch concurrently
// and still reason about the whole set when it lands.
export function settle(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

export function createCycleTracker() {
  let begun = 0;
  let applied = 0;
  return {
    // Start a new refresh cycle; returns its sequence number.
    begin() { begun += 1; return begun; },
    // A cycle may commit only while it is the newest begun cycle and no
    // cycle at or after it has already committed.
    canCommit(seq) { return seq === begun && seq > applied; },
    markApplied(seq) { if (seq > applied) applied = seq; },
    get begunSeq() { return begun; },
    get appliedSeq() { return applied; }
  };
}

// Build the candidate state for one refresh cycle from its settled
// fetch results. `parts` = { core, records, automations, audit }, each
// a settle() result; core.value = { modules, screens, installs }.
// `previous` is the last good state, used as the fallback for the
// secondary classes only. The candidate is complete only when BOTH
// critical fetches succeeded.
export function buildCandidate(parts, previous) {
  if (!parts.core?.ok) return { complete: false, state: null, error: parts.core?.error || new Error("core fetch failed") };
  if (!parts.records?.ok) return { complete: false, state: null, error: parts.records?.error || new Error("records fetch failed") };
  return {
    complete: true,
    error: null,
    state: {
      modules: parts.core.value.modules,
      screens: parts.core.value.screens,
      installs: parts.core.value.installs,
      records: parts.records.value,
      automations: parts.automations?.ok ? parts.automations.value : previous.automations,
      audit: parts.audit?.ok ? parts.audit.value : previous.audit
    }
  };
}

// ------------------------------------------------------------ no-change gate
// The blink guard: a background refresh whose candidate is identical to
// the state already on screen must do NO DOM work at all. Comparison is
// structural (JSON) over exactly the classes a refresh can replace —
// the same technique the adapter poll uses for its change hash.
export function dataStatesEqual(a, b) {
  if (!a || !b) return false;
  for (const k of ["modules", "screens", "installs", "records", "automations", "audit"]) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}
