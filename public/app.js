// Factory dashboard. No build step: plain ES modules, server-provided JSON, live via SSE.

const STATUS_ORDER = ["reviewing", "building", "planned", "specced", "idea", "done"];
const SESSION_LABEL = { needs_you: "Needs you", your_turn: "Your turn", working: "Working", ended: "Ended" };
const SESSION_RANK = { needs_you: 0, your_turn: 1, working: 2, ended: 3 };
const STALE_MS = 20 * 60_000; // "working" with no hook event for this long is probably gone
const INBOX_TURN_MS = 48 * 3600_000; // "your turn" sessions older than this drop out of the inbox

const icons = {
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5l7 7-7 7"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6M12 19h8"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
  branch: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 5-12 3-12 7.6"/></svg>',
};

const TABS = [
  { id: "next", label: "Next", icon: icons.next },
  { id: "inbox", label: "Inbox", icon: icons.inbox },
  { id: "projects", label: "Projects", icon: icons.projects },
  { id: "sessions", label: "Sessions", icon: icons.sessions },
];

let state = { projects: [], sessions: [], jobs: [], next: [], now: new Date().toISOString() };
let featureFilter = "all";
const expandedDone = new Set();

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const isStale = (s) => s.status === "working" && Date.now() - new Date(s.updated_at).getTime() > STALE_MS;
const statusClass = (st) => (STATUS_ORDER.includes(st) ? `st-${st}` : "st-other");
const basename = (p) => (p ? p.replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop() : "");

function projectBySlug(slug) {
  return state.projects.find((p) => p.slug === slug);
}

function liveSessions() {
  return state.sessions.filter((s) => s.status !== "ended" && !isStale(s));
}

function inboxSessions() {
  const now = Date.now();
  return liveSessions()
    .filter((s) => s.status !== "your_turn" || now - new Date(s.status_since ?? s.updated_at).getTime() < INBOX_TURN_MS)
    .sort((a, b) => SESSION_RANK[a.status] - SESSION_RANK[b.status] || b.updated_at.localeCompare(a.updated_at));
}

function attentionCount() {
  return inboxSessions().filter((s) => s.status === "needs_you" || s.status === "your_turn").length;
}

// Most urgent live session for a feature, for the dot next to it.
function featureSession(projectSlug, featureSlug) {
  return liveSessions()
    .filter((s) => s.project === projectSlug && s.feature === featureSlug)
    .sort((a, b) => SESSION_RANK[a.status] - SESSION_RANK[b.status])[0];
}

// ---------- routing ----------
// #/<tab>[/<project>][/doc/<project>[/<feature>]]
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const docAt = parts.indexOf("doc");
  const base = docAt >= 0 ? parts.slice(0, docAt) : parts;
  const doc = docAt >= 0 ? { project: parts[docAt + 1], feature: parts[docAt + 2] } : null;
  const tab = TABS.some((t) => t.id === base[0]) ? base[0] : "next";
  return { tab, project: tab === "projects" ? base[1] : undefined, doc };
}

function baseHash(r = parseRoute()) {
  return `#/${r.tab}${r.project ? `/${encodeURIComponent(r.project)}` : ""}`;
}

function docHash(project, feature) {
  const enc = encodeURIComponent;
  return `${baseHash()}/doc/${enc(project)}${feature ? `/${enc(feature)}` : ""}`;
}

