// ComfyUI Mirror Fetch - frontend panel
// Fills in missing models from a configurable mirror, with resume and live progress.
// It does not patch any official file.

const API = "/mirror_fetch";

const MODEL_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i;

const log = (...a) => console.log("[mirror-fetch]", ...a);
const mb = (n) => {
  if (!n) return "0";
  return n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB";
};
const baseName = (p) => String(p || "").split(/[\\/]/).pop();

// ---------------------------------------------------------------- collect model refs

// widget name -> ComfyUI folder (authoritative: the widget options come from that folder)
const WIDGET_DIR = {
  ckpt_name: "checkpoints",
  unet_name: "diffusion_models",
  clip_name: "text_encoders",
  clip_name1: "text_encoders",
  clip_name2: "text_encoders",
  clip_name3: "text_encoders",
  vae_name: "vae",
  lora_name: "loras",
  control_net_name: "controlnet",
  clip_vision_name: "clip_vision",
  upscale_model_name: "upscale_models",
  style_model_name: "style_models",
  gligen_name: "gligen",
  model_name: "diffusion_models",
};
function guessDir(name) {
  const n = String(name).toLowerCase();
  if (n.includes("lora")) return "loras";
  if (n.includes("vae")) return "vae";
  if (n.includes("clip") || n.includes("t5") || n.includes("text")) return "text_encoders";
  if (n.includes("control")) return "controlnet";
  return "diffusion_models";
}

// Deep scan: wherever the URL is buried, keep any object shaped like {name, url, directory}.
function deepFindModels(root, out, seen, visited, depth) {
  if (!root || depth > 7) return;
  if (typeof root !== "object") return;
  if (visited.has(root)) return;
  visited.add(root);

  if (Array.isArray(root)) {
    for (const v of root) deepFindModels(v, out, seen, visited, depth + 1);
    return;
  }

  const nm = root.name;
  if (typeof nm === "string" && MODEL_RE.test(nm)) {
    const key = (root.directory || "") + "|" + nm;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        name: nm,
        url: typeof root.url === "string" ? root.url : "",
        directory: root.directory || guessDir(nm),
        dirKnown: !!root.directory,
      });
    }
  }

  for (const k of Object.keys(root)) {
    if (k === "_nodes" || k === "__proto__") continue;
    let v;
    try { v = root[k]; } catch (e) { continue; }
    if (v && typeof v === "object") deepFindModels(v, out, seen, visited, depth + 1);
  }
}

