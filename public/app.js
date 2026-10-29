// Nova LiveOS shell — v1.0.4 "Advanced"
// Ships empty: navigation, pages and features all come from the data layer
// (Supabase when configured, local fixture data otherwise) and re-render
// live when the data changes — no reload, no redeploy.
//
// v1.0: progressive boot (chrome + skeletons first, catalogue next, records
// last — first paint never waits on the slowest query), Supabase Auth,
// admin console, cart + checkout, kanban with drag, global search/command
// palette, notifications, presence, the in-shell automation engine, and
// optimistic updates on every mutation (instant local echo, then server
// confirmation; a failure rolls back via a fresh read + a visible toast).
//
// v1.0.3: first-paint speed + monotonic state + invisible sync. Boot
// paints the last good state from the localStorage snapshot
// (lib/snapshot) instantly and revalidates in the background; cold
// boots paint each data class as it lands. Refresh cycles are
// coordinated (lib/refresh): concurrently started, sequence-gated, and
// — once a complete state exists — applied all-or-nothing, so a
// partial, failed or stale cycle can never downgrade the rendered
// state or its counts. And refresh is invisible: presence never
// reaches the render path, a no-change cycle does zero DOM work, and
// real changes are patched into the live DOM in place (lib/patch) —
// scroll, focus and typed input survive every sync.

import { renderBlock, renderScreen, escapeHtml, fillTemplate } from "./lib/core.mjs";
import { createAdapter, PRESENCE_WINDOW_MS } from "./lib/data.mjs";
import { iconSvg, moduleIcon, moduleIconSlug } from "./lib/icons.mjs";
import {
  cartAdd, cartSetQty, cartRemove, cartView, cartSummary,
  moveRecordStatus, buildSearchIndex, searchIndex, notificationsFrom, isPresenceAudit,
  BLOCK_SCHEMAS, BLOCK_TYPES, addBlock, removeBlock, moveBlockInLayout, applyBlockEdit
} from "./lib/features.mjs";
import { runAutomations } from "./lib/features.mjs";
import { displayNameFromEmail } from "./lib/auth.mjs";
import { getDataOnline, noteDataSuccess, noteDataFailure, onDataConnectivity } from "./lib/net.mjs";
import { snapshotIdentity, readSnapshot, writeSnapshot } from "./lib/snapshot.mjs";
import { settle, createCycleTracker, buildCandidate, dataStatesEqual } from "./lib/refresh.mjs";
import { patchChildren } from "./lib/patch.mjs";

const config = window.LIVEOS_CONFIG || {};
const adapter = createAdapter(config);
const app = document.getElementById("app");
const drawer = document.getElementById("drawer");
const overlay = document.getElementById("drawerOverlay");
const nav = document.getElementById("drawerNav");

const CART_KEY = "liveos.cart.v1";
const SEEN_KEY = "liveos.notifSeen.v1";

let state = {
  modules: [], screens: [], records: [], installs: [],
  automations: [], audit: [], profile: null, roles: [],
  session: null, presence: 1, catalogue: null, booted: false, coreReady: false,
  recordsReady: false, fromSnapshot: false
};
let cart = loadCart();
let sortState = {};
let paletteOpen = false;
let paletteResults = [];
let paletteSel = 0;
let editor = null; // { module, layout } while in the screen editor
let recordsFilter = { module: "", kind: "" };
let toastTimer = null;
let engineBusy = false;
let deferredInstallPrompt = null;

// ---------------------------------------------------------------- utilities
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function loadCart() {
  try { return cartView(JSON.parse(localStorage.getItem(CART_KEY) || '{"items":[]}')); }
  catch { return cartView({ items: [] }); }
}
function saveCart() { localStorage.setItem(CART_KEY, JSON.stringify({ items: cart.items })); updateBadges(); }
function isAdmin() { return adapter.mode === "local" || state.roles.includes("admin"); }
function displayName() {
  if (state.profile?.display_name) return state.profile.display_name;
  if (state.session?.user?.email) return displayNameFromEmail(state.session.user.email);
  return adapter.mode === "local" ? "Local user" : `Shell ${String(adapter.userId).slice(0, 4)}`;
}
function publishedModules() { return state.modules.filter((m) => m.published); }
function catalogueModules() { return state.catalogue?.modules || state.modules; }
function catalogueScreens() { return state.catalogue?.screens || state.screens; }

