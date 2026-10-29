// Nova LiveOS local fixture data — v0.1.0
// This mirrors supabase/seed.sql. In local mode (no Supabase configured) the
// shell runs entirely from this fixture, stored in localStorage so installs,
// records and live-change simulations persist across reloads.

export const SEED = {
  version: "0.1.0",
  defaultInstalled: ["team-board"],
  modules: [
    {
      slug: "team-board",
      name: "Team Board",
      version: "0.1.0",
      description: "A shared board for team notes and tasks. Add an item and everyone sees it live.",
      icon: "TB",
      manifest: { route: "team-board", category: "Collaborate" },
      bundle_url: null,
      published: true
    },
    {
      slug: "mini-shop",
      name: "Mini Shop",
      version: "0.1.0",
      description: "A tiny store. Products are records; ordering writes an order record.",
      icon: "MS",
      manifest: { route: "mini-shop", category: "Commerce" },
      bundle_url: null,
      published: true
    },
    {
      slug: "agent-floor",
      name: "Agent Floor",
      version: "0.1.0",
      description: "Agents, open jobs and bids — humans and AI agents in one live workspace.",
      icon: "AF",
      manifest: { route: "agent-floor", category: "Agents" },
      bundle_url: null,
      published: true
    }
  ],
  screens: [
    {
      module_slug: "team-board",
      slug: "main",
      title: "Team Board",
      published: true,
      layout: [
        { type: "hero", title: "Team Board", subtitle: "Shared notes and tasks for the whole team. Add an item below — it appears here instantly, for everyone." },
        { type: "stats", items: [
          { label: "Board items", countKey: "team-board:note" },
          { label: "Modules live", countKey: "modules:installed" }
        ]},
        { type: "form", id: "team-add", title: "Add to the board",
          fields: [
            { name: "title", label: "Title", required: true, placeholder: "e.g. Call the supplier" },
            { name: "body", label: "Details", type: "textarea", placeholder: "Anything the team should know" }
          ],
          submitLabel: "Add item",
          action: { type: "create-record", module_slug: "team-board", kind: "note", successMessage: "Added to the board." } },
        { type: "list", id: "team-list", title: "On the board",
          source: { module_slug: "team-board", kind: "note" },
          titleField: "title", bodyField: "body", emptyText: "Nothing on the board yet." }
      ]
    },
    {
      module_slug: "mini-shop",
      slug: "main",
      title: "Mini Shop",
      published: true,
      layout: [
        { type: "hero", title: "Mini Shop", subtitle: "A working store made of records. Pick a product and place an order." },
        { type: "cards", id: "products", title: "Products",
          source: { module_slug: "mini-shop", kind: "product" },
          titleField: "name", bodyField: "description", metaField: "priceLabel",
          cardAction: { label: "Order",
            action: { type: "create-record-from-source", module_slug: "mini-shop", kind: "order",
                      payloadTemplate: { product: "{{name}}", price: "{{priceLabel}}" },
                      successMessage: "Order placed — see it under Your orders." } } },
        { type: "list", id: "orders", title: "Your orders",
          source: { module_slug: "mini-shop", kind: "order" },
          titleField: "product", bodyField: "price", emptyText: "No orders yet." }
      ]
    },
    {
      module_slug: "agent-floor",
      slug: "main",
      title: "Agent Floor",
      published: true,
      layout: [
        { type: "hero", title: "Agent Floor", subtitle: "Agents ready to work, open jobs, and bids — all live records." },
        { type: "stats", items: [
          { label: "Agents online", countKey: "agent-floor:agent" },
          { label: "Open jobs", countKey: "agent-floor:job" },
          { label: "Bids placed", countKey: "agent-floor:bid" }
        ]},
        { type: "form", id: "job-post", title: "Post a job",
          fields: [
            { name: "title", label: "Job title", required: true, placeholder: "e.g. Research five suppliers" },
            { name: "budget", label: "Budget (USD)", type: "number", placeholder: "100" }
          ],
          submitLabel: "Post job",
          action: { type: "create-record", module_slug: "agent-floor", kind: "job", successMessage: "Job posted to the floor." } },
        { type: "list", id: "jobs", title: "Open jobs",
          source: { module_slug: "agent-floor", kind: "job" },
          titleField: "title", bodyField: "budgetLabel",
          itemAction: { label: "Bid",
            action: { type: "create-record-for-item", module_slug: "agent-floor", kind: "bid",
                      fields: [
                        { name: "amount", label: "Your bid (USD)", type: "number", required: true },
                        { name: "message", label: "Message", placeholder: "Why you are right for this job" }
                      ],
                      payloadTemplate: { job: "{{title}}" },
                      successMessage: "Bid placed." } },
          emptyText: "No open jobs." },
        { type: "list", id: "agents", title: "Agents",
          source: { module_slug: "agent-floor", kind: "agent" },
          titleField: "name", bodyField: "skills", emptyText: "No agents yet." },
        { type: "list", id: "bids", title: "Bids",
          source: { module_slug: "agent-floor", kind: "bid" },
          titleField: "job", bodyField: "amountLabel", emptyText: "No bids yet." }
      ]
    }
  ],
  records: [
    { module_slug: "team-board", kind: "note", payload: { title: "Welcome to the board", body: "This note is a record in the database. Add yours below." } },
    { module_slug: "team-board", kind: "note", payload: { title: "Launch checklist", body: "Shell, kernel and three proof modules — all live." } },
    { module_slug: "mini-shop", kind: "product", payload: { name: "Nova Mug", description: "White mug with the Nova mark.", price: 12, priceLabel: "$12" } },
    { module_slug: "mini-shop", kind: "product", payload: { name: "Nova Tee", description: "Soft cotton tee, black tile logo.", price: 24, priceLabel: "$24" } },
    { module_slug: "mini-shop", kind: "product", payload: { name: "Nova Notebook", description: "Pocket notebook for big ideas.", price: 9, priceLabel: "$9" } },
    { module_slug: "agent-floor", kind: "agent", payload: { name: "Scout", skills: "Research and sourcing", status: "online" } },
    { module_slug: "agent-floor", kind: "agent", payload: { name: "Scribe", skills: "Writing and documentation", status: "online" } },
    { module_slug: "agent-floor", kind: "agent", payload: { name: "Atlas", skills: "Data and mapping", status: "busy" } },
    { module_slug: "agent-floor", kind: "job", payload: { title: "Design a landing page", budget: 150, budgetLabel: "Budget $150" } }
  ]
};
