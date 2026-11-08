// ComfyUI 镜像补缺 · 前端面板
// 缺模型时，一键从可配置的镜像端点补齐，带断点续传和实时进度。
// 不改官方任何文件。

const API = "/mirror_fetch";

const MODEL_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i;

const log = (...a) => console.log("[mirror-fetch]", ...a);
const mb = (n) => {
  if (!n) return "0";
  return n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB";
};
const baseName = (p) => String(p || "").split(/[\\/]/).pop();

// ---------------------------------------------------------------- 收集模型引用

// 控件名 → ComfyUI 目录（权威映射：控件可选值本身就来自这个目录）
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

// 深度扫描：不管 URL 藏在哪一层，对象长成 {name, url, directory} 就抓出来
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
          // 控件名决定目录：这个控件能选什么，是从那个目录里读的
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

// ---------------------------------------------------------------- 状态

let panel = null;
let rows = [];        // 当前缺失/存在的行
let jobsBy = {};      // basename -> job
const pending = new Set();  // 刚点下载、后端还没回报的名字
let scanning = false;
let statusMsg = "";

// ---------------------------------------------------------------- 面板骨架

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
      '<b style="flex:1">镜像补缺</b>' +
      '<span id="mf-mirror" style="font-size:11px;color:#8a8aa0"></span>' +
      '<button id="mf-scan" style="background:#2e2e42;border:0;color:#e6e6ef;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">重新扫描</button>' +
      '<span id="mf-close" style="cursor:pointer;color:#8a8aa0;padding:0 4px">✕</span>' +
    '</div>' +
    '<div id="mf-body" style="padding:10px 14px;overflow:auto;flex:1"></div>' +
    '<div style="padding:10px 14px;border-top:1px solid #2e2e42;display:flex;gap:8px">' +
      '<button id="mf-all" style="flex:1;background:#4a7dff;border:0;color:#fff;border-radius:8px;padding:8px;cursor:pointer;font-weight:600">全部下载</button>' +
      '<button id="mf-pauseall" style="background:#3a3a52;border:0;color:#cfd8ff;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600">全部暂停</button>' +
    '</div>';

  document.body.appendChild(panel);
  panel.querySelector("#mf-close").onclick = () => (panel.style.display = "none");
  panel.querySelector("#mf-scan").onclick = () => scan();
  panel.querySelector("#mf-all").onclick = () => withBatchFeedback(panel.querySelector("#mf-all"), "提交中…", downloadAll);
  panel.querySelector("#mf-pauseall").onclick = () => withBatchFeedback(panel.querySelector("#mf-pauseall"), "暂停中…", pauseAll);

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

// ---------------------------------------------------------------- 渲染

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
  return r.state === "complete" ? "done" : "idle";
}

let lastCats = {};