// ---------- rendering ----------
function renderNav() {
  const r = parseRoute();
  const n = attentionCount();
  const counts = { projects: state.projects.length, sessions: state.sessions.length };
  const badge = (id) => (id === "inbox" && n ? `<span class="badge">${n}</span>` : "");
  $("#tabbar").innerHTML = TABS.map(
    (t) => `<a class="tab" href="#/${t.id}" ${r.tab === t.id ? 'aria-current="page"' : ""}>${t.icon}${badge(t.id)}<span>${t.label}</span></a>`,
  ).join("");
  $("#side-nav").innerHTML = TABS.map(
    (t) =>
      `<a class="side-link" href="#/${t.id}" ${r.tab === t.id && !r.project ? 'aria-current="page"' : ""}>${t.icon}${t.label}${
        badge(t.id) || (counts[t.id] ? `<span class="count">${counts[t.id]}</span>` : "")
      }</a>`,
  ).join("");
  $("#side-projects").innerHTML = state.projects
    .map((p) => {
      const live = liveSessions().filter((s) => s.project === p.slug).sort((a, b) => SESSION_RANK[a.status] - SESSION_RANK[b.status])[0];
      return `<a class="side-link" href="#/projects/${encodeURIComponent(p.slug)}" ${r.project === p.slug ? 'aria-current="page"' : ""}>
        <span class="status-dot ${statusClass(p.status === "active" ? "building" : p.status)}"></span>${esc(p.name)}
        ${live ? `<span class="live-dot ${live.status}" style="margin-left:auto" title="${SESSION_LABEL[live.status]}"></span>` : ""}</a>`;
    })
    .join("");
  document.title = n ? `(${n}) Factory` : "Factory";
}

function sessionCard(s, { compact = false } = {}) {
  const p = projectBySlug(s.project);
  const f = p?.features.find((x) => x.slug === s.feature);
  const stale = isStale(s);
  const kicker = p ? esc(p.name) : "Not linked to a project";
  const title = f ? esc(f.title) : p ? "General work" : esc(basename(s.repo) || basename(s.cwd) || "Session");
  const label = stale ? "No signal" : SESSION_LABEL[s.status];
  const docLink = p ? docHash(p.slug, f?.slug) : null;
  return `<article class="card session st-${s.status}">
    <div class="session-head">
      <span class="kicker">${kicker}</span>
      <span class="pill ${stale ? "stale" : s.status}">${label}</span>
      <span class="time" title="${esc(new Date(s.updated_at).toLocaleString())}">${ago(s.updated_at)}</span>
    </div>
    <h3 class="session-title">${docLink ? `<a href="${docLink}">${title}</a>` : title}</h3>
    ${s.message && !compact ? `<p class="msg">${esc(s.message)}</p>` : ""}
    ${s.prompt ? `<p class="prompt"><b>You:</b> ${esc(s.prompt)}</p>` : ""}
    <div class="meta">
      ${s.branch ? `<span class="tag">${icons.branch}${esc(s.branch)}</span>` : ""}
      ${s.host ? `<span class="tag">${esc(s.host)}</span>` : ""}
    </div>
    <div class="actions">
      ${s.url ? `<a class="btn primary" href="${esc(s.url)}" target="_blank" rel="noopener" data-seen="${esc(s.id)}">Open session ${icons.open}</a>` : ""}
      <button class="btn" data-dismiss="${esc(s.id)}" aria-label="Dismiss session" title="Dismiss">${icons.x}${s.url ? "" : " Dismiss"}</button>
    </div>
  </article>`;
}

function empty(title, body) {
  return `<div class="empty">${icons.check}<h3>${title}</h3><p>${body}</p></div>`;
}

// Which factory command each kind maps to. Same mapping /factory next uses, so the dashboard
// and the command agree about what "Build" means. Session kinds are absent on purpose: no
// command can answer a session for you.
const KIND_COMMAND = { approve: "build", unstick: "build", build: "build", plan: "plan", spec: "spec" };

function jobFor(projectSlug, featureSlug) {
  return (state.jobs ?? []).find((j) => j.project === projectSlug && j.feature === featureSlug);
}

const JOB_LABEL = { queued: "Queued", claimed: "Starting", running: "Started", failed: "Failed", done: "Done" };

// The button that queues work, or the state of the job already queued for it.
function startControl(item, { primary = false } = {}) {
  const command = KIND_COMMAND[item.kind];
  if (!command || !item.feature || item.blocked) return "";
  const job = jobFor(item.projectSlug, item.feature);
  if (job && job.status !== "done") {
    const label = JOB_LABEL[job.status] ?? job.status;
    return job.status === "failed"
      ? `<span class="pill needs_you" title="${esc(job.error ?? "")}">${label}</span>`
      : `<span class="pill working">${label}</span>`;
  }
  return `<button class="btn ${primary ? "primary" : ""}" data-start="${esc(item.projectSlug)}/${esc(item.feature)}/${esc(command)}">${esc(item.action)} it</button>`;
}