function counts() {
  const map = { "modules:installed": state.installs.length, "modules:total": publishedModules().length, "records:total": state.records.length };
  for (const r of state.records) {
    const k = `${r.module_slug}:${r.kind}`;
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

// Records as the renderer should see them: shop/job labels filled in and
// each job carrying its live bid count.
function preparedRecords() {
  const bidsByJob = {};
  for (const r of state.records) {
    if (r.kind === "bid" && r.payload?.job) bidsByJob[r.payload.job] = (bidsByJob[r.payload.job] || 0) + 1;
  }
  return state.records.map((r) => {
    const p = { ...r.payload };
    if (typeof p.price === "number" && !p.priceLabel) p.priceLabel = `$${p.price}`;
    if (typeof p.total === "number" && !p.totalLabel) p.totalLabel = `$${p.total}`;
    if (r.kind === "order" && p.status && !p.statusLabel) p.statusLabel = `Status: ${p.status}`;
    if (r.kind === "job") {
      const n = bidsByJob[p.title] || 0;
      p.bidCountLabel = `${n} bid${n === 1 ? "" : "s"}`;
    }
    return { ...r, payload: p };
  });
}
function renderCtx() {
  return { records: preparedRecords(), counts: counts(), cart, sortState, statsPending: !state.recordsReady };
}

// ------------------------------------------------------------------- routing
function route() {
  const hash = location.hash || "#/";
  if (hash === "#/" || hash === "#") return { view: "home" };
  if (hash === "#/store") return { view: "store" };
  if (hash === "#/cart") return { view: "cart" };
  if (hash === "#/profile") return { view: "profile" };
  if (hash === "#/notifications") return { view: "notifications" };
  if (hash === "#/admin") return { view: "admin" };
  const a = hash.match(/^#\/admin\/(\w+)$/);
  if (a) return { view: "admin", section: a[1] };
  const m = hash.match(/^#\/m\/([\w-]+)$/);
  if (m) return { view: "module", slug: m[1] };
  return { view: "home" };
}

// -------------------------------------------------------------------- chrome
// The drawer is rebuilt only when its signature actually changes
// (route, installs, module identities, session, unread, cart) — a
// background refresh that changes none of those leaves the DOM alone.
let lastNavSig = "";
function renderNav() {
  const r = route();
  const sig = JSON.stringify([r.view, r.slug || "", state.installs,
    state.modules.map((m) => `${m.slug}:${m.name}:${moduleIconSlug(m)}:${m.manifest?.category || ""}`),
    state.session?.user?.email || "", isAdmin(), unreadCount(), cart.count]);
  if (sig === lastNavSig) return;
  lastNavSig = sig;
  const groups = new Map();
  for (const slug of state.installs) {
    const mod = state.modules.find((m) => m.slug === slug);
    if (!mod) continue;
    const cat = mod.manifest?.category || "Modules";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(mod);
  }
  let html = `<div class="nav-group">LiveOS</div>
    <a class="nav-link ${r.view === "home" ? "active" : ""}" href="#/">${iconSvg("home", "icon nav-icon")}<span>Home</span></a>
    <a class="nav-link ${r.view === "store" ? "active" : ""}" href="#/store">${iconSvg("store", "icon nav-icon")}<span>Module Store</span></a>
    <a class="nav-link ${r.view === "cart" ? "active" : ""}" href="#/cart">${iconSvg("cart", "icon nav-icon")}<span>Cart</span>${cart.count ? `<span class="nav-count">${cart.count}</span>` : ""}</a>
    <a class="nav-link ${r.view === "notifications" ? "active" : ""}" href="#/notifications">${iconSvg("bell", "icon nav-icon")}<span>Notifications</span>${unreadCount() ? `<span class="nav-count alert">${unreadCount()}</span>` : ""}</a>`;
  for (const [cat, mods] of groups) {
    html += `<div class="nav-group">${escapeHtml(cat)}</div>`;
    for (const mod of mods) {
      html += `<a class="nav-link ${r.view === "module" && r.slug === mod.slug ? "active" : ""}" href="#/m/${escapeHtml(mod.slug)}">${moduleIcon(mod, "icon nav-icon")}<span>${escapeHtml(mod.name)}</span></a>`;
    }
  }
  if (isAdmin()) {
    html += `<div class="nav-group">Administration</div>
      <a class="nav-link ${r.view === "admin" ? "active" : ""}" href="#/admin">${iconSvg("shield", "icon nav-icon")}<span>Admin Console</span></a>`;
  }
  nav.innerHTML = html;
  renderAccount();
}

function renderAccount() {
  const el = document.getElementById("drawerAccount");
  if (!el) return;
  if (state.session) {
    el.innerHTML = `<a class="account-card" href="#/profile">
      <span class="avatar">${escapeHtml(displayName().slice(0, 1).toUpperCase())}</span>
      <span class="account-meta"><strong>${escapeHtml(displayName())}</strong><small>${escapeHtml(state.session.user.email || "")}</small></span>
      ${iconSvg("user", "icon account-icon")}</a>`;
  } else {
    el.innerHTML = `<a class="account-card" href="#/profile">
      <span class="avatar guest">${iconSvg("user", "icon")}</span>
      <span class="account-meta"><strong>Welcome</strong><small>Sign in for your profile & roles</small></span></a>`;
  }
}

function unreadCount() {
  const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
  return notificationsFrom({ records: state.records, audit: state.audit }, seen, 99).length;
}

// Badge + presence writes are value-gated: the DOM is touched only
// when the displayed number actually changes. A presence heartbeat
// whose count is unchanged writes nothing at all.
const badgeCache = { bell: null, cart: null, presence: null };
function updateBadges() {
  const bellBadge = document.getElementById("bellBadge");
  const cartBadge = document.getElementById("cartBadge");
  const n = unreadCount();
  if (bellBadge && badgeCache.bell !== n) {
    badgeCache.bell = n;
    bellBadge.textContent = n;
    bellBadge.style.display = n ? "inline-flex" : "none";
  }
  if (cartBadge && badgeCache.cart !== cart.count) {
    badgeCache.cart = cart.count;
    cartBadge.textContent = cart.count;
    cartBadge.style.display = cart.count ? "inline-flex" : "none";
  }
  const presenceEl = document.getElementById("presenceChip");
  if (presenceEl && badgeCache.presence !== state.presence) {
    badgeCache.presence = state.presence;
    presenceEl.innerHTML = `<span class="presence-dot"></span>${state.presence} online`;
  }
}

function renderChromeStatus() {
  document.getElementById("liveStatus").textContent = !state.coreReady
    ? "Connecting…"
    : state.fromSnapshot ? "Syncing…"
    : adapter.mode === "supabase" ? "Live · Supabase connected" : "Live · local mode (fixture data)";
  document.getElementById("modePill").textContent = adapter.mode;
  updateBadges();
}

// -------------------------------------------------------------- view: shell
function skeletonView() {
  return `<section class="block hero"><div class="skel skel-title"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></section>
  <section class="block stats"><div class="stat"><div class="skel skel-num"></div><div class="skel skel-line short"></div></div><div class="stat"><div class="skel skel-num"></div><div class="skel skel-line short"></div></div><div class="stat"><div class="skel skel-num"></div><div class="skel skel-line short"></div></div></section>
  <section class="block"><div class="skel skel-card"></div></section>`;
}

function homeView() {
  if (!state.coreReady) return skeletonView();
  const hero = renderBlock({ type: "hero", title: "One shell. Everything else is data.",
    subtitle: "Nova LiveOS ships empty. Every screen, feature and module you see lives in the database and updates here live — change the data, and every installed copy changes with it. No server, no redeploy.",
    caption: "Your home base: what is installed, what is live, and where to go next." });
  const stats = renderBlock({ type: "stats", items: [
    { label: "Modules in store", countKey: "modules:total" },
    { label: "Installed", countKey: "modules:installed" },
    { label: "Live records", countKey: "records:total" }
  ]}, renderCtx());
  const installedCards = state.installs.map((slug) => {
    const mod = state.modules.find((m) => m.slug === slug);
    if (!mod) return "";
    return `<article class="card module-card"><div class="module-card-head">${moduleIcon(mod, "icon module-icon")}<h3>${escapeHtml(mod.name)}</h3></div><p>${escapeHtml(mod.description)}</p><a class="btn btn-primary" href="#/m/${escapeHtml(mod.slug)}">Open</a></article>`;
  }).join("");
  const demo = adapter.mode === "local" ? `<section class="block demo-panel"><h2>See it live</h2>
    <p>This copy is running in local mode on fixture data. Use the <strong>Simulate live change</strong> button to change the Team Board screen definition in the data layer — every open shell updates in place, without a reload. Wire a Supabase project (see the installer) and the same thing happens from a database edit, via Realtime.</p>
    <button class="btn btn-accent" id="simulateBtn2">Simulate live change</button></section>` :
    `<section class="block demo-panel"><h2>Live from Supabase</h2><p>This copy reads modules, screens and records from your Supabase project in real time. Edit a row — every shell updates itself.</p></section>`;
  return `${hero}${stats}<section class="block"><div class="block-head"><h2>Your modules</h2><p class="block-caption">Installed modules, one tap away. Install more from the Module Store.</p></div><div class="cards">${installedCards || '<p class="list-empty">Nothing installed yet — visit the Module Store and pick your first module.</p>'}</div></section>${demo}`;
}

function storeView() {
  if (!state.coreReady) return skeletonView();
  const cards = publishedModules().map((mod) => {
    const installed = state.installs.includes(mod.slug);
    return `<article class="card store-card"><div class="module-card-head">${moduleIcon(mod, "icon module-icon")}<h3>${escapeHtml(mod.name)}</h3></div><p>${escapeHtml(mod.description)}</p>
      <p class="card-meta">${escapeHtml(mod.manifest?.category || "")} · v${escapeHtml(mod.version)}</p>
      <div class="card-actions">${installed
        ? `<a class="btn btn-primary" href="#/m/${escapeHtml(mod.slug)}">Open</a><button class="btn btn-danger uninstall-btn" data-slug="${escapeHtml(mod.slug)}">Uninstall</button>`
        : `<button class="btn btn-accent install-btn" data-slug="${escapeHtml(mod.slug)}">Install</button>`}</div></article>`;
  }).join("");
  return `${renderBlock({ type: "hero", icon: "store", title: "Module Store", subtitle: "Modules are data. Installing one adds it to your navigation instantly — for this shell, installing is just a record.", caption: "The catalogue: every module available to this workspace." })}<section class="block"><div class="cards">${cards}</div></section>`;
}

function moduleView(slug) {
  if (!state.coreReady) return skeletonView();
  const mod = state.modules.find((m) => m.slug === slug);
  if (!mod) return `<section class="block"><h1>Module not found</h1><p>It may have been unpublished. Visit the <a href="#/store">Module Store</a>.</p></section>`;
  if (!state.installs.includes(slug)) {
    return `<section class="block module-install-prompt"><div class="module-card-head big">${moduleIcon(mod, "icon module-icon lg")}<h1>${escapeHtml(mod.name)}</h1></div><p>${escapeHtml(mod.description)}</p><p class="block-caption">This module is not installed in your shell yet.</p><button class="btn btn-accent install-btn" data-slug="${escapeHtml(mod.slug)}">Install ${escapeHtml(mod.name)}</button></section>`;
  }
  const screen = state.screens.find((s) => s.module_slug === slug && s.slug === "main");
  if (!screen) return `<section class="block"><h1>${escapeHtml(mod.name)}</h1><p>No screen published for this module yet.</p></section>`;
  return renderScreen(screen, renderCtx());
}

function cartViewPage() {
  const lines = cart.items.map((i) => `<li class="list-row"><div class="list-row-main"><strong>${escapeHtml(i.product)}</strong><span class="list-row-body">$${i.price} each</span></div>
    <div class="qty-tools"><button class="mini-btn" data-qty="${escapeHtml(i.product)}" data-qty-delta="-1">−</button><span class="qty">${i.qty}</span><button class="mini-btn" data-qty="${escapeHtml(i.product)}" data-qty-delta="1">+</button>
    <span class="card-meta">$${i.qty * i.price}</span><button class="mini-btn danger" data-cart-remove="${escapeHtml(i.product)}" title="Remove">×</button></div></li>`).join("");
  return `${renderBlock({ type: "hero", icon: "cart", title: "Your cart", subtitle: "Review what you are buying. Checkout writes a real order record into the Mini Shop history — and the automation engine logs it to Analytics.", caption: "The cart: quantities, totals and checkout." })}
  <section class="block">${cart.count ? `<ul class="list">${lines}</ul>
    <div class="cart-foot"><span>Total <strong>$${cart.total}</strong> · ${cart.count} item${cart.count === 1 ? "" : "s"}</span>
    <span class="cart-actions"><button class="btn btn-ghost" data-cart-clear="1">Clear cart</button><button class="btn btn-primary" data-checkout="1">Checkout — $${cart.total}</button></span></div>`
    : `<p class="list-empty">Your cart is empty. Browse the <a href="#/m/mini-shop">Mini Shop</a> and add something.</p>`}</section>`;
}

// ------------------------------------------------------------- view: profile
function profileView() {
  const head = renderBlock({ type: "hero", icon: "user", title: "Profile", subtitle: "Your identity in this workspace. Sign in to carry your installs and records with your account; stay anonymous and this shell keeps its own per-browser identity.", caption: "Account: sign-in, roles and your presence in the workspace." });
  if (state.session) {
    const roles = state.roles.length ? state.roles : ["member"];
    return `${head}<section class="block"><article class="card profile-card">
      <div class="profile-head"><span class="avatar lg">${escapeHtml(displayName().slice(0, 1).toUpperCase())}</span>
      <div><h3>${escapeHtml(displayName())}</h3><p>${escapeHtml(state.session.user.email || "")}</p>
      <p class="role-chips">${roles.map((r) => `<span class="chip">${escapeHtml(r)}</span>`).join("")}${adapter.mode === "local" ? `<span class="chip soft">local fixture session</span>` : ""}</p></div></div>
      <form class="auth-form profile-edit" data-auth="rename">
        <label class="field"><span>Display name</span><input name="display_name" value="${escapeHtml(state.profile?.display_name || "")}" placeholder="How the team sees you"></label>
        <button class="btn btn-primary" type="submit">Save name</button>
      </form>
      <div class="profile-actions"><button class="btn btn-danger" id="signOutBtn">Sign out</button></div>
      </article></section>
      ${installCard()}
      ${shortcutsCard()}`;
  }
  const localNote = adapter.mode === "local"
    ? `<div class="embed-note slim">${iconSvg("inbox", "icon note-icon")}<div><strong>Local fixture mode</strong><div class="md"><p>Sign-in is simulated on this device: any password works, and your profile is stored locally. Wire Supabase and the same forms use real Supabase Auth.</p></div></div></div>`
    : "";
  return `${head}${localNote}
  <section class="block auth-grid">
    <article class="card"><h3>Sign in</h3><p>Welcome back. Your installs follow your account.</p>
      <form class="auth-form" data-auth="signin">
        <label class="field"><span>Email</span><input name="email" type="email" required placeholder="you@company.com"></label>
        <label class="field"><span>Password</span><input name="password" type="password" required placeholder="••••••••"></label>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form></article>
    <article class="card"><h3>Create account</h3><p>New here? Create an account with email and password.</p>
      <form class="auth-form" data-auth="signup">
        <label class="field"><span>Email</span><input name="email" type="email" required placeholder="you@company.com"></label>
        <label class="field"><span>Password</span><input name="password" type="password" required placeholder="Choose a password"></label>
        <button class="btn btn-accent" type="submit">Create account</button>
      </form></article>
    <article class="card"><h3>Magic link</h3><p>No password: we email you a one-tap sign-in link.</p>
      <form class="auth-form" data-auth="magic">
        <label class="field"><span>Email</span><input name="email" type="email" required placeholder="you@company.com"></label>
        <button class="btn btn-ghost" type="submit">Email me a link</button>
      </form></article>
  </section>
  ${installCard()}
  ${shortcutsCard()}`;
}

function installCard() {
  return `<section class="block"><article class="card"><h3>Install LiveOS</h3>
    <p>Add Nova LiveOS to your home screen or desktop — it opens full-screen, works offline for the shell, and stays live against the database.</p>
    <button class="btn btn-primary" id="pwaInstallBtn" ${deferredInstallPrompt ? "" : "disabled"}>${deferredInstallPrompt ? "Install the app" : "Use your browser menu → Install / Add to Home Screen"}</button>
    </article></section>`;
}

function shortcutsCard() {
  return `<section class="block"><article class="card"><h3>Keyboard shortcuts</h3>
    <p><kbd>Ctrl</kbd>+<kbd>K</kbd> search & commands · <kbd>D</kbd> toggle drawer · <kbd>H</kbd> home · <kbd>S</kbd> store · <kbd>Esc</kbd> close panels</p>
    </article></section>`;
}

// ------------------------------------------------------- view: notifications
function notificationsView() {
  const items = notificationsFrom({ records: state.records, audit: state.audit }, 0, 30);
  const rows = items.map((n) => `<li class="list-row"><span class="notif-icon">${iconSvg(n.icon, "icon")}</span><div class="list-row-main"><strong>${escapeHtml(n.text)}</strong><span class="list-row-body">${new Date(n.ts).toLocaleString()}</span></div><a class="btn btn-ghost" href="${escapeHtml(n.route)}">Open</a></li>`).join("");
  return `${renderBlock({ type: "hero", icon: "bell", title: "Notifications", subtitle: "Everything that happened in the workspace, as it happens — new records, automation runs, audit events.", caption: "The feed: what changed, newest first. Opening this page marks all as read." })}
  <section class="block"><ul class="list">${rows || '<li class="list-empty">Nothing yet. When the team adds records or an automation runs, it will land here.</li>'}</ul></section>`;
}

// -------------------------------------------------------------- view: admin
function adminHomeView() {
  const cards = [
    { href: "#/admin/screens", icon: "layers", title: "Screen Editor", text: "Edit any module screen as structured blocks, with a live preview. Saving updates every open shell instantly." },
    { href: "#/admin/modules", icon: "grid", title: "Module Manager", text: "Create modules, edit their details, pick their app icon, publish or unpublish them for the whole workspace." },
    { href: "#/admin/records", icon: "inbox", title: "Records Browser", text: "Every record in the workspace, filterable by module and kind — inspect payloads and delete with care." },
    { href: "#/admin/activity", icon: "activity", title: "Activity", text: "The audit log: who changed what, including every automation execution, newest first." },
    { href: "#/admin/automations", icon: "zap", title: "Automations", text: "The in-shell engine's rules: triggers and actions that run the moment records change. Toggle, retarget, rewire." }
  ];
  return `${renderBlock({ type: "hero", icon: "shield", title: "Admin Console", subtitle: "Run the workspace from here. Everything in this console writes to the same data layer the shell renders from — changes are live everywhere, immediately.", caption: "Administration: screens, modules, records, activity and automations." })}
  <section class="block"><div class="cards admin-cards">${cards.map((c) => `<article class="card module-card"><div class="module-card-head">${iconSvg(c.icon, "icon module-icon")}<h3>${c.title}</h3></div><p>${c.text}</p><a class="btn btn-primary" href="${c.href}">Open</a></article>`).join("")}</div></section>`;
}

function editorFieldHtml(block, f) {
  const v = block[f.name];
  const val = f.kind === "json" ? (v === undefined ? "" : JSON.stringify(v, null, 1)) : (v ?? "");
  if (f.kind === "textarea" || f.kind === "json") {
    return `<label class="field"><span>${escapeHtml(f.label)}</span><textarea name="${escapeHtml(f.name)}" rows="${f.kind === "json" ? 4 : 3}" data-block-field="${escapeHtml(f.name)}">${escapeHtml(val)}</textarea></label>`;
  }
  if (f.kind === "select") {
    const opts = (f.options || []).map((o) => `<option value="${escapeHtml(o)}" ${String(v) === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
    return `<label class="field"><span>${escapeHtml(f.label)}</span><select name="${escapeHtml(f.name)}" data-block-field="${escapeHtml(f.name)}">${opts}</select></label>`;
  }
  return `<label class="field"><span>${escapeHtml(f.label)}</span><input name="${escapeHtml(f.name)}" value="${escapeHtml(val)}" data-block-field="${escapeHtml(f.name)}"></label>`;
}

function adminScreensView() {
  const mods = catalogueModules();
  const sel = editor?.module || mods[0]?.slug || "";
  const screen = catalogueScreens().find((s) => s.module_slug === sel && s.slug === "main");
  if (!editor || editor.module !== sel) {
    editor = { module: sel, layout: structuredClone(screen?.layout || []) };
  }
  const blockCards = editor.layout.map((block, i) => {
    const schema = BLOCK_SCHEMAS[block.type] || [];
    return `<article class="card editor-block" data-block-index="${i}">
      <div class="editor-block-head"><span class="chip">${escapeHtml(block.type)}</span><span class="block-tools">
        <button class="mini-btn" data-block-move="${i}" data-dir="-1" title="Move up">↑</button>
        <button class="mini-btn" data-block-move="${i}" data-dir="1" title="Move down">↓</button>
        <button class="mini-btn danger" data-block-remove="${i}" title="Remove block">×</button></span></div>
      <form class="block-edit-form" data-block-index="${i}">${schema.map((f) => editorFieldHtml(block, f)).join("") || '<p class="list-empty">No editable fields for this block type.</p>'}</form>
    </article>`;
  }).join("");
  const typeOptions = BLOCK_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
  const preview = renderScreen({ layout: editor.layout }, renderCtx());
  return `${renderBlock({ type: "hero", icon: "layers", title: "Screen Editor", subtitle: "Screens are data: an ordered list of blocks. Edit fields, reorder, add or remove blocks — then save and every open shell re-renders the new screen live.", caption: "Editor: pick a module, shape its screen, preview, save." })}
  <section class="block"><label class="field"><span>Module</span><select id="editorModuleSel">${mods.map((m) => `<option value="${escapeHtml(m.slug)}" ${m.slug === sel ? "selected" : ""}>${escapeHtml(m.name)} (${escapeHtml(m.slug)})</option>`).join("")}</select></label>
  <div class="editor-actions"><span class="add-block-tools"><select id="addBlockType">${typeOptions}</select><button class="btn btn-ghost" id="addBlockBtn">Add block</button></span>
  <button class="btn btn-primary" id="saveScreenBtn">Save screen — go live</button></div></section>
  <section class="block editor-grid"><div class="editor-col">${blockCards || '<p class="list-empty">This screen has no blocks yet — add one above.</p>'}</div>
  <div class="editor-col preview-col"><div class="block-head"><h2>Live preview</h2><p class="block-caption">Exactly what every shell will render on save.</p></div><div class="preview-frame">${preview}</div></div></section>`;
}

function adminModulesView() {
  const mods = catalogueModules();
  const rows = mods.map((mod) => `
    <article class="card editor-block">
      <div class="editor-block-head"><span class="module-card-head">${moduleIcon(mod, "icon module-icon")}<strong>${escapeHtml(mod.name)}</strong></span>
      <span class="chip ${mod.published ? "" : "soft"}">${mod.published ? "published" : "unpublished"}</span></div>
      <form class="admin-form module-edit-form" data-admin="module-edit" data-slug="${escapeHtml(mod.slug)}">
        <label class="field"><span>Name</span><input name="name" value="${escapeHtml(mod.name)}" required></label>
        <label class="field"><span>Description</span><textarea name="description" rows="2">${escapeHtml(mod.description)}</textarea></label>
        <div class="form-row">
          <label class="field"><span>Category</span><input name="category" value="${escapeHtml(mod.manifest?.category || "")}"></label>
          <label class="field"><span>Version</span><input name="version" value="${escapeHtml(mod.version)}"></label>
          <label class="field check"><span>Published</span><input type="checkbox" name="published" ${mod.published ? "checked" : ""}></label>
        </div>
        <div class="field"><span>App icon — pick from the library</span>
          <div class="icon-picker">${iconPickerHtml(moduleIconSlug(mod))}</div>
          <input type="hidden" name="icon" value="${escapeHtml(moduleIconSlug(mod))}">
        </div>
        <button class="btn btn-primary" type="submit">Save module</button>
      </form>
    </article>`).join("");
  return `${renderBlock({ type: "hero", icon: "grid", title: "Module Manager", subtitle: "Modules are catalogue rows. Create one and it appears in the Store for everyone; unpublish and it vanishes from shells — live.", caption: "Manager: create, edit, brand and publish modules." })}
  <section class="block"><article class="card"><h3>Create a module</h3>
    <form class="admin-form" data-admin="module-create">
      <div class="form-row">
        <label class="field"><span>Slug</span><input name="slug" required pattern="[a-z0-9-]+" placeholder="e.g. field-notes"></label>
        <label class="field"><span>Name</span><input name="name" required placeholder="e.g. Field Notes"></label>
        <label class="field"><span>Category</span><input name="category" placeholder="e.g. Work"></label>
      </div>
      <label class="field"><span>Description</span><textarea name="description" rows="2" placeholder="What is this module for?"></textarea></label>
      <div class="field"><span>App icon</span><div class="icon-picker">${iconPickerHtml("grid")}</div><input type="hidden" name="icon" value="grid"></div>
      <button class="btn btn-accent" type="submit">Create module + starter screen</button>
    </form></article></section>
  <section class="block editor-col">${rows}</section>`;
}

function iconPickerHtml(selected) {
  const slugs = ["board", "shop", "briefcase", "chat", "chart-bar", "address-book", "store", "home", "grid", "calendar", "mail", "users", "folder", "star", "layers", "inbox", "line-chart", "zap", "clock", "activity"];
  return slugs.map((s) => `<button type="button" class="icon-pick ${s === selected ? "selected" : ""}" data-icon-pick="${s}" title="${s}">${iconSvg(s, "icon")}</button>`).join("");
}

function adminRecordsView() {
  const moduleSlugs = [...new Set(state.records.map((r) => r.module_slug))].sort();
  const kinds = [...new Set(state.records.filter((r) => !recordsFilter.module || r.module_slug === recordsFilter.module).map((r) => r.kind))].sort();
  const rows = state.records
    .filter((r) => (!recordsFilter.module || r.module_slug === recordsFilter.module) && (!recordsFilter.kind || r.kind === recordsFilter.kind))
    .slice().reverse().slice(0, 100)
    .map((r) => `<tr><td><code>${escapeHtml(String(r.id).slice(0, 8))}…</code></td><td>${escapeHtml(r.module_slug)}</td><td>${escapeHtml(r.kind)}</td>
      <td><details><summary>JSON</summary><pre class="payload-json">${escapeHtml(JSON.stringify(r.payload, null, 1))}</pre></details></td>
      <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
      <td><button class="mini-btn danger" data-delete-record="${escapeHtml(r.id)}" title="Delete record">×</button></td></tr>`).join("");
  return `${renderBlock({ type: "hero", icon: "inbox", title: "Records Browser", subtitle: "The whole workspace is records. Filter, inspect the raw payload, and delete — deletions propagate live like everything else.", caption: "Browser: every record, newest first (latest 100 of the current filter)." })}
  <section class="block"><div class="form-row">
    <label class="field"><span>Module</span><select id="recFilterModule"><option value="">All modules</option>${moduleSlugs.map((s) => `<option value="${escapeHtml(s)}" ${recordsFilter.module === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select></label>
    <label class="field"><span>Kind</span><select id="recFilterKind"><option value="">All kinds</option>${kinds.map((s) => `<option value="${escapeHtml(s)}" ${recordsFilter.kind === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select></label>
  </div>
  <div class="table-wrap"><table class="data-table"><thead><tr><th>Id</th><th>Module</th><th>Kind</th><th>Payload</th><th>Created</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="table-empty">No records match this filter.</td></tr>'}</tbody></table></div></section>`;
}

function adminActivityView() {
  const rows = state.audit.filter((a) => !isPresenceAudit(a)).slice(0, 100).map((a) => `<li class="list-row"><span class="notif-icon">${iconSvg("activity", "icon")}</span>
    <div class="list-row-main"><strong>${escapeHtml(a.event)}</strong><span class="list-row-body">${escapeHtml(a.entity || "")}${a.entity_id ? ` · ${escapeHtml(String(a.entity_id).slice(0, 18))}` : ""}${a.detail?.text ? ` — ${escapeHtml(a.detail.text)}` : ""}</span></div>
    <span class="list-row-meta">${escapeHtml(new Date(a.created_at).toLocaleString())}</span></li>`).join("");
  return `${renderBlock({ type: "hero", icon: "activity", title: "Activity", subtitle: "The audit log, newest first. In Supabase mode, database triggers write these rows for every change — whichever client made it. Automation executions are logged here too.", caption: "Activity: the latest 100 audit events." })}
  <section class="block"><ul class="list">${rows || '<li class="list-empty">No audit events yet. Changes you make will be recorded here.</li>'}</ul></section>`;
}

function adminAutomationsView() {
  const rows = state.automations.map((a) => `
    <article class="card editor-block">
      <div class="editor-block-head"><strong>${escapeHtml(a.name)}</strong><span class="chip ${a.enabled ? "" : "soft"}">${a.enabled ? "enabled" : "paused"}</span></div>
      <p class="card-meta">${escapeHtml(a.slug)}</p>
      <form class="admin-form" data-admin="automation-edit" data-id="${escapeHtml(a.id || a.slug)}">
        <div class="form-row">
          <label class="field"><span>Trigger event</span><input name="trigger_event" value="${escapeHtml(a.trigger_event)}"></label>
          <label class="field check"><span>Enabled</span><input type="checkbox" name="enabled" ${a.enabled ? "checked" : ""}></label>
        </div>
        <label class="field"><span>Action (JSON)</span><textarea name="action" rows="4">${escapeHtml(JSON.stringify(a.action, null, 1))}</textarea></label>
        <button class="btn btn-primary" type="submit">Save automation</button>
      </form>
    </article>`).join("");
  return `${renderBlock({ type: "hero", icon: "zap", title: "Automations", subtitle: "Rules the in-shell engine evaluates the moment data changes. Triggers look like record.created:order; actions create records or write audit entries — and every run is itself logged.", caption: "Automations: toggle, retarget triggers, rewire actions." })}
  <section class="block editor-col">${rows || '<p class="list-empty">No automations defined.</p>'}</section>`;
}

// -------------------------------------------------------------------- render
const boundEls = new WeakSet();
function bindOnce(el, event, fn) {
  if (el && !boundEls.has(el)) { boundEls.add(el); el.addEventListener(event, fn); }
}

// Rendering patches the live DOM in place (lib/patch) instead of
// replacing innerHTML: unchanged subtrees are never touched, so scroll,
// focus, caret, typed input and drag state survive, and a data change
// lands as an in-place update — never a screen blink. `background`
// renders (data refreshes, as opposed to navigations / user actions)
// additionally skip the view-enter animation and the counter count-up.
function render(opts = {}) {
  const background = !!opts.background;
  const r = route();
  let html;
  if (r.view === "home") html = homeView();
  else if (r.view === "store") html = storeView();
  else if (r.view === "cart") html = cartViewPage();
  else if (r.view === "profile") html = profileView();
  else if (r.view === "notifications") html = notificationsView();
  else if (r.view === "admin") {
    html = !isAdmin() ? profileView()
      : r.section === "screens" ? adminScreensView()
      : r.section === "modules" ? adminModulesView()
      : r.section === "records" ? adminRecordsView()
      : r.section === "activity" ? adminActivityView()
      : r.section === "automations" ? adminAutomationsView()
      : adminHomeView();
  } else html = moduleView(r.slug);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  patchChildren(app, tpl.content);
  if (!background) {
    app.classList.remove("view-enter");
    void app.offsetWidth;
    app.classList.add("view-enter");
  }
  renderNav();
  renderChromeStatus();
  bindOnce(document.getElementById("simulateBtn2"), "click", simulateLiveChange);
  bindOnce(document.getElementById("signOutBtn"), "click", doSignOut);
  const pwa = document.getElementById("pwaInstallBtn");
  if (pwa && deferredInstallPrompt) bindOnce(pwa, "click", promptInstall);
  if (!background) animateCounters();
  if (r.view === "notifications") {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    setTimeout(updateBadges, 400);
  }
}

function animateCounters() {
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  for (const el of app.querySelectorAll(".stat-value[data-count]")) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || target <= 0) continue;
    const t0 = performance.now(), dur = 650;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// ------------------------------------------------------------- data refresh
async function loadAuthState() {
  try {
    state.session = await adapter.getSession();
    if (state.session) {
      state.profile = await adapter.getMyProfile().catch(() => null);
      state.roles = await adapter.getMyRoles().catch(() => []);
    } else { state.profile = null; state.roles = []; }
  } catch { state.session = null; state.profile = null; state.roles = []; }
}

// ---------------------------------------------------------- boot snapshot
// The last good state, persisted by every successful refresh, lets boot
// paint the home screen immediately and revalidate in the background
// (v1.0.3). Identity-bound (mode + project origin + user id): a snapshot
// is only ever painted for the exact shell identity that wrote it.
const refreshGate = createCycleTracker();
function snapshotIdentityFor() {
  return snapshotIdentity({ mode: adapter.mode, supabaseUrl: config.supabaseUrl || "", userId: adapter.userId });
}
function persistSnapshot() {
  writeSnapshot(localStorage, state, snapshotIdentityFor());
}
function hydrateFromSnapshot() {
  const snap = readSnapshot(localStorage, snapshotIdentityFor());
  if (!snap) return false;
  state.modules = snap.modules;
  state.screens = snap.screens;
  state.installs = snap.installs;
  state.records = snap.records;
  state.coreReady = true;
  // When the snapshot's records had to be trimmed to fit, keep the stats
  // in their pending state until the live records land.
  state.recordsReady = snap.recordsComplete;
  state.fromSnapshot = true;
  return true;
}

function loadFailure(err) {
  console.error("[liveos] load failed:", err);
  noteDataFailure(err);
  updateOnlineBanner();
  // The error page replaces the view ONLY when nothing is painted: with
  // a snapshot (or any earlier good state) on screen, a failed load keeps
  // that state visible and the connectivity banner carries the news.
  if (!state.coreReady) {
    app.innerHTML = `<section class="block"><h1>Couldn't load LiveOS data</h1><p>${escapeHtml(err?.message || String(err))}</p><p><button class="btn btn-primary" id="retryBtn">Retry</button></p></section>`;
    document.getElementById("retryBtn")?.addEventListener("click", () => boot());
  }
  return false;
}

async function refreshCatalogue() {
  if (route().view === "admin" && isAdmin() && adapter.getAdminCatalogue) {
    try { state.catalogue = await adapter.getAdminCatalogue(); } catch { /* keep previous */ }
  }
}

// Presence heartbeat mirrors (the audit trigger copies every heartbeat
// insert into the audit log) are stripped from the state's audit list:
// they are not activity, and letting them in would make every heartbeat
// look like a state change. Display layers filter them too; this keeps
// the no-change gate exact.
function cleanAudit(list) {
  return (list || []).filter((a) => !isPresenceAudit(a));
}

// Refresh, coordinated (v1.0.3):
// - Every fetch starts concurrently; nothing waits in a queue behind a
//   slower, less important query.
// - While the shell holds NO complete state (cold boot, or a snapshot
//   whose records have not revalidated), each class of data paints the
//   moment it lands: catalogue first, records next, automations/audit
//   last. The first paint never waits on the slowest query.
// - Once a complete state exists, replacement is MONOTONIC: the whole
//   candidate is built first and swapped in only if the full fetch set
//   succeeded AND this cycle is still the newest. A partial, failed or
//   stale cycle leaves the last good state — and its counts — untouched.
async function refresh(reason) {
  const seq = refreshGate.begin();
  const wasPainted = state.coreReady;
  const hasGoodState = state.coreReady && state.recordsReady;
  const parts = {
    core: settle(adapter.getCoreState()),
    records: settle(adapter.getRecords ? adapter.getRecords() : adapter.getState().then((s) => s.records)),
    automations: settle(adapter.getAutomations ? adapter.getAutomations() : Promise.resolve(state.automations)),
    audit: settle(adapter.getAudit ? adapter.getAudit(100) : Promise.resolve(state.audit))
  };

  if (!hasGoodState) {
    const core = await parts.core;
    if (!refreshGate.canCommit(seq)) return state.coreReady;
    if (!core.ok) return loadFailure(core.error);
    state.modules = core.value.modules;
    state.screens = core.value.screens;
    state.installs = core.value.installs;
    state.coreReady = true;
    noteDataSuccess();
    updateOnlineBanner();
    render({ background: wasPainted });
    const rec = await parts.records;
    if (!refreshGate.canCommit(seq)) return true;
    if (rec.ok) {
      state.records = rec.value;
      state.recordsReady = true;
    } else {
      noteDataFailure(rec.error);
      updateOnlineBanner();
    }
    render({ background: true });
    const [au, ad] = await Promise.all([parts.automations, parts.audit]);
    if (!refreshGate.canCommit(seq)) return true;
    if (au.ok) state.automations = au.value;
    if (ad.ok) state.audit = cleanAudit(ad.value);
    if (rec.ok) {
      state.fromSnapshot = false;
      refreshGate.markApplied(seq);
      persistSnapshot();
      await refreshCatalogue();
    }
    render({ background: true });
    if (reason) console.debug("[liveos] re-render:", reason);
    return true;
  }

  const candidate = buildCandidate({
    core: await parts.core,
    records: await parts.records,
    automations: await parts.automations,
    audit: await parts.audit
  }, state);
  if (!candidate.complete) {
    // Partial or failed cycle: keep the last good state exactly as-is.
    noteDataFailure(candidate.error);
    updateOnlineBanner();
    console.error("[liveos] refresh kept last good state:", candidate.error);
    return true;
  }
  if (!refreshGate.canCommit(seq)) return true; // a newer cycle owns the state now
  candidate.state.audit = cleanAudit(candidate.state.audit);
  if (dataStatesEqual(candidate.state, state)) {
    // No-change cycle: the fetches succeeded, but nothing on screen may
    // move — no render, no DOM writes, no snapshot rewrite. (The admin
    // catalogue is the one exception: it can change without any of the
    // six gated classes changing, so it still refreshes in admin view.)
    noteDataSuccess();
    updateOnlineBanner();
    const prevCatalogue = state.catalogue;
    await refreshCatalogue();
    if (state.catalogue !== prevCatalogue) render({ background: true });
    return true;
  }
  state.modules = candidate.state.modules;
  state.screens = candidate.state.screens;
  state.installs = candidate.state.installs;
  state.records = candidate.state.records;
  state.automations = candidate.state.automations;
  state.audit = candidate.state.audit;
  state.fromSnapshot = false;
  refreshGate.markApplied(seq);
  noteDataSuccess();
  updateOnlineBanner();
  persistSnapshot();
  await refreshCatalogue();
  render({ background: true });
  if (reason) console.debug("[liveos] re-render:", reason);
  return true;
}

// Boot: the init code below has already painted any snapshot, so boot is
// just the first (revalidating) refresh, then auth + presence alongside.
async function boot() {
  const ok = await refresh("boot");
  if (!ok && !state.coreReady) return; // nothing painted: the error page is up
  loadAuthState().then(() => render());
  startPresence();
}

// ----------------------------------------------------------------- presence
let presenceTimer = null;
function startPresence() {
  if (presenceTimer) return;
  const beat = async () => {
    try { state.presence = await adapter.heartbeat(adapter.shellId || adapter.userId); }
    catch { try { state.presence = await adapter.getPresenceCount(); } catch { /* keep last */ } }
    updateBadges();
  };
  beat();
  presenceTimer = setInterval(beat, Math.min(15_000, PRESENCE_WINDOW_MS));
}

// ------------------------------------------------------- automation engine
// Executed by the shell that made the change; the resulting records/audit
// rows then propagate live to every other shell like any other data.
async function runEngine(event) {
  if (engineBusy) return;
  const actions = runAutomations(state.automations, event);
  if (!actions.length) return;
  engineBusy = true;
  try {
    for (const a of actions) {
      if (a.type === "create-record") {
        const row = await adapter.createRecord(a.module_slug, a.kind, a.payload);
        state.records.push(row);
      } else if (a.type === "audit") {
        await adapter.addAudit({ event: a.event, entity: "automations", entity_id: a.automation, detail: a.detail });
      }
      await adapter.addAudit({
        event: "automation.executed", entity: "automations", entity_id: a.automation,
        detail: { trigger: event.type, action: a.type }
      }).catch(() => null);
    }
    state.audit = await adapter.getAudit(100).catch(() => state.audit);
    render();
  } catch (err) {
    console.error("[liveos] automation failed:", err);
  } finally {
    engineBusy = false;
  }
}

// ---------------------------------------------------------------- mutations
function enrich(kind, payload) {
  const out = { ...payload };
  if (out.budget !== undefined && out.budget !== "") { out.budget = Number(out.budget); out.budgetLabel = `Budget $${out.budget}`; }
  if (out.amount !== undefined && out.amount !== "") { out.amount = Number(out.amount); out.amountLabel = `$${out.amount}`; }
  if (out.price !== undefined && out.price !== "") { out.price = Number(out.price); }
  return out;
}

// Optimistic create: echo instantly with a temp id, swap in the real row on
// confirmation, roll back on failure.
async function optimisticCreate(moduleSlug, kind, payload, { silent = false } = {}) {
  const temp = {
    id: `tmp_${Date.now().toString(36)}`, module_slug: moduleSlug, kind,
    payload: { ...payload }, created_by: state.session?.user?.id || null,
    created_at: new Date().toISOString()
  };
  state.records.push(temp);
  render();
  try {
    const row = await adapter.createRecord(moduleSlug, kind, payload);
    const idx = state.records.findIndex((r) => r.id === temp.id);
    if (idx >= 0) state.records[idx] = row;
    render();
    runEngine({ type: "record.created", record: row });
    return row;
  } catch (err) {
    state.records = state.records.filter((r) => r.id !== temp.id);
    render();
    if (!silent) toast(`Could not save: ${err.message}`);
    throw err;
  }
}

async function doInstall(slug, btn) {
  if (btn) { btn.disabled = true; btn.classList.add("pending"); }
  const had = state.installs.includes(slug);
  if (!had) { state.installs = [...state.installs, slug]; render(); }
  try {
    state.installs = await adapter.install(slug);
    toast("Module installed.");
    runEngine({ type: "module.installed", record: null, slug });
  } catch (err) {
    if (!had) state.installs = state.installs.filter((s) => s !== slug);
    toast(`Install failed: ${err.message}`);
  }
  render();
}

async function doUninstall(slug, btn) {
  if (btn) { btn.disabled = true; btn.classList.add("pending"); }
  const prev = state.installs;
  state.installs = state.installs.filter((s) => s !== slug);
  render();
  try {
    state.installs = await adapter.uninstall(slug);
    toast("Module uninstalled.");
    runEngine({ type: "module.uninstalled", record: null, slug });
  } catch (err) {
    state.installs = prev;
    toast(`Uninstall failed: ${err.message}`);
  }
  render();
}

async function moveRecord(recordId, toStatus, kanbanEl) {
  const rec = state.records.find((r) => r.id === recordId);
  if (!rec) return;
  const field = kanbanEl?.dataset.statusField || "status";
  const updated = moveRecordStatus(rec, toStatus, field);
  state.records = state.records.map((r) => (r.id === recordId ? updated : r));
  render();
  try {
    const row = await adapter.updateRecord(recordId, { [field]: toStatus });
    state.records = state.records.map((r) => (r.id === recordId ? row : r));
    render();
    runEngine({ type: "record.updated", record: row });
  } catch (err) {
    toast(`Move failed: ${err.message}`);
    refresh("move-rollback");
  }
}

async function deleteRecord(recordId) {
  const rec = state.records.find((r) => r.id === recordId);
  if (!rec) return;
  if (!confirm(`Delete this ${rec.kind} record (${rec.module_slug})? This cannot be undone.`)) return;
  const prev = state.records;
  state.records = state.records.filter((r) => r.id !== recordId);
  render();
  try {
    await adapter.deleteRecord(recordId);
    toast("Record deleted.");
    runEngine({ type: "record.deleted", record: rec });
  } catch (err) {
    state.records = prev;
    render();
    toast(`Delete failed: ${err.message}`);
  }
}

async function checkout() {
  if (!cart.count) { toast("Your cart is empty."); return; }
  const order = {
    summary: cartSummary(cart), items: cart.items.map((i) => ({ ...i })),
    total: cart.total, totalLabel: `$${cart.total}`, status: "placed", statusLabel: "Status: placed"
  };
  const done = cart;
  cart = cartView({ items: [] });
  saveCart();
  try {
    await optimisticCreate("mini-shop", "order", order);
    toast(`Order placed — $${done.total}. Thank you.`);
    if (route().view !== "module") location.hash = "#/m/mini-shop";
  } catch { /* optimisticCreate already toasted + rolled back */ }
}

async function runAction(action, sourcePayload, formData) {
  if (!action) return;
  if (action.type === "navigate") { location.hash = action.route || "#/"; return; }
  if (action.type === "add-to-cart") {
    let payload = {};
    if (action.payloadTemplate) payload = fillTemplate(action.payloadTemplate, sourcePayload || {});
    cart = cartAdd(cart, { product: payload.product || "Item", price: Number(payload.price) || 0, qty: 1 });
    saveCart();
    render();
    toast(action.successMessage || "Added to your cart.");
    return;
  }
  if (action.type === "create-record" || action.type === "create-record-from-source" || action.type === "create-record-for-item") {
    let payload = {};
    if (action.payloadTemplate) payload = fillTemplate(action.payloadTemplate, sourcePayload || {});
    if (formData) for (const [k, v] of formData.entries()) payload[k] = v;
    if (action.withAuthor && !payload.author) payload.author = displayName();
    await optimisticCreate(action.module_slug, action.kind, enrich(action.kind, payload));
    toast(action.successMessage || "Saved.");
    return;
  }
  toast("That action is not wired in this shell yet.");
}

// ------------------------------------------------------------ sign in / out
async function doSignOut() {
  try { await adapter.signOut(); } catch { /* local state clears regardless */ }
  state.session = null; state.profile = null; state.roles = [];
  toast("Signed out. This shell is anonymous again.");
  await refresh("signout");
  render(); // session is not a refresh data class — reflect it explicitly
}

async function afterAuthChange() {
  await loadAuthState();
  await refresh("auth");
  render(); // session/profile/roles are not refresh data classes — reflect them explicitly
  toast(state.session ? `Signed in as ${displayName()}.` : "Signed out.");
}

// ------------------------------------------------------------ event wiring
document.addEventListener("click", async (e) => {
  const installBtn = e.target.closest(".install-btn");
  if (installBtn) { doInstall(installBtn.dataset.slug, installBtn); return; }
  const uninstallBtn = e.target.closest(".uninstall-btn");
  if (uninstallBtn) { doUninstall(uninstallBtn.dataset.slug, uninstallBtn); return; }
  const checkoutBtn = e.target.closest("[data-checkout]");
  if (checkoutBtn) { checkout(); return; }
  const qtyBtn = e.target.closest("[data-qty]");
  if (qtyBtn) {
    const item = cart.items.find((i) => i.product === qtyBtn.dataset.qty);
    if (item) { cart = cartSetQty(cart, item.product, item.qty + Number(qtyBtn.dataset.qtyDelta)); saveCart(); render(); }
    return;
  }
  const removeBtn = e.target.closest("[data-cart-remove]");
  if (removeBtn) { cart = cartRemove(cart, removeBtn.dataset.cartRemove); saveCart(); render(); return; }
  if (e.target.closest("[data-cart-clear]")) { cart = cartView({ items: [] }); saveCart(); render(); return; }
  const moveBtn = e.target.closest("[data-move-record]");
  if (moveBtn) { moveRecord(moveBtn.dataset.moveRecord, moveBtn.dataset.moveTo, moveBtn.closest(".kanban")); return; }
  const delBtn = e.target.closest("[data-delete-record]");
  if (delBtn) { deleteRecord(delBtn.dataset.deleteRecord); return; }
  const sortBtn = e.target.closest("[data-sort-field]");
  if (sortBtn) {
    const id = sortBtn.dataset.sortBlock;
    const cur = sortState[id];
    sortState = { ...sortState, [id]: { field: sortBtn.dataset.sortField, dir: cur?.field === sortBtn.dataset.sortField && cur.dir === "asc" ? "desc" : "asc" } };
    render();
    return;
  }
  const iconPick = e.target.closest("[data-icon-pick]");
  if (iconPick) {
    const form = iconPick.closest("form");
    form.querySelectorAll(".icon-pick").forEach((b) => b.classList.toggle("selected", b === iconPick));
    const hidden = form.querySelector('input[name="icon"]');
    if (hidden) hidden.value = iconPick.dataset.iconPick;
    return;
  }
  const blockMove = e.target.closest("[data-block-move]");
  if (blockMove && editor) {
    editor.layout = moveBlockInLayout(editor.layout, Number(blockMove.dataset.blockMove), Number(blockMove.dataset.dir));
    captureEditorFields();
    render();
    return;
  }
  const blockRemove = e.target.closest("[data-block-remove]");
  if (blockRemove && editor) {
    captureEditorFields();
    editor.layout = removeBlock(editor.layout, Number(blockRemove.dataset.blockRemove));
    render();
    return;
  }
  if (e.target.closest("#addBlockBtn") && editor) {
    captureEditorFields();
    editor.layout = addBlock(editor.layout, document.getElementById("addBlockType").value);
    render();
    return;
  }
  if (e.target.closest("#saveScreenBtn") && editor) {
    try {
      captureEditorFields();
      await adapter.updateScreenLayout(editor.module, "main", editor.layout);
      state.screens = state.screens.map((s) => (s.module_slug === editor.module && s.slug === "main" ? { ...s, layout: structuredClone(editor.layout) } : s));
      if (state.catalogue) state.catalogue = null;
      toast("Screen saved — live in every shell.");
      render();
    } catch (err) { toast(`Save failed: ${err.message}`); }
    return;
  }
  const itemBtn = e.target.closest(".item-action");
  if (itemBtn) {
    const action = JSON.parse(itemBtn.dataset.action || "{}");
    const item = JSON.parse(itemBtn.dataset.item || "{}");
    const row = itemBtn.closest(".list-row");
    if (action.fields?.length && row && !row.querySelector(".inline-form")) {
      const fields = action.fields.map((f) => {
        const req = f.required ? " required" : "";
        const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : "";
        return `<label class="field"><span>${escapeHtml(f.label || f.name)}</span><input name="${escapeHtml(f.name)}" type="${escapeHtml(f.type || "text")}"${req}${ph}></label>`;
      }).join("");
      row.insertAdjacentHTML("beforeend", `<form class="inline-form" data-item='${escapeHtml(JSON.stringify(item))}' data-action='${escapeHtml(JSON.stringify(action))}'>${fields}<button class="btn btn-primary" type="submit">${escapeHtml(itemBtn.textContent)}</button></form>`);
      row.querySelector(".inline-form input")?.focus();
    } else if (!action.fields?.length) {
      await runAction(action, item, null);
    }
    return;
  }
  const cardBtn = e.target.closest(".card-action");
  if (cardBtn) {
    const action = JSON.parse(cardBtn.dataset.action || "{}");
    const card = JSON.parse(cardBtn.dataset.card || "{}");
    await runAction(action, card, null);
    return;
  }
  const actionBtn = e.target.closest(".action-button");
  if (actionBtn) { await runAction(JSON.parse(actionBtn.dataset.action || "{}"), {}, null); return; }
  const palItem = e.target.closest(".palette-item");
  if (palItem) { activatePaletteItem(Number(palItem.dataset.index)); return; }
});

// The editor keeps its working layout in memory; field edits land there on
// change (not per keystroke) so typing never triggers a re-render.
function captureEditorFields() {
  if (!editor) return;
  for (const form of document.querySelectorAll(".block-edit-form")) {
    const idx = Number(form.dataset.blockIndex);
    const edits = {};
    for (const input of form.querySelectorAll("[data-block-field]")) edits[input.name] = input.value;
    try { editor.layout[idx] = applyBlockEdit(editor.layout[idx], edits); }
    catch (err) { toast(err.message); throw err; }
  }
}
document.addEventListener("change", (e) => {
  if (e.target.closest(".block-edit-form") && editor) {
    // Update the working layout + preview only — a full render here would
    // destroy the field being edited (and any click in flight, e.g. Save).
    try {
      captureEditorFields();
      const frame = document.querySelector(".preview-frame");
      if (frame) frame.innerHTML = renderScreen({ layout: editor.layout }, renderCtx());
    } catch { /* toasted already */ }
  }
  if (e.target.id === "editorModuleSel") {
    editor = null;
    editor = { module: e.target.value, layout: structuredClone((catalogueScreens().find((s) => s.module_slug === e.target.value && s.slug === "main")?.layout) || []) };
    render();
  }
  if (e.target.id === "recFilterModule") { recordsFilter.module = e.target.value; recordsFilter.kind = ""; render(); }
  if (e.target.id === "recFilterKind") { recordsFilter.kind = e.target.value; render(); }
});

document.addEventListener("submit", async (e) => {
  if (e.target.closest("form.block-edit-form")) {
    e.preventDefault();
    try { captureEditorFields(); } catch { /* toasted already */ }
    return;
  }
  const authForm = e.target.closest("form.auth-form");
  if (authForm) {
    e.preventDefault();
    const fd = new FormData(authForm);
    const mode = authForm.dataset.auth;
    try {
      if (mode === "signin") { await adapter.signIn(fd.get("email"), fd.get("password") || undefined); await afterAuthChange(); }
      else if (mode === "signup") {
        const res = await adapter.signUp(fd.get("email"), fd.get("password") || undefined);
        if (res?.needsConfirmation) { toast("Account created — check your email to confirm, then sign in."); }
        else await afterAuthChange();
      } else if (mode === "magic") {
        const res = await adapter.signInWithMagicLink(fd.get("email"));
        toast(res?.local ? "Magic links need Supabase — in local mode, use password sign-in above (any password works)." : "Magic link sent — check your email.");
      } else if (mode === "rename") {
        const name = String(fd.get("display_name") || "").trim();
        if (name && state.session) {
          await adapter.upsertProfile({ auth_user_id: state.session.user.id, email: state.session.user.email || "", display_name: name });
          state.profile = await adapter.getMyProfile().catch(() => ({ ...(state.profile || {}), display_name: name }));
          toast("Display name saved.");
          render();
        }
      }
    } catch (err) { toast(`Auth failed: ${err.message}`); }
    return;
  }
  const adminForm = e.target.closest("form.admin-form");
  if (adminForm) {
    e.preventDefault();
    const fd = new FormData(adminForm);
    const kind = adminForm.dataset.admin;
    try {
      if (kind === "module-create") {
        const slug = String(fd.get("slug") || "").trim().toLowerCase();
        const mod = await adapter.createModule({
          slug, name: String(fd.get("name") || slug),
          description: String(fd.get("description") || ""),
          manifest: { category: String(fd.get("category") || "Modules"), icon: String(fd.get("icon") || "grid") }
        });
        await adapter.createScreen(slug, mod.name);
        toast(`Module "${mod.name}" created — find it in the Store.`);
        state.catalogue = null;
        await refresh("module-created");
      } else if (kind === "module-edit") {
        const slug = adminForm.dataset.slug;
        const existing = catalogueModules().find((m) => m.slug === slug);
        await adapter.updateModule(slug, {
          name: String(fd.get("name") || slug),
          description: String(fd.get("description") || ""),
          version: String(fd.get("version") || "1.0.0"),
          icon: String(fd.get("icon") || "grid"),
          manifest: { ...(existing?.manifest || {}), category: String(fd.get("category") || "Modules"), icon: String(fd.get("icon") || "grid"), route: slug },
          published: fd.get("published") === "on"
        });
        toast("Module saved — live everywhere.");
        state.catalogue = null;
        await refresh("module-edited");
      } else if (kind === "automation-edit") {
        let actionJson;
        try { actionJson = JSON.parse(String(fd.get("action") || "{}")); }
        catch { toast("Action JSON is invalid — fix and save again."); return; }
        await adapter.updateAutomation(adminForm.dataset.id, {
          trigger_event: String(fd.get("trigger_event") || ""),
          action: actionJson,
          enabled: fd.get("enabled") === "on"
        });
        toast("Automation saved.");
        await refresh("automation-edited");
      }
    } catch (err) { toast(`Failed: ${err.message}`); }
    return;
  }
  const form = e.target.closest("form.live-form, form.inline-form");
  if (!form) return;
  e.preventDefault();
  const action = JSON.parse(form.dataset.action || "{}");
  const item = form.dataset.item ? JSON.parse(form.dataset.item) : {};
  try {
    await runAction(action, item, new FormData(form));
    form.reset();
  } catch { /* optimisticCreate already toasted */ }
});

// Kanban drag & drop (the arrow buttons cover touch + precision moves).
document.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".kanban-card");
  if (card) {
    e.dataTransfer.setData("text/plain", card.dataset.recordId);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  }
});
document.addEventListener("dragend", (e) => {
  e.target.closest(".kanban-card")?.classList.remove("dragging");
  document.querySelectorAll(".kanban-cards.dragover").forEach((el) => el.classList.remove("dragover"));
});
document.addEventListener("dragover", (e) => {
  const zone = e.target.closest(".kanban-cards");
  if (zone) { e.preventDefault(); zone.classList.add("dragover"); }
});
document.addEventListener("dragleave", (e) => {
  e.target.closest(".kanban-cards")?.classList.remove("dragover");
});
document.addEventListener("drop", (e) => {
  const zone = e.target.closest(".kanban-cards");
  if (!zone) return;
  e.preventDefault();
  const id = e.dataTransfer.getData("text/plain");
  if (id) moveRecord(id, zone.dataset.dropColumn, zone.closest(".kanban"));
});

// ------------------------------------------------------- search / palette
const paletteEl = document.getElementById("palette");
const paletteInput = document.getElementById("paletteInput");
const paletteResultsEl = document.getElementById("paletteResults");

function paletteActions() {
  const actions = [
    { title: "Go to Home", subtitle: "Command", route: "#/", command: "go", icon: "home" },
    { title: "Go to Module Store", subtitle: "Command", route: "#/store", command: "go", icon: "store" },
    { title: "Go to Cart", subtitle: "Command", route: "#/cart", command: "go", icon: "cart" },
    { title: "Go to Notifications", subtitle: "Command", route: "#/notifications", command: "go", icon: "bell" },
    { title: "Go to Profile", subtitle: "Command", route: "#/profile", command: "go", icon: "user" },
    { title: "Toggle drawer", subtitle: "Command", command: "drawer", icon: "sliders" },
    state.session
      ? { title: "Sign out", subtitle: "Command", command: "signout", icon: "user" }
      : { title: "Sign in", subtitle: "Command", route: "#/profile", command: "go", icon: "user" }
  ];
  if (isAdmin()) actions.push({ title: "Go to Admin Console", subtitle: "Command", route: "#/admin", command: "go", icon: "shield" });
  if (adapter.mode === "local") actions.push({ title: "Simulate live change", subtitle: "Command", command: "simulate", icon: "zap" });
  for (const m of publishedModules()) {
    if (!state.installs.includes(m.slug)) {
      actions.push({ title: `Install ${m.name}`, subtitle: "Command", command: "install", slug: m.slug, icon: moduleIconSlug(m) });
    }
  }
  return actions;
}

function renderPalette() {
  const index = buildSearchIndex({ modules: publishedModules(), records: preparedRecords(), actions: paletteActions() });
  paletteResults = searchIndex(index, paletteInput.value, 14);
  paletteSel = Math.min(paletteSel, Math.max(0, paletteResults.length - 1));
  paletteResultsEl.innerHTML = paletteResults.map((r, i) => `
    <button class="palette-item ${i === paletteSel ? "selected" : ""}" data-index="${i}">
      ${iconSvg(r.icon || (r.type === "module" ? "grid" : "inbox"), "icon palette-icon")}
      <span class="palette-main"><strong>${escapeHtml(r.title)}</strong><small>${escapeHtml(r.subtitle)}</small></span>
      <span class="chip soft">${escapeHtml(r.type)}</span>
    </button>`).join("") || `<p class="list-empty">No matches. Try a module name, a product, a job, a contact…</p>`;
}
function openPalette() {
  paletteOpen = true;
  paletteEl.classList.add("open");
  paletteSel = 0;
  renderPalette();
  setTimeout(() => paletteInput.focus(), 30);
}
function closePalette() {
  paletteOpen = false;
  paletteEl.classList.remove("open");
  paletteInput.value = "";
}
function activatePaletteItem(i) {
  const r = paletteResults[i];
  if (!r) return;
  closePalette();
  if (r.command === "drawer") { toggleDrawer(); return; }
  if (r.command === "signout") { doSignOut(); return; }
  if (r.command === "simulate") { simulateLiveChange(); return; }
  if (r.command === "install" && r.slug) { doInstall(r.slug, null); location.hash = `#/m/${r.slug}`; return; }
  if (r.route) location.hash = r.route;
}
paletteInput?.addEventListener("input", () => { paletteSel = 0; renderPalette(); });
paletteInput?.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteResults.length - 1, paletteSel + 1); renderPalette(); }
  if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(0, paletteSel - 1); renderPalette(); }
  if (e.key === "Enter") { e.preventDefault(); activatePaletteItem(paletteSel); }
});
document.getElementById("paletteOverlay")?.addEventListener("click", closePalette);
document.getElementById("searchBtn")?.addEventListener("click", openPalette);
document.getElementById("bellBtn")?.addEventListener("click", () => { location.hash = "#/notifications"; });
document.getElementById("cartBtn")?.addEventListener("click", () => { location.hash = "#/cart"; });

// ------------------------------------------------------------------ keyboard
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }
  if (e.key === "Escape") {
    if (paletteOpen) closePalette();
    closeDrawer();
    return;
  }
  if (paletteOpen) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "d" || e.key === "D") toggleDrawer();
  if (e.key === "h" || e.key === "H") location.hash = "#/";
  if (e.key === "s" || e.key === "S") location.hash = "#/store";
});

