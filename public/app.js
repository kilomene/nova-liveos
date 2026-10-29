// Nova LiveOS shell — v0.1.0
// Ships empty: navigation, pages and features all come from the data layer
// (Supabase when configured, local fixture data otherwise) and re-render live
// when the data changes — no reload, no redeploy.

import { renderBlock, renderScreen, escapeHtml, fillTemplate } from "./lib/core.mjs";
import { createAdapter } from "./lib/data.mjs";

const config = window.LIVEOS_CONFIG || {};
const adapter = createAdapter(config);
const app = document.getElementById("app");
const drawer = document.getElementById("drawer");
const overlay = document.getElementById("drawerOverlay");
const nav = document.getElementById("drawerNav");

let state = { modules: [], screens: [], records: [], installs: [] };
let toastTimer = null;

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function counts() {
  const map = { "modules:installed": state.installs.length, "modules:total": state.modules.length, "records:total": state.records.length };
  for (const r of state.records) {
    const k = `${r.module_slug}:${r.kind}`;
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

function route() {
  const hash = location.hash || "#/";
  if (hash === "#/" || hash === "#") return { view: "home" };
  if (hash === "#/store") return { view: "store" };
  const m = hash.match(/^#\/m\/([\w-]+)$/);
  if (m) return { view: "module", slug: m[1] };
  return { view: "home" };
}

function renderNav() {
  const r = route();
  const groups = new Map();
  for (const slug of state.installs) {
    const mod = state.modules.find((m) => m.slug === slug);
    if (!mod) continue;
    const cat = mod.manifest?.category || "Modules";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(mod);
  }
  let html = `<div class="nav-group">LiveOS</div>
    <a class="nav-link ${r.view === "home" ? "active" : ""}" href="#/"><span class="nav-badge">⌂</span>Home</a>
    <a class="nav-link ${r.view === "store" ? "active" : ""}" href="#/store"><span class="nav-badge">ST</span>Module Store</a>`;
  for (const [cat, mods] of groups) {
    html += `<div class="nav-group">${escapeHtml(cat)}</div>`;
    for (const mod of mods) {
      html += `<a class="nav-link ${r.view === "module" && r.slug === mod.slug ? "active" : ""}" href="#/m/${escapeHtml(mod.slug)}"><span class="nav-badge">${escapeHtml(mod.icon || "•")}</span>${escapeHtml(mod.name)}</a>`;
    }
  }
  nav.innerHTML = html;
}

function homeView() {
  const hero = renderBlock({ type: "hero", title: "One shell. Everything else is data.",
    subtitle: "Nova LiveOS ships empty. Every screen, feature and module you see lives in the database and updates here live — change the data, and every installed copy changes with it. No server, no redeploy." });
  const stats = renderBlock({ type: "stats", items: [
    { label: "Modules in store", countKey: "modules:total" },
    { label: "Installed", countKey: "modules:installed" },
    { label: "Live records", countKey: "records:total" }
  ]}, { counts: counts() });
  const installedCards = state.installs.map((slug) => {
    const mod = state.modules.find((m) => m.slug === slug);
    if (!mod) return "";
    return `<article class="card"><h3>${escapeHtml(mod.name)}</h3><p>${escapeHtml(mod.description)}</p><a class="btn btn-primary" href="#/m/${escapeHtml(mod.slug)}">Open</a></article>`;
  }).join("");
  const demo = adapter.mode === "local" ? `<section class="block demo-panel"><h2>See it live</h2>
    <p>This copy is running in local mode on fixture data. Use the <strong>Simulate live change</strong> button to change the Team Board screen definition in the data layer — the open screen updates in place, without a reload. Wire a Supabase project (see the installer) and the same thing happens from a database edit, via Realtime.</p>
    <button class="btn btn-accent" id="simulateBtn2">Simulate live change</button></section>` :
    `<section class="block demo-panel"><h2>Live from Supabase</h2><p>This copy is reading modules, screens and records from your Supabase project. Edit a row — the shell updates itself.</p></section>`;
  return `${hero}${stats}<section class="block"><h2>Your modules</h2><div class="cards">${installedCards || '<p class="list-empty">Nothing installed yet — visit the Module Store.</p>'}</div></section>${demo}`;
}

function storeView() {
  const cards = state.modules.map((mod) => {
    const installed = state.installs.includes(mod.slug);
    return `<article class="card store-card"><h3>${escapeHtml(mod.name)}</h3><p>${escapeHtml(mod.description)}</p>
      <p class="card-meta">${escapeHtml(mod.manifest?.category || "")} · v${escapeHtml(mod.version)}</p>
      <div class="card-actions">${installed
        ? `<a class="btn btn-primary" href="#/m/${escapeHtml(mod.slug)}">Open</a><button class="btn btn-danger uninstall-btn" data-slug="${escapeHtml(mod.slug)}">Uninstall</button>`
        : `<button class="btn btn-accent install-btn" data-slug="${escapeHtml(mod.slug)}">Install</button>`}</div></article>`;
  }).join("");
  return `${renderBlock({ type: "hero", title: "Module Store", subtitle: "Modules are data. Installing one adds it to your navigation instantly — for this shell, installing is just a record." })}<section class="block"><div class="cards">${cards}</div></section>`;
}

function moduleView(slug) {
  const mod = state.modules.find((m) => m.slug === slug);
  if (!mod) return `<section class="block"><h1>Module not found</h1><p>It may have been unpublished. Visit the <a href="#/store">Module Store</a>.</p></section>`;
  if (!state.installs.includes(slug)) {
    return `<section class="block"><h1>${escapeHtml(mod.name)}</h1><p>${escapeHtml(mod.description)}</p><button class="btn btn-accent install-btn" data-slug="${escapeHtml(mod.slug)}">Install ${escapeHtml(mod.name)}</button></section>`;
  }
  const screen = state.screens.find((s) => s.module_slug === slug && s.slug === "main");
  if (!screen) return `<section class="block"><h1>${escapeHtml(mod.name)}</h1><p>No screen published for this module yet.</p></section>`;
  return renderScreen(screen, { records: state.records, counts: counts() });
}

function render() {
  const r = route();
  app.innerHTML = r.view === "home" ? homeView() : r.view === "store" ? storeView() : moduleView(r.slug);
  renderNav();
  document.getElementById("liveStatus").textContent =
    adapter.mode === "supabase" ? "Live · Supabase connected" : "Live · local mode (fixture data)";
  document.getElementById("modePill").textContent = adapter.mode;
  const sim2 = document.getElementById("simulateBtn2");
  if (sim2) sim2.addEventListener("click", simulateLiveChange);
}

async function refresh(reason) {
  state = await adapter.getState();
  render();
  if (reason) console.debug("[liveos] re-render:", reason);
}

function enrich(kind, payload) {
  const out = { ...payload };
  if (out.budget !== undefined && out.budget !== "") { out.budget = Number(out.budget); out.budgetLabel = `Budget $${out.budget}`; }
  if (out.amount !== undefined && out.amount !== "") { out.amount = Number(out.amount); out.amountLabel = `$${out.amount}`; }
  return out;
}

async function runAction(action, sourcePayload, formData) {
  if (!action) return;
  if (action.type === "navigate") { location.hash = action.route || "#/"; return; }
  if (action.type === "create-record" || action.type === "create-record-from-source" || action.type === "create-record-for-item") {
    let payload = {};
    if (action.payloadTemplate) payload = fillTemplate(action.payloadTemplate, sourcePayload || {});
    if (formData) for (const [k, v] of formData.entries()) payload[k] = v;
    await adapter.createRecord(action.module_slug, action.kind, enrich(action.kind, payload));
    toast(action.successMessage || "Saved.");
    await refresh("record-created");
    return;
  }
  toast("That action is not wired in this shell yet.");
}

// Click delegation: installs, card actions, item (bid) actions, buttons.
document.addEventListener("click", async (e) => {
  const installBtn = e.target.closest(".install-btn");
  if (installBtn) { await adapter.install(installBtn.dataset.slug); toast("Module installed."); await refresh("install"); return; }
  const uninstallBtn = e.target.closest(".uninstall-btn");
  if (uninstallBtn) { await adapter.uninstall(uninstallBtn.dataset.slug); toast("Module uninstalled."); await refresh("uninstall"); return; }
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
});

// Form delegation: generic create-record forms + inline (bid) forms.
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form.live-form, form.inline-form");
  if (!form) return;
  e.preventDefault();
  const action = JSON.parse(form.dataset.action || "{}");
  const item = form.dataset.item ? JSON.parse(form.dataset.item) : {};
  await runAction(action, item, new FormData(form));
  form.reset();
});

// Live-change simulation (local mode): change a screen definition in the
// data layer; the adapter's change event re-renders the shell in place.
async function simulateLiveChange() {
  if (adapter.mode !== "local") { toast("In Supabase mode, edit a screens row — the shell follows live."); return; }
  const screen = state.screens.find((s) => s.module_slug === "team-board" && s.slug === "main");
  if (!screen) return;
  const layout = structuredClone(screen.layout);
  const hero = layout.find((b) => b.type === "hero");
  const stamp = new Date().toLocaleTimeString();
  hero.subtitle = `Shared notes and tasks for the whole team. Live update received at ${stamp} — this text changed in the data layer and the shell re-rendered without a reload.`;
  await adapter.updateScreenLayout("team-board", "main", layout);
  toast(`Live change applied at ${stamp}`);
}

document.getElementById("simulateBtn").addEventListener("click", simulateLiveChange);
document.getElementById("menuBtn").addEventListener("click", () => { drawer.classList.add("open"); overlay.classList.add("show"); });
overlay.addEventListener("click", closeDrawer);
nav.addEventListener("click", (e) => { if (e.target.closest("a")) closeDrawer(); });
function closeDrawer() { drawer.classList.remove("open"); overlay.classList.remove("show"); }

window.addEventListener("hashchange", render);
adapter.onChange(() => refresh("change-event"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is best-effort */ });
}

refresh("boot");