// 全量重绘（只在状态类别变化时调用）
function renderRows() {
  if (!panel) return;
  const body = panel.querySelector("#mf-body");
  if (!body) return;

  const withUrl = rows.filter((r) => r.url).length;
  const missing = rows.filter((r) => r.state !== "complete");

  let html =
    '<div style="display:flex;align-items:center;gap:8px;padding:2px 0 9px;border-bottom:1px solid #22222f;margin-bottom:8px;font-size:11px;color:#8a8aa0">' +
      '<span style="flex:1">引用 ' + rows.length + " 个 · 带地址 " + withUrl + " 个 · 缺 " + missing.length + " 个</span>" +
      '<button id="mf-copy" style="background:#2e2e42;border:0;color:#cfd8ff;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px">复制诊断</button>' +
    "</div>";

  if (statusMsg) {
    html += '<div style="color:#f0c060;padding:2px 0 10px;font-size:12px">' + escapeHtml(statusMsg) + "</div>";
  }

  if (!rows.length) {
    body.innerHTML = html + '<div style="color:#8a8aa0;padding:20px 0;text-align:center">点右上「重新扫描」查看缺什么</div>';
    bindCopy();
    return;
  }
  if (!missing.length) {
    body.innerHTML = html + '<div style="color:#3ecf8e;padding:20px 0;text-align:center">✓ 全部已存在，不缺东西</div>';
    bindCopy();
    return;
  }
  if (!withUrl) {
    html += '<div style="color:#f0c060;padding:8px 0 12px;font-size:12px;line-height:1.6">找不到下载地址。点「复制诊断」把结果发我。</div>';
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
      right = '<span style="font-size:11px;color:#3ecf8e;flex-shrink:0">✓ 已存在</span>';
    } else if (cat === "downloading" || cat === "queued") {
      right = '<div style="display:flex;gap:4px;flex-shrink:0">' + btn("mf-pause", "暂停", "#3a3a52") + btn("mf-cancel", "取消", "#4a2530") + "</div>";
    } else if (cat === "pending") {
      right = '<div style="display:flex;gap:4px;flex-shrink:0">' + btn("mf-cancel", "取消", "#4a2530") + "</div>";
    } else if (cat === "paused") {
      color = "#f0c060";
      right = '<div style="display:flex;gap:4px;flex-shrink:0">' + btn("mf-dl", "继续", "#4a7dff") + btn("mf-cancel", "取消", "#4a2530") + "</div>";
    } else if (cat === "error") {
      color = "#ff6b6b";
      right = btn("mf-dl", "重试", "#4a7dff");
    } else if (cat === "cancelled") {
      right = btn("mf-dl", "重新下载", "#4a7dff");
    } else {
      right = r.url
        ? btn("mf-dl", "下载", "#4a7dff")
        : '<button disabled style="background:#2e2e42;border:0;color:#666680;border-radius:6px;padding:5px 12px">无地址</button>';
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

  body.innerHTML = html;
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

// 只改数字和进度条，不重建 DOM —— 这样按钮不会被秒刷掉，点击就不会丢
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
      const eta = job.eta ? "剩 " + Math.round(job.eta) + " 秒" : "";
      numEl.style.color = "#4a7dff";
      numEl.textContent = pct.toFixed(0) + "% · " + mb(job.done) + " / " + mb(job.total) +
        " · " + sp + " · " + eta + (job.resumed ? " · 续传" : "");
    } else if (cat === "pending") {
      barEl.style.width = "0%";
      numEl.style.color = "#8a8aa0";
      numEl.textContent = "准备中…";
    } else if (cat === "paused") {
      barEl.style.width = pct.toFixed(1) + "%";
      barEl.style.background = "#f0c060";
      numEl.style.color = "#f0c060";
      numEl.textContent = "已暂停 · " + mb(job.done) + " / " + mb(job.total);
    } else if (cat === "error") {
      barEl.style.width = "100%";
      barEl.style.background = "#ff6b6b";
      numEl.style.color = "#ff6b6b";
      numEl.textContent = "失败：" + String(job.error || "").slice(0, 60);
    } else if (cat === "cancelled") {
      numEl.style.color = "#8a8aa0";
      numEl.textContent = "已取消";
    } else if (cat === "done") {
      barEl.style.width = "100%";
      barEl.style.background = "#3ecf8e";
      numEl.style.color = "#3ecf8e";
      numEl.textContent = "✓ 已完成";
    } else {
      barEl.style.width = "0%";
      numEl.style.color = "#7a7a92";
      numEl.textContent = r.state === "partial" ? "已下 " + mb(r.have) : "未下载";
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
      btn.textContent = "已复制";
    } catch (e) {
      btn.textContent = "复制失败";
      console.log(txt);
    }
    setTimeout(() => (btn.textContent = "复制诊断"), 1500);
  };
}

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/'/g, "&#39;");

// ---------------------------------------------------------------- 扫描