// ------------------------------------------------------------- drawer / misc
function toggleDrawer() {
  drawer.classList.toggle("open");
  overlay.classList.toggle("show", drawer.classList.contains("open"));
}
function closeDrawer() { drawer.classList.remove("open"); overlay.classList.remove("show"); }
document.getElementById("simulateBtn").addEventListener("click", simulateLiveChange);
document.getElementById("menuBtn").addEventListener("click", toggleDrawer);
overlay.addEventListener("click", closeDrawer);
nav.addEventListener("click", (e) => { if (e.target.closest("a")) closeDrawer(); });
document.getElementById("drawerAccount")?.addEventListener("click", (e) => { if (e.target.closest("a")) closeDrawer(); });

async function simulateLiveChange() {
  if (adapter.mode !== "local") { toast("In Supabase mode, edit a screens row — the shell follows live."); return; }
  const screen = state.screens.find((s) => s.module_slug === "team-board" && s.slug === "main");
  if (!screen) return;
  const layout = structuredClone(screen.layout);
  const hero = layout.find((b) => b.type === "hero");
  const stamp = new Date().toLocaleTimeString();
  hero.subtitle = `Shared work, kept in the open. Live update received at ${stamp} — this text changed in the data layer and every shell re-rendered without a reload.`;
  await adapter.updateScreenLayout("team-board", "main", layout);
  toast(`Live change applied at ${stamp}`);
}

