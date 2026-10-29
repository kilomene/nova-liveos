// Nova LiveOS data layer — v1.0.1
// Two adapters behind one interface:
//   LocalAdapter    — fixture data in localStorage (works offline, no account)
//   SupabaseAdapter — PostgREST via fetch with the anon key (or the signed-in
//                     user's token); live updates via a Realtime websocket,
//                     with a polling fallback that re-renders on change.
// Every network call goes through fetchWithRetry (8s timeout, one retry) so
// a slow query can never stall the shell the way v0.1's cold load did.
// The shell picks the adapter automatically from public/config.js.

import { SEED } from "./seed-data.mjs";
import { fetchWithRetry } from "./net.mjs";
import { AuthClient, displayNameFromEmail, SESSION_KEY } from "./auth.mjs";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }
export function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const PRESENCE_MODULE = "liveos-core";
export const PRESENCE_WINDOW_MS = 45_000;

// ------------------------------------------------------------ local store
// Pure state logic over a {getItem,setItem} storage — unit-testable in node
// with an in-memory shim, and used by LocalAdapter with real localStorage.
// reload() picks up writes made by OTHER shells (tabs) sharing the storage:
// that is what makes local mode genuinely multi-shell real-time via the
// `storage` event, not just same-tab live.
export function createLocalStore(storage, seed = SEED, storageKey = "liveos.local.v1") {
  let state;
  let lastRaw = null;
  const raw0 = storage.getItem(storageKey);
  if (raw0) { try { state = JSON.parse(raw0); } catch { state = null; } }
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
      automations: structuredClone(seed.automations || []).map((a, i) => ({ id: `auto_${i + 1}`, ...a })),
      audit: [],
      profiles: [],
      userRoles: [],
      presence: {},
      userId: "local-user"
    };
    persist();
  } else {
    lastRaw = raw0;
    state.automations ||= [];
    state.audit ||= [];
    state.profiles ||= [];
    state.userRoles ||= [];
    state.presence ||= {};
  }
  const listeners = new Set();
  function persist() {
    lastRaw = JSON.stringify(state);
    storage.setItem(storageKey, lastRaw);
  }
  function emit(change) { for (const fn of listeners) fn(change); }
  function logAudit(event, entity, entityId, detail = {}) {
    state.audit.push({
      id: nextId("audit"), actor: "local", event, entity,
      entity_id: String(entityId || ""), detail,
      created_at: new Date().toISOString()
    });
    if (state.audit.length > 400) state.audit = state.audit.slice(-400);
  }

  return {
    get userId() { return state.userId; },
    // Re-read storage if another shell changed it. Returns true on change.
    reload() {
      const raw = storage.getItem(storageKey);
      if (raw && raw !== lastRaw) {
        try {
          const next = JSON.parse(raw);
          if (next && next.version === seed.version) {
            state = next; lastRaw = raw;
            state.automations ||= []; state.audit ||= []; state.profiles ||= [];
            state.userRoles ||= []; state.presence ||= {};
            return true;
          }
        } catch { /* keep current state */ }
      }
      return false;
    },
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
      if (!state.installs.includes(slug)) {
        state.installs.push(slug);
        logAudit("module.installed", "modules", slug, { slug });
        persist(); emit({ type: "install", slug });
      }
      return [...state.installs];
    },
    uninstall(slug) {
      state.installs = state.installs.filter((s) => s !== slug);
      logAudit("module.uninstalled", "modules", slug, { slug });
      persist(); emit({ type: "uninstall", slug });
      return [...state.installs];
    },
    createRecord(moduleSlug, kind, payload, createdBy = state.userId) {
      const record = {
        id: nextId(), module_slug: moduleSlug, kind,
        payload: { ...payload }, created_by: createdBy, created_at: new Date().toISOString()
      };
      state.records.push(record);
      logAudit("record.created", "records", record.id, { module_slug: moduleSlug, kind });
      persist(); emit({ type: "record", record });
      return structuredClone(record);
    },
    updateRecord(id, payloadPatch) {
      const r = state.records.find((x) => x.id === id);
      if (!r) throw new Error(`unknown record: ${id}`);
      r.payload = { ...r.payload, ...structuredClone(payloadPatch) };
      r.updated_at = new Date().toISOString();
      logAudit("record.updated", "records", id, { module_slug: r.module_slug, kind: r.kind });
      persist(); emit({ type: "record", record: structuredClone(r) });
      return structuredClone(r);
    },
    deleteRecord(id) {
      const idx = state.records.findIndex((x) => x.id === id);
      if (idx < 0) throw new Error(`unknown record: ${id}`);
      const [gone] = state.records.splice(idx, 1);
      logAudit("record.deleted", "records", id, { module_slug: gone.module_slug, kind: gone.kind });
      persist(); emit({ type: "record-delete", id });
      return true;
    },
    createModule(data) {
      if (state.modules.some((m) => m.slug === data.slug)) throw new Error(`module exists: ${data.slug}`);
      const mod = {
        slug: data.slug, name: data.name || data.slug, version: data.version || "1.0.0",
        description: data.description || "", icon: data.manifest?.icon || "grid",
        manifest: { route: data.slug, category: "Modules", ...(data.manifest || {}) },
        bundle_url: null, published: data.published !== false
      };
      state.modules.push(mod);
      logAudit("module.created", "modules", mod.slug, { slug: mod.slug });
      persist(); emit({ type: "module", slug: mod.slug });
      return structuredClone(mod);
    },
    updateModule(slug, patch) {
      const m = state.modules.find((x) => x.slug === slug);
      if (!m) throw new Error(`unknown module: ${slug}`);
      Object.assign(m, structuredClone(patch));
      logAudit("module.updated", "modules", slug, { slug });
      persist(); emit({ type: "module", slug });
      return structuredClone(m);
    },
    createScreen(moduleSlug, title) {
      const screen = {
        module_slug: moduleSlug, slug: "main", title: title || moduleSlug, published: true,
        layout: [{ type: "hero", title: title || moduleSlug, subtitle: "A brand-new module. Shape it in the Screen Editor.", caption: "Freshly created — make it yours." }]
      };
      state.screens.push(screen);
      logAudit("screen.created", "screens", `${moduleSlug}/main`, {});
      persist(); emit({ type: "screen", module_slug: moduleSlug, slug: "main" });
      return structuredClone(screen);
    },
    updateScreenLayout(moduleSlug, slug, layout) {
      const s = state.screens.find((x) => x.module_slug === moduleSlug && x.slug === slug);
      if (!s) throw new Error(`unknown screen: ${moduleSlug}/${slug}`);
      s.layout = structuredClone(layout);
      logAudit("screen.updated", "screens", `${moduleSlug}/${slug}`, {});
      persist(); emit({ type: "screen", module_slug: moduleSlug, slug });
      return structuredClone(s);
    },
    getAutomations: () => structuredClone(state.automations),
    updateAutomation(id, patch) {
      const a = state.automations.find((x) => x.id === id || x.slug === id);
      if (!a) throw new Error(`unknown automation: ${id}`);
      Object.assign(a, structuredClone(patch));
      logAudit("automation.updated", "automations", a.slug, { enabled: a.enabled });
      persist(); emit({ type: "automation", slug: a.slug });
      return structuredClone(a);
    },
    addAudit(entry) {
      logAudit(entry.event, entry.entity || "", entry.entity_id || "", entry.detail || {});
      persist(); emit({ type: "audit" });
      return true;
    },
    getAudit: (limit = 100) => structuredClone([...state.audit].reverse().slice(0, limit)),
    upsertProfile(profile) {
      const idx = state.profiles.findIndex((p) => p.auth_user_id === profile.auth_user_id);
      const row = {
        id: idx >= 0 ? state.profiles[idx].id : newUuid(),
        display_name: "", email: "", ...profile
      };
      if (idx >= 0) state.profiles[idx] = { ...state.profiles[idx], ...row };
      else {
        state.profiles.push(row);
        state.userRoles.push({ user_id: row.id, roles: ["admin", "member"] });
      }
      persist(); emit({ type: "profile" });
      return structuredClone(idx >= 0 ? state.profiles[idx] : row);
    },
    getProfileByAuthId(authId) {
      const p = state.profiles.find((x) => x.auth_user_id === authId);
      return p ? structuredClone(p) : null;
    },
    getRoleSlugs(profileId) {
      const ur = state.userRoles.find((x) => x.user_id === profileId);
      return ur ? [...ur.roles] : [];
    },
    heartbeat(shellId) {
      const now = Date.now();
      state.presence[shellId] = now;
      for (const [k, ts] of Object.entries(state.presence)) {
        if (now - ts > PRESENCE_WINDOW_MS * 4) delete state.presence[k];
      }
      persist();
      return Object.values(state.presence).filter((ts) => now - ts <= PRESENCE_WINDOW_MS).length;
    },
    getPresenceCount() {
      const now = Date.now();
      return Object.values(state.presence).filter((ts) => now - ts <= PRESENCE_WINDOW_MS).length;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => structuredClone(state)
  };
}