// One recommendation, a few alternatives. Everything here is a thing you could start now.
function renderNext() {
  const items = state.next ?? [];
  const live = items.filter((i) => !i.blocked);
  const blocked = items.filter((i) => i.blocked);
  if (!live.length && !blocked.length)
    return empty("Nothing waiting", "No sessions need you and no feature is ready to move. Add an idea with <code>/factory spec</code>.");

  const [top, ...rest] = live;
  const link = (i) => (i.projectSlug ? docHash(i.projectSlug, i.feature ?? undefined) : null);

  const hero = top
    ? `<article class="card hero k-${esc(top.kind)}">
        <div class="hero-kicker">${esc(top.project)}${top.feature ? ` <span class="sep">›</span> ${esc(top.feature.slice(0, 3))}` : ""}</div>
        <h2 class="hero-title">${esc(top.action)} ${esc(top.title)}</h2>
        <p class="hero-why">${esc(top.reason)}</p>
        <div class="actions">
          ${top.url ? `<a class="btn primary" href="${esc(top.url)}" target="_blank" rel="noopener" data-seen="${esc(top.sessionId)}">Open session ${icons.open}</a>` : ""}
          ${startControl(top, { primary: !top.url })}
          ${link(top) ? `<a class="btn" href="${link(top)}">Open spec</a>` : ""}
          ${!top.url && !link(top) ? `<a class="btn primary" href="#/inbox">See in inbox</a>` : ""}
        </div>
      </article>`
    : "";

  const row = (i) =>
    `<li><a class="nextrow" href="${link(i) ?? "#/inbox"}">
      <span class="dot k-${esc(i.kind)}"></span>
      <span class="nextmain"><b>${esc(i.action)}</b> ${esc(i.title)}</span>
      <span class="nextwhy">${esc(i.project)} · ${esc(i.reason)}</span>
    </a>${startControl(i) ? `<div class="rowaction">${startControl(i)}</div>` : ""}</li>`;

  const alts = rest.slice(0, 4);
  return `${hero}
    ${alts.length ? `<div class="section"><h2>Then</h2></div><ul class="nextlist">${alts.map(row).join("")}</ul>` : ""}
    ${blocked.length ? `<div class="section"><h2>Blocked</h2><span class="n">${blocked.length}</span></div><ul class="nextlist blocked">${blocked.slice(0, 4).map(row).join("")}</ul>` : ""}`;
}

function renderInbox() {
  const list = inboxSessions();
  const by = (st) => list.filter((s) => s.status === st);
  const groups = [
    ["needs_you", "Needs you"],
    ["your_turn", "Your turn"],
    ["working", "Working"],
  ];
  const counts = groups.map(([st, label]) => [st, label, by(st).length]);
  const chips = counts
    .map(([st, label, n]) => `<span class="chip"><span class="dot" style="background:var(--${st === "needs_you" ? "needs" : st === "your_turn" ? "turn" : "working"})"></span>${n} ${label.toLowerCase()}</span>`)
    .join("");
  const building = state.projects.flatMap((p) => p.features.filter((f) => f.status === "building")).length;
  let html = `<div class="summary narrow">${chips}<span class="chip"><span class="dot st-building"></span>${building} building</span></div>`;
  if (!list.length) {
    html += state.sessions.length
      ? empty("All quiet", "No session is waiting on you right now.")
      : empty("No sessions yet", "Install the hooks in a repo (<code>npm run install-hooks</code>) and start Claude there. It will show up here.");
  }
  for (const [st, label] of groups) {
    const items = by(st);
    if (!items.length) continue;
    html += `<div class="section"><h2>${label}</h2><span class="n">${items.length}</span></div>
      <div class="stack narrow">${items.map((s) => sessionCard(s, { compact: st === "working" && !s.message })).join("")}</div>`;
  }
  return html;
}