// --------------------------------------------------------------------- PWA
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  render();
});
async function promptInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  render();
}
// The offline banner is driven by REAL data-layer connectivity (lib/net):
// it appears only after an actual data fetch/refresh fails with a network
// error, and hides on the next success. The browser's own onLine flag is
// never read — it lied persistently in environments where Supabase traffic was flowing
// (the v1.0.0 false "You are offline" defect). The window online/offline
// events are hints only: 'online' triggers a refresh attempt (whose
// outcome drives the banner), 'offline' triggers a silent probe — if
// data still loads, the banner stays hidden.
function updateOnlineBanner() {
  const el = document.getElementById("offlineBanner");
  if (el) el.classList.toggle("show", !getDataOnline());
}
onDataConnectivity(() => updateOnlineBanner());
window.addEventListener("online", () => { refresh("online-event"); });
window.addEventListener("offline", async () => {
  if (adapter.mode !== "supabase") { noteDataSuccess(); updateOnlineBanner(); return; }
  try { await adapter.getCoreState(); noteDataSuccess(); }
  catch (err) { noteDataFailure(err); }
  updateOnlineBanner();
});

// ---------------------------------------------------------------------- init
window.addEventListener("hashchange", async () => {
  const r = route();
  if (r.view === "admin" && isAdmin() && adapter.mode === "supabase" && !state.catalogue) {
    try { state.catalogue = await adapter.getAdminCatalogue(); } catch { state.catalogue = null; }
  }
  if (r.view !== "admin") editor = null;
  render();
});

