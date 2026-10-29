// Nova LiveOS icon library — v1.0.0
// Hand-crafted inline SVG icons: one consistent classical style (24×24 grid,
// 1.7 stroke, round caps/joins, ink strokes with sparing green/pink accents)
// designed for the white Nova theme. Icons are data: a module's manifest
// carries an icon slug from this library and the shell renders the real SVG
// everywhere the module appears. No icon fonts, no emoji, no external files.

const P = (d, extra = "") => `<path d="${d}" ${extra}/>`;
const C = (cx, cy, r, extra = "") => `<circle cx="${cx}" cy="${cy}" r="${r}" ${extra}/>`;
const R = (x, y, w, h, rx = 2, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ${extra}/>`;
const L = (x1, y1, x2, y2, extra = "") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
const ACCENT = `fill="var(--green)" stroke="none"`;
const ACCENT2 = `fill="var(--pink)" stroke="none"`;

export const ICONS = {
  // ------------------------------------------------ module icons
  board: P("M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z") +
    L(9.3, 3, 9.3, 21) + L(14.7, 3, 14.7, 21) +
    C(6.7, 6.5, 1.1, ACCENT) + C(12, 6.5, 1.1, ACCENT2) + C(17.3, 6.5, 1.1, ACCENT),
  shop: P("M5 8l1.2-4h11.6L19 8") + P("M5 8h14v3a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-4-3z") +
    P("M6 13v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7") + P("M10 20v-4h4v4"),
  briefcase: R(3, 7.5, 18, 12.5, 2.5) + P("M9 7.5V6a3 3 0 0 1 3-3v0a3 3 0 0 1 3 3v1.5") +
    P("M3 12.5h18") + C(12, 12.5, 1.2, ACCENT),
  chat: P("M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z") +
    L(8, 7.5, 16, 7.5) + L(8, 11, 13, 11) + C(17.6, 7.5, 1, ACCENT2),
  "chart-bar": L(4, 4, 4, 20) + L(4, 20, 20, 20) +
    P("M8.5 20v-5", `stroke="var(--green)" stroke-width="2.6"`) + P("M12.5 20V9", `stroke="currentColor" stroke-width="2.6"`) +
    P("M16.5 20v-8", `stroke="var(--pink)" stroke-width="2.6"`),
  "address-book": P("M6 3h13a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z") +
    L(4, 8, 6.5, 8) + L(4, 12, 6.5, 12) + L(4, 16, 6.5, 16) +
    C(13, 9.5, 2.2) + P("M9.2 17.5c.6-2 2-3 3.8-3s3.2 1 3.8 3"),
  // ------------------------------------------------ shell / generic icons
  home: P("M4 11l8-7 8 7") + P("M6 9.5V20h12V9.5") + P("M10 20v-5h4v5"),
  store: P("M4 7l1.5-3.5h13L20 7") + P("M4 7h16v2.5a2.6 2.6 0 0 1-5.2 0 2.6 2.6 0 0 1-5.6 0A2.6 2.6 0 0 1 4 9.5z") +
    P("M5.5 12.5V20h13v-7.5") + P("M10 20v-4h4v4"),
  shield: P("M12 3l7 2.5V11c0 4.8-3 8.4-7 10-4-1.6-7-5.2-7-10V5.5z") + P("M9 11.5l2.2 2.2L15.5 9.5", `stroke="var(--green)"`),
  search: C(11, 11, 6.5) + L(16, 16, 20.5, 20.5),
  bell: P("M6 16v-5a6 6 0 0 1 12 0v5l1.5 3h-15z") + P("M10 21a2.2 2.2 0 0 0 4 0") + C(17.5, 5.5, 1.1, ACCENT2),
  sliders: L(5, 7, 19, 7) + L(5, 12, 19, 12) + L(5, 17, 19, 17) +
    C(9, 7, 1.8, `fill="#fff"`) + C(15, 12, 1.8, `fill="#fff"`) + C(8, 17, 1.8, `fill="#fff"`),
  grid: R(4, 4, 7, 7, 1.5) + R(13, 4, 7, 7, 1.5) + R(4, 13, 7, 7, 1.5) + R(13, 13, 7, 7, 1.5, ACCENT),
  cart: C(9.5, 20, 1.3) + C(17, 20, 1.3) + P("M3 3.5h2l2.4 11h9.8l2-7.5H6.2"),
  users: C(9, 8.5, 3.2) + P("M3.5 19.5c.7-3.2 2.8-4.8 5.5-4.8s4.8 1.6 5.5 4.8") +
    P("M15.5 5.8a3.2 3.2 0 0 1 0 5.9") + P("M17.8 15.1c1.6.7 2.6 2.1 3 4.4"),
  calendar: R(3.5, 5, 17, 16, 2) + L(3.5, 9.5, 20.5, 9.5) + L(8, 3, 8, 7) + L(16, 3, 16, 7) +
    C(8, 13.5, 1.1, ACCENT) + C(12, 13.5, 1.1, ACCENT) + C(16, 13.5, 1.1) + C(8, 17, 1.1) + C(12, 17, 1.1, ACCENT2),
  mail: R(3, 5.5, 18, 13, 2) + P("M3.5 7l8.5 6 8.5-6"),
  "line-chart": L(4, 4, 4, 20) + L(4, 20, 20, 20) + P("M7 15.5l3.5-4 3 2.5L17.5 9", `stroke="var(--green)"`) +
    C(17.5, 9, 1.4, ACCENT2),
  star: P("M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"),
  folder: P("M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"),
  check: P("M4.5 12.5l5 5L19.5 7"),
  plus: L(12, 5, 12, 19) + L(5, 12, 19, 12),
  activity: P("M3.5 12h4l2.5-6 4 12 2.5-6h4", `stroke="var(--pink)"`),
  zap: P("M13 2.5L4.5 13.5H11L9.8 21.5l8.7-11H12z"),
  user: C(12, 8, 3.6) + P("M5 20.5c.9-3.8 3.6-5.7 7-5.7s6.1 1.9 7 5.7"),
  clock: C(12, 12, 8.5) + P("M12 7.5V12l3 2"),
  layers: P("M12 3.5l9 5-9 5-9-5z") + P("M3.5 13.5l8.5 4.7 8.5-4.7"),
  inbox: P("M4 13.5l2-8h12l2 8v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z") + P("M4 13.5h5l1.2 2h3.6l1.2-2h5")
};

export const ICON_SLUGS = Object.keys(ICONS);
export const FALLBACK_ICON = "grid";

export function isIconSlug(slug) {
  return typeof slug === "string" && Object.hasOwn(ICONS, slug);
}

// Render an icon as inline SVG. Unknown slugs fall back to the grid icon so
// a bad manifest value can never break a screen.
export function iconSvg(slug, cls = "icon") {
  const body = ICONS[isIconSlug(slug) ? slug : FALLBACK_ICON];
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// A module's icon slug lives in its manifest (module data), falling back to
// the legacy top-level icon field, then to the generic grid icon.
export function moduleIconSlug(mod) {
  const slug = mod?.manifest?.icon || mod?.icon || "";
  return isIconSlug(slug) ? slug : FALLBACK_ICON;
}

export function moduleIcon(mod, cls = "icon") {
  return iconSvg(moduleIconSlug(mod), cls);
}