function progressBar(features) {
  if (!features.length) return "";
  const total = features.length;
  const segs = STATUS_ORDER.slice()
    .reverse()
    .map((st) => [st, features.filter((f) => f.status === st).length])
    .filter(([, n]) => n);
  return `<div class="progress" role="img" aria-label="${segs.map(([st, n]) => `${n} ${st}`).join(", ")}">
    ${segs.map(([st, n]) => `<span class="st-${st}" style="flex:${n}"></span>`).join("")}</div>
    <div class="legend">${segs.map(([st, n]) => `<span><i class="st-${st}"></i>${n} ${st}</span>`).join("")}<span style="margin-left:auto">${Math.round((features.filter((f) => f.status === "done").length / total) * 100)}% done</span></div>`;
}

function featureRow(p, f) {
  const live = featureSession(p.slug, f.slug);
  return `<li><button class="feature ${f.status === "done" ? "done" : ""}" data-doc="${esc(p.slug)}/${esc(f.slug)}">
    <span class="status-dot ${statusClass(f.status)}" title="${esc(f.status)}"></span>
    <span class="ftitle"><span class="fid">${esc(f.id)}</span> ${esc(f.title)}</span>
    <span class="fstatus">${live ? `<span class="live-dot ${live.status}" title="${SESSION_LABEL[live.status]}"></span>` : ""}${esc(f.status)}</span>
  </button></li>`;
}

function projectCard(p, { showAllDone = false } = {}) {
  const rank = (f) => (STATUS_ORDER.includes(f.status) ? STATUS_ORDER.indexOf(f.status) : 2.5);
  let features = p.features.slice().sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  if (featureFilter !== "all") features = features.filter((f) => f.status === featureFilter);
  const open = features.filter((f) => f.status !== "done" || featureFilter === "done");
  const done = featureFilter === "done" ? [] : features.filter((f) => f.status === "done");
  const showDone = showAllDone || expandedDone.has(p.slug);
  if (featureFilter !== "all" && !features.length) return "";
  return `<article class="card project">
    <div class="project-head"><div>
      <h3><button data-doc="${esc(p.slug)}">${esc(p.name)}</button></h3>
      ${p.summary ? `<p class="summary-text">${esc(p.summary)}</p>` : ""}
    </div><span class="pill neutral">${esc(p.status)}</span></div>
    ${progressBar(p.features)}
    <ul class="features">
      ${open.map((f) => featureRow(p, f)).join("")}
      ${showDone ? done.map((f) => featureRow(p, f)).join("") : ""}
    </ul>
    ${done.length && !showAllDone ? `<button class="more" data-toggle-done="${esc(p.slug)}">${showDone ? "Hide done" : `Show ${done.length} done`}</button>` : ""}
    ${!p.features.length ? `<p class="prompt">No features yet. Run <code>/factory spec</code> in Claude.</p>` : ""}
  </article>`;
}

function renderProjects(focus) {
  const all = state.projects.flatMap((p) => p.features);
  const filters = ["all", ...STATUS_ORDER].flatMap((st) => {
    const n = st === "all" ? all.length : all.filter((f) => f.status === st).length;
    if (!n && st !== featureFilter && st !== "all") return [];
    return `<button class="filter" data-filter="${st}" aria-pressed="${featureFilter === st}">${st === "all" ? "All" : st[0].toUpperCase() + st.slice(1)} ${n}</button>`;
  });
  if (!state.projects.length)
    return empty("No projects yet", "Run <code>/factory project</code> in Claude inside this repo, then push.");
  if (focus) {
    const p = projectBySlug(focus);
    if (!p) return empty("Project not found", `No project called ${esc(focus)}.`);
    const sessions = state.sessions.filter((s) => s.project === p.slug);
    return `<div class="filters">${filters.join("")}</div>
      <div class="grid">${projectCard(p, { showAllDone: true }) || empty("Nothing here", "No features with that status.")}</div>
      ${sessions.length ? `<div class="section"><h2>Sessions</h2><span class="n">${sessions.length}</span></div><div class="stack wide">${sessions.map((s) => sessionCard(s)).join("")}</div>` : ""}`;
  }
  const cards = state.projects.map((p) => projectCard(p)).filter(Boolean);
  return `<div class="filters">${filters.join("")}</div>
    <div class="grid cols">${cards.join("") || empty("Nothing here", "No features with that status.")}</div>`;
}

