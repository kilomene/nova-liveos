// Nova LiveOS feature logic — v1.0.2
// Pure, testable logic shared by the shell and the test suite: cart maths,
// kanban moves, global search, notification derivation, the admin block
// editor model, and the in-shell automation engine.

import { fillTemplate } from "./core.mjs";

// -------------------------------------------------------------------- cart
// Cart items: { product, price, qty }. Prices are whole dollars in v1.0.
export function cartAdd(cart, item) {
  const items = (cart?.items || []).map((i) => ({ ...i }));
  const found = items.find((i) => i.product === item.product);
  if (found) found.qty += item.qty || 1;
  else items.push({ product: item.product, price: Number(item.price) || 0, qty: item.qty || 1 });
  return cartView({ items });
}
export function cartSetQty(cart, product, qty) {
  const items = (cart?.items || [])
    .map((i) => (i.product === product ? { ...i, qty } : { ...i }))
    .filter((i) => i.qty > 0);
  return cartView({ items });
}
export function cartRemove(cart, product) {
  return cartView({ items: (cart?.items || []).filter((i) => i.product !== product) });
}
export function cartView(cart) {
  const items = (cart?.items || []).map((i) => ({ ...i }));
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const count = items.reduce((s, i) => s + i.qty, 0);
  return { items, total, count };
}
export function cartSummary(cart) {
  return (cart?.items || []).map((i) => `${i.qty} × ${i.product}`).join(", ");
}

// ------------------------------------------------------------------ kanban
export function moveRecordStatus(record, status, statusField = "status") {
  return { ...record, payload: { ...(record.payload || {}), [statusField]: status } };
}

// ------------------------------------------------------------------ search
// Index entries: { type: "module"|"record"|"action", title, subtitle, route,
// text } — `text` is the lowercase haystack used for matching.
export function buildSearchIndex({ modules = [], records = [], actions = [] } = {}) {
  const entries = [];
  for (const m of modules) {
    entries.push({
      type: "module", title: m.name, subtitle: `${m.manifest?.category || "Module"} · v${m.version}`,
      route: `#/m/${m.slug}`, icon: m.manifest?.icon || m.icon || "grid",
      text: `${m.name} ${m.slug} ${m.description || ""}`.toLowerCase()
    });
  }
  for (const r of records) {
    const p = r.payload || {};
    const title = p.title || p.name || p.product || p.text || p.summary || `${r.kind} record`;
    const bits = Object.values(p).filter((v) => typeof v === "string" || typeof v === "number").join(" ");
    entries.push({
      type: "record", title: String(title), subtitle: `${r.module_slug} · ${r.kind}`,
      route: `#/m/${r.module_slug}`, record_id: r.id,
      text: `${title} ${bits} ${r.module_slug} ${r.kind}`.toLowerCase()
    });
  }
  for (const a of actions) {
    entries.push({ type: "action", title: a.title, subtitle: a.subtitle || "Command", route: a.route || "", command: a.command, icon: a.icon || "zap", text: `${a.title} ${a.subtitle || ""}`.toLowerCase() });
  }
  return entries;
}