function collectModelRefs() {
  const out = [];
  const seen = new Set();
  const visited = new Set();
  const app = window.app;
  const graph = app?.graph;
  if (!graph) return out;

  const roots = [];
  const push = (o) => { if (o && typeof o === "object") roots.push(o); };

  try { push(graph.serialize ? graph.serialize() : null); } catch (e) {}
  push(graph);
  try { push(app.workflowManager?.activeWorkflow); } catch (e) {}
  try { push(app.workflowManager?.activeWorkflow?.activeState); } catch (e) {}
  for (const n of graph._nodes || []) {
    push(n);
    try { push(n.constructor?.nodeData); } catch (e) {}
  }

  for (const r of roots) deepFindModels(r, out, seen, visited, 0);

  for (const n of graph._nodes || []) {
    for (const w of n?.widgets || []) {
      const v = w?.value;
      if (typeof v === "string" && MODEL_RE.test(v)) {
        const key = "|" + v;
        if (!seen.has(key)) {
          seen.add(key);
          // The widget name decides the folder: its options are listed from that folder.
          const wd = WIDGET_DIR[w?.name];
          out.push({
            name: v,
            url: "",
            directory: wd || guessDir(v),
            dirKnown: !!wd,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- state

let panel = null;
let rows = [];        // current missing/present rows
let jobsBy = {};      // basename -> job
const pending = new Set();  // names the user just submitted; backend has not reported yet
let scanning = false;
let statusMsg = "";

// ---------------------------------------------------------------- panel skeleton

function buildPanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "mirror-fetch-panel";
  panel.style.cssText = [
    "position:fixed", "right:16px", "top:80px", "width:440px", "max-height:74vh",
    "z-index:99998", "display:none", "flex-direction:column",
    "background:#16161f", "border:1px solid #2e2e42", "border-radius:12px",
    "box-shadow:0 10px 30px rgba(0,0,0,.5)", "color:#e6e6ef",
    "font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif", "overflow:hidden",
  ].join(";");

  panel.innerHTML =
    '<div style="padding:11px 14px;border-bottom:1px solid #2e2e42;display:flex;align-items:center;gap:8px">' +
      '<b style="flex:1">Mirror Fetch</b>' +
      '<span id="mf-mirror" style="font-size:11px;color:#8a8aa0"></span>' +
      '<button id="mf-scan" style="background:#2e2e42;border:0;color:#e6e6ef;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">Rescan</button>' +
      '<span id="mf-close" style="cursor:pointer;color:#8a8aa0;padding:0 4px">✕</span>' +
    '</div>' +
    '<div id="mf-body" style="padding:10px 14px;overflow:auto;flex:1"></div>' +
    '<div style="padding:10px 14px;border-top:1px solid #2e2e42;display:flex;gap:8px">' +
      '<button id="mf-all" style="flex:1;background:#4a7dff;border:0;color:#fff;border-radius:8px;padding:8px;cursor:pointer;font-weight:600">Download all</button>' +
      '<button id="mf-pauseall" style="background:#3a3a52;border:0;color:#cfd8ff;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600">Pause all</button>' +
    '</div>';
  zhDom(panel);

  document.body.appendChild(panel);
  panel.querySelector("#mf-close").onclick = () => (panel.style.display = "none");
  panel.querySelector("#mf-scan").onclick = () => scan();
  panel.querySelector("#mf-all").onclick = () => withBatchFeedback(panel.querySelector("#mf-all"), "Submitting...", downloadAll);
  panel.querySelector("#mf-pauseall").onclick = () => withBatchFeedback(panel.querySelector("#mf-pauseall"), "Pausing...", pauseAll);

  fetch(API + "/info").then((r) => r.json()).then((d) => {
    panel.querySelector("#mf-mirror").textContent = d.mirror || "";
  }).catch(() => {});

  return panel;
}

function openPanel() {
  const p = buildPanel();
  const show = p.style.display !== "flex";
  p.style.display = show ? "flex" : "none";
  if (show) scan();
}

// ---------------------------------------------------------------- render

function jobFor(name) {
  return jobsBy[baseName(name)] || null;
}

function bar(pct, color) {
  return '<div style="height:5px;background:#22222f;border-radius:3px;overflow:hidden;margin:5px 0 3px">' +
    '<i style="display:block;height:100%;background:' + color + ';width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>';
}

function catOf(r) {
  const j = jobFor(r.name);
  if (j) return j.state;
  if (pending.has(baseName(r.name))) return "pending";
  return r.state === "complete" ? zh("done") : "idle";
}

let lastCats = {};

// Full rebuild - only when the state category changes.
function renderRows() {
  if (!panel) return;
  const body = panel.querySelector("#mf-body");
  if (!body) return;

  const withUrl = rows.filter((r) => r.url).length;
  const missing = rows.filter((r) => r.state !== "complete");

  let html =
    '<div style="display:flex;align-items:center;gap:8px;padding:2px 0 9px;border-bottom:1px solid #22222f;margin-bottom:8px;font-size:11px;color:#8a8aa0">' +
      '<span style="flex:1">Referenced ' + rows.length + " · with URL " + withUrl + " · missing " + missing.length + "</span>" +
      '<button id="mf-copy" style="background:#2e2e42;border:0;color:#cfd8ff;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px">Copy &amp; report</button>' +
    "</div>";

  if (statusMsg) {
    html += '<div style="color:#f0c060;padding:2px 0 10px;font-size:12px">' + escapeHtml(statusMsg) + "</div>";
  }

  if (!rows.length) {
    body.innerHTML = zh(html) + '<div style="color:#8a8aa0;padding:20px 0;text-align:center">Click “Rescan” in the top right to see what is missing</div>';
    bindCopy();
    return;
  }
  if (!missing.length) {
    body.innerHTML = zh(html) + '<div style="color:#3ecf8e;padding:20px 0;text-align:center">✓ Everything is already present</div>';
    bindCopy();
    return;
  }
  if (!withUrl && !statusMsg) {
    html += '<div style="color:#f0c060;padding:8px 0 12px;font-size:12px;line-height:1.6">These files were not found on the mirror. They may be private repos, or renamed after the fact.<br>Click “Copy &amp; report” in the top right: it copies the diagnostics and opens the issue page.</div>';
  }

  for (const r of missing) {
    const cat = catOf(r);
    const job = jobFor(r.name);
    const btn = (cls, txt, color) =>
      '<button class="' + cls + '" data-n="' + escapeAttr(r.name) + '" style="background:' + color +
      ';border:0;color:#fff;border-radius:6px;padding:4px 9px;cursor:pointer;font-size:11px">' + txt + "</button>";

    let right = "";
    let color = "#4a7dff";
    let pct = 0;

    if (r.state === "complete" && !job) {
      right = '<span style="font-size:11px;color:#3ecf8e;flex-shrink:0">✓ present</span>';
    } else if (cat === "downloading" || cat === "queued") {
      right = '<div style="display:flex;gap:4px;flex-shrink:0">' + btn("mf-pause", "Pause", "#3a3a52") + btn("mf-cancel", zh("Cancel"), "#4a2530") + "</div>";
    } else if (cat === "pending") {
      right = '<div style="display:flex;gap:4px;flex-shrink:0">' + btn("mf-cancel", zh("Cancel"), "#4a2530") + "</div>";
    } else if (cat === "paused") {
      color = "#f0c060";
      right = '<div style="display:flex;gap:4px;flex-shrink:0">' + btn("mf-dl", zh("Resume"), "#4a7dff") + btn("mf-cancel", zh("Cancel"), "#4a2530") + "</div>";
    } else if (cat === "error") {
      color = "#ff6b6b";
      right = btn("mf-dl", zh("Retry"), "#4a7dff");
    } else if (cat === "cancelled") {
      right = btn("mf-dl", "Redownload", "#4a7dff");
    } else {
      right = r.url
        ? btn("mf-dl", "Download", "#4a7dff")
        : '<button disabled style="background:#2e2e42;border:0;color:#666680;border-radius:6px;padding:5px 12px">No URL</button>';
    }

    html +=
      '<div data-row="' + escapeAttr(r.name) + '" style="padding:9px 0;border-bottom:1px solid #22222f">' +
        '<div style="display:flex;gap:8px;align-items:flex-start">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.name) + "</div>" +
            '<div style="font-size:11px;color:#7a7a92;margin-top:2px">' + escapeHtml(r.directory || "?") +
              (r.size ? " · " + mb(r.size) : "") + (r.repo ? " · " + escapeHtml(r.repo) : "") + "</div>" +
          "</div>" + right +
        "</div>" +
        '<div style="height:5px;background:#22222f;border-radius:3px;overflow:hidden;margin:6px 0 3px">' +
          '<i data-bar="' + escapeAttr(r.name) + '" style="display:block;height:100%;background:' + color + ';width:' + pct + '%"></i>' +
        "</div>" +
        '<div data-num="' + escapeAttr(r.name) + '" style="font-size:11px;color:#7a7a92"></div>' +
      "</div>";
  }

  body.innerHTML = zh(html);
  bindCopy();

  body.querySelectorAll("button.mf-dl").forEach((b) => {
    b.onclick = () => {
      const r = missing.find((x) => x.name === b.dataset.n);
      if (r) startDownload(r);
    };
  });
  body.querySelectorAll("button.mf-pause").forEach((b) => {
    b.onclick = () => postJob("/mirror_fetch/pause", b.dataset.n, b);
  });
  body.querySelectorAll("button.mf-cancel").forEach((b) => {
    b.onclick = () => postJob("/mirror_fetch/cancel", b.dataset.n, b);
  });

  updateBatchBar();
  lastCats = {};
  for (const r of rows) lastCats[r.name] = catOf(r);
  updateNumbers();
}

// Update numbers and bars in place. Rebuilding the DOM every second swallows clicks.
function updateNumbers() {
  if (!panel) return;
  const body = panel.querySelector("#mf-body");
  if (!body) return;

  for (const r of rows) {
    if (r.state === "complete") continue;
    const job = jobFor(r.name);
    const cat = catOf(r);
    const barEl = body.querySelector('[data-bar="' + cssEscape(r.name) + '"]');
    const numEl = body.querySelector('[data-num="' + cssEscape(r.name) + '"]');
    if (!barEl || !numEl) continue;

    const pct = job && job.total ? (job.done / job.total) * 100 : 0;

    if (cat === "downloading" || cat === "queued") {
      barEl.style.width = pct.toFixed(1) + "%";
      barEl.style.background = "#4a7dff";
      const sp = job.speed ? (job.speed / 1048576).toFixed(1) + " MB/s" : "…";
      const eta = job.eta ? "left " + Math.round(job.eta) + " s" : "";
      numEl.style.color = "#4a7dff";
      numEl.textContent = pct.toFixed(0) + "% · " + mb(job.done) + " / " + mb(job.total) +
        " · " + sp + " · " + eta + (job.resumed ? " · resumed" : "");
    } else if (cat === "pending") {
      barEl.style.width = "0%";
      numEl.style.color = "#8a8aa0";
      numEl.textContent = zh("Preparing...");
    } else if (cat === "paused") {
      barEl.style.width = pct.toFixed(1) + "%";
      barEl.style.background = "#f0c060";
      numEl.style.color = "#f0c060";
      numEl.textContent = zh("Paused · ") + mb(job.done) + " / " + mb(job.total);
    } else if (cat === "error") {
      barEl.style.width = "100%";
      barEl.style.background = "#ff6b6b";
      numEl.style.color = "#ff6b6b";
      numEl.textContent = zh("Failed: ") + String(job.error || "").slice(0, 60);
    } else if (cat === "cancelled") {
      numEl.style.color = "#8a8aa0";
      numEl.textContent = zh("Cancelled");
    } else if (cat === zh("done")) {
      barEl.style.width = "100%";
      barEl.style.background = "#3ecf8e";
      numEl.style.color = "#3ecf8e";
      numEl.textContent = "✓ done";
    } else {
      barEl.style.width = "0%";
      numEl.style.color = "#7a7a92";
      numEl.textContent = r.state === "partial" ? "got " + mb(r.have) : zh("Not downloaded");
    }
  }
}

const cssEscape = (s) => String(s).replace(/["\\]/g, "\\$&");
function bindCopy() {
  const btn = panel.querySelector("#mf-copy");
  if (!btn) return;
  btn.onclick = async () => {
    const txt = JSON.stringify(rows, null, 2);
    try {
      await navigator.clipboard.writeText(txt);
      btn.textContent = zh("Copied. Opening the issue page...");
      const title = encodeURIComponent("[unresolved] " + rows.filter(r => !r.url).map(r => r.name).join(", ").slice(0, 120));
      const body = encodeURIComponent("Please paste the diagnostics from your clipboard here (Ctrl+V).\n\n---\n\n");
      window.open("https://github.com/AinJuZen/ComfyUI-ModelMirror/issues/new?title=" + title + "&body=" + body, "_blank");
    } catch (e) {
      btn.textContent = "Copy failed";
      console.log(txt);
    }
    setTimeout(() => (btn.textContent = zh("Copy &amp; report")), 1500);
  };
}

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/'/g, "&#39;");

// ---------------------------------------------------------------- scan

async function scan() {
  if (scanning) return;
  scanning = true;
  statusMsg = "Scanning...";
  renderRows();

  const refs = collectModelRefs();
  if (!refs.length) {
    rows = [];
    statusMsg = "No model references found in the current workflow";
    scanning = false;
    renderRows();
    return;
  }

  let res;
  try {
    res = await fetch(API + "/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: refs }),
    }).then((r) => r.json());
  } catch (e) {
    statusMsg = "Check failed: " + e.message;
    scanning = false;
    renderRows();
    return;
  }

  rows = (res.items || []).map((it) => {
    const src = refs.find((r) => r.name === it.name);
    return { ...it, url: src?.url || "", size: 0, repo: "" };
  });

  const need = rows.filter((r) => r.state !== "complete" && !r.url).map((r) => r.name);
  if (need.length) {
    statusMsg = "Looking up download URLs on the mirror... the first run is slow (10-40s), then it is cached";
    renderRows();
    try {
      const rv = await fetch(API + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: need }),
      }).then((r) => r.json());
      const found = rv.found || {};
      for (const r of rows) {
        const f = found[r.name];
        if (f) {
          r.url = f.url;
          r.size = f.size || 0;
          r.repo = f.repo || "";
          if (f.directory && !r.dirKnown) r.directory = f.directory;
        }
      }
      // The folder was corrected - re-check existence, otherwise present files are reported missing.
      const res2 = await fetch(API + "/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: rows.map((r) => ({ name: r.name, directory: r.directory })) }),
      }).then((r) => r.json());
      for (const it of res2.items || []) {
        const r = rows.find((x) => x.name === it.name);
        if (r) { r.state = it.state; r.have = it.have; r.path = it.path; }
      }
    } catch (e) {
      log("resolve failed", e);
    }
  }

  statusMsg = "";
  scanning = false;
  renderRows();
}

async function startDownload(r) {
  pending.add(baseName(r.name));
  renderRows();
  try {
    const d = await fetch(API + "/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: r.url, name: r.name, directory: r.directory }),
    }).then((x) => x.json());
    if (d.error) alert("Submit failed: " + d.error);
    else statusMsg = "";
  } catch (e) {
    alert("Submit failed: " + e.message);
  }
  pollJobs();
}

async function postJob(path, name, btn) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name }),
    });
    if (!r.ok) {
      statusMsg =
        "endpoint " + path + " returned HTTP " + r.status +
        " — the backend is still running the old code. Restart the ComfyUI instance (reloading the page is not enough).";
      renderRows();
      return;
    }
    statusMsg = "";
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
  } catch (e) {
    statusMsg = "Request failed: " + e.message;
    renderRows();
  }
  setTimeout(pollJobs, 400);
}