// Magic-link callbacks arrive in the hash — capture BEFORE the router reads
// it, then reset the route to home.
if (adapter.mode === "supabase" && adapter.auth) {
  const captured = adapter.auth.captureCallbackHash(location.hash);
  if (captured) {
    history.replaceState(null, "", location.pathname + location.search + "#/");
    adapter.getSession().then(async (s) => {
      if (s) { await adapter._adoptSession(s); toast("Signed in via magic link."); }
    });
  }
}
if (!localStorage.getItem(SEEN_KEY)) localStorage.setItem(SEEN_KEY, String(Date.now()));
// Paint the last good state from the boot snapshot, if one exists for
// this identity — the first render below is then real home content, and
// boot() only has to revalidate it in the background.
hydrateFromSnapshot();
updateOnlineBanner();
render();
adapter.onChange(() => refresh("change-event"));
if ("serviceWorker" in navigator) {
  // One-time auto-reload when a NEW service worker takes control of a
  // page an old one was already controlling (an upgrade): the shell
  // assets should come from the new worker without the user ever
  // reloading by hand. The sessionStorage flag makes a loop impossible —
  // after one reload this session never auto-reloads again.
  let swReloadAttempted = false;
  let swHadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The first controllerchange on a fresh install is just the initial
    // claim — the page loaded fresh from the network, nothing to reload.
    if (!swHadController) { swHadController = true; return; }
    if (swReloadAttempted) return;
    swReloadAttempted = true;
    try {
      if (sessionStorage.getItem("liveos.swReloaded") === "1") return;
      sessionStorage.setItem("liveos.swReloaded", "1");
    } catch { return; /* storage unavailable: never risk a reload loop */ }
    location.reload();
  });
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is best-effort */ });
}
boot();
