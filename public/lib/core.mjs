// Nova LiveOS block renderer — v1.0.2
// Pure functions: layout JSON in, HTML string out. No DOM access, so the same
// code runs in the browser shell and in the node test suite.
// v1.0 adds: kanban, table (sortable), gallery, chart (hand-rolled SVG),
// rich-text (safe markdown subset), divider, embed-note, cart — plus a
// `caption` (one-line purpose statement) and `deletable` rows on list/table.

import { iconSvg } from "./icons.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fieldHtml(field) {
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label || field.name);
  const required = field.required ? " required" : "";
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";
  if (field.type === "textarea") {
    return `<label class="field"><span>${label}</span><textarea name="${name}" rows="3"${required}${placeholder}></textarea></label>`;
  }
  if (field.type === "select") {
    const opts = (field.options || []).map((o) => {
      const v = typeof o === "string" ? o : o.value;
      const t = typeof o === "string" ? o : (o.label || o.value);
      return `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
    }).join("");
    return `<label class="field"><span>${label}</span><select name="${name}"${required}>${opts}</select></label>`;
  }
  const type = escapeHtml(field.type || "text");
  return `<label class="field"><span>${label}</span><input name="${name}" type="${type}"${required}${placeholder}></label>`;
}

function actionAttrs(action) {
  return ` data-action='${escapeHtml(JSON.stringify(action || {}))}'`;
}

function sectionHead(block) {
  if (!block.title && !block.caption) return "";
  return `<div class="block-head">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}` +
    (block.caption ? `<p class="block-caption">${escapeHtml(block.caption)}</p>` : "") + `</div>`;
}

function sourceRecords(block, context) {
  if (!block.source) return [];
  return (context.records || []).filter(
    (r) => r.module_slug === block.source.module_slug && (!block.source.kind || r.kind === block.source.kind)
  );
}

// ---------------------------------------------------------------- markdown
// A deliberately small, safe markdown subset for rich-text blocks. The input
// is HTML-escaped FIRST, then only these constructs are re-introduced:
// **bold**, *italic*, `code`, [label](https://…), # / ## / ### headings,
// "- " bullet lists and plain paragraphs. Raw HTML can never reach the page.
export function renderMarkdown(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const out = [];
  let listOpen = false;
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      if (!listOpen) { out.push("<ul>"); listOpen = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (/^###\s+/.test(line)) { closeList(); out.push(`<h4>${inline(line.replace(/^###\s+/, ""))}</h4>`);
    } else if (/^##\s+/.test(line)) { closeList(); out.push(`<h3>${inline(line.replace(/^##\s+/, ""))}</h3>`);
    } else if (/^#\s+/.test(line)) { closeList(); out.push(`<h2>${inline(line.replace(/^#\s+/, ""))}</h2>`);
    } else if (line.trim() === "") { closeList(); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join("\n");
}

// ------------------------------------------------------------- aggregation
// Chart data from records. spec: { source?, groupBy, value }
//   groupBy: "module_slug" | "kind" | "day" | "payload.<field>"
//   value:   "count" | "sum:payload.<field>"
// Returns [{label, value}] — sorted by value desc, except day series which
// sort chronologically so line charts read left→right in time.
export function aggregateRecords(records, spec = {}) {
  let rows = records || [];
  if (spec.source) {
    rows = rows.filter((r) =>
      (!spec.source.module_slug || r.module_slug === spec.source.module_slug) &&
      (!spec.source.kind || r.kind === spec.source.kind));
  }
  const groupBy = spec.groupBy || "module_slug";
  const groups = new Map();
  for (const r of rows) {
    let key;
    if (groupBy === "day") key = String(r.created_at || "").slice(0, 10) || "—";
    else if (groupBy.startsWith("payload.")) key = String(r.payload?.[groupBy.slice(8)] ?? "—");
    else key = String(r[groupBy] ?? "—");
    let val = 1;
    if (typeof spec.value === "string" && spec.value.startsWith("sum:payload.")) {
      val = Number(r.payload?.[spec.value.slice(12)]) || 0;
    }
    groups.set(key, (groups.get(key) || 0) + val);
  }
  const out = [...groups.entries()].map(([label, value]) => ({ label, value }));
  if (groupBy === "day") out.sort((a, b) => a.label.localeCompare(b.label));
  else out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return spec.limit ? out.slice(0, spec.limit) : out;
}

function renderChart(block, context) {
  const data = aggregateRecords(context.records || [], block);
  const W = 640, H = 240, PADL = 8, PADB = 26, PADT = 18;
  const max = Math.max(1, ...data.map((d) => d.value));
  let inner = "";
  if (!data.length) {
    inner = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="chart-empty">No data yet</text>`;
  } else if ((block.chart || "bar") === "line") {
    // v1.0.1: x labels are middle-anchored on their points, so the first
    // and last points need real horizontal padding — at PADL=8 the first
    // label ("10-29") overflowed the left edge and rendered as "0-29".
    const PADX = 30;
    const stepX = data.length > 1 ? (W - PADX * 2) / (data.length - 1) : 0;
    const pts = data.map((d, i) => [data.length > 1 ? PADX + i * stepX : W / 2, PADT + (H - PADT - PADB) * (1 - d.value / max)]);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    inner = `<path d="${path}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round"/>` +
      pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="var(--pink)"/><text x="${p[0]}" y="${p[1] - 8}" text-anchor="middle" class="chart-val">${escapeHtml(data[i].value)}</text><text x="${p[0]}" y="${H - 6}" text-anchor="middle" class="chart-lab">${escapeHtml(data[i].label.slice(5) || data[i].label)}</text>`).join("");
  } else {
    const bw = (W - PADL * 2) / Math.max(1, data.length);
    inner = data.map((d, i) => {
      const h = (H - PADT - PADB) * (d.value / max);
      const x = PADL + i * bw + bw * 0.16, w = bw * 0.68, y = H - PADB - h;
      const fill = i % 3 === 1 ? "var(--green)" : i % 3 === 2 ? "var(--pink)" : "#14161a";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${fill}"/>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${y - 5}" text-anchor="middle" class="chart-val">${escapeHtml(d.value)}</text>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart-lab">${escapeHtml(d.label)}</text>`;
    }).join("");
  }
  return `<section class="block chart-block">${sectionHead(block)}<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${escapeHtml(block.title || "Chart")}">${inner}</svg></div></section>`;
}

// ----------------------------------------------------------------- kanban
export function kanbanColumns(block, context) {
  const cols = block.columns || [{ id: "todo", label: "To do" }, { id: "doing", label: "Doing" }, { id: "done", label: "Done" }];
  const statusField = block.statusField || "status";
  const rows = sourceRecords(block, context);
  return cols.map((c) => ({
    ...c,
    cards: rows.filter((r) => String(r.payload?.[statusField] ?? cols[0].id) === c.id)
  }));
}

function renderKanban(block, context) {
  const cols = kanbanColumns(block, context);
  const titleField = block.titleField || "title";
  const bodyField = block.bodyField || "body";
  const colHtml = cols.map((col, ci) => {
    const cards = col.cards.map((r) => `
      <article class="kanban-card" draggable="true" data-record-id="${escapeHtml(r.id)}">
        <div class="kanban-card-main"><strong>${escapeHtml(r.payload?.[titleField] ?? "")}</strong>
        ${r.payload?.[bodyField] ? `<p>${escapeHtml(r.payload[bodyField])}</p>` : ""}</div>
        <div class="kanban-card-tools">
          ${ci > 0 ? `<button class="mini-btn" data-move-record="${escapeHtml(r.id)}" data-move-to="${escapeHtml(cols[ci - 1].id)}" title="Move to ${escapeHtml(cols[ci - 1].label)}">‹</button>` : ""}
          ${ci < cols.length - 1 ? `<button class="mini-btn" data-move-record="${escapeHtml(r.id)}" data-move-to="${escapeHtml(cols[ci + 1].id)}" title="Move to ${escapeHtml(cols[ci + 1].label)}">›</button>` : ""}
          <button class="mini-btn danger" data-delete-record="${escapeHtml(r.id)}" title="Delete">×</button>
        </div>
      </article>`).join("");
    return `<div class="kanban-col" data-column="${escapeHtml(col.id)}">
      <div class="kanban-col-head"><span>${escapeHtml(col.label)}</span><span class="kanban-count">${col.cards.length}</span></div>
      <div class="kanban-cards" data-drop-column="${escapeHtml(col.id)}">${cards || `<p class="kanban-empty">Nothing here yet — drag a card in, or add one above.</p>`}</div>
    </div>`;
  }).join("");
  return `<section class="block kanban-block">${sectionHead(block)}<div class="kanban" data-status-field="${escapeHtml(block.statusField || "status")}" data-module="${escapeHtml(block.source?.module_slug || "")}">${colHtml}</div></section>`;
}

// ------------------------------------------------------------------ table
export function sortRows(rows, field, dir = "asc") {
  if (!field) return [...rows];
  const mul = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a.payload?.[field], vb = b.payload?.[field];
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
    return String(va ?? "").localeCompare(String(vb ?? "")) * mul;
  });
}

function renderTable(block, context) {
  const columns = block.columns || [{ field: "title", label: "Title" }];
  const sort = context.sortState?.[block.id || "table"];
  let rows = sourceRecords(block, context);
  if (sort?.field) rows = sortRows(rows, sort.field, sort.dir);
  const head = columns.map((c) => {
    const active = sort?.field === c.field;
    return `<th><button class="th-sort ${active ? "active" : ""}" data-sort-block="${escapeHtml(block.id || "table")}" data-sort-field="${escapeHtml(c.field)}">${escapeHtml(c.label || c.field)}${active ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}</button></th>`;
  }).join("") + (block.deletable ? "<th></th>" : "");
  const body = rows.length ? rows.map((r) => `<tr data-record-id="${escapeHtml(r.id)}">` +
    columns.map((c) => `<td>${escapeHtml(r.payload?.[c.field] ?? "")}</td>`).join("") +
    (block.deletable ? `<td><button class="mini-btn danger" data-delete-record="${escapeHtml(r.id)}" title="Delete">×</button></td>` : "") +
    `</tr>`).join("")
    : `<tr><td colspan="${columns.length + (block.deletable ? 1 : 0)}" class="table-empty">${escapeHtml(block.emptyText || "Nothing here yet.")}</td></tr>`;
  return `<section class="block table-block">${sectionHead(block)}<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

// ------------------------------------------------------------------ blocks
export function renderBlock(block, context = {}) {
  const records = context.records || [];
  switch (block.type) {
    case "hero":
      return `<section class="block hero">${block.icon ? `<div class="hero-icon">${iconSvg(block.icon, "icon hero-icon-svg")}</div>` : ""}<h1>${escapeHtml(block.title || "")}</h1>` +
        (block.subtitle ? `<p class="hero-sub">${escapeHtml(block.subtitle)}</p>` : "") +
        (block.caption ? `<p class="hero-caption">${escapeHtml(block.caption)}</p>` : "") + `</section>`;
    case "text":
      return `<section class="block text">${sectionHead(block)}<p>${escapeHtml(block.text || "")}</p></section>`;
    case "rich-text":
      return `<section class="block rich-text">${sectionHead(block)}<div class="md">${renderMarkdown(block.markdown ?? block.text ?? "")}</div></section>`;
    case "stats": {
      const items = (block.items || []).map((item) => {
        // v1.0.1: before the first live records load lands, countKey stats
        // render a skeleton placeholder — never a final-looking number
        // (the shell used to paint the pre-load 0, then jump to the real
        // count when records arrived: the "stat flicker").
        if (item.countKey && context.statsPending) {
          return `<div class="stat"><div class="skel skel-num" aria-label="Loading"></div><div class="stat-label">${escapeHtml(item.label || "")}</div></div>`;
        }
        const value = item.countKey ? (context.counts?.[item.countKey] ?? 0) : (item.value ?? "");
        const numeric = typeof value === "number" || /^\d+$/.test(String(value));
        return `<div class="stat"><div class="stat-value" ${numeric ? `data-count="${escapeHtml(value)}"` : ""}>${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(item.label || "")}</div></div>`;
      }).join("");
      return `<section class="block stats">${items}</section>`;
    }
    case "cards": {
      let items = block.items || [];
      if (block.source) {
        items = sourceRecords(block, context).map((r) => ({
          title: r.payload?.[block.titleField || "title"] ?? "",
          body: r.payload?.[block.bodyField || "body"] ?? "",
          meta: block.metaField ? (r.payload?.[block.metaField] ?? "") : "",
          record_id: r.id,
          payload: r.payload
        }));
      }
      const cards = items.map((item) => {
        const actionBtn = block.cardAction
          ? `<button class="btn btn-accent card-action" data-card='${escapeHtml(JSON.stringify(item.payload || item))}'${actionAttrs(block.cardAction.action)}>${escapeHtml(block.cardAction.label)}</button>`
          : "";
        return `<article class="card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p>` +
          (item.meta ? `<p class="card-meta">${escapeHtml(item.meta)}</p>` : "") + actionBtn + `</article>`;
      }).join("");
      return `<section class="block cards-block">${sectionHead(block)}<div class="cards">${cards || `<p class="list-empty">${escapeHtml(block.emptyText || "Nothing here yet.")}</p>`}</div></section>`;
    }
    case "list": {
      let items = block.items || [];
      if (block.source) {
        items = sourceRecords(block, context).map((r) => ({
          title: r.payload?.[block.titleField || "title"] ?? "",
          body: block.bodyField ? (r.payload?.[block.bodyField] ?? "") : "",
          meta: block.metaField ? (r.payload?.[block.metaField] ?? "") : "",
          record_id: r.id,
          payload: r.payload
        }));
      }
      const rows = items.length
        ? items.map((item) => {
            const bidBtn = block.itemAction
              ? `<button class="btn btn-ghost item-action" data-item='${escapeHtml(JSON.stringify(item.payload || item))}'${actionAttrs(block.itemAction.action)}>${escapeHtml(block.itemAction.label)}</button>`
              : "";
            const delBtn = block.deletable && item.record_id
              ? `<button class="mini-btn danger" data-delete-record="${escapeHtml(item.record_id)}" title="Delete">×</button>` : "";
            return `<li class="list-row"><div class="list-row-main"><strong>${escapeHtml(item.title)}</strong>` +
              (item.body ? `<span class="list-row-body">${escapeHtml(item.body)}</span>` : "") +
              (item.meta ? `<span class="list-row-meta">${escapeHtml(item.meta)}</span>` : "") +
              `</div><div class="list-row-tools">${bidBtn}${delBtn}</div></li>`;
          }).join("")
        : `<li class="list-empty">${escapeHtml(block.emptyText || "Nothing here yet.")}</li>`;
      return `<section class="block list-block">${sectionHead(block)}<ul class="list">${rows}</ul></section>`;
    }
    case "form": {
      const fields = (block.fields || []).map(fieldHtml).join("");
      return `<section class="block form-block">${sectionHead(block)}` +
        `<form class="live-form" data-form-id="${escapeHtml(block.id || "form")}"${actionAttrs(block.action)}>${fields}` +
        `<button class="btn btn-primary" type="submit">${escapeHtml(block.submitLabel || "Submit")}</button></form></section>`;
    }
    case "action-button":
      return `<section class="block action-block">${sectionHead(block)}<button class="btn btn-primary action-button"${actionAttrs(block.action)}>${escapeHtml(block.label || "Go")}</button></section>`;
    case "kanban":
      return renderKanban(block, context);
    case "table":
      return renderTable(block, context);
    case "gallery": {
      const imgField = block.imageField || "image";
      const items = sourceRecords(block, context).map((r) => `
        <figure class="gallery-item"><img src="${escapeHtml(r.payload?.[imgField] ?? "")}" alt="${escapeHtml(r.payload?.[block.titleField || "title"] ?? "")}" loading="lazy">
        <figcaption><strong>${escapeHtml(r.payload?.[block.titleField || "title"] ?? "")}</strong>${r.payload?.[block.bodyField || "body"] ? `<span>${escapeHtml(r.payload[block.bodyField || "body"])}</span>` : ""}</figcaption></figure>`).join("");
      return `<section class="block gallery-block">${sectionHead(block)}<div class="gallery">${items || `<p class="list-empty">${escapeHtml(block.emptyText || "No images yet.")}</p>`}</div></section>`;
    }
    case "chart":
      return renderChart(block, context);
    case "divider":
      return `<section class="block divider-block"><div class="divider">${block.label ? `<span>${escapeHtml(block.label)}</span>` : ""}</div></section>`;
    case "embed-note":
      return `<section class="block embed-note">${iconSvg(block.icon || "inbox", "icon note-icon")}<div>${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : ""}<div class="md">${renderMarkdown(block.markdown ?? block.text ?? "")}</div></div></section>`;
    case "cart": {
      const cart = context.cart || { items: [], total: 0, count: 0 };
      const lines = (cart.items || []).map((i) =>
        `<li class="list-row"><div class="list-row-main"><strong>${escapeHtml(i.product)}</strong><span class="list-row-body">${escapeHtml(i.qty)} × $${escapeHtml(i.price)}</span></div><span class="card-meta">$${escapeHtml(i.qty * i.price)}</span></li>`).join("");
      return `<section class="block cart-block">${sectionHead(block)}` +
        (cart.count
          ? `<ul class="list">${lines}</ul><div class="cart-foot"><span>Total <strong>$${escapeHtml(cart.total)}</strong> · ${cart.count} item${cart.count === 1 ? "" : "s"}</span><span class="cart-actions"><a class="btn btn-ghost" href="#/cart">Review cart</a><button class="btn btn-primary" data-checkout="1">Checkout</button></span></div>`
          : `<p class="list-empty">${escapeHtml(block.emptyText || "Your cart is empty — add a product above and it will appear here.")}</p>`) +
        `</section>`;
    }
    default:
      return `<section class="block unknown"><!-- unknown block type: ${escapeHtml(block.type)} --></section>`;
  }
}

export function renderScreen(screen, context = {}) {
  const blocks = Array.isArray(screen?.layout) ? screen.layout : [];
  return blocks.map((b) => renderBlock(b, context)).join("\n");
}

// Fill {{field}} placeholders in a payload template from a source payload.
export function fillTemplate(template, source) {
  const out = {};
  for (const [key, value] of Object.entries(template || {})) {
    out[key] = typeof value === "string"
      ? value.replace(/\{\{(\w+)\}\}/g, (_, f) => String(source?.[f] ?? ""))
      : value;
  }
  return out;
}
