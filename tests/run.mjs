// Nova LiveOS test suite — v0.1.0. Zero dependencies: `node tests/run.mjs`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderBlock, renderScreen, fillTemplate, escapeHtml } from "../public/lib/core.mjs";
import { createLocalStore, selectMode, SupabaseAdapter, isUuid } from "../public/lib/data.mjs";
import { SEED } from "../public/lib/seed-data.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// ------------------------------------------------------------ schema checks
const sql = readFileSync(join(root, "supabase/migrations/0001_kernel.sql"), "utf8");
const tables = ["profiles", "roles", "permissions", "role_permissions", "user_roles", "modules",
  "screens", "module_installs", "records", "automations", "audit_log"];
for (const t of tables) check(`schema creates table ${t}`, new RegExp(`create table if not exists public\\.${t} \\(`).test(sql));
for (const t of tables) check(`RLS enabled on ${t}`, sql.includes(`alter table public.${t} enable row level security`));
for (const t of tables) check(`${t} in realtime publication list`, sql.includes(`'${t}'`) || sql.includes(`,${t}`) || sql.includes(`'${t}',`) || new RegExp(`array\\[[^\\]]*'${t}'`).test(sql) || sql.includes(`'${t}'`));
check("realtime publication alter present", sql.includes("alter publication supabase_realtime add table"));
check("audit is insert-only for clients", sql.includes('create policy "audit insert only"'));
check("published modules readable policy", sql.includes('create policy "modules readable"'));
check("no service-role key anywhere in sql", !/service_role|SERVICE_ROLE/.test(sql));

// --------------------------------------------------------------- seed checks
const seedSql = readFileSync(join(root, "supabase/seed.sql"), "utf8");
const seedModules = ["team-board", "mini-shop", "agent-floor"];
check("fixture defines exactly 3 modules", SEED.modules.length === 3, `got ${SEED.modules.length}`);
for (const slug of seedModules) {
  check(`seed.sql defines module ${slug}`, seedSql.includes(`'${slug}'`));
  check(`fixture defines module ${slug}`, SEED.modules.some((m) => m.slug === slug));
  check(`fixture has a main screen for ${slug}`, SEED.screens.some((s) => s.module_slug === slug && s.slug === "main" && s.layout.length >= 2));
  check(`seed.sql has a main screen for ${slug}`, seedSql.includes(`('${slug}', 'main'`));
}
check("seed.sql defines demo products", seedSql.includes("Nova Mug") && seedSql.includes("Nova Tee"));
check("seed.sql defines demo agents", seedSql.includes("Scout") && seedSql.includes("Atlas"));

// ----------------------------------------------------------- renderer checks
const ctx = { records: SEED.records.map((r, i) => ({ id: `r${i}`, ...r })), counts: { "team-board:note": 2 } };
check("hero block", renderBlock({ type: "hero", title: "Hi <b>", subtitle: "Sub" }, ctx).includes("<h1>Hi &lt;b&gt;</h1>"));
check("text block escapes", renderBlock({ type: "text", text: "a & b" }, ctx).includes("a &amp; b"));
check("stats block resolves countKey", renderBlock({ type: "stats", items: [{ label: "Items", countKey: "team-board:note" }] }, ctx).includes(">2<"));
check("stats block static value", renderBlock({ type: "stats", items: [{ label: "X", value: 7 }] }, ctx).includes(">7<"));
const cardsHtml = renderBlock({ type: "cards", source: { module_slug: "mini-shop", kind: "product" }, titleField: "name", bodyField: "description", metaField: "priceLabel",
  cardAction: { label: "Order", action: { type: "create-record-from-source", module_slug: "mini-shop", kind: "order" } } }, ctx);
check("cards block renders products from records", cardsHtml.includes("Nova Mug") && cardsHtml.includes("Nova Tee") && cardsHtml.includes("$12"));
check("cards block renders order buttons", (cardsHtml.match(/card-action/g) || []).length === 3);
const listHtml = renderBlock({ type: "list", source: { module_slug: "team-board", kind: "note" }, titleField: "title", bodyField: "body", emptyText: "Empty!" }, ctx);
check("list block renders records", listHtml.includes("Welcome to the board"));
check("list block empty state", renderBlock({ type: "list", source: { module_slug: "x", kind: "y" }, emptyText: "Empty!" }, ctx).includes("Empty!"));
const formHtml = renderBlock({ type: "form", id: "f1", fields: [{ name: "title", label: "Title", required: true }, { name: "body", label: "Body", type: "textarea" }],
  submitLabel: "Send", action: { type: "create-record", module_slug: "team-board", kind: "note" } }, ctx);