async function scan() {
  if (scanning) return;
  scanning = true;
  statusMsg = "正在扫描…";
  renderRows();

  const refs = collectModelRefs();
  if (!refs.length) {
    rows = [];
    statusMsg = "当前工作流没检测到模型引用";
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
    statusMsg = "检查失败：" + e.message;
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
    statusMsg = "正在镜像上查找下载地址…（首次约 10 秒，之后有缓存）";
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
      // 目录被纠正过 → 重新校验存在性，否则会把已有的文件报成缺失
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
      log("resolve 失败", e);
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
    if (d.error) alert("提交失败：" + d.error);
    else statusMsg = "";
  } catch (e) {
    alert("提交失败：" + e.message);
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
        "接口 " + path + " 返回 HTTP " + r.status +
        " —— 后端没加载新代码，请重启 ComfyUI 实例（不是刷新页面）";
      renderRows();
      return;
    }
    statusMsg = "";
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
  } catch (e) {
    statusMsg = "请求失败：" + e.message;
    renderRows();
  }
  setTimeout(pollJobs, 400);
}

// 按状态批量操作，跟 Chrome 下载器一致：
// 没开始的 → 开始；已暂停/失败/已取消 → 继续；正在下的 → 跳过
async function downloadAll() {
  const list = rows.filter((r) => r.state !== "complete" && r.url);
  for (const r of list) {
    const j = jobFor(r.name);
    const busy = j && (j.state === "downloading" || j.state === "queued");
    if (busy) continue;
    await startDownload(r);
  }
}

// 批量按钮的状态反馈：数量、忙闲、没得做时禁用
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
    all.textContent = todo.length ? "全部下载（" + todo.length + "）" : "全部下载";
    all.disabled = todo.length === 0;
    all.style.opacity = todo.length ? "1" : ".45";
    all.style.cursor = todo.length ? "pointer" : "default";
  }
  pa.textContent = busy.length ? "全部暂停（" + busy.length + "）" : "全部暂停";
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
    log("全部暂停失败", e);
  }
  setTimeout(pollJobs, 400);
}

// ---------------------------------------------------------------- 轮询

async function pollJobs() {
  if (!panel || panel.style.display !== "flex") return;
  try {
    const j = await fetch(API + "/jobs").then((r) => r.json());
    const next = {};
    for (const k of Object.keys(j)) {
      const nm = baseName(j[k].name);
      const cur = next[nm];
      // 有正在跑的优先显示正在跑的
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
  // 只有"状态类别"变化时才重建 DOM；否则只更新数字——
  // 否则每秒重建按钮，点击会被吞掉（这是"点好几次才有反应"的根因）
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

// ---------------------------------------------------------------- 入口（只放右侧原生面板里）

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

// 官方那个按钮各语言下的文案 —— 注入点必须跨语言都能命中
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

  // 兜底 1：找"缺失模型 / Missing Models"这块容器里的按钮
  if (!anchor) {
    const marker = Array.from(document.querySelectorAll("div,span,p,h1,h2,h3"))
      .find((el) => el.children.length === 0 && /缺失模型|Missing Models?|Missing models/i.test(el.textContent || ""));
    if (marker) {
      const scope = marker.closest("div") || marker.parentElement;
      const inner = scope ? Array.from(scope.querySelectorAll("button")) : [];
      anchor = inner[inner.length - 1] || null;
    }
  }

  // 兜底 2：都没找到 → 挂一个浮动按钮，保证功能可达
  if (!anchor) {
    mountFloating();
    return true;
  }

  const b = document.createElement("button");
  b.id = "mirror-fetch-inline";
  b.textContent = "镜像补缺";
  b.title = "缺的模型从国内镜像下载（断点续传）";
  b.style.cssText = fakeStyleFrom(anchor);
  b.onmouseenter = () => (b.style.background = "#2c3c66");
  b.onmouseleave = () => (b.style.background = "#243055");
  b.onclick = openPanel;
  anchor.parentElement.insertBefore(b, anchor.nextSibling);
  log("已插入到缺失模型面板");
  return true;
}

function mountFloating() {
  if (document.getElementById("mirror-fetch-float")) return;
  const b = document.createElement("button");
  b.id = "mirror-fetch-float";
  b.textContent = "镜像补缺";
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
  log("MutationObserver 不可用", e);
}
