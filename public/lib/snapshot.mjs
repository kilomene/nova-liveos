// Nova LiveOS boot snapshot — v1.0.5
// The last good state, persisted to localStorage on every successful
// refresh so the NEXT boot can paint the home screen immediately from
// it instead of sitting on skeleton bars while the network round trips
// run (the live v1.0.1 defect: ~25s of skeleton on a cold load, ~10s on
// reload, which on a phone reads as "the site displays nothing").
//
// The snapshot is a paint cache only — never a source of truth. Boot
// renders it, marks the shell "Syncing…", and revalidates against the
// data layer in the background; the refresh coordination (lib/refresh)
// swaps the live state in when the fetch set lands. Connectivity and
// the offline banner keep their v1.0.1 semantics: they are driven by
// real fetch outcomes in lib/net, never by the snapshot.
//
// Safety rails:
// - Identity-bound: a snapshot is readable only by the exact shell
//   identity that wrote it — same adapter mode, same Supabase project
//   origin, same user id. A config change (e.g. placeholder/local mode
//   vs a wired project), a different project, or a different signed-in
//   user can NEVER be painted someone else's saved state.
// - Corruption-tolerant: unparseable or malformed content reads as
//   "no snapshot" and the shell falls back to the normal cold boot.
// - Age-capped: snapshots older than MAX_SNAPSHOT_AGE_MS are ignored.
// - Size-capped: records are trimmed (newest kept) until the payload
//   fits MAX_SNAPSHOT_BYTES; if records had to be trimmed the snapshot
//   is flagged recordsComplete=false so the shell keeps its stats in
//   the pending state until the live records land. A store that throws
//   (quota/private mode) just makes the write a no-op.

export const SNAPSHOT_KEY = "liveos.snapshot.v1";
export const SNAPSHOT_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 1_500_000;
export const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 3600 * 1000;

export function snapshotIdentity({ mode, supabaseUrl, userId } = {}) {
  return {
    mode: mode || "local",
    origin: mode === "supabase" ? String(supabaseUrl || "").replace(/\/$/, "") : "local",
    userId: String(userId || "")
  };
}

function sameIdentity(a, b) {
  return !!a && !!b && a.mode === b.mode && a.origin === b.origin && a.userId === b.userId;
}

export function buildSnapshot(data, identity, now = Date.now()) {
  return {
    v: SNAPSHOT_VERSION,
    savedAt: now,
    identity,
    modules: Array.isArray(data.modules) ? data.modules : [],
    screens: Array.isArray(data.screens) ? data.screens : [],
    installs: Array.isArray(data.installs) ? data.installs : [],
    records: Array.isArray(data.records) ? data.records : [],
    recordsComplete: true
  };
}

// Serialize with the size cap applied. Returns { text, recordsComplete }
// or null when even the catalogue alone cannot fit.
export function serializeSnapshot(snap, maxBytes = MAX_SNAPSHOT_BYTES) {
  let records = snap.records;
  let recordsComplete = true;
  let text = JSON.stringify({ ...snap, records });
  while (text.length > maxBytes && records.length) {
    // Records arrive oldest-first; keep the newest half each round.
    records = records.slice(Math.floor(records.length / 2));
    recordsComplete = false;
    text = JSON.stringify({ ...snap, records, recordsComplete });
  }
  if (text.length > maxBytes) return null;
  return { text, recordsComplete };
}

// Persist the last good state. Returns true when written. Any storage
// failure (quota, private mode) is swallowed — the snapshot is an
// optimisation, never a reason to break a refresh.
export function writeSnapshot(storage, data, identity, now = Date.now()) {
  if (!storage) return false;
  try {
    const snap = buildSnapshot(data, identity, now);
    const out = serializeSnapshot(snap);
    if (!out) return false;
    storage.setItem(SNAPSHOT_KEY, out.text);
    return true;
  } catch {
    return false;
  }
}

// Pure validation: raw stored text + the identity asking for it ->
// the snapshot's state, or null when it must not be painted.
export function parseSnapshot(raw, identity, now = Date.now(), maxAgeMs = MAX_SNAPSHOT_AGE_MS) {
  if (!raw) return null;
  let snap;
  try { snap = JSON.parse(raw); } catch { return null; }
  if (!snap || typeof snap !== "object") return null;
  if (snap.v !== SNAPSHOT_VERSION) return null;
  if (!sameIdentity(snap.identity, identity)) return null;
  if (typeof snap.savedAt !== "number" || now - snap.savedAt > maxAgeMs || snap.savedAt - now > 5 * 60 * 1000) return null;
  if (!Array.isArray(snap.modules) || !Array.isArray(snap.screens) ||
      !Array.isArray(snap.installs) || !Array.isArray(snap.records)) return null;
  return {
    modules: snap.modules,
    screens: snap.screens,
    installs: snap.installs,
    records: snap.records,
    recordsComplete: snap.recordsComplete !== false,
    savedAt: snap.savedAt
  };
}

export function readSnapshot(storage, identity, now = Date.now()) {
  if (!storage) return null;
  let raw = null;
  try { raw = storage.getItem(SNAPSHOT_KEY); } catch { return null; }
  return parseSnapshot(raw, identity, now);
}