export class LocalAdapter {
  constructor(storage = globalThis.localStorage) {
    this.mode = "local";
    this.store = createLocalStore(storage);
    this.storage = storage;
    this.userId = this.store.userId;
    // Presence identity is per SHELL (tab), not per browser: sessionStorage
    // is scoped to the tab, so two tabs count as two live shells.
    const ss = globalThis.sessionStorage;
    let sid = null;
    try { sid = ss?.getItem("liveos.shellId"); } catch { sid = null; }
    this.shellId = isUuid(sid) ? sid : newUuid();
    if (this.shellId !== sid) { try { ss?.setItem("liveos.shellId", this.shellId); } catch { /* private mode */ } }
    this.session = null;
    try { this.session = JSON.parse(storage?.getItem(SESSION_KEY) || "null"); } catch { this.session = null; }
    if (this.session && !this.session.user?.id) this.session = null;
  }
  async getState() {
    this.store.reload();
    return {
      modules: this.store.getModules(),
      screens: this.store.getScreens(),
      records: this.store.getRecords(),
      installs: this.store.getInstalls()
    };
  }
  async getCoreState() { return this.getState(); }
  async getRecords() { this.store.reload(); return this.store.getRecords(); }
  async getAdminCatalogue() {
    return { modules: this.store.getModules(), screens: this.store.getScreens() };
  }
  async upsertProfile(profile) { return this.store.upsertProfile(profile); }
  async createRecord(m, k, p) {
    const payload = { ...p };
    return this.store.createRecord(m, k, payload, this.session?.user?.id || this.userId);
  }
  async updateRecord(id, patch) { return this.store.updateRecord(id, patch); }
  async deleteRecord(id) { return this.store.deleteRecord(id); }
  async install(slug) { return this.store.install(slug); }
  async uninstall(slug) { return this.store.uninstall(slug); }
  async updateScreenLayout(m, s, l) { return this.store.updateScreenLayout(m, s, l); }
  async createModule(data) { return this.store.createModule(data); }
  async updateModule(slug, patch) { return this.store.updateModule(slug, patch); }
  async createScreen(m, t) { return this.store.createScreen(m, t); }
  async getAutomations() { return this.store.getAutomations(); }
  async updateAutomation(id, patch) { return this.store.updateAutomation(id, patch); }
  async getAudit(limit) { return this.store.getAudit(limit); }
  async addAudit(entry) { return this.store.addAudit(entry); }
  async heartbeat(shellId) { return this.store.heartbeat(shellId); }
  async getPresenceCount() { return this.store.getPresenceCount(); }
  // --- auth (fixture simulation, clearly labelled as local mode in the UI)
  async signIn(email) {
    const profile = this.store.upsertProfile({
      auth_user_id: `local:${email}`, email,
      display_name: displayNameFromEmail(email)
    });
    this.session = {
      access_token: "local", refresh_token: "",
      expires_at: Date.now() + 365 * 24 * 3600 * 1000,
      user: { id: profile.auth_user_id, email }, local: true, profileId: profile.id
    };
    this.storage?.setItem(SESSION_KEY, JSON.stringify(this.session));
    return this.session;
  }
  async signUp(email) { return this.signIn(email); }
  async signInWithMagicLink() { return { sent: true, local: true }; }
  async signOut() {
    this.session = null;
    this.storage?.removeItem(SESSION_KEY);
  }
  async getSession() { return this.session; }
  async getMyProfile() {
    if (!this.session) return null;
    return this.store.getProfileByAuthId(this.session.user.id);
  }
  async getMyRoles() {
    if (!this.session) return [];
    const p = await this.getMyProfile();
    return p ? this.store.getRoleSlugs(p.id) : [];
  }
  // Live path (local): same-tab event bus + cross-tab `storage` events.
  // On a storage event the store reloads from shared storage, so a change
  // in one tab/shell appears in the other without a reload.
  onChange(fn) {
    const unsub = this.store.subscribe(fn);
    const onStorage = (e) => {
      if (e.key === "liveos.local.v1" && this.store.reload()) fn({ type: "storage" });
      if (e.key === SESSION_KEY) fn({ type: "auth" });
    };
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
    this.auth = new AuthClient({ url: this.url, anonKey: this.key });
    this.session = this.auth.session;
    // module_installs.user_id is a uuid column: the per-browser id MUST be a
    // real UUID or the installs query in getState() fails (22P02) and the
    // shell never renders. A legacy non-UUID stored id is replaced. While
    // signed in, identity is the auth user id (also a uuid).
    const storedId = globalThis.localStorage?.getItem("liveos.userId");
    this.anonId = isUuid(storedId) ? storedId : newUuid();
    if (this.anonId !== storedId) globalThis.localStorage?.setItem("liveos.userId", this.anonId);
    this.userId = this.session?.user?.id || this.anonId;
    const storedShell = globalThis.localStorage?.getItem("liveos.shellId");
    this.shellId = isUuid(storedShell) ? storedShell : newUuid();
    if (this.shellId !== storedShell) globalThis.localStorage?.setItem("liveos.shellId", this.shellId);
    this._hash = "";
    this._timer = null;
    this._ws = null;
  }
  _headers(extra = {}) {
    const token = this.session?.access_token || this.key;
    return { apikey: this.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra };
  }
  async _req(method, path, body, extraHeaders = {}) {
    const res = await fetchWithRetry(`${this.url}/rest/v1/${path}`, {
      method, headers: this._headers(extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.message || ""; } catch { /* ignore */ }
      throw new Error(`Supabase ${method} ${path.split("?")[0]} -> ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  _get(path) { return this._req("GET", path); }

  // Fast path: catalogue + installs only (no records). Boot renders from
  // this; records stream in right behind it.
  async getCoreState() {
    const [modules, screens, installs] = await Promise.all([
      this._get("modules?select=*&published=eq.true&order=slug"),
      this._get("screens?select=*&published=eq.true"),
      this._get(`module_installs?select=module_slug&user_id=eq.${this.userId}`)
    ]);
    return { modules, screens, installs: installs.map((i) => i.module_slug) };
  }
  async getRecords() {
    return this._get(`records?select=*&module_slug=neq.${PRESENCE_MODULE}&order=created_at.asc`);
  }
  async getState() {
    const [core, records] = await Promise.all([this.getCoreState(), this.getRecords()]);
    return { ...core, records };
  }
  // Admin catalogue: unpublished modules/screens included (migration 0003
  // opens catalogue reads; before it, this returns the published subset).
  async getAdminCatalogue() {
    const [modules, screens] = await Promise.all([
      this._get("modules?select=*&order=slug"),
      this._get("screens?select=*")
    ]);
    return { modules, screens };
  }
  async createRecord(moduleSlug, kind, payload) {
    const [row] = await this._req("POST", "records", {
      module_slug: moduleSlug, kind, payload,
      created_by: this.session?.user?.id || null
    }, { Prefer: "return=representation" });
    return row;
  }
  async updateRecord(id, payloadPatch) {
    const current = await this._get(`records?select=payload&id=eq.${id}`);
    const merged = { ...(current?.[0]?.payload || {}), ...payloadPatch };
    const [row] = await this._req("PATCH", `records?id=eq.${id}`, { payload: merged }, { Prefer: "return=representation" });
    return row;
  }
  async deleteRecord(id) {
    await this._req("DELETE", `records?id=eq.${id}`);
    return true;
  }
  async install(slug) {
    const res = await fetchWithRetry(`${this.url}/rest/v1/module_installs`, {
      method: "POST", headers: this._headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ user_id: this.userId, module_slug: slug })
    });
    if (!res.ok && res.status !== 409) throw new Error(`install -> ${res.status}`);
    return (await this.getCoreState()).installs;
  }
  async uninstall(slug) {
    await this._req("DELETE", `module_installs?user_id=eq.${this.userId}&module_slug=eq.${slug}`);
    return (await this.getCoreState()).installs;
  }
  async updateScreenLayout(moduleSlug, slug, layout) {
    const [row] = await this._req("PATCH",
      `screens?module_slug=eq.${encodeURIComponent(moduleSlug)}&slug=eq.${encodeURIComponent(slug)}`,
      { layout }, { Prefer: "return=representation" });
    return row;
  }
  async createModule(data) {
    const [row] = await this._req("POST", "modules", {
      slug: data.slug, name: data.name, version: data.version || "1.0.0",
      description: data.description || "", icon: data.manifest?.icon || "grid",
      manifest: { route: data.slug, category: "Modules", ...(data.manifest || {}) },
      published: data.published !== false
    }, { Prefer: "return=representation" });
    return row;
  }
  async updateModule(slug, patch) {
    const body = {};
    for (const k of ["name", "version", "description", "icon", "manifest", "published", "bundle_url"]) {
      if (k in patch) body[k] = patch[k];
    }
    const [row] = await this._req("PATCH", `modules?slug=eq.${encodeURIComponent(slug)}`, body, { Prefer: "return=representation" });
    return row;
  }
  async createScreen(moduleSlug, title) {
    const [row] = await this._req("POST", "screens", {
      module_slug: moduleSlug, slug: "main", title: title || moduleSlug, published: true,
      layout: [{ type: "hero", title: title || moduleSlug, subtitle: "A brand-new module. Shape it in the Screen Editor.", caption: "Freshly created — make it yours." }]
    }, { Prefer: "return=representation" });
    return row;
  }
  async getAutomations() { return this._get("automations?select=*&order=slug"); }
  async updateAutomation(id, patch) {
    const body = {};
    for (const k of ["name", "trigger_event", "action", "enabled"]) if (k in patch) body[k] = patch[k];
    const key = isUuid(id) ? `id=eq.${id}` : `slug=eq.${encodeURIComponent(id)}`;
    const [row] = await this._req("PATCH", `automations?${key}`, body, { Prefer: "return=representation" });
    return row;
  }
  async getAudit(limit = 100) {
    return this._get(`audit_log?select=*&order=created_at.desc&limit=${limit}`);
  }
  async addAudit(entry) {
    await this._req("POST", "audit_log", {
      actor: this.session?.user?.id || null,
      event: entry.event, entity: entry.entity || "",
      entity_id: String(entry.entity_id || ""), detail: entry.detail || {}
    }, { Prefer: "return=minimal" });
    return true;
  }
  // Presence: one tiny heartbeat row per shell per beat in the records table
  // (module liveos-core, filtered out of every normal record read). Counting
  // distinct shell ids inside the freshness window gives live presence.
  async heartbeat() {
    await this._req("POST", "records", {
      module_slug: PRESENCE_MODULE, kind: "presence",
      payload: { shell: this.shellId }, created_by: null
    }, { Prefer: "return=minimal" });
    return this.getPresenceCount();
  }
  async getPresenceCount() {
    const since = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString();
    const rows = await this._get(
      `records?select=payload&module_slug=eq.${PRESENCE_MODULE}&kind=eq.presence&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=500`);
    const shells = new Set((rows || []).map((r) => r.payload?.shell).filter(Boolean));
    shells.add(this.shellId);
    return shells.size;
  }
  // -------------------------------------------------------------- auth flow
  async _adoptSession(session) {
    const previousAnon = this.anonId;
    this.session = session;
    this.userId = session?.user?.id || this.anonId;
    if (session?.user?.id) {
      // Migrate the anonymous installs to the account (best effort).
      try {
        const anonInstalls = await this._get(`module_installs?select=module_slug&user_id=eq.${previousAnon}`);
        for (const row of anonInstalls || []) {
          await fetchWithRetry(`${this.url}/rest/v1/module_installs`, {
            method: "POST", headers: this._headers({ Prefer: "return=minimal" }),
            body: JSON.stringify({ user_id: session.user.id, module_slug: row.module_slug })
          }).catch(() => null);
        }
      } catch { /* migration is a nicety, never a blocker */ }
      await this.upsertProfile({
        auth_user_id: session.user.id,
        email: session.user.email || "",
        display_name: displayNameFromEmail(session.user.email)
      }).catch(() => null);
    }
  }
  async signIn(email, password) {
    const session = await this.auth.signIn(email, password);
    await this._adoptSession(session);
    return session;
  }
  async signUp(email, password) {
    const result = await this.auth.signUp(email, password);
    if (result.session) await this._adoptSession(result.session);
    return result;
  }
  async signInWithMagicLink(email) {
    return this.auth.signInWithMagicLink(email, globalThis.location?.href?.split("#")[0]);
  }
  async signOut() {
    await this.auth.signOut();
    await this._adoptSession(null);
  }
  async getSession() {
    const session = await this.auth.validSession();
    if ((session?.user?.id || null) !== (this.session?.user?.id || null)) {
      await this._adoptSession(session);
    } else this.session = session;
    return this.session;
  }
  async upsertProfile(profile) {
    const [row] = await this._req("POST", "profiles?on_conflict=auth_user_id", profile,
      { Prefer: "resolution=merge-duplicates,return=representation" });
    return row;
  }
  async getMyProfile() {
    if (!this.session?.user?.id) return null;
    const rows = await this._get(`profiles?select=*&auth_user_id=eq.${this.session.user.id}`);
    return rows?.[0] || null;
  }
  async getMyRoles() {
    const profile = await this.getMyProfile();
    if (!profile) return [];
    const rows = await this._get(`user_roles?select=roles(slug)&user_id=eq.${profile.id}`);
    return (rows || []).map((r) => r.roles?.slug).filter(Boolean);
  }
  // Live path (Supabase): Realtime websocket (phoenix protocol,
  // postgres_changes on the kernel tables incl. audit + automations).
  // Whether or not the socket connects, a 5s poll compares a state hash and
  // fires on change, so the shell always re-renders live without a reload.
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
              { event: "*", schema: "public", table: "module_installs" },
              { event: "*", schema: "public", table: "automations" },
              { event: "*", schema: "public", table: "audit_log" }
            ] } }, ref: "1"
        }));
      };
      this._ws.onmessage = (msg) => { if (!stopped && String(msg.data).includes("postgres_changes")) fn({ type: "realtime" }); };
    } catch { /* polling fallback covers it */ }
    return () => { stopped = true; clearInterval(this._timer); try { this._ws?.close(); } catch {} };
  }
}

export function createAdapter(config, storage) {
  return selectMode(config) === "supabase" ? new SupabaseAdapter(config) : new LocalAdapter(storage);
}
