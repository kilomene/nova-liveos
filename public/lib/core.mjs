// Nova LiveOS block renderer — v0.1.0
// Pure functions: layout JSON in, HTML string out. No DOM access, so the same
// code runs in the browser shell and in the node test suite.

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
  const type = escapeHtml(field.type || "text");
  return `<label class="field"><span>${label}</span><input name="${name}" type="${type}"${required}${placeholder}></label>`;
}

function actionAttrs(action) {
  return ` data-action='${escapeHtml(JSON.stringify(action || {}))}'`;
}

export function renderBlock(block, context = {}) {
  const records = context.records || [];
  switch (block.type) {
    case "hero":
      return `<section class="block hero"><h1>${escapeHtml(block.title || "")}</h1>` +
        (block.subtitle ? `<p class="hero-sub">${escapeHtml(block.subtitle)}</p>` : "") + `</section>`;
    case "text":
      return `<section class="block text"><p>${escapeHtml(block.text || "")}</p></section>`;
    case "stats": {
      const items = (block.items || []).map((item) => {
        const value = item.countKey ? (context.counts?.[item.countKey] ?? 0) : (item.value ?? "");
        return `<div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(item.label || "")}</div></div>`;
      }).join("");
      return `<section class="block stats">${items}</section>`;
    }
    case "cards": {
      let items = block.items || [];
      if (block.source) {
        items = records
          .filter((r) => r.module_slug === block.source.module_slug && r.kind === block.source.kind)
          .map((r) => ({
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
      return `<section class="block cards-block">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}<div class="cards">${cards}</div></section>`;
    }
    case "list": {
      let items = block.items || [];
      if (block.source) {
        items = records
          .filter((r) => r.module_slug === block.source.module_slug && r.kind === block.source.kind)
          .map((r) => ({
            title: r.payload?.[block.titleField || "title"] ?? "",
            body: block.bodyField ? (r.payload?.[block.bodyField] ?? "") : "",
            record_id: r.id,
            payload: r.payload
          }));
      }
      const rows = items.length
        ? items.map((item) => {
            const bidBtn = block.itemAction
              ? `<button class="btn btn-ghost item-action" data-item='${escapeHtml(JSON.stringify(item.payload || item))}'${actionAttrs(block.itemAction.action)}>${escapeHtml(block.itemAction.label)}</button>`
              : "";
            return `<li class="list-row"><div class="list-row-main"><strong>${escapeHtml(item.title)}</strong>` +
              (item.body ? `<span class="list-row-body">${escapeHtml(item.body)}</span>` : "") +
              `</div>${bidBtn}</li>`;
          }).join("")
        : `<li class="list-empty">${escapeHtml(block.emptyText || "Nothing here yet.")}</li>`;
      return `<section class="block list-block">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}<ul class="list">${rows}</ul></section>`;
    }
    case "form": {
      const fields = (block.fields || []).map(fieldHtml).join("");
      return `<section class="block form-block">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}` +
        `<form class="live-form" data-form-id="${escapeHtml(block.id || "form")}"${actionAttrs(block.action)}>${fields}` +
        `<button class="btn btn-primary" type="submit">${escapeHtml(block.submitLabel || "Submit")}</button></form></section>`;
    }
    case "action-button":
      return `<section class="block action-block"><button class="btn btn-primary action-button"${actionAttrs(block.action)}>${escapeHtml(block.label || "Go")}</button></section>`;
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
