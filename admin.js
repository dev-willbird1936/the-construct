// Owner admin: pending publish queue (approve/reject with preview),
// kill switch, own spend + worker status. Owner role only.
const params = new URLSearchParams(location.search);
const apiBase = params.get("api") || "";
const apiUrl = (p) => `${apiBase}${p}`;
const $ = (s) => document.querySelector(s);

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function card(job) {
  const r = job.result || {};
  const el = document.createElement("div");
  el.className = "admin-card";
  const thumb = r.thumb ? apiUrl(`/${r.thumb}`) : "";
  el.innerHTML = `
    ${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : `<span class="dim">no preview</span>`}
    <div>
      <b></b>
      <span class="dim"></span>
      <div class="row-btns"></div>
    </div>`;
  el.querySelector("b").textContent = r.title || job.title || `${job.tier} build`;
  const prov = (r.meta?.provenance || []).join(" + ");
  el.querySelector(".dim").textContent = `${job.tier} · ${job.status} · ${r.subject || ""}${prov ? ` · ${prov}` : ""}`;
  const row = el.querySelector(".row-btns");
  const btn = (label, primary, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "btn btn-primary" : "btn btn-quiet";
    b.textContent = label;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        queueState(`Failed: ${e.message}`);
      }
      refresh();
    });
    row.append(b);
  };
  if (r.viewer) {
    const a = document.createElement("a");
    a.className = "link-btn";
    a.href = apiUrl(`/${r.viewer}`);
    a.textContent = "Open viewer";
    row.append(a);
  }
  btn("Approve", true, () => api(`/api/admin/${job.id}/approve`, { method: "POST" }));
  btn("Reject", false, () => api(`/api/admin/${job.id}/reject`, { method: "POST" }));
  return el;
}

function queueState(text) {
  $("#queueState").textContent = text;
}

async function refresh() {
  const box = $("#queue");
  box.innerHTML = "";
  try {
    const { pending } = await api("/api/admin/pending");
    if (!pending?.length) queueState("Queue is empty — nothing waiting for approval.");
    else {
      queueState(`${pending.length} build${pending.length === 1 ? "" : "s"} waiting.`);
      pending.forEach((job) => box.append(card(job)));
    }
  } catch (e) {
    queueState(`Could not load the queue: ${e.message}`);
  }
}

async function boot() {
  let me;
  try {
    const res = await fetch(apiUrl("/api/me"));
    if (res.status === 401) {
      queueState("Sign in first.");
      $("#adminLede").innerHTML = `This page is for the owner. <a href="${apiBase}/signin?next=${encodeURIComponent("admin.html")}">Sign in</a>`;
      return;
    }
    me = await res.json();
  } catch {
    queueState("No link to the service. Check the connection and try again.");
    return;
  }
  if (me.role !== "owner") {
    queueState("Owner role required — this account cannot approve builds.");
    return;
  }
  $("#killRow").hidden = false;
  const spend = $("#spendLine");
  spend.hidden = false;
  const w = me.worker || {};
  spend.textContent = `Signed in as ${me.email} · spend today ≈${(me.spendTodayCents / 100).toFixed(2)}$ (ledger estimates, not bills) · GPU worker ${w.online ? "online" : "offline"}.`;
  $("#killOn").addEventListener("click", async () => {
    await api("/api/admin/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) }).catch((e) => queueState(e.message));
    refreshStatus();
  });
  $("#killOff").addEventListener("click", async () => {
    await api("/api/admin/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) }).catch((e) => queueState(e.message));
    refreshStatus();
  });
  refreshStatus();
  refresh();
}

async function refreshStatus() {
  const panel = $("#statusPanel");
  try {
    const s = await api("/api/admin/status");
    const dollars = (c) => `≈$${(Number(c) / 100).toFixed(2)}`;
    const rows = [
      ["service", s.killed ? "PAUSED (kill switch)" : "live"],
      ["spend today", `${dollars(s.spendTodayCents)} of ${dollars(s.capGlobalCents)} global cap`],
      ["jobs today", `${s.jobsToday} of ${s.capJobsToday} global cap`],
      ["pending", String(s.pending)],
      ["active", `${s.running} local · ${s.queuedGpu} gpu-queued`],
      ["reports", String(s.reports)],
      ["gpu worker", s.worker && s.worker.online ? "online" : "offline"],
    ];
    panel.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd></dd></div>`).join("");
    [...panel.querySelectorAll("dd")].forEach((dd, i) => { dd.textContent = rows[i][1]; });
    panel.hidden = false;
    $("#killState").textContent = s.killed ? "Kill switch is ON: new uploads and jobs are refused." : "Kill switch is off.";
  } catch (e) {
    panel.hidden = true;
    $("#killState").textContent = `Status unreadable: ${e.message}`;
  }
}

boot();
