// Nova LiveOS local fixture data — v1.0.2
// This mirrors supabase/seed.sql. In local mode (no Supabase configured) the
// shell runs entirely from this fixture, stored in localStorage so installs,
// records, automations and live-change simulations persist across reloads.

const KANBAN_COLS = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" }
];

export const SEED = {
  version: "1.0.0",
  defaultInstalled: ["team-board", "chat"],
  modules: [
    {
      slug: "team-board",
      name: "Team Board",
      version: "1.0.0",
      description: "The team kanban board. Work moves from To do to Done — drag a card, or use its arrows, and every shell sees it move live.",
      icon: "board",
      manifest: { route: "team-board", category: "Collaborate", icon: "board" },
      bundle_url: null,
      published: true
    },
    {
      slug: "chat",
      name: "Team Chat",
      version: "1.0.0",
      description: "One live room for the whole team. Messages are records; they appear in every open shell the moment they are sent.",
      icon: "chat",
      manifest: { route: "chat", category: "Collaborate", icon: "chat" },
      bundle_url: null,
      published: true
    },
    {
      slug: "mini-shop",
      name: "Mini Shop",
      version: "1.0.0",
      description: "A working store made of records. Add products to a cart, check out, and the order lands in the shared order history.",
      icon: "shop",
      manifest: { route: "mini-shop", category: "Commerce", icon: "shop" },
      bundle_url: null,
      published: true
    },
    {
      slug: "agent-floor",
      name: "Agent Floor",
      version: "1.0.0",
      description: "Agents, open jobs and bids — humans and AI agents in one live workspace. Post a job; bids arrive live with counts.",
      icon: "briefcase",
      manifest: { route: "agent-floor", category: "Agents", icon: "briefcase" },
      bundle_url: null,
      published: true
    },
    {
      slug: "analytics",
      name: "Analytics",
      version: "1.0.0",
      description: "The whole workspace at a glance. Charts are computed live from records across every module — no separate reporting store.",
      icon: "chart-bar",
      manifest: { route: "analytics", category: "Insights", icon: "chart-bar" },
      bundle_url: null,
      published: true
    },
    {
      slug: "contacts",
      name: "Contacts CRM",
      version: "1.0.0",
      description: "A small, honest CRM. Add contacts, sort the table, and move people through the pipeline on the board.",
      icon: "address-book",
      manifest: { route: "contacts", category: "Business", icon: "address-book" },
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
        { type: "hero", icon: "board", title: "Team Board", subtitle: "Shared work, kept in the open. Every card is a record in the database — move one and every installed copy moves with it.", caption: "The team kanban: what we owe, what we are doing, what is done." },
        { type: "stats", items: [
          { label: "Tasks", countKey: "team-board:task" },
          { label: "Modules live", countKey: "modules:installed" },
          { label: "Records in workspace", countKey: "records:total" }
        ]},
        { type: "form", id: "task-add", title: "Add a task", caption: "New tasks start in To do. Give it a title and enough detail to act on.",
          fields: [
            { name: "title", label: "Title", required: true, placeholder: "e.g. Call the supplier" },
            { name: "body", label: "Details", type: "textarea", placeholder: "Anything the team should know" },
            { name: "status", label: "Start in", type: "select", options: [
              { value: "todo", label: "To do" }, { value: "doing", label: "Doing" }, { value: "done", label: "Done" }
            ]}
          ],
          submitLabel: "Add task",
          action: { type: "create-record", module_slug: "team-board", kind: "task", successMessage: "Task added to the board." } },
        { type: "kanban", id: "board", title: "The board", caption: "Drag a card between columns, or use the arrows on the card. Changes save and broadcast instantly.",
          source: { module_slug: "team-board", kind: "task" },
          statusField: "status", titleField: "title", bodyField: "body", columns: KANBAN_COLS },
        { type: "embed-note", title: "How the board stays live", markdown: "Cards are rows in the **records** table. An edit here is a database write; Realtime (with a polling fallback) re-renders every other shell — no reload, no redeploy." }
      ]
    },
    {
      module_slug: "chat",
      slug: "main",
      title: "Team Chat",
      published: true,
      layout: [
        { type: "hero", icon: "chat", title: "Team Chat", subtitle: "One room, everybody in it. Say something and it appears in every open shell immediately.", caption: "The team room: quick questions, decisions and shout-outs." },
        { type: "stats", items: [
          { label: "Messages", countKey: "chat:message" },
          { label: "Modules live", countKey: "modules:installed" }
        ]},
        { type: "list", id: "messages", title: "Conversation", caption: "Newest messages join at the bottom, live.",
          source: { module_slug: "chat", kind: "message" },
          titleField: "author", bodyField: "text", emptyText: "No messages yet — say the first hello below." },
        { type: "form", id: "chat-send", title: "Send a message", caption: "Messages are signed with your profile name, or your anonymous shell name when signed out.",
          fields: [
            { name: "text", label: "Message", required: true, placeholder: "Type a message for the team" }
          ],
          submitLabel: "Send",
          action: { type: "create-record", module_slug: "chat", kind: "message", withAuthor: true, successMessage: "Message sent." } }
      ]
    },
    {
      module_slug: "mini-shop",
      slug: "main",
      title: "Mini Shop",
      published: true,
      layout: [
        { type: "hero", icon: "shop", title: "Mini Shop", subtitle: "A working store made entirely of records. Add products to your cart; checkout writes a real order into the shared history.", caption: "The store: browse, fill a cart, check out." },
        { type: "stats", items: [
          { label: "Products", countKey: "mini-shop:product" },
          { label: "Orders placed", countKey: "mini-shop:order" }
        ]},
        { type: "cards", id: "products", title: "Products", caption: "Each product is a record. Adding to the cart is instant; the order is written at checkout.",
          source: { module_slug: "mini-shop", kind: "product" },
          titleField: "name", bodyField: "description", metaField: "priceLabel",
          cardAction: { label: "Add to cart",
            action: { type: "add-to-cart", module_slug: "mini-shop", kind: "order",
                      payloadTemplate: { product: "{{name}}", price: "{{price}}" },
                      successMessage: "Added to your cart." } } },
        { type: "cart", id: "cart", title: "Your cart", caption: "Review quantities, then check out — the order appears in the history below and in Analytics." },
        { type: "list", id: "orders", title: "Order history", caption: "Every completed checkout, newest last, shared by the whole workspace.",
          source: { module_slug: "mini-shop", kind: "order" },
          titleField: "summary", bodyField: "statusLabel", metaField: "totalLabel", emptyText: "No orders yet — your first checkout will appear here." }
      ]
    },
    {
      module_slug: "agent-floor",
      slug: "main",
      title: "Agent Floor",
      published: true,
      layout: [
        { type: "hero", icon: "briefcase", title: "Agent Floor", subtitle: "Agents ready to work, open jobs, and live bids — humans and AI agents in one workspace.", caption: "The floor: who can work, what needs doing, who has bid." },
        { type: "stats", items: [
          { label: "Agents online", countKey: "agent-floor:agent" },
          { label: "Open jobs", countKey: "agent-floor:job" },
          { label: "Bids placed", countKey: "agent-floor:bid" }
        ]},
        { type: "form", id: "job-post", title: "Post a job", caption: "Describe the work and the budget. Agents bid below; the count updates live.",
          fields: [
            { name: "title", label: "Job title", required: true, placeholder: "e.g. Research five suppliers" },
            { name: "budget", label: "Budget (USD)", type: "number", placeholder: "100" }
          ],
          submitLabel: "Post job",
          action: { type: "create-record", module_slug: "agent-floor", kind: "job", successMessage: "Job posted to the floor." } },
        { type: "list", id: "jobs", title: "Open jobs", caption: "Bid on any job — bids are records, counted next to each job.",
          source: { module_slug: "agent-floor", kind: "job" },
          titleField: "title", bodyField: "budgetLabel", metaField: "bidCountLabel",
          itemAction: { label: "Bid",
            action: { type: "create-record-for-item", module_slug: "agent-floor", kind: "bid",
                      fields: [
                        { name: "amount", label: "Your bid (USD)", type: "number", required: true },
                        { name: "message", label: "Message", placeholder: "Why you are right for this job" }
                      ],
                      payloadTemplate: { job: "{{title}}" },
                      successMessage: "Bid placed." } },
          emptyText: "No open jobs — post the first one above." },
        { type: "list", id: "agents", title: "Agents", caption: "Registered agents and what they do.",
          source: { module_slug: "agent-floor", kind: "agent" },
          titleField: "name", bodyField: "skills", metaField: "status", emptyText: "No agents yet." },
        { type: "list", id: "bids", title: "Bids", caption: "Every bid placed, in order.",
          source: { module_slug: "agent-floor", kind: "bid" },
          titleField: "job", bodyField: "amountLabel", emptyText: "No bids yet." }
      ]
    },
    {
      module_slug: "analytics",
      slug: "main",
      title: "Analytics",
      published: true,
      layout: [
        { type: "hero", icon: "chart-bar", title: "Analytics", subtitle: "The workspace, measured honestly. Every number here is computed from live records the moment this screen renders.", caption: "The dashboard: records, revenue and rhythm across all modules." },
        { type: "stats", items: [
          { label: "Total records", countKey: "records:total" },
          { label: "Orders", countKey: "mini-shop:order" },
          { label: "Messages", countKey: "chat:message" },
          { label: "Contacts", countKey: "contacts:contact" }
        ]},
        { type: "chart", id: "by-module", title: "Records by module", caption: "Where the workspace is busiest, across every module.",
          chart: "bar", groupBy: "module_slug", value: "count" },
        { type: "chart", id: "revenue", title: "Order revenue by product line", caption: "Summed order totals grouped by the order summary line.",
          chart: "bar", source: { module_slug: "mini-shop", kind: "order" }, groupBy: "payload.summary", value: "sum:payload.total" },
        { type: "chart", id: "rhythm", title: "Activity by day", caption: "Records created per day — the rhythm of the workspace.",
          chart: "line", groupBy: "day", value: "count" },
        { type: "list", id: "activity", title: "Activity stream", caption: "What the automation engine and the team have been doing, newest last.",
          source: { module_slug: "analytics", kind: "activity" },
          titleField: "text", emptyText: "Nothing yet — place an order or a bid and the engine will note it here." }
      ]
    },
    {
      module_slug: "contacts",
      slug: "main",
      title: "Contacts CRM",
      published: true,
      layout: [
        { type: "hero", icon: "address-book", title: "Contacts CRM", subtitle: "A small CRM that keeps its promises: add a person, find them in the table, move them through the pipeline.", caption: "The CRM: people, companies and where each relationship stands." },
        { type: "stats", items: [
          { label: "Contacts", countKey: "contacts:contact" },
          { label: "Modules live", countKey: "modules:installed" }
        ]},
        { type: "form", id: "contact-add", title: "Add a contact", caption: "New contacts enter the pipeline as leads unless you say otherwise.",
          fields: [
            { name: "name", label: "Full name", required: true, placeholder: "e.g. Ada Okafor" },
            { name: "company", label: "Company", placeholder: "e.g. Northwind Traders" },
            { name: "email", label: "Email", type: "email", placeholder: "name@company.com" },
            { name: "status", label: "Pipeline stage", type: "select", options: [
              { value: "lead", label: "Lead" }, { value: "contacted", label: "Contacted" }, { value: "customer", label: "Customer" }
            ]}
          ],
          submitLabel: "Add contact",
          action: { type: "create-record", module_slug: "contacts", kind: "contact", successMessage: "Contact added." } },
        { type: "table", id: "contacts-table", title: "All contacts", caption: "Click a column heading to sort. The bin removes a contact for good.",
          source: { module_slug: "contacts", kind: "contact" },
          columns: [
            { field: "name", label: "Name" }, { field: "company", label: "Company" },
            { field: "email", label: "Email" }, { field: "status", label: "Stage" }
          ],
          deletable: true, emptyText: "No contacts yet — add the first one above." },
        { type: "kanban", id: "pipeline", title: "Pipeline", caption: "Drag a contact between stages, or use the arrows on their card.",
          source: { module_slug: "contacts", kind: "contact" },
          statusField: "status", titleField: "name", bodyField: "company",
          columns: [
            { id: "lead", label: "Lead" }, { id: "contacted", label: "Contacted" }, { id: "customer", label: "Customer" }
          ]}
      ]
    }
  ],
  records: [
    { module_slug: "team-board", kind: "task", payload: { title: "Welcome to the board", body: "This card is a record in the database. Drag it to Doing and watch another shell follow.", status: "todo" } },
    { module_slug: "team-board", kind: "task", payload: { title: "Launch checklist", body: "Shell, kernel and six modules — all live.", status: "doing" } },
    { module_slug: "team-board", kind: "task", payload: { title: "Invite the team", body: "Share the install link once the shell is deployed.", status: "todo" } },
    { module_slug: "team-board", kind: "task", payload: { title: "v1.0 Advanced ships", body: "Auth, admin console, kanban, chat, analytics, CRM.", status: "done" } },
    { module_slug: "chat", kind: "message", payload: { author: "Nova", text: "Welcome to Team Chat — messages here are live records." } },
    { module_slug: "chat", kind: "message", payload: { author: "Scout", text: "Morning all. The board is up to date; two tasks are moving today." } },
    { module_slug: "mini-shop", kind: "product", payload: { name: "Nova Mug", description: "White mug with the Nova mark.", price: 12, priceLabel: "$12" } },
    { module_slug: "mini-shop", kind: "product", payload: { name: "Nova Tee", description: "Soft cotton tee, black tile logo.", price: 24, priceLabel: "$24" } },
    { module_slug: "mini-shop", kind: "product", payload: { name: "Nova Notebook", description: "Pocket notebook for big ideas.", price: 9, priceLabel: "$9" } },
    { module_slug: "agent-floor", kind: "agent", payload: { name: "Scout", skills: "Research and sourcing", status: "online" } },
    { module_slug: "agent-floor", kind: "agent", payload: { name: "Scribe", skills: "Writing and documentation", status: "online" } },
    { module_slug: "agent-floor", kind: "agent", payload: { name: "Atlas", skills: "Data and mapping", status: "busy" } },
    { module_slug: "agent-floor", kind: "job", payload: { title: "Design a landing page", budget: 150, budgetLabel: "Budget $150" } },
    { module_slug: "contacts", kind: "contact", payload: { name: "Ada Okafor", company: "Northwind Traders", email: "ada@northwind.example", status: "lead" } },
    { module_slug: "contacts", kind: "contact", payload: { name: "Marcus Reid", company: "Reid Logistics", email: "marcus@reidlogistics.example", status: "contacted" } },
    { module_slug: "contacts", kind: "contact", payload: { name: "Lena Hoffmann", company: "Hoffmann Studio", email: "lena@hoffmann.example", status: "customer" } }
  ],
  automations: [
    { slug: "welcome-on-install", name: "Welcome note on module install", trigger_event: "module.installed", enabled: true,
      action: { type: "audit", event: "automation.welcome", text: "A module was installed: {{slug}}" } },
    { slug: "order-activity", name: "Log shop orders to the activity stream", trigger_event: "record.created:order", enabled: true,
      action: { type: "create-record", module_slug: "analytics", kind: "activity", payloadTemplate: { text: "Order placed: {{summary}} — {{totalLabel}}" } } },
    { slug: "bid-activity", name: "Log agent-floor bids to the activity stream", trigger_event: "record.created:bid", enabled: true,
      action: { type: "create-record", module_slug: "analytics", kind: "activity", payloadTemplate: { text: "New bid on {{job}} — {{amountLabel}}" } } },
    { slug: "job-audit", name: "Audit new job postings", trigger_event: "record.created:job", enabled: true,
      action: { type: "audit", event: "automation.new-job", text: "New job posted: {{title}} ({{budgetLabel}})" } }
  ]
};