function renderSessions() {
  if (!state.sessions.length)
    return empty("No sessions yet", "Sessions show up here once a repo has the Factory hooks installed.");
  const sorted = state.sessions.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const live = sorted.filter((s) => s.status !== "ended" && !isStale(s));
  const rest = sorted.filter((s) => !live.includes(s));
  let html = "";
  if (live.length) html += `<div class="section"><h2>Active</h2><span class="n">${live.length}</span></div><div class="stack wide">${live.map((s) => sessionCard(s)).join("")}</div>`;
  if (rest.length) html += `<div class="section"><h2>Recent</h2><span class="n">${rest.length}</span></div><div class="stack wide">${rest.map((s) => sessionCard(s, { compact: true })).join("")}</div>`;
  return html;
}

function render() {
  const r = parseRoute();
  renderNav();
  const titles = { next: "Next", inbox: "Inbox", projects: r.project ? projectBySlug(r.project)?.name ?? "Project" : "Projects", sessions: "Sessions" };
  $("#title").textContent = titles[r.tab];
  const view = $("#view");
  view.innerHTML =
    r.tab === "projects" ? renderProjects(r.project)
    : r.tab === "sessions" ? renderSessions()
    : r.tab === "inbox" ? renderInbox()
    : renderNext();
  syncSheet(r);
}

// ---------- detail sheet ----------
let sheetKey = null;
let openedByUs = false;

async function syncSheet(r) {
  const sheet = $("#sheet");
  const key = r.doc ? `${r.doc.project}/${r.doc.feature ?? ""}` : null;
  if (!key) {
    if (sheetKey) closeSheetUi();
    return;
  }
  const p = projectBySlug(r.doc.project);
  const f = p?.features.find((x) => x.slug === r.doc.feature);
  $("#sheet-title").textContent = f ? f.title : p?.name ?? r.doc.project;
  const sub = [];
  if (f) {
    sub.push(`<span class="fstatus"><span class="status-dot ${statusClass(f.status)}"></span>${esc(f.status)}</span>`);
    if (p) sub.push(`<a href="#/projects/${encodeURIComponent(p.slug)}">${esc(p.name)}</a>`);
    if (f.priority) sub.push(`<span>priority ${esc(f.priority)}</span>`);
  } else if (p) {
    sub.push(`<span>${p.features.length} features</span>`);
    if (p.repoUrl) sub.push(`<span class="tag">${esc(p.repoUrl)}</span>`);
  }
  $("#sheet-sub").innerHTML = sub.join("");

  const related = state.sessions.filter((s) => s.project === r.doc.project && (!r.doc.feature || s.feature === r.doc.feature));
  const sessionsHtml = related.length
    ? `<div class="stack" style="margin-bottom:20px">${related.map((s) => sessionCard(s, { compact: s.status === "ended" })).join("")}</div>`
    : "";

  if (key !== sheetKey) {
    sheetKey = key;
    $("#sheet-body").innerHTML = `${sessionsHtml}<div class="prose" aria-busy="true"><p style="color:var(--text-3)">Loading…</p></div>`;
    sheet.hidden = false;
    requestAnimationFrame(() => {
      sheet.classList.add("open");
      $("#scrim").classList.add("open");
    });
    document.body.style.overflow = "hidden";
    const res = await fetch(`/api/docs/${encodeURIComponent(r.doc.project)}${r.doc.feature ? `/${encodeURIComponent(r.doc.feature)}` : ""}`);
    if (sheetKey !== key) return;
    const prose = $("#sheet-body .prose");
    prose.removeAttribute("aria-busy");
    prose.innerHTML = res.ok ? (await res.json()).html : "<p>This spec could not be loaded.</p>";
    $("#sheet-close").focus({ preventScroll: true });
  } else {
    // Live refresh: keep the spec, update the session cards above it.
    const body = $("#sheet-body");
    body.querySelector(".stack")?.remove();
    body.insertAdjacentHTML("afterbegin", sessionsHtml);
  }
}