// Batch actions are filtered by state, same as the Chrome download manager:
// not started -> start; paused/failed/cancelled -> resume; in progress -> skip.
async function downloadAll() {
  const list = rows.filter((r) => r.state !== "complete" && r.url);
  for (const r of list) {
    const j = jobFor(r.name);
    const busy = j && (j.state === "downloading" || j.state === "queued");
    if (busy) continue;
    await startDownload(r);
  }
}

// Batch button feedback: counts, busy state, disabled when there is nothing to do.
function updateBatchBar() {
  if (!panel) return;
  const all = panel.querySelector("#mf-all");
  const pa = panel.querySelector("#mf-pauseall");
  if (!all || !pa) return;

  const missing = rows.filter((r) => r.state !== "complete" && r.url);
  const busy = missing.filter((r) => {
    const j = jobFor(r.name);
    return j && (j.state === "downloading" || j.state === "queued");
  });
  const todo = missing.filter((r) => {
    const j = jobFor(r.name);
    return !j || !(j.state === "downloading" || j.state === "queued");
  });

  if (!batchBusy) {
    all.textContent = todo.length ? labelCount("Download all", todo.length) : zh("Download all");
    all.disabled = todo.length === 0;
    all.style.opacity = todo.length ? "1" : ".45";
    all.style.cursor = todo.length ? "pointer" : "default";
  }
  pa.textContent = busy.length ? labelCount("Pause all", busy.length) : zh("Pause all");
  pa.disabled = busy.length === 0;
  pa.style.opacity = busy.length ? "1" : ".45";
  pa.style.cursor = busy.length ? "pointer" : "default";
}