export function searchIndex(index, query, limit = 12) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return index.filter((e) => e.type !== "record").slice(0, limit);
  const scored = [];
  for (const e of index) {
    const t = e.title.toLowerCase();
    let score = -1;
    if (t === q) score = 100;
    else if (t.startsWith(q)) score = 60;
    else if (t.includes(q)) score = 40;
    else if (e.text.includes(q)) score = 20;
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

// ------------------------------------------------------------- notifications
// Derived, not stored: anything created after `sinceTs` (records + audit
// events) is a notification.
//
// v1.0.1 — presence/heartbeat churn must NEVER surface here. In Supabase
// mode every heartbeat is an INSERT into records (module 'liveos-core',
// kind 'presence'), and the 0003 audit trigger mirrors it into audit_log
// as `insert.records` with detail.module_slug = 'liveos-core'. Both forms
// are filtered below (the old comment claimed presence "never reaches
// this list" — true for local mode, false for the audit half in Supabase
// mode, which is exactly how the badge climbed 2 → 37 in one session).
// Two more inflation sources are removed at the same layer:
//   - mechanical DB-trigger audit rows (insert./update./delete.<table>)
//     are raw change mirrors for the Admin Activity viewer, not
//     user-facing events;
//   - an audit row that merely mirrors a record already in the list
//     (same entity_id, e.g. the local store's `record.created` entry)
//     would double-count one real event, so it is dropped.
export const PRESENCE_MODULE_SLUG = "liveos-core";
const MECHANICAL_AUDIT_EVENT = /^(insert|update|delete)\./;

export function isPresenceRecord(r) {
  return r?.module_slug === PRESENCE_MODULE_SLUG || r?.kind === "presence";
}
export function isPresenceAudit(a) {
  return a?.detail?.module_slug === PRESENCE_MODULE_SLUG
    || a?.detail?.kind === "presence"
    || /(^|\.)presence(\.|$)/.test(String(a?.event || ""));
}

export function notificationsFrom({ records = [], audit = [] } = {}, sinceTs = 0, limit = 30) {
  const items = [];
  const recordIds = new Set();
  for (const r of records) {
    if (isPresenceRecord(r)) continue;
    const ts = Date.parse(r.created_at || "") || 0;
    if (ts <= sinceTs) continue;
    recordIds.add(String(r.id));
    const p = r.payload || {};
    const label = p.title || p.name || p.product || p.summary || p.text || r.kind;
    items.push({
      ts, kind: "record", icon: "plus",
      text: `${r.module_slug}: new ${r.kind} — ${String(label).slice(0, 80)}`,
      route: `#/m/${r.module_slug}`
    });
  }
  for (const a of audit) {
    if (isPresenceAudit(a)) continue;
    if (MECHANICAL_AUDIT_EVENT.test(String(a.event || ""))) continue;
    if (a.entity === "records" && a.entity_id && recordIds.has(String(a.entity_id))) continue;
    const ts = Date.parse(a.created_at || "") || 0;
    if (ts <= sinceTs) continue;
    items.push({
      ts, kind: "audit", icon: "activity",
      text: a.detail?.text ? String(a.detail.text) : `${a.event}${a.entity ? ` · ${a.entity}` : ""}`,
      route: "#/admin/activity"
    });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, limit);
}

// -------------------------------------------------------- admin block editor
// Form schema per block type: which fields the editor shows, and how each is
// edited (text / textarea / number / json / select). Anything structural is
// JSON; anything human is a plain field.
export const BLOCK_SCHEMAS = {
  hero: [
    { name: "title", label: "Title", kind: "text" },
    { name: "subtitle", label: "Subtitle", kind: "textarea" },
    { name: "caption", label: "Purpose caption", kind: "text" }
  ],
  text: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "text", label: "Text", kind: "textarea" }
  ],
  "rich-text": [
    { name: "title", label: "Heading", kind: "text" },
    { name: "markdown", label: "Markdown", kind: "textarea" }
  ],
  stats: [
    { name: "items", label: "Stat items (JSON)", kind: "json" }
  ],
  cards: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "source", label: "Source (JSON)", kind: "json" },
    { name: "titleField", label: "Title field", kind: "text" },
    { name: "bodyField", label: "Body field", kind: "text" },
    { name: "metaField", label: "Meta field", kind: "text" },
    { name: "cardAction", label: "Card action (JSON)", kind: "json" }
  ],
  list: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "source", label: "Source (JSON)", kind: "json" },
    { name: "titleField", label: "Title field", kind: "text" },
    { name: "bodyField", label: "Body field", kind: "text" },
    { name: "metaField", label: "Meta field", kind: "text" },
    { name: "itemAction", label: "Item action (JSON)", kind: "json" },
    { name: "emptyText", label: "Empty text", kind: "text" }
  ],
  form: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "submitLabel", label: "Submit label", kind: "text" },
    { name: "fields", label: "Fields (JSON)", kind: "json" },
    { name: "action", label: "Action (JSON)", kind: "json" }
  ],
  "action-button": [
    { name: "label", label: "Label", kind: "text" },
    { name: "action", label: "Action (JSON)", kind: "json" }
  ],
  kanban: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "source", label: "Source (JSON)", kind: "json" },
    { name: "statusField", label: "Status field", kind: "text" },
    { name: "titleField", label: "Card title field", kind: "text" },
    { name: "bodyField", label: "Card body field", kind: "text" },
    { name: "columns", label: "Columns (JSON)", kind: "json" }
  ],
  table: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "source", label: "Source (JSON)", kind: "json" },
    { name: "columns", label: "Columns (JSON)", kind: "json" },
    { name: "emptyText", label: "Empty text", kind: "text" }
  ],
  gallery: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "source", label: "Source (JSON)", kind: "json" },
    { name: "imageField", label: "Image field", kind: "text" },
    { name: "titleField", label: "Title field", kind: "text" }
  ],
  chart: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "chart", label: "Chart type", kind: "select", options: ["bar", "line"] },
    { name: "source", label: "Source (JSON)", kind: "json" },
    { name: "groupBy", label: "Group by", kind: "text" },
    { name: "value", label: "Value", kind: "text" }
  ],
  divider: [{ name: "label", label: "Label", kind: "text" }],
  "embed-note": [
    { name: "title", label: "Title", kind: "text" },
    { name: "markdown", label: "Note (markdown)", kind: "textarea" }
  ],
  cart: [
    { name: "title", label: "Heading", kind: "text" },
    { name: "caption", label: "Purpose caption", kind: "text" },
    { name: "emptyText", label: "Empty text", kind: "text" }
  ]
};