function closeSheetUi() {
  sheetKey = null;
  const sheet = $("#sheet");
  sheet.classList.remove("open");
  $("#scrim").classList.remove("open");
  document.body.style.overflow = "";
  setTimeout(() => !sheetKey && (sheet.hidden = true), 300);
}

function closeSheet() {
  if (openedByUs) {
    openedByUs = false;
    history.back();
  } else {
    location.hash = baseHash();
  }
}

function openDoc(project, feature) {
  openedByUs = true;
  location.hash = docHash(project, feature);
}

// Swipe the sheet down to close it (mobile).
function enableSwipe() {
  const sheet = $("#sheet");
  let startY = null;
  let dy = 0;
  sheet.addEventListener("touchstart", (e) => {
    const body = $("#sheet-body");
    if (window.innerWidth >= 900 || (body.contains(e.target) && body.scrollTop > 0)) return;
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener("touchend", () => {
    if (startY === null) return;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (dy > 110) closeSheet();
    startY = null;
  });
}

// ---------- data ----------
let loading = null;
async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.status === 401) return void (location.href = "/login");
      if (res.ok) {
        state = await res.json();
        render();
      }
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function setLive(on) {
  for (const el of [$("#live"), $("#live-side")]) {
    el.classList.toggle("on", on);
    el.textContent = on ? "Live" : "Offline";
  }
}

function connect() {
  const es = new EventSource("/api/stream");
  let t;
  es.addEventListener("hello", () => {
    setLive(true);
    load();
  });
  es.addEventListener("change", () => {
    clearTimeout(t);
    t = setTimeout(load, 150);
  });
  es.onerror = () => setLive(false);
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  // Opening a session is acting on it, so the notification clears itself. Any later status
  // change on that session brings it back; a repeated idle nudge does not.
  const start = e.target.closest("[data-start]");
  if (start) {
    const [project, feature, command] = start.dataset.start.split("/");
    start.disabled = true;
    start.textContent = "Starting…";
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, feature, command }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "could not queue" }));
      start.textContent = esc(error ?? "failed");
    }
    load();
    return;
  }
  const seen = e.target.closest("[data-seen]");
  if (seen) {
    fetch(`/api/sessions/${encodeURIComponent(seen.dataset.seen)}/dismiss`, { method: "POST" }).then(load);
    return;
  }
  const t = e.target.closest("[data-doc],[data-dismiss],[data-filter],[data-toggle-done]");
  if (!t) return;
  if (t.dataset.doc) {
    const [project, feature] = t.dataset.doc.split("/");
    openDoc(project, feature);
  } else if (t.dataset.dismiss) {
    t.disabled = true;
    await fetch(`/api/sessions/${encodeURIComponent(t.dataset.dismiss)}/dismiss`, { method: "POST" });
    load();
  } else if (t.dataset.filter) {
    featureFilter = t.dataset.filter;
    render();
  } else if (t.dataset.toggleDone) {
    const slug = t.dataset.toggleDone;
    expandedDone.has(slug) ? expandedDone.delete(slug) : expandedDone.add(slug);
    render();
  }
});

$("#sheet-close").addEventListener("click", closeSheet);
$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => e.key === "Escape" && sheetKey && closeSheet());

$("#sync").addEventListener("click", async () => {
  const btn = $("#sync");
  btn.classList.add("spin");
  try {
    await fetch("/api/specs/sync", { method: "POST" });
    await load();
  } finally {
    btn.classList.remove("spin");
  }
});

let lastBase = baseHash();
window.addEventListener("hashchange", () => {
  const r = parseRoute();
  if (!r.doc) openedByUs = false;
  render();
  // Only jump to the top when switching views, not when a sheet opens or closes.
  if (baseHash(r) !== lastBase) window.scrollTo({ top: 0 });
  lastBase = baseHash(r);
});
window.addEventListener("scroll", () => $("#topbar").classList.toggle("scrolled", scrollY > 4), { passive: true });
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
setInterval(() => document.visibilityState === "visible" && render(), 30_000); // refresh "5m ago"
setInterval(() => document.visibilityState === "visible" && load(), 60_000); // safety net if SSE drops

enableSwipe();
render();
load();
connect();