check("form block renders fields + action", formHtml.includes('name="title"') && formHtml.includes("<textarea") && formHtml.includes("create-record"));
check("action-button block", renderBlock({ type: "action-button", label: "Go", action: { type: "navigate", route: "#/store" } }, ctx).includes("Go"));
check("unknown block is inert", renderBlock({ type: "nope" }, ctx).includes("unknown block"));
check("renderScreen renders a full screen", renderScreen(SEED.screens[0], ctx).includes("Team Board"));
check("fillTemplate fills placeholders", fillTemplate({ p: "{{name}}" }, { name: "Mug" }).p === "Mug");
check("escapeHtml escapes quotes", escapeHtml('"x"') === "&quot;x&quot;");

// ------------------------------------------------------- local store checks
const store = createLocalStore(memoryStorage());
check("store seeds 3 modules", store.getModules().length === 3);
check("default install is team-board only", JSON.stringify(store.getInstalls()) === JSON.stringify(["team-board"]));
store.install("mini-shop");
check("install adds module", store.isInstalled("mini-shop"));
check("install is idempotent", store.install("mini-shop").filter((s) => s === "mini-shop").length === 1);
store.uninstall("mini-shop");
check("uninstall removes module", !store.isInstalled("mini-shop"));
let threw = false; try { store.install("does-not-exist"); } catch { threw = true; }
check("install of unknown module throws", threw);
const before = store.getRecords("team-board", "note").length;
const rec = store.createRecord("team-board", "note", { title: "Test note", body: "From the suite" });
check("createRecord returns the record", rec.payload.title === "Test note" && !!rec.id);
check("createRecord persists in store", store.getRecords("team-board", "note").length === before + 1);
let events = 0; const unsub = store.subscribe(() => events++);
store.createRecord("agent-floor", "job", { title: "Job X" });
check("change events fire (live-update bus)", events === 1);
unsub();
const layout = structuredClone(store.getScreen("team-board", "main").layout);
layout[0].subtitle = "Changed live";
store.updateScreenLayout("team-board", "main", layout);
check("updateScreenLayout changes the screen definition", store.getScreen("team-board", "main").layout[0].subtitle === "Changed live");
const store2 = createLocalStore(memoryStorage());
check("a fresh store is independent", store2.getScreen("team-board", "main").layout[0].subtitle !== "Changed live");

// ------------------------------------------------------------- mode checks
check("empty config selects local mode", selectMode({}) === "local");
check("placeholder config selects local mode", selectMode({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "YOUR-KEY" }) === "local");
check("real config selects supabase mode", selectMode({ supabaseUrl: "https://abcd1234.supabase.co", supabaseAnonKey: "a".repeat(40) }) === "supabase");

// -------------------------------------- supabase adapter identity (uuid)
// Regression guard for the live defect: a non-UUID per-browser id makes the
// module_installs query (user_id is a uuid column) fail, getState() rejects,
// and the shell never renders — stuck on "Loading…" forever.
const sbCfg = { supabaseUrl: "https://abcd1234.supabase.co", supabaseAnonKey: "a".repeat(40) };
const sb1 = new SupabaseAdapter(sbCfg);
check("supabase adapter userId is a uuid", isUuid(sb1.userId));
const memLS = new Map();
globalThis.localStorage = { getItem: (k) => (memLS.has(k) ? memLS.get(k) : null), setItem: (k, v) => memLS.set(k, String(v)), removeItem: (k) => memLS.delete(k) };
memLS.set("liveos.userId", "user_legacybad");
const sb2 = new SupabaseAdapter(sbCfg);
check("legacy non-uuid stored id is replaced with a uuid", isUuid(sb2.userId) && sb2.userId !== "user_legacybad");
check("uuid id persists to storage", memLS.get("liveos.userId") === sb2.userId);
const sb3 = new SupabaseAdapter(sbCfg);
check("uuid id is stable across constructions", sb3.userId === sb2.userId);
delete globalThis.localStorage;

// Migration 0002 must exist and replace the auth.uid()-bound install policy.
const mig2 = readFileSync(join(root, "supabase/migrations/0002_installs_anon.sql"), "utf8");
check("migration 0002 drops the auth-bound installs write policy", mig2.includes('drop policy if exists "installs own write"'));
check("migration 0002 adds anon insert and delete install policies", mig2.includes('"installs anon insert"') && mig2.includes('"installs anon delete"'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