export const BLOCK_TYPES = Object.keys(BLOCK_SCHEMAS);

export function blockTemplate(type) {
  const base = { type };
  switch (type) {
    case "hero": return { ...base, title: "New section", subtitle: "", caption: "" };
    case "text": return { ...base, text: "Write something…" };
    case "rich-text": return { ...base, markdown: "**Bold** start…" };
    case "stats": return { ...base, items: [{ label: "Records", countKey: "records:total" }] };
    case "divider": return { ...base, label: "" };
    case "embed-note": return { ...base, title: "Note", markdown: "Something worth knowing." };
    case "form": return { ...base, title: "New form", fields: [{ name: "title", label: "Title", required: true }], submitLabel: "Save", action: { type: "create-record", module_slug: "", kind: "note", successMessage: "Saved." } };
    default: return base;
  }
}

export function addBlock(layout, type) {
  return [...(layout || []), blockTemplate(type)];
}
export function removeBlock(layout, index) {
  return (layout || []).filter((_, i) => i !== index);
}
export function moveBlockInLayout(layout, index, dir) {
  const out = [...(layout || [])];
  const j = index + dir;
  if (j < 0 || j >= out.length) return out;
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}
// Apply editor field values to one block. JSON-kind fields arrive as strings
// and are parsed here; a parse failure throws with the field name so the UI
// can point at the exact problem.
export function applyBlockEdit(block, edits) {
  const schema = BLOCK_SCHEMAS[block.type] || [];
  const out = { ...block };
  for (const f of schema) {
    if (!(f.name in edits)) continue;
    const v = edits[f.name];
    if (f.kind === "json") {
      if (v === "" || v == null) { delete out[f.name]; continue; }
      try { out[f.name] = typeof v === "string" ? JSON.parse(v) : v; }
      catch { throw new Error(`Invalid JSON in field "${f.label}"`); }
    } else if (f.kind === "number") out[f.name] = Number(v);
    else out[f.name] = v;
  }
  return out;
}

// ---------------------------------------------------------- automation engine
// The engine is pure: given the enabled automations and one change event it
// returns the actions to perform. The shell executes them through the data
// adapter (create-record / audit) and logs each execution back to the audit
// log. Trigger grammar:
//   "record.created"            any record creation
//   "record.created:<kind>"     creations of one kind (e.g. :order, :bid)
//   "record.updated" / "record.deleted" / "module.installed" / …
// Loop safety: records created BY an automation carry payload._auto = slug
// and never trigger further automations (depth 1, enforced here).
export function automationMatches(automation, event) {
  if (!automation?.enabled) return false;
  const trig = automation.trigger_event || "";
  if (event?.record?.payload?._auto) return false;
  if (trig === event.type) return true;
  if (event.type === "record.created" && trig.startsWith("record.created:")) {
    return trig.slice("record.created:".length) === event.record?.kind;
  }
  return false;
}

export function runAutomations(automations, event) {
  const out = [];
  for (const a of automations || []) {
    if (!automationMatches(a, event)) continue;
    const action = a.action || {};
    if (action.type === "create-record") {
      out.push({
        automation: a.slug, type: "create-record",
        module_slug: action.module_slug, kind: action.kind,
        payload: { ...fillTemplate(action.payloadTemplate || {}, event.record?.payload || {}), _auto: a.slug }
      });
    } else if (action.type === "audit") {
      out.push({
        automation: a.slug, type: "audit",
        event: action.event || `automation.${a.slug}`,
        detail: { text: fillTemplate({ t: action.text || "" }, event.record?.payload || {}).t, trigger: event.type }
      });
    }
  }
  return out;
}
