/**
 * Transactra control centre.
 *
 * A single dependency-free page served by the control plane. It contains no build step and no
 * third-party runtime: the browser only talks to this control plane's `/v1` API with the owner's
 * bearer token, and every value coming back from the API is HTML-escaped before rendering.
 *
 * `__NONCE__` is replaced per request so the inline script and stylesheet can run under a strict
 * Content-Security-Policy without `'unsafe-inline'`.
 */
export const DASHBOARD_NONCE_PLACEHOLDER = "__NONCE__";

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Transactra control centre</title>
<style nonce="__NONCE__">
  :root {
    --bg: #f8fafc;
    --panel: #ffffff;
    --border: #d5dce6;
    --text: #16202e;
    --muted: #5a6478;
    --accent: #0369a1;
    --accent-soft: #e6f2fa;
    --ok: #0f7b52;
    --warn: #a15c00;
    --bad: #b42318;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  header.top {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .brand { display: flex; align-items: baseline; gap: 10px; }
  .brand h1 { font-size: 19px; margin: 0; letter-spacing: -0.2px; }
  .brand span { color: var(--muted); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
  .grow { flex: 1 1 auto; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); border-radius: 999px;
    padding: 3px 10px; font-size: 12px; color: var(--muted); background: var(--bg);
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.ok { background: var(--ok); }
  .dot.bad { background: var(--bad); }
  .dot.warn { background: var(--warn); }
  button {
    font: inherit; font-size: 13px; cursor: pointer;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
    padding: 6px 12px; border-radius: 8px;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
  button.primary:hover { background: #075985; color: #ffffff; }
  button.danger { border-color: #e3b4ae; color: var(--bad); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input, textarea {
    font: inherit; font-size: 13px; color: var(--text);
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 7px 10px; width: 100%;
  }
  input:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  nav.tabs {
    display: flex; gap: 4px; padding: 0 24px; background: var(--panel);
    border-bottom: 1px solid var(--border); overflow-x: auto;
  }
  nav.tabs button {
    border: none; background: none; border-bottom: 2px solid transparent;
    border-radius: 0; padding: 11px 12px; color: var(--muted); font-size: 13.5px; white-space: nowrap;
  }
  nav.tabs button[aria-current="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  main { padding: 22px 24px 60px; max-width: 1320px; margin: 0 auto; }
  .grid { display: grid; gap: 14px; }
  .cols-4 { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
  .cols-2 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 18px;
  }
  .panel h2 { font-size: 14px; margin: 0 0 12px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
  .panel h3 { font-size: 15px; margin: 0 0 6px; }
  .metric { display: flex; flex-direction: column; gap: 4px; }
  .metric .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .metric .value { font-size: 27px; font-weight: 650; letter-spacing: -0.5px; }
  .metric .hint { font-size: 12px; color: var(--muted); }
  .score { display: flex; align-items: center; gap: 18px; }
  .score .value { font-size: 46px; font-weight: 700; letter-spacing: -1.5px; line-height: 1; }
  .score .of { color: var(--muted); font-size: 13px; }
  .bar { height: 8px; background: #eef2f7; border-radius: 999px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .bar.warn > i { background: var(--warn); }
  .bar.bad > i { background: var(--bad); }
  .muted { color: var(--muted); }
  .small { font-size: 12.5px; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .between { justify-content: space-between; }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .item { border: 1px solid var(--border); border-radius: 8px; padding: 11px 13px; background: #fdfefe; }
  .item .head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
  .item .title { font-weight: 600; font-size: 14px; }
  .tag {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; color: var(--muted);
    background: var(--bg); white-space: nowrap;
  }
  .tag.ok { color: var(--ok); border-color: #b7dfcd; background: #eef8f3; }
  .tag.warn { color: var(--warn); border-color: #ecd3a6; background: #fdf6e9; }
  .tag.bad { color: var(--bad); border-color: #eec2bc; background: #fdf0ee; }
  .tag.info { color: var(--accent); border-color: #bcd9ec; background: var(--accent-soft); }
  pre.block {
    margin: 8px 0 0; padding: 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; overflow: auto; max-height: 260px; white-space: pre-wrap; word-break: break-word;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; color: var(--text);
  }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  .empty { padding: 26px 10px; text-align: center; color: var(--muted); font-size: 13.5px; }
  .banner {
    background: #fdf6e9; border: 1px solid #ecd3a6; color: #6b4300;
    border-radius: 8px; padding: 10px 13px; font-size: 13px; margin-bottom: 14px;
  }
  .banner.error { background: #fdf0ee; border-color: #eec2bc; color: #7a1c12; }
  .signin { max-width: 430px; margin: 8vh auto; }
  .signin .panel { padding: 24px; }
  .signin h2 { font-size: 20px; text-transform: none; letter-spacing: -0.2px; color: var(--text); }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.06em; }
  .feed { display: flex; flex-direction: column; gap: 8px; max-height: 360px; overflow: auto; }
  .feed div { font-size: 12.5px; display: flex; gap: 8px; align-items: baseline; }
  .feed time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  details summary { cursor: pointer; color: var(--accent); font-size: 13px; }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  @media (max-width: 640px) {
    main { padding: 16px 14px 40px; }
    header.top, nav.tabs { padding-left: 14px; padding-right: 14px; }
  }
</style>
</head>
<body>
<header class="top">
  <div class="brand"><h1>Transactra</h1><span>Control centre</span></div>
  <div class="grow"></div>
  <span class="pill" id="readiness"><span class="dot" id="readyDot"></span><span id="readyText">checking</span></span>
  <span class="pill" id="ownerPill">owner</span>
  <button id="refreshBtn" type="button">Refresh</button>
  <button id="signOutBtn" type="button" class="danger">Lock</button>
</header>
<nav class="tabs" id="tabs" aria-label="Sections">
  <button type="button" data-tab="overview" aria-current="true">Overview</button>
  <button type="button" data-tab="tasks">Tasks</button>
  <button type="button" data-tab="approvals">Approvals</button>
  <button type="button" data-tab="workforce">Workforce</button>
  <button type="button" data-tab="evolution">Evolution</button>
  <button type="button" data-tab="operations">Operations</button>
  <button type="button" data-tab="intelligence">Intelligence</button>
  <button type="button" data-tab="projects">Projects</button>
</nav>
<main id="app">
  <div class="signin" id="signin">
    <div class="panel">
      <h2>Unlock the control plane</h2>
      <p class="small muted">Paste the control-plane API token. It stays in this browser tab only and is sent as a bearer token. The approval credential is separate and is only requested when you decide an approval.</p>
      <div class="field">
        <label for="tokenInput">API token</label>
        <input id="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="CONTROL_PLANE_API_TOKEN">
      </div>
      <div class="field">
        <label for="approvalInput">Approval credential (optional now)</label>
        <input id="approvalInput" type="password" autocomplete="off" spellcheck="false" placeholder="CONTROL_PLANE_APPROVAL_TOKEN">
      </div>
      <div class="row">
        <button class="primary" id="unlockBtn" type="button">Unlock</button>
        <span class="small muted" id="signinError"></span>
      </div>
    </div>
  </div>
  <div id="view" class="sr"></div>
</main>
<script nonce="__NONCE__">
(function () {
  "use strict";

  var state = { token: "", approvalToken: "", tab: "overview", timer: null, data: null, error: "" };

  var app = document.getElementById("view");
  var signin = document.getElementById("signin");
  var readyDot = document.getElementById("readyDot");
  var readyText = document.getElementById("readyText");

  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n.toLocaleString("en-IN") : "0";
  }
  function when(value) {
    if (!value) return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
  function tag(text, tone) { return '<span class="tag ' + (tone || "") + '">' + esc(text) + "</span>"; }
  function toneForStatus(status) {
    var s = String(status || "").toLowerCase();
    if (["succeeded", "sent", "verified", "enabled", "completed", "applied", "ready", "approved", "resolved", "scaffolded"].indexOf(s) >= 0) return "ok";
    if (["failed", "validation_failed", "quarantined", "rejected", "critical", "rolled_back", "error"].indexOf(s) >= 0) return "bad";
    if (["queued", "pending", "running", "dispatched", "in_progress", "awaiting_approval", "proposed", "validated", "warning", "open", "probation", "acknowledged"].indexOf(s) >= 0) return "warn";
    return "info";
  }
  function metric(label, value, hint) {
    return '<div class="panel metric"><span class="label">' + esc(label) + '</span><span class="value">' + esc(value) + '</span>' +
      (hint ? '<span class="hint">' + esc(hint) + "</span>" : "") + "</div>";
  }
  function empty(text) { return '<div class="empty">' + esc(text) + "</div>"; }

  function api(path, options) {
    var init = options || {};
    var headers = new Headers(init.headers || {});
    headers.set("authorization", "Bearer " + state.token);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(path, { method: init.method || "GET", headers: headers, body: init.body }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
        var detail = body && body.error ? String(body.error) : "request failed";
        throw new Error("HTTP " + response.status + " · " + detail);
      }
        return body;
      });
    });
  }

  function setReadiness(kind, text) {
    readyDot.className = "dot " + kind;
    readyText.textContent = text;
  }

  function showSignIn(message) {
    state.token = "";
    state.approvalToken = "";
    try { sessionStorage.removeItem("transactra.token"); sessionStorage.removeItem("transactra.approval"); } catch (e) {}
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    app.className = "sr";
    app.innerHTML = "";
    signin.style.display = "";
    document.getElementById("signinError").textContent = message || "";
  }

  function unlock() {
    var token = document.getElementById("tokenInput").value.trim();
    var approval = document.getElementById("approvalInput").value.trim();
    if (!token) { document.getElementById("signinError").textContent = "The API token is required."; return; }
    state.token = token;
    state.approvalToken = approval;
    try { sessionStorage.setItem("transactra.token", token); sessionStorage.setItem("transactra.approval", approval); } catch (e) {}
    signin.style.display = "none";
    app.className = "";
    render();
    if (!state.timer) state.timer = setInterval(function () { if (!document.hidden) render(true); }, 20000);
  }

  function load() {
    var jobs = {
      ready: api("/health/ready").catch(function () { return { status: "not_ready" }; }),
      overview: api("/v1/organization"),
      tasks: api("/v1/tasks?limit=50"),
      approvals: api("/v1/approvals?limit=50"),
      agents: api("/v1/agents?includeInactive=true"),
      proposals: api("/v1/evolution/proposals?limit=50"),
      incidents: api("/v1/incidents?limit=50"),
      deployments: api("/v1/deployments?limit=50"),
      notifications: api("/v1/notifications?limit=50"),
      reports: api("/v1/reports?limit=20"),
      opportunities: api("/v1/opportunities?limit=20"),
      projects: api("/v1/projects?limit=50"),
      cycles: api("/v1/organization/cycles?limit=20")
    };
    var keys = Object.keys(jobs);
    return Promise.all(keys.map(function (key) { return jobs[key]; })).then(function (results) {
      var data = {};
      keys.forEach(function (key, index) { data[key] = results[index]; });
      return data;
    });
  }

  function renderOverview(data) {
    var metrics = (data.overview.organization && data.overview.organization.metrics) || {};
    var score = (data.overview.organization && data.overview.organization.score) || 0;
    var incidents = data.overview.openIncidents || {};
    var cycle = data.overview.latestCycle;
    var failureRate = (Number(metrics.succeededTasks30d) + Number(metrics.failedTasks30d)) === 0 ? 0
      : Math.round((Number(metrics.failedTasks30d) / (Number(metrics.succeededTasks30d) + Number(metrics.failedTasks30d))) * 100);
    var html = '<div class="grid cols-4" style="margin-bottom:14px">';
    html += '<div class="panel"><div class="score"><div><div class="value">' + esc(num(score)) + '</div><div class="of">of 100 · measured</div></div></div>' +
      '<div class="bar ' + (score >= 80 ? "" : score >= 60 ? "warn" : "bad") + '" style="margin-top:14px"><i style="width:' + Math.max(2, Math.min(100, score)) + '%"></i></div>' +
      '<div class="small muted" style="margin-top:8px">30-day evidence: task reliability, incidents, leases, approvals, quarantines.</div></div>';
    html += metric("Tasks succeeded (30d)", num(metrics.succeededTasks30d), num(metrics.failedTasks30d) + " failed · " + failureRate + "% failure rate");
    html += metric("Pending approvals", num(metrics.pendingApprovals), "sensitive actions waiting on you");
    html += metric("Open incidents", num(incidents.critical) + " / " + num(incidents.warning), "critical / warning");
    html += metric("Active agents", num(metrics.activeAgents), num(metrics.quarantinedAgents) + " quarantined");
    html += metric("Deployments (30d)", num(metrics.deployments30d), num(metrics.successfulDeployments30d) + " succeeded");
    html += metric("Reports", num((data.reports.reports || []).length), num(metrics.researchSources30d) + " sources (30d)");
    html += metric("Memory items", num(metrics.memoryItems), "durable knowledge");
    html += metric("Projects", num(metrics.totalProjects), num(metrics.verifiedProjects) + " verified");
    html += "</div>";

    html += '<div class="grid cols-2">';
    html += '<div class="panel"><h2>Latest organisation cycle</h2>';
    if (!cycle) html += empty("No cycle recorded yet. Start the scheduler service.");
    else {
      var decisions = Array.isArray(cycle.decisions) ? cycle.decisions : [];
      html += '<div class="row between" style="margin-bottom:10px">' + tag(cycle.status, toneForStatus(cycle.status)) +
        '<span class="small muted mono">' + esc(cycle.cycle_key) + " · " + esc(when(cycle.completed_at)) + "</span></div>";
      html += '<div class="feed">';
      decisions.slice(0, 12).forEach(function (decision) {
        html += '<div><time>' + esc(decision.department || "system") + '</time><span>' + esc(decision.action || "") +
          " — " + esc(decision.detail || "") + "</span></div>";
      });
      if (!decisions.length) html += '<div class="muted small">Cycle recorded no decisions.</div>';
      html += "</div>";
    }
    html += "</div>";

    html += '<div class="panel"><h2>Attention</h2><div class="list">';
    var items = 0;
    (data.approvals.approvals || []).slice(0, 5).forEach(function (approval) {
      items += 1;
      html += '<div class="item"><div class="head"><span class="title">Approval required</span>' + tag("pending", "warn") + "</div>" +
        '<div class="small muted mono">' + esc(approval.id) + "</div>" +
        '<div class="small">' + esc((approval.action && approval.action.capability) || "action") + " · " + esc((approval.action && approval.action.resource) || "") + "</div></div>";
    });
    (data.incidents.incidents || []).filter(function (incident) { return incident.status !== "resolved"; }).slice(0, 5).forEach(function (incident) {
      items += 1;
      html += '<div class="item"><div class="head"><span class="title">' + esc(incident.title) + "</span>" + tag(incident.severity, toneForStatus(incident.severity)) + "</div>" +
        '<div class="small muted">' + esc(incident.status) + " · " + esc(when(incident.opened_at)) + "</div></div>";
    });
    (data.notifications.notifications || []).filter(function (notification) { return notification.status === "failed"; }).slice(0, 3).forEach(function (notification) {
      items += 1;
      html += '<div class="item"><div class="head"><span class="title">Undelivered notification</span>' + tag("failed", "bad") + "</div>" +
        '<div class="small muted">' + esc(notification.kind) + " · " + esc(when(notification.created_at)) + "</div></div>";
    });
    if (!items) html += empty("Nothing needs the owner right now.");
    html += "</div></div></div>";
    return html;
  }

  function renderTasks(data) {
    var tasks = data.tasks.tasks || [];
    if (!tasks.length) return '<div class="panel">' + empty("No tasks recorded.") + "</div>";
    var html = '<div class="panel"><h2>Recent tasks</h2><table><thead><tr><th>Task</th><th>Department</th><th>Status</th><th>Risk</th><th>Attempt</th><th>Updated</th></tr></thead><tbody>';
    tasks.forEach(function (task) {
      html += "<tr><td><div>" + esc(task.title) + '</div><div class="mono muted">' + esc(task.id) + "</div></td><td>" + esc(task.department) +
        "</td><td>" + tag(task.status, toneForStatus(task.status)) + "</td><td>" + esc(task.risk) + "</td><td>" + esc(task.attempt) +
        '</td><td class="small muted">' + esc(when(task.updated_at || task.created_at)) + "</td></tr>";
    });
    return html + "</tbody></table></div>";
  }

  function renderApprovals(data) {
    var approvals = data.approvals.approvals || [];
    var html = '<div class="panel"><h2>Pending approvals</h2>' +
      '<p class="small muted">Approving consumes a single-use credential bound to the exact action. The approval credential is separate from the API token.</p>' +
      '<div class="field" style="max-width:420px"><label for="approvalTokenField">Approval credential</label>' +
      '<input id="approvalTokenField" type="password" autocomplete="off" spellcheck="false" value="' + esc(state.approvalToken) + '"></div>';
    if (!approvals.length) return html + empty("No approval is waiting.") + "</div>";
    html += '<div class="list">';
    approvals.forEach(function (approval) {
      var action = approval.action || {};
      html += '<div class="item"><div class="head"><span class="title">' + esc(action.capability || "action") + "</span>" + tag("expires " + when(approval.expires_at), "warn") + "</div>" +
        '<div class="small muted mono">' + esc(approval.id) + "</div>" +
        '<div class="small" style="margin:6px 0">' + esc(action.resource || "") + "</div>" +
        '<details><summary>Bound action payload</summary><pre class="block">' + esc(JSON.stringify(action.policyAction || action, null, 2).slice(0, 4000)) + "</pre></details>" +
        '<div class="field" style="margin-top:10px"><label for="reason-' + esc(approval.id) + '">Reason</label>' +
        '<input id="reason-' + esc(approval.id) + '" data-reason="' + esc(approval.id) + '" placeholder="Why is this approved or rejected?"></div>' +
        '<div class="row"><button class="primary" data-decide="approved" data-id="' + esc(approval.id) + '">Approve</button>' +
        '<button class="danger" data-decide="rejected" data-id="' + esc(approval.id) + '">Reject</button></div></div>';
    });
    return html + "</div></div>";
  }

  function renderWorkforce(data) {
    var agents = data.agents.agents || [];
    if (!agents.length) return '<div class="panel">' + empty("No agents registered.") + "</div>";
    var html = '<div class="panel"><h2>Workforce</h2><table><thead><tr><th>Agent</th><th>Department</th><th>Lifecycle</th><th>Capabilities</th><th>Concurrency</th></tr></thead><tbody>';
    agents.forEach(function (agent) {
      html += "<tr><td><div>" + esc(agent.name) + '</div><div class="mono muted">' + esc(agent.id) + "</div></td><td>" + esc(agent.department) +
        "</td><td>" + tag(agent.lifecycle_status, toneForStatus(agent.lifecycle_status)) + '</td><td class="small mono">' +
        esc((agent.capabilities || []).join(", ")) + "</td><td>" + esc(agent.max_concurrent_tasks) + "</td></tr>";
    });
    return html + "</tbody></table></div>";
  }

  function renderEvolution(data) {
    var proposals = data.proposals.proposals || [];
    var html = '<div class="panel"><h2>Self-evolution proposals</h2>' +
      '<p class="small muted">Validation runs in the isolated sandbox. Applying or rolling back requires your approval and is requested from the worker, never written directly by this page.</p>';
    if (!proposals.length) return html + empty("No proposal has been raised.") + "</div>";
    html += '<div class="list">';
    proposals.forEach(function (proposal) {
      var changes = Array.isArray(proposal.changes) ? proposal.changes : (proposal.changes && proposal.changes.changes) || [];
      html += '<div class="item"><div class="head"><span class="title">' + esc(proposal.title) + "</span>" + tag(proposal.status, toneForStatus(proposal.status)) + "</div>" +
        '<div class="small muted mono">' + esc(proposal.id) + " · " + esc(when(proposal.created_at)) + "</div>" +
        '<div class="small" style="margin:6px 0">' + esc(proposal.rationale) + "</div>" +
        '<div class="small mono">' + esc((Array.isArray(changes) ? changes : []).map(function (change) { return change.path; }).join(", ")) + "</div>" +
        '<div class="row" style="margin-top:10px">' +
        (proposal.status === "proposed" || proposal.status === "validation_failed" || proposal.status === "validated"
          ? '<button data-evolution="validate" data-id="' + esc(proposal.id) + '">Request validation</button>' : "") +
        (proposal.status === "validated" ? '<button class="primary" data-evolution="apply" data-id="' + esc(proposal.id) + '">Request apply</button>' : "") +
        (proposal.status === "applied" ? '<button class="danger" data-evolution="rollback" data-id="' + esc(proposal.id) + '">Request rollback</button>' : "") +
        "</div></div>";
    });
    return html + "</div></div>";
  }

  function renderOperations(data) {
    var incidents = data.incidents.incidents || [];
    var deployments = data.deployments.deployments || [];
    var notifications = data.notifications.notifications || [];
    var html = '<div class="grid cols-2">';
    html += '<div class="panel"><h2>Incidents</h2>';
    html += incidents.length ? '<div class="list">' + incidents.map(function (incident) {
      return '<div class="item"><div class="head"><span class="title">' + esc(incident.title) + "</span>" + tag(incident.severity + " · " + incident.status, toneForStatus(incident.severity)) + "</div>" +
        '<div class="small muted">' + esc(when(incident.opened_at)) + "</div>" +
        '<div class="row" style="margin-top:8px">' +
        (incident.status !== "resolved" ? '<button data-incident="resolved" data-id="' + esc(incident.id) + '">Resolve</button>' : "") +
        (incident.status === "open" ? '<button data-incident="acknowledged" data-id="' + esc(incident.id) + '">Acknowledge</button>' : "") +
        "</div></div>";
    }).join("") + "</div>" : empty("No incidents recorded.");
    html += "</div>";
    html += '<div class="panel"><h2>Deployments</h2>';
    html += deployments.length ? '<table><thead><tr><th>Environment</th><th>Repository</th><th>Status</th><th>Commit</th></tr></thead><tbody>' +
      deployments.map(function (deployment) {
        return "<tr><td>" + esc(deployment.environment) + "</td><td>" + esc(deployment.repository) + "</td><td>" +
          tag(deployment.status, toneForStatus(deployment.status)) + '</td><td class="mono small">' + esc((deployment.commit_sha || "").slice(0, 12)) + "</td></tr>";
      }).join("") + "</tbody></table>" : empty("No deployment recorded.");
    html += "</div>";
    html += '<div class="panel"><h2>Notifications</h2>';
    html += notifications.length ? '<table><thead><tr><th>Kind</th><th>Status</th><th>Channel</th><th>Created</th></tr></thead><tbody>' +
      notifications.map(function (notification) {
        return "<tr><td>" + esc(notification.kind) + "</td><td>" + tag(notification.status, toneForStatus(notification.status)) +
          "</td><td>" + esc(notification.channel) + '</td><td class="small muted">' + esc(when(notification.created_at)) + "</td></tr>";
      }).join("") + "</tbody></table>" : empty("No notification queued.");
    html += "</div>";
    html += '<div class="panel"><h2>Organisation cycles</h2>';
    var cycles = data.cycles.cycles || [];
    html += cycles.length ? '<table><thead><tr><th>Cycle</th><th>Status</th><th>Tasks enqueued</th><th>Completed</th></tr></thead><tbody>' +
      cycles.map(function (cycle) {
        return '<tr><td class="mono small">' + esc(cycle.cycle_key) + "</td><td>" + tag(cycle.status, toneForStatus(cycle.status)) +
          "</td><td>" + esc(cycle.tasks_enqueued) + '</td><td class="small muted">' + esc(when(cycle.completed_at)) + "</td></tr>";
      }).join("") + "</tbody></table>" : empty("No cycle recorded.");
    return html + "</div></div>";
  }

  function renderIntelligence(data) {
    var reports = data.reports.reports || [];
    var opportunities = data.opportunities.opportunities || [];
    var html = '<div class="grid cols-2">';
    html += '<div class="panel"><h2>Reports</h2>';
    html += reports.length ? '<div class="list">' + reports.map(function (report) {
      return '<div class="item"><div class="head"><span class="title">' + esc(when(report.created_at)) + "</span>" + tag("report", "info") + "</div>" +
        '<div class="small" style="margin-top:6px">' + esc(String(report.summary || "").slice(0, 700)) + "</div>" +
        '<div class="small muted mono" style="margin-top:6px">' + esc(report.id) + "</div></div>";
    }).join("") + "</div>" : empty("No intelligence report yet.");
    html += "</div>";
    html += '<div class="panel"><h2>Opportunities</h2>';
    html += opportunities.length ? '<table><thead><tr><th>Problem</th><th>User</th><th>Score</th><th>Eligible</th></tr></thead><tbody>' +
      opportunities.map(function (opportunity) {
        return "<tr><td>" + esc(String(opportunity.problem || "").slice(0, 140)) + "</td><td>" + esc(opportunity.target_user || opportunity.targetUser || "") +
          "</td><td>" + esc(opportunity.score) + "</td><td>" + tag(opportunity.eligible ? "eligible" : "below gate", opportunity.eligible ? "ok" : "warn") + "</td></tr>";
      }).join("") + "</tbody></table>" : empty("No scored opportunity yet.");
    return html + "</div></div>";
  }

  function renderProjects(data) {
    var projects = data.projects.projects || [];
    if (!projects.length) return '<div class="panel">' + empty("No innovation project generated yet.") + "</div>";
    var html = '<div class="panel"><h2>Innovation projects</h2><table><thead><tr><th>Project</th><th>Repository</th><th>Status</th><th>Created</th></tr></thead><tbody>';
    projects.forEach(function (project) {
      html += "<tr><td>" + esc(project.name) + '</td><td class="mono small">' + esc(project.repository_full_name) + "</td><td>" +
        tag(project.status, toneForStatus(project.status)) + '</td><td class="small muted">' + esc(when(project.created_at)) + "</td></tr>";
    });
    return html + "</tbody></table></div>";
  }

  function renderTable() {
    if (!state.data) return '<div class="panel">' + empty("Loading…") + "</div>";
    switch (state.tab) {
      case "tasks": return renderTasks(state.data);
      case "approvals": return renderApprovals(state.data);
      case "workforce": return renderWorkforce(state.data);
      case "evolution": return renderEvolution(state.data);
      case "operations": return renderOperations(state.data);
      case "intelligence": return renderIntelligence(state.data);
      case "projects": return renderProjects(state.data);
      default: return renderOverview(state.data);
    }
  }

  function render(quiet) {
    if (!state.token) return;
    if (!quiet) app.innerHTML = '<div class="panel">' + empty("Loading…") + "</div>";
    load().then(function (data) {
      state.data = data;
      state.error = "";
      var ready = data.ready && data.ready.status === "ready";
      setReadiness(ready ? "ok" : "warn", ready ? "database ready" : "database not ready");
      var banner = "";
      if (!ready) banner += '<div class="banner">The database schema is not ready. Run the migration service before reading live state.</div>';
      app.innerHTML = banner + renderTable();
    }).catch(function (error) {
      var message = error && error.message ? error.message : "request failed";
      if (/unauthorized/i.test(message)) { showSignIn("That token was rejected by the control plane."); return; }
      setReadiness("bad", "control plane error");
      app.innerHTML = '<div class="banner error">' + esc(message) + "</div>";
    });
  }

  document.getElementById("unlockBtn").addEventListener("click", unlock);
  document.getElementById("tokenInput").addEventListener("keydown", function (event) { if (event.key === "Enter") unlock(); });
  document.getElementById("refreshBtn").addEventListener("click", function () { render(); });
  document.getElementById("signOutBtn").addEventListener("click", function () { showSignIn(""); });
  document.getElementById("tabs").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-tab]");
    if (!button) return;
    state.tab = button.getAttribute("data-tab");
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (item) {
      item.setAttribute("aria-current", item === button ? "true" : "false");
    });
    render();
  });
  app.addEventListener("click", function (event) {
    var decide = event.target.closest("button[data-decide]");
    if (decide) {
      var approvalId = decide.getAttribute("data-id");
      var decision = decide.getAttribute("data-decide");
      var reasonField = document.querySelector('[data-reason="' + approvalId + '"]');
      var reason = reasonField ? reasonField.value.trim() : "";
      var credential = document.getElementById("approvalTokenField");
      var approvalToken = credential ? credential.value.trim() : state.approvalToken;
      if (!reason) { window.alert("A written reason is required for every approval decision."); return; }
      if (!approvalToken) { window.alert("Enter the separate approval credential first."); return; }
      decide.disabled = true;
      api("/v1/approvals/" + approvalId + "/decision", {
        method: "POST",
        headers: { "x-transactra-approval-token": approvalToken },
        body: JSON.stringify({ decision: decision, reason: reason })
      }).then(function () { render(); }).catch(function (error) {
        decide.disabled = false;
        window.alert("Decision failed: " + (error && error.message ? error.message : "unknown error"));
      });
      return;
    }
    var evolution = event.target.closest("button[data-evolution]");
    if (evolution) {
      var action = evolution.getAttribute("data-evolution");
      if (!window.confirm("Request " + action + " for this proposal? Applying and rolling back still requires a separate owner approval.")) return;
      evolution.disabled = true;
      api("/v1/evolution/proposals/" + evolution.getAttribute("data-id") + "/" + action, { method: "POST", body: "{}" })
        .then(function () { render(); }).catch(function (error) {
          evolution.disabled = false;
          window.alert("Request failed: " + (error && error.message ? error.message : "unknown error"));
        });
      return;
    }
    var incident = event.target.closest("button[data-incident]");
    if (incident) {
      incident.disabled = true;
      api("/v1/incidents/" + incident.getAttribute("data-id") + "/status", {
        method: "POST", body: JSON.stringify({ status: incident.getAttribute("data-incident") })
      }).then(function () { render(); }).catch(function (error) {
        incident.disabled = false;
        window.alert("Update failed: " + (error && error.message ? error.message : "unknown error"));
      });
    }
  });

  try {
    state.token = sessionStorage.getItem("transactra.token") || "";
    state.approvalToken = sessionStorage.getItem("transactra.approval") || "";
  } catch (e) {}
  if (state.token) {
    signin.style.display = "none";
    app.className = "";
    render();
    state.timer = setInterval(function () { if (!document.hidden) render(true); }, 20000);
  }
})();
</script>
</body>
</html>
`;
