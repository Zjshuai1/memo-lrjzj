// 周月备忘计划表 —— GitHub Pages 版前端逻辑（同步后端 = GitHub 仓库文件）
const API = "https://api.github.com";
const DATA_PATH = "memo-data.json";

const state = {
  items: [],
  view: "week",
  anchor: new Date(),
  filter: "all",
  search: "",
};
let editingId = null;
let modalOpen = false;
let lastSync = null;
let cfg = loadCfg();

/* ---------- 配置（settings） ---------- */
function loadCfg() { try { return JSON.parse(localStorage.getItem("memocfg") || "{}"); } catch { return {}; } }
function saveCfg() { localStorage.setItem("memocfg", JSON.stringify(cfg)); }

function b64decode(b64) {
  b64 = (b64 || "").replace(/\s/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function configured() { return !!(cfg.user && cfg.repo && cfg.token); }

/* ---------- GitHub 同步 ---------- */
async function ghGet() {
  const r = await fetch(`${API}/repos/${cfg.user}/${cfg.repo}/contents/${DATA_PATH}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}
async function load() {
  if (!configured()) { openSettings(); setStatus("请先配置 GitHub", true); return; }
  try {
    const j = await ghGet();
    if (j.notFound) { state.items = []; await save(); }
    else { const data = JSON.parse(b64decode(j.content)); state.items = data.items || []; }
    lastSync = new Date();
    render(); updateStatus();
  } catch (e) { setStatus("加载失败：" + e.message, true); }
}
async function save() {
  if (!configured()) return;
  try {
    let sha;
    try { const j = await ghGet(); if (!j.notFound) sha = j.sha; } catch (e) { /* 可能 404 */ }
    const body = { message: "update memo", content: b64encode(JSON.stringify({ items: state.items })) };
    if (sha) body.sha = sha;
    const r = await fetch(`${API}/repos/${cfg.user}/${cfg.repo}/contents/${DATA_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    lastSync = new Date();
    updateStatus();
  } catch (e) { setStatus("保存失败：" + e.message + "（点⟳重试）", true); }
}
function updateStatus() {
  const el = document.getElementById("status");
  if (!lastSync) { el.textContent = configured() ? "未同步" : "未配置"; return; }
  el.classList.remove("err");
  el.textContent = "已同步 " + lastSync.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function setStatus(t, err) {
  const el = document.getElementById("status");
  el.textContent = t;
  el.classList.toggle("err", !!err);
}

/* ---------- 日期工具 ---------- */
function fmt(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() { return fmt(new Date()); }
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mondayOf(d) { const x = new Date(d); const w = (x.getDay() + 6) % 7; return addDays(x, -w); }
function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/* ---------- 过滤/搜索 ---------- */
function matchesFilter(it) {
  if (state.filter === "pending" && it.status !== "pending") return false;
  if (state.filter === "done" && it.status !== "done") return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!(it.content.toLowerCase().includes(q) || (it.notes || "").toLowerCase().includes(q))) return false;
  }
  return true;
}
function itemsForDate(dateStr) { return state.items.filter((it) => it.date === dateStr && matchesFilter(it)); }
function scopeItems() {
  const a = state.anchor;
  if (state.view === "week") {
    const mon = mondayOf(a);
    const days = WEEK.map((_, i) => fmt(addDays(mon, i)));
    return state.items.filter((it) => days.includes(it.date));
  } else {
    const y = a.getFullYear(), m = a.getMonth();
    const lo = fmt(new Date(y, m, 1)), hi = fmt(new Date(y, m + 1, 0));
    return state.items.filter((it) => it.date >= lo && it.date <= hi);
  }
}

/* ---------- 渲染 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function itemCard(it) {
  const overdue = it.status === "pending" && it.date < todayStr();
  const cls = ["item", "p-" + it.priority, it.status === "done" ? "done" : "", overdue ? "overdue" : ""].join(" ").trim();
  const note = it.notes ? `<div class="inote">${esc(it.notes)}</div>` : "";
  return `<div class="${cls}" data-id="${it.id}">
    <div class="ititle"><span>${esc(it.content)}</span>
      <input class="chk" type="checkbox" data-id="${it.id}" ${it.status === "done" ? "checked" : ""} title="标记完成"/></div>
    ${note}
    <div class="imeta"><span class="pill ${it.priority}">${it.priority === "high" ? "高" : it.priority === "medium" ? "中" : "低"}</span>
      ${overdue ? '<span class="pill" style="background:#fee2e2;color:#dc2626">逾期</span>' : ""}</div>
  </div>`;
}
function renderWeek() {
  const mon = mondayOf(state.anchor);
  const today = todayStr();
  let html = '<div class="week">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const ds = fmt(d);
    const its = itemsForDate(ds);
    const list = its.length ? its.map(itemCard).join("") : '<div class="empty">暂无</div>';
    html += `<div class="day ${ds === today ? "today" : ""}">
      <div class="dhead"><span><span class="dname">${WEEK[i]}</span> <span class="dnum">${ds.slice(5)}</span></span>
        <button class="dadd" data-date="${ds}" title="添加">＋</button></div>
      <div class="dlist">${list}</div></div>`;
  }
  html += "</div>";
  return html;
}
function renderMonth() {
  const a = state.anchor, y = a.getFullYear(), m = a.getMonth();
  const first = new Date(y, m, 1);
  const mon = mondayOf(first);
  const today = todayStr();
  let html = '<div class="month">';
  for (let i = 0; i < 7; i++) html += `<div class="mhead">${WEEK[i]}</div>`;
  for (let w = 0; w < 6; w++) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, w * 7 + i);
      const ds = fmt(d);
      const its = itemsForDate(ds);
      const pend = its.filter((x) => x.status === "pending").length;
      const done = its.length - pend;
      const out = !sameMonth(d, first);
      const overdue = its.some((x) => x.status === "pending" && x.date < today);
      const badges = (pend || done)
        ? `<div class="mbadge">${pend ? `<span class="dot p"></span>${pend}` : ""}${done ? `<span class="dot d"></span>${done}` : ""}</div>`
        : "";
      html += `<div class="mcell ${out ? "out" : ""} ${ds === today ? "today" : ""}" data-date="${ds}">
        <div class="mnum">${d.getDate()}</div>${badges}${overdue ? '<div class="mtag">逾</div>' : ""}</div>`;
    }
  }
  html += "</div>";
  return html;
}
function render() {
  const view = document.getElementById("view");
  view.innerHTML = state.view === "week" ? renderWeek() : renderMonth();
  const a = state.anchor;
  if (state.view === "week") {
    const mon = mondayOf(a), sun = addDays(mon, 6);
    document.getElementById("rangeLabel").textContent = `${fmt(mon)} ~ ${fmt(sun)}`;
  } else {
    document.getElementById("rangeLabel").textContent = `${a.getFullYear()}年${a.getMonth() + 1}月`;
  }
  const scope = scopeItems();
  const total = scope.length;
  const done = scope.filter((x) => x.status === "done").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("progressText").textContent = total ? `完成率 ${pct}%（${done}/${total}）` : "完成率 —（本期无条目）";
  document.getElementById("overdueText").hidden = !scope.some((x) => x.status === "pending" && x.date < todayStr());
}

/* ---------- 弹窗 ---------- */
function openAdd(dateStr) {
  editingId = null;
  document.getElementById("modalTitle").textContent = "新建备忘";
  document.getElementById("fDate").value = dateStr || todayStr();
  document.getElementById("fContent").value = "";
  document.getElementById("fNotes").value = "";
  document.getElementById("fPriority").value = "medium";
  document.getElementById("fDone").checked = false;
  document.getElementById("deleteBtn").classList.add("hidden");
  showModal();
}
function openEdit(it) {
  editingId = it.id;
  document.getElementById("modalTitle").textContent = "编辑备忘";
  document.getElementById("fDate").value = it.date;
  document.getElementById("fContent").value = it.content;
  document.getElementById("fNotes").value = it.notes || "";
  document.getElementById("fPriority").value = it.priority;
  document.getElementById("fDone").checked = it.status === "done";
  document.getElementById("deleteBtn").classList.remove("hidden");
  showModal();
}
function showModal() { modalOpen = true; document.getElementById("modal").classList.remove("hidden"); document.getElementById("fContent").focus(); }
function closeModal() { modalOpen = false; document.getElementById("modal").classList.add("hidden"); }
function saveModal() {
  const content = document.getElementById("fContent").value.trim();
  if (!content) { alert("请填写内容"); return; }
  const obj = {
    date: document.getElementById("fDate").value || todayStr(),
    content,
    notes: document.getElementById("fNotes").value.trim(),
    priority: document.getElementById("fPriority").value,
    status: document.getElementById("fDone").checked ? "done" : "pending",
    completedAt: document.getElementById("fDone").checked ? new Date().toISOString() : null,
  };
  if (editingId) { const it = state.items.find((x) => x.id === editingId); Object.assign(it, obj); }
  else { state.items.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), createdAt: new Date().toISOString(), ...obj }); }
  closeModal(); render(); save();
}
function deleteItem() {
  if (!editingId) return;
  if (!confirm("确定删除这条备忘？")) return;
  state.items = state.items.filter((x) => x.id !== editingId);
  closeModal(); render(); save();
}

/* ---------- 事件 ---------- */
function toggleDone(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  if (it.status === "done") { it.status = "pending"; it.completedAt = null; }
  else { it.status = "done"; it.completedAt = new Date().toISOString(); }
  render(); save();
}
function openSettings() {
  document.getElementById("sUser").value = cfg.user || "";
  document.getElementById("sRepo").value = cfg.repo || "";
  document.getElementById("sToken").value = cfg.token || "";
  document.getElementById("settings").classList.remove("hidden");
}
function closeSettings() { document.getElementById("settings").classList.add("hidden"); }

document.getElementById("viewSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  state.view = b.dataset.view;
  document.querySelectorAll("#viewSeg button").forEach((x) => x.classList.toggle("active", x === b));
  render();
});
document.getElementById("prevBtn").addEventListener("click", () => {
  state.anchor = state.view === "week" ? addDays(state.anchor, -7) : new Date(state.anchor.getFullYear(), state.anchor.getMonth() - 1, 1);
  render();
});
document.getElementById("nextBtn").addEventListener("click", () => {
  state.anchor = state.view === "week" ? addDays(state.anchor, 7) : new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
  render();
});
document.getElementById("todayBtn").addEventListener("click", () => { state.anchor = new Date(); render(); });
document.getElementById("filter").addEventListener("change", (e) => { state.filter = e.target.value; render(); });
document.getElementById("search").addEventListener("input", (e) => { state.search = e.target.value.trim(); render(); });
document.getElementById("refreshBtn").addEventListener("click", () => load());
document.getElementById("addFab").addEventListener("click", () => openAdd(todayStr()));
document.getElementById("saveBtn").addEventListener("click", saveModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
document.getElementById("deleteBtn").addEventListener("click", deleteItem);
document.getElementById("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.getElementById("gearBtn").addEventListener("click", openSettings);
document.getElementById("sCancel").addEventListener("click", closeSettings);
document.getElementById("sSave").addEventListener("click", () => {
  cfg.user = document.getElementById("sUser").value.trim();
  cfg.repo = document.getElementById("sRepo").value.trim();
  cfg.token = document.getElementById("sToken").value.trim();
  if (!cfg.user || !cfg.repo || !cfg.token) { alert("三项都要填写"); return; }
  saveCfg(); closeSettings(); load();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalOpen) closeModal(); });

document.getElementById("view").addEventListener("click", (e) => {
  const chk = e.target.closest(".chk");
  if (chk) { e.stopPropagation(); toggleDone(chk.dataset.id); return; }
  const add = e.target.closest(".dadd");
  if (add) { openAdd(add.dataset.date); return; }
  const cell = e.target.closest(".mcell");
  if (cell) { openAdd(cell.dataset.date); return; }
  const card = e.target.closest(".item");
  if (card) { const it = state.items.find((x) => x.id === card.dataset.id); if (it) openEdit(it); }
});

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); });
}

/* 跨设备同步：每 30 秒静默刷新（未配置/弹窗打开时跳过） */
setInterval(() => { if (configured() && !modalOpen) load(); }, 30000);

load();
