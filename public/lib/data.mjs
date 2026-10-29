// Nova LiveOS data layer — v0.1.0
// Two adapters behind one interface:
//   LocalAdapter    — fixture data in localStorage (works offline, no account)
//   SupabaseAdapter — PostgREST via fetch with the anon key; live updates via
//                     a Realtime websocket when it connects, with a polling
//                     fallback that still re-renders the shell on change.
// The shell picks the adapter automatically from public/config.js.

import { SEED } from "./seed-data.mjs";

export function selectMode(config) {
  const url = config?.supabaseUrl || "";
  const key = config?.supabaseAnonKey || "";
  const real = /^https:\/\/.+\.supabase\.co/.test(url) && key.length > 20 && !/YOUR|PLACEHOLDER/i.test(key);
  return real ? "supabase" : "local";
}

let idCounter = 0;
function nextId(prefix = "rec") {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// ------------------------------------------------------------ local store
// Pure state logic over a {getItem,setItem} storage — unit-testable in node
// with an in-memory shim, and used by LocalAdapter with real localStorage.
export function createLocalStore(storage, seed = SEED, storageKey = "liveos.local.v1") {
  let state;
  const raw = storage.getItem(storageKey);
  if (raw) {
    try { state = JSON.parse(raw); } catch { state = null; }
  }
  if (!state || state.version !== seed.version) {
    state = {
      version: seed.version,
      modules: structuredClone(seed.modules),
      screens: structuredClone(seed.screens),
      records: seed.records.map((r, i) => ({
        id: `seed_${i + 1}`, module_slug: r.module_slug, kind: r.kind,
        payload: structuredClone(r.payload), created_by: "local",
        created_at: new Date(Date.now() - (seed.records.length - i) * 60000).toISOString()
      })),
      installs: [...seed.defaultInstalled],
      userId: "local-user"
    };
    persist();
  }
  const listeners = new Set();
  function persist() { storage.setItem(storageKey, JSON.stringify(state)); }
  function emit(change) { for (const fn of listeners) fn(change); }

  return {
    get userId() { return state.userId; },
    getModules: () => structuredClone(state.modules),
    getScreens: () => structuredClone(state.screens),
    getScreen(moduleSlug, slug = "main") {
      const s = state.screens.find((x) => x.module_slug === moduleSlug && x.slug === slug);
      return s ? structuredClone(s) : null;
    },
    getRecords: (moduleSlug, kind) => structuredClone(
      state.records.filter((r) => (!moduleSlug || r.module_slug === moduleSlug) && (!kind || r.kind === kind))
    ),
    getInstalls: () => [...state.installs],
    isInstalled: (slug) => state.installs.includes(slug),
    install(slug) {
      if (!state.modules.some((m) => m.slug === slug)) throw new Error(`unknown module: ${slug}`);
      if (!state.installs.includes(slug)) { state.installs.push(slug); persist(); emit({ type: "install", slug }); }
      return [...state.installs];
    },
    uninstall(slug) {
      state.installs = state.installs.filter((s) => s !== slug);
      persist(); emit({ type: "uninstall", slug });
      return [...state.installs];
    },
    createRecord(moduleSlug, kind, payload, createdBy = state.userId) {
      const record = {
        id: nextId(), module_slug: moduleSlug, kind,
        payload: { ...payload }, created_by: createdBy, created_at: new Date().toISOString()
      };
      state.records.push(record);
      persist(); emit({ type: "record", record });
      return structuredClone(record);
    },
    updateScreenLayout(moduleSlug, slug, layout) {
      const s = state.screens.find((x) => x.module_slug === moduleSlug && x.slug === slug);
      if (!s) throw new Error(`unknown screen: ${moduleSlug}/${slug}`);
      s.layout = structuredClone(layout);
      persist(); emit({ type: "screen", module_slug: moduleSlug, slug });
      return structuredClone(s);
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => structuredClone(state)
  };
}

export class LocalAdapter {
  constructor(storage = globalThis.localStorage) {
    this.mode = "local";
    this.store = createLocalStore(storage);
    this.userId = this.store.userId;
  }
  async getState() {
    return {
      modules: this.store.getModules(),
      screens: this.store.getScreens(),
      records: this.store.getRecords(),
      installs: this.store.getInstalls()
    };
  }
  async createRecord(m, k, p) { return this.store.createRecord(m, k, p); }
  async install(slug) { return this.store.install(slug); }
  async uninstall(slug) { return this.store.uninstall(slug); }
  async updateScreenLayout(m, s, l) { return this.store.updateScreenLayout(m, s, l); }
  // Live path (local): same-tab event bus + cross-tab `storage` events.
  onChange(fn) {
    const unsub = this.store.subscribe(fn);
    const onStorage = (e) => { if (e.key === "liveos.local.v1") fn({ type: "storage" }); };
    globalThis.addEventListener?.("storage", onStorage);
    return () => { unsub(); globalThis.removeEventListener?.("storage", onStorage); };
  }
}

// --------------------------------------------------------- supabase adapter
export class SupabaseAdapter {
  constructor(config) {
    this.mode = "supabase";
    this.url = config.supabaseUrl.replace(/\/$/, "");
    this.key = config.supabaseAnonKey;
    this.userId = globalThis.localStorage?.getItem("liveos.userId") || (() => {
      const id = nextId("user"); globalThis.localStorage?.setItem("liveos.userId", id); return id;
    })();
    this._hash = "";
    this._timer = null;
    this._ws = null;
  }
  _headers(extra = {}) {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...extra };
  }
  async _get(path) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, { headers: this._headers() });
    if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
    return res.json();
  }
  async getState() {
    const [modules, screens, records, installs] = await Promise.all([
      this._get("modules?select=*&published=eq.true&order=slug"),
      this._get("screens?select=*&published=eq.true"),
      this._get("records?select=*&order=created_at.asc"),
      this._get(`module_installs?select=module_slug&user_id=eq.${this.userId}`)
    ]);
    return { modules, screens, records, installs: installs.map((i) => i.module_slug) };
  }
  async createRecord(moduleSlug, kind, payload) {
    const res = await fetch(`${this.url}/rest/v1/records`, {
      method: "POST",
      headers: this._headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ module_slug: moduleSlug, kind, payload, created_by: null })
    });
    if (!res.ok) throw new Error(`Supabase POST records -> ${res.status}`);
    const [row] = await res.json();
    return row;
  }
  async install(slug) {
    const res = await fetch(`${this.url}/rest/v1/module_installs`, {
      method: "POST", headers: this._headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ user_id: this.userId, module_slug: slug })
    });
    if (!res.ok && res.status !== 409) throw new Error(`install -> ${res.status}`);
    return (await this.getState()).installs;
  }
  async uninstall(slug) {
    const res = await fetch(`${this.url}/rest/v1/module_installs?user_id=eq.${this.userId}&module_slug=eq.${slug}`, {
      method: "DELETE", headers: this._headers()
    });
    if (!res.ok) throw new Error(`uninstall -> ${res.status}`);
    return (await this.getState()).installs;
  }
  async updateScreenLayout() { throw new Error("Screen edits in Supabase mode are made in the database (Table Editor / SQL) — the shell updates live when the row changes."); }
  // Live path (Supabase): try a Realtime websocket (phoenix protocol,
  // postgres_changes on the kernel tables). Whether or not the socket
  // connects, a 5s poll compares a state hash and fires on change, so the
  // shell always re-renders live without a reload.
  onChange(fn) {
    let stopped = false;
    const poll = async () => {
      try {
        const state = await this.getState();
        const hash = JSON.stringify(state);
        if (this._hash && hash !== this._hash) fn({ type: "remote" });
        this._hash = hash;
      } catch { /* transient; next poll retries */ }
    };
    this._hash = "";
    poll();
    this._timer = setInterval(poll, 5000);
    try {
      const wsUrl = `${this.url.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${this.key}&vsn=1.0.0`;
      this._ws = new WebSocket(wsUrl);
      this._ws.onopen = () => {
        this._ws.send(JSON.stringify({
          topic: "realtime:liveos", event: "phx_join", payload: { config: { broadcast: { self: false },
            postgres_changes: [
              { event: "*", schema: "public", table: "screens" },
              { event: "*", schema: "public", table: "modules" },
              { event: "*", schema: "public", table: "records" },
              { event: "*", schema: "public", table: "module_installs" }
            ] } }, ref: "1"
        }));
      };
      this._ws.onmessage = (msg) => { if (String(msg.data).includes("postgres_changes")) fn({ type: "realtime" }); };
    } catch { /* polling fallback covers it */ }
    return () => { stopped = true; clearInterval(this._timer); try { this._ws?.close(); } catch {} };
  }
}

export function createAdapter(config, storage) {
  return selectMode(config) === "supabase" ? new SupabaseAdapter(config) : new LocalAdapter(storage);
}