let batchBusy = false;

async function withBatchFeedback(btn, label, fn) {
  const old = btn.textContent;
  batchBusy = true;
  btn.disabled = true;
  btn.textContent = label;
  btn.style.opacity = ".6";
  try {
    await fn();
  } finally {
    setTimeout(() => {
      batchBusy = false;
      btn.textContent = old;
      btn.style.opacity = "";
      updateBatchBar();
    }, 600);
  }
}
async function pauseAll() {
  const busy = rows.filter((r) => {
    const j = jobFor(r.name);
    return j && (j.state === "downloading" || j.state === "queued");
  });
  if (!busy.length) return;
  try {
    await fetch("/mirror_fetch/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
  } catch (e) {
    log("Pause all failed", e);
  }
  setTimeout(pollJobs, 400);
}

// ---------------------------------------------------------------- polling

async function pollJobs() {
  if (!panel || panel.style.display !== "flex") return;
  try {
    const j = await fetch(API + "/jobs").then((r) => r.json());
    const next = {};
    for (const k of Object.keys(j)) {
      const nm = baseName(j[k].name);
      const cur = next[nm];
      // Prefer showing a running job when several exist.
      if (!cur || j[k].state === "downloading" || (cur.state !== "downloading" && j[k].job > cur.job)) {
        next[nm] = j[k];
      }
    }
    jobsBy = next;
    for (const nm of Array.from(pending)) {
      if (jobsBy[nm]) pending.delete(nm);
    }
  } catch (e) {
    return;
  }
  // Rebuild the DOM only when the state category changes; otherwise update numbers only.
  // Rebuilding the buttons every second swallows clicks - that was a real bug here.
  let changed = false;
  for (const r of rows) {
    const c = catOf(r);
    if (lastCats[r.name] !== c) { changed = true; break; }
  }
  if (changed) renderRows();
  else updateNumbers();
  updateBatchBar();
}

setInterval(pollJobs, 1000);

// ---------------------------------------------------------------- entry point (native panel only)

const BTN_STYLE =
  "display:flex;align-items:center;justify-content:center;gap:6px;" +
  "width:auto;margin:6px 10px 0;padding:6px 12px;" +
  "background:#243055;border:1px solid #3a4a7a;border-radius:6px;";

function fakeStyleFrom(el) {
  try {
    const cs = getComputedStyle(el);
    return BTN_STYLE + "border-radius:" + (cs.borderRadius || "6px") + ";" +
      "color:#cfd8ff;font:" + (cs.font || "13px system-ui") + ";cursor:pointer;";
  } catch (e) {
    return BTN_STYLE + "color:#cfd8ff;font:13px system-ui;cursor:pointer;";
  }
}

// The official button label in every locale we know - the injection point must match all of them.
const ALL_DL_LABELS = [
  "全部下载", "下载全部", "下载所有",
  "Download All", "Download all", "Download all missing",
  "Alle herunterladen", "Tout télécharger", "Descargar todo",
  "すべてダウンロード", "全部下載",
];

function injectInline() {
  if (document.getElementById("mirror-fetch-inline")) return true;
  const btns = Array.from(document.querySelectorAll("button"));

  let anchor = btns.find((b) => ALL_DL_LABELS.includes(b.textContent.trim()));

  // Fallback 1: find buttons inside the "Missing Models" container.
  if (!anchor) {
    const marker = Array.from(document.querySelectorAll("div,span,p,h1,h2,h3"))
      .find((el) => el.children.length === 0 && /Missing Models?|缺失模型/i.test(el.textContent || ""));
    if (marker) {
      const scope = marker.closest("div") || marker.parentElement;
      const inner = scope ? Array.from(scope.querySelectorAll("button")) : [];
      anchor = inner[inner.length - 1] || null;
    }
  }

  // Fallback 2: nothing matched -> mount a floating button so the feature stays reachable.
  if (!anchor) {
    mountFloating();
    return true;
  }

  const b = document.createElement("button");
  b.id = "mirror-fetch-inline";
  b.textContent = zh("Mirror Fetch");
  b.title = "Download missing models through a mirror (resumable)";
  b.style.cssText = fakeStyleFrom(anchor);
  b.onmouseenter = () => (b.style.background = "#2c3c66");
  b.onmouseleave = () => (b.style.background = "#243055");
  b.onclick = openPanel;
  anchor.parentElement.insertBefore(b, anchor.nextSibling);
  log("Injected into the missing-models panel");
  return true;
}

function mountFloating() {
  if (document.getElementById("mirror-fetch-float")) return;
  const b = document.createElement("button");
  b.id = "mirror-fetch-float";
  b.textContent = zh("Mirror Fetch");
  b.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:99997;padding:8px 14px;" +
    "background:#243055;border:1px solid #3a4a7a;border-radius:8px;color:#cfd8ff;" +
    "font:12px system-ui;cursor:pointer;opacity:.85";
  b.onclick = openPanel;
  document.body.appendChild(b);
}

let tries = 0;
const timer = setInterval(() => {
  tries++;
  injectInline();
  if (tries > 240) clearInterval(timer);
}, 500);

try {
  const mo = new MutationObserver(() => injectInline());
  mo.observe(document.body, { childList: true, subtree: true });
} catch (e) {
  log("MutationObserver is not available", e);
}

// ---------------------------------------------------------------- 中文本地化
// The source language is English (required for the registry listing).
// When the browser language is Chinese, T() swaps the display string at build time.
// 不用「渲染后再改 DOM」的做法：那会半途替换（中英混排），并让观察器自触发、面板闪烁。
const ZH_MODE = /^zh/i.test(navigator.language || "");

const ZH = {
  "Mirror Fetch": "镜像补缺",
  "Rescan": "重新扫描",
  "Download all (": "全部下载（",
  "Download all": "全部下载",
  "Pause all (": "全部暂停（",
  "Pause all": "全部暂停",
  "Download": "下载",
  "Pause": "暂停",
  "Resume": "继续",
  "Retry": "重试",
  "Cancel": "取消",
  "Redownload": "重新下载",
  "No URL": "无地址",
  "Copy & report": "复制并报告",
  "Copy &amp; report": "复制并报告",
  "Not downloaded": "未下载",
  "Preparing...": "准备中…",
  "Paused · ": "已暂停 · ",
  "Paused": "已暂停",
  "Cancelled": "已取消",
  "Failed: ": "失败：",
  "Copied. Opening the issue page...": "已复制，正在打开反馈页…",
  "done": "已完成",
  "Referenced ": "引用 ",
  " · with URL ": " 个 · 带地址 ",
  " · missing ": " 个 · 缺 ",
  "got ": "已下 ",
  "left ": "剩 ",
  " · resumed": " · 续传",
  "Missing Models": "缺失模型",
  "No model references found in the current workflow": "当前工作流没检测到模型引用",
  "These files were not found on the mirror. They may be private repos, or renamed after the fact.":
    "没在镜像上找到这几个文件，可能是私有仓库或者后来改过名。",
  "Click “Copy &amp; report” in the top right: it copies the diagnostics and opens the issue page.":
    "点右上「复制并报告」，会自动复制诊断信息并打开反馈页面。",
  "Click “Rescan” in the top right to see what is missing": "点右上「重新扫描」查看缺什么",
  "✓ Everything is already present": "✓ 全部已存在，不缺东西",
};

// 长键先换，免得 "Download all" 先把 "Download all (" 吃掉
const ZH_KEYS = Object.keys(ZH).sort((a, b) => b.length - a.length);

// 用函数声明而不是 const：函数声明会提升，模块求值期间调用也不会踩 TDZ。
function zh(s) { return T(s); }

function T(s) {
  if (!ZH_MODE || !s) return s;
  let out = s;
  for (const k of ZH_KEYS) {
    if (out.indexOf(k) >= 0) out = out.split(k).join(ZH[k]);
  }
  return out;
}

// 只跑一次：骨架是整段 innerHTML，字符串里塞不下逐个标点。
// 不是观察器，改完就结束，所以不会自触发。
// 计数标签：中文用全角括号，英文用半角加空格。一次拼好，不留给翻译层。
function labelCount(en, n) {
  return ZH_MODE ? zh(en) + "（" + n + "）" : en + " (" + n + ")";
}

function zhDom(root) {
  if (!ZH_MODE || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const v = node.nodeValue;
    if (!v || !v.trim()) continue;
    const nv = T(v);
    if (nv !== v) node.nodeValue = nv;
  }
  root.querySelectorAll("[title]").forEach((el) => {
    const a = el.getAttribute("title");
    const b = T(a);
    if (b !== a) el.setAttribute("title", b);
  });
}
// 加载标记：控制台里 window.__mirrorFetchBooted 为 true 说明模块起来了。
// 按钮不见了先看这个，能一眼分清「模块没加载」和「注入点没找到」。
try {
  window.__mirrorFetchBooted = true;
  console.log("[mirror-fetch] panel.js loaded, lang=" + (ZH_MODE ? "zh" : "en"));
} catch (e) {
  /* 忽略 */
}