// 周月备忘计划表 —— GitHub Pages 版前端逻辑（含重复/聚焦/通知/离线/拖拽/冲突/标签/统计/快捷/节假日）
const API = "https://api.github.com";
const DATA_PATH = "memo-data.json";
const DATA_REPO = "memo-lrjzj-data"; // 私有数据仓库（仅存数据）

/* ============ 基础工具 ============ */
const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WD = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
// 莫兰迪淡色标签色板
const TAG_COLORS = ["#9caf88", "#c28b8b", "#c9b08a", "#8fa3b3", "#b09ab7", "#a3b1a1", "#cbb6c2", "#bfa98f"];

const state = {
  items: [], view: "week", anchor: new Date(),
  filter: "all", search: "", tagFilter: "",
};
let editingId = null, modalOpen = false, lastSync = null, outbox = false;
let conflictRemote = null, conflictSha = null;
let notified = new Set(JSON.parse(localStorage.getItem("memonotified") || "[]"));

const cfg = loadCfg();
function loadCfg() { try { return JSON.parse(localStorage.getItem("memocfg") || "{}"); } catch { return {}; } }
function saveCfg() { localStorage.setItem("memocfg", JSON.stringify(cfg)); }
function configured() { return !!(cfg.user && cfg.token); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); }

function b64decode(b64) {
  b64 = (b64 || "").replace(/\s/g, "");
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str); let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* ============ 日期工具 ============ */
function fmt(d) { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0"); return `${y}-${m}-${day}`; }
function todayStr() { return fmt(new Date()); }
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mondayOf(d) { const x = new Date(d); const w = (x.getDay() + 6) % 7; return addDays(x, -w); }
function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
function priName(p) { return p === "high" ? "高" : p === "low" ? "低" : "中"; }
function tagColor(t) { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TAG_COLORS[h % TAG_COLORS.length]; }

/* ============ 节假日 / 调休（可编辑，以国务院公布为准） ============ */
const HOLIDAYS = {
  "2026-01-01": "元旦",
  "2026-02-17": "春节", "2026-02-18": "春节", "2026-02-19": "春节", "2026-02-20": "春节", "2026-02-21": "春节", "2026-02-22": "春节", "2026-02-23": "春节",
  "2026-04-04": "清明", "2026-04-05": "清明", "2026-04-06": "清明",
  "2026-05-01": "劳动节", "2026-05-02": "劳动节", "2026-05-03": "劳动节", "2026-05-04": "劳动节", "2026-05-05": "劳动节",
  "2026-06-19": "端午", "2026-06-20": "端午", "2026-06-21": "端午",
  "2026-09-25": "中秋", "2026-09-26": "中秋", "2026-09-27": "中秋",
  "2026-10-01": "国庆", "2026-10-02": "国庆", "2026-10-03": "国庆", "2026-10-04": "国庆", "2026-10-05": "国庆", "2026-10-06": "国庆", "2026-10-07": "国庆",
  "2027-01-01": "元旦",
};
const WORKDAYS = { "2026-02-14": "班", "2026-05-09": "班", "2026-10-10": "班" };

/* ============ GitHub 同步 ============ */
async function ghGet() {
  const r = await fetch(`${API}/repos/${cfg.user}/${DATA_REPO}/contents/${DATA_PATH}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}
function cacheData() { try { localStorage.setItem("memocache", JSON.stringify({ items: state.items, at: Date.now() })); } catch (e) {} }

async function load() {
  if (!configured()) { openSettings(); setStatus("请先配置 GitHub", true); render(); return; }
  try {
    const j = await ghGet();
    if (j.notFound) {
      if (state.items.length === 0) state.items = [];
    } else {
      // 合并而非整体替换：保留本地尚未保存的项，避免刚创建的内容被远端快照覆盖导致“变空白”
      const remoteItems = JSON.parse(b64decode(j.content)).items || [];
      const localIds = new Set(state.items.map((i) => i.id));
      const merged = state.items.slice();
      for (const r of remoteItems) if (!localIds.has(r.id)) merged.push(r);
      state.items = merged;
    }
    lastSync = new Date(); outbox = false; cacheData(); render(); updateStatus();
  } catch (e) {
    const c = localStorage.getItem("memocache");
    if (c) { try { state.items = JSON.parse(c).items || []; render(); setStatus("离线（本地缓存）", true); return; } catch (_) {} }
    setStatus("加载失败：" + e.message, true);
  }
}
async function doSave(remoteSha) {
  if (!configured()) return;
  let sha = remoteSha;
  if (sha === undefined) { try { const j = await ghGet(); if (!j.notFound) sha = j.sha; } catch (e) {} }
  try {
    const body = { message: "update memo", content: b64encode(JSON.stringify({ items: state.items })) };
    if (sha) body.sha = sha;
    const r = await fetch(`${API}/repos/${cfg.user}/${DATA_REPO}/contents/${DATA_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 409) { handleConflict(); return; }
    if (r.status === 401 || r.status === 403) { setStatus("Token 无效或无权限", true); outbox = true; return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    lastSync = new Date(); outbox = false; cacheData(); updateStatus();
  } catch (e) {
    outbox = true; cacheData(); setStatus("离线：已本地保存，联网后自动同步", true);
  }
}
function save() { doSave(); }

async function handleConflict() {
  try {
    const j = await ghGet();
    conflictRemote = (JSON.parse(b64decode(j.content)).items) || [];
    conflictSha = j.sha;
    document.getElementById("conflict").classList.remove("hidden");
  } catch (e) { setStatus("冲突处理失败，请点⟳重试", true); }
}
function mergeItems(remote, local) {
  const map = new Map(); remote.forEach((it) => map.set(it.id, it));
  local.forEach((it) => map.set(it.id, it)); // 本机优先
  return [...map.values()];
}

function updateStatus() {
  const el = document.getElementById("status");
  if (outbox) { el.textContent = "离线待同步"; el.className = "status offline"; return; }
  if (!lastSync) { el.textContent = configured() ? "未同步" : "未配置"; el.className = "status"; return; }
  el.className = "status";
  el.textContent = "已同步 " + lastSync.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function setStatus(t, err) {
  const el = document.getElementById("status");
  el.textContent = t; el.className = "status" + (err ? " err" : "");
}

/* ============ 重复 / 出现（occurrence）模型 ============ */
function isRecur(it) { return it.recur && it.recur.type && it.recur.type !== "none"; }
function recurMatches(it, ds) {
  const r = it.recur, d = parse(ds), s = parse(it.date);
  if (ds < it.date) return false;
  if (r.endDate && ds > r.endDate) return false;
  if (r.type === "daily") return true;
  if (r.type === "weekday") { const w = d.getDay(); return w >= 1 && w <= 5; }
  if (r.type === "weekly") return d.getDay() === s.getDay();
  if (r.type === "biweekly") { if (d.getDay() !== s.getDay()) return false; const wk = Math.floor((d - s) / (7 * 86400000)); return wk % 2 === 0; }
  if (r.type === "monthly") return d.getDate() === s.getDate();
  if (r.type === "yearly") return d.getMonth() === s.getMonth() && d.getDate() === s.getDate();
  return false;
}
function occOn(ds) {
  const out = [];
  for (const it of state.items) {
    if (isRecur(it)) { if (recurMatches(it, ds)) out.push({ it, ds, done: !!(it.completed && it.completed[ds]) }); }
    else if (it.date === ds) out.push({ it, ds, done: it.status === "done" });
  }
  return out;
}
function filterOcc(o) {
  const it = o.it;
  if (state.tagFilter && it.tag !== state.tagFilter) return false;
  if (state.filter === "pending" && o.done) return false;
  if (state.filter === "done" && !o.done) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!(it.content.toLowerCase().includes(q) || (it.notes || "").toLowerCase().includes(q))) return false;
  }
  return true;
}
function occDoneSet(o, val) {
  const it = o.it;
  if (isRecur(it)) { it.completed = it.completed || {}; if (val) it.completed[o.ds] = true; else delete it.completed[o.ds]; }
  else { it.status = val ? "done" : "pending"; it.completedAt = val ? new Date().toISOString() : null; }
}
function itemsForDate(ds) { return occOn(ds).filter(filterOcc); }
function scopeOccs() {
  let dates = [];
  if (state.view === "week") { const mon = mondayOf(state.anchor); for (let i = 0; i < 7; i++) dates.push(fmt(addDays(mon, i))); }
  else if (state.view === "month") { const a = state.anchor, y = a.getFullYear(), m = a.getMonth(); const n = new Date(y, m + 1, 0).getDate(); for (let i = 1; i <= n; i++) dates.push(fmt(new Date(y, m, i))); }
  else { dates = [todayStr()]; }
  let occs = [];
  for (const ds of dates) for (const o of occOn(ds)) occs.push(o);
  if (state.view === "focus") {
    for (const it of state.items) if (!isRecur(it) && it.date < todayStr() && it.status !== "done") occs.push({ it, ds: it.date, done: false });
  }
  return occs;
}

/* ============ 渲染 ============ */
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function recurBadge(it) { return isRecur(it) ? '<span class="pill recur">🔁</span>' : ""; }
function tagPill(it) { return it.tag ? `<span class="pill tag" style="background:${tagColor(it.tag)}">${esc(it.tag)}</span>` : ""; }

/* 可爱小装饰 SVG（莫兰迪淡色） */
function cuteSVG(kind) {
  if (kind === "bunny") return `<svg class="cute" viewBox="0 0 64 64" width="58" height="58" aria-hidden="true">
    <ellipse cx="32" cy="42" rx="18" ry="15" fill="#f1e7df"/>
    <ellipse cx="22" cy="17" rx="6" ry="14" fill="#f1e7df"/>
    <ellipse cx="42" cy="17" rx="6" ry="14" fill="#f1e7df"/>
    <ellipse cx="22" cy="17" rx="3" ry="10" fill="#e7c7bd"/>
    <ellipse cx="42" cy="17" rx="3" ry="10" fill="#e7c7bd"/>
    <circle cx="26" cy="40" r="2.4" fill="#6b6258"/>
    <circle cx="38" cy="40" r="2.4" fill="#6b6258"/>
    <path d="M29 45 q3 2.4 6 0" stroke="#c08471" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <circle cx="32" cy="43.5" r="1.6" fill="#c08471"/>
    <circle cx="20" cy="44" r="2.4" fill="#e7b6ac" opacity=".6"/>
    <circle cx="44" cy="44" r="2.4" fill="#e7b6ac" opacity=".6"/></svg>`;
  if (kind === "sprout") return `<svg class="cute" viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
    <path d="M32 56 v-20" stroke="#9caf88" stroke-width="3" stroke-linecap="round"/>
    <path d="M32 44 q-15 -2 -17 -17 q15 0 17 13" fill="#b2c49c"/>
    <path d="M32 41 q15 -2 17 -17 q-15 0 -17 13" fill="#9caf88"/>
    <path d="M32 52 q-11 0 -13 -11 q11 0 13 9" fill="#c9a66b"/></svg>`;
  if (kind === "flower") return `<svg class="cute" viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">
    <circle cx="32" cy="32" r="6" fill="#e7c7bd"/>
    <g fill="#cf9aa6"><circle cx="32" cy="18" r="7"/><circle cx="46" cy="32" r="7"/><circle cx="32" cy="46" r="7"/><circle cx="18" cy="32" r="7"/></g>
    <path d="M32 52 v8" stroke="#9caf88" stroke-width="3" stroke-linecap="round"/></svg>`;
  return "";
}
function emptyCute(text, kind) {
  return `<div class="empty cute-empty">${cuteSVG(kind || "bunny")}<div>${esc(text)}</div></div>`;
}

function itemCard(o) {
  const it = o.it, overdue = !o.done && o.ds < todayStr();
  const cls = ["item", "p-" + it.priority, o.done ? "done" : "", overdue ? "overdue" : "", isRecur(it) ? "recur" : "nodrag"].join(" ").trim();
  const note = it.notes ? `<div class="inote">${esc(it.notes)}</div>` : "";
  const drag = isRecur(it) ? "" : 'draggable="true"';
  return `<div class="${cls}" data-id="${it.id}" data-date="${o.ds}" ${drag}>
    <div class="ititle"><span>${esc(it.content)}</span>
      <input class="chk" type="checkbox" data-id="${it.id}" data-date="${o.ds}" ${o.done ? "checked" : ""} title="标记完成"/></div>
    ${note}
    <div class="imeta">
      <span class="pill ${it.priority}">${priName(it.priority)}</span>
      ${tagPill(it)} ${recurBadge(it)}
      ${overdue ? '<span class="pill" style="background:var(--rose-soft);color:var(--high)">逾期</span>' : ""}
    </div>
  </div>`;
}
function renderWeek() {
  const mon = mondayOf(state.anchor), today = todayStr();
  let html = '<div class="week">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i), ds = fmt(d);
    const its = itemsForDate(ds);
    const list = its.length ? its.map(itemCard).join("") : emptyCute("这一天还没有安排哦～", "bunny");
    html += `<div class="day ${ds === today ? "today" : ""}" data-date="${ds}">
      <div class="dhead"><span><span class="dname">${WEEK[i]}</span> <span class="dnum">${ds.slice(5)}</span></span>
        <button class="dadd" data-date="${ds}" title="添加">＋</button></div>
      <div class="dlist">${list}</div></div>`;
  }
  return html + "</div>";
}
function renderMonth() {
  const a = state.anchor, y = a.getFullYear(), m = a.getMonth();
  const first = new Date(y, m, 1), mon = mondayOf(first), today = todayStr();
  let html = '<div class="month">';
  for (let i = 0; i < 7; i++) html += `<div class="mhead">${WEEK[i]}</div>`;
  for (let w = 0; w < 6; w++) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, w * 7 + i), ds = fmt(d);
      const its = itemsForDate(ds);
      const pend = its.filter((x) => !x.done).length, done = its.length - pend;
      const out = !sameMonth(d, first);
      const overdue = its.some((x) => !x.done && x.ds < today);
      const badges = (pend || done) ? `<div class="mbadge">${pend ? `<span class="dot p"></span>${pend}` : ""}${done ? `<span class="dot d"></span>${done}` : ""}</div>` : "";
      const hol = HOLIDAYS[ds], wk = WORKDAYS[ds];
      const mark = wk ? `<span class="hwk">班</span>` : hol ? `<span class="hhol">休</span>` : "";
      html += `<div class="mcell ${out ? "out" : ""} ${ds === today ? "today" : ""}" data-date="${ds}">
        <div class="mnum">${d.getDate()}${mark}</div>
        ${hol ? `<div class="mhol">${hol}</div>` : ""}
        ${badges}${overdue ? '<div class="mtag">逾</div>' : ""}</div>`;
    }
  }
  return html + "</div>";
}
function focusRow(o) {
  const overdue = !o.done && o.ds < todayStr();
  return `<div class="frow ${o.done ? "done" : ""} ${overdue ? "overdue" : ""}" data-id="${o.it.id}" data-date="${o.ds}">
    <input class="chk" type="checkbox" data-id="${o.it.id}" data-date="${o.ds}" ${o.done ? "checked" : ""}/>
    <div class="fmain"><div class="ftitle">${esc(o.it.content)}</div>
      <div class="fsub">${o.ds.slice(5)}${o.it.tag ? " · " + esc(o.it.tag) : ""} · ${priName(o.it.priority)}${isRecur(o.it) ? " · 🔁" : ""}</div></div>
    ${overdue ? '<span class="pill" style="background:var(--rose-soft);color:var(--high)">逾期</span>' : ""}
  </div>`;
}
function renderFocus() {
  const today = todayStr();
  const todayOcc = occOn(today).filter(filterOcc).sort((a, b) => (a.it.priority === "high" ? 0 : 1) - (b.it.priority === "high" ? 0 : 1));
  const overdue = [];
  for (const it of state.items) if (!isRecur(it) && it.date < today && it.status !== "done" && filterOcc({ it, ds: it.date, done: false })) overdue.push({ it, ds: it.date, done: false });
  overdue.sort((a, b) => (a.ds < b.ds ? -1 : 1));
  let h = '<div class="focus">';
  h += `<div class="fsec"><div class="fhead">📌 今天（${today}）</div><div class="flist">`;
  h += todayOcc.length ? todayOcc.map(focusRow).join("") : emptyCute("今天还没有安排，给自己放个小假吧～", "sprout");
  h += '</div></div>';
  h += `<div class="fsec"><div class="fhead overdue">⚠ 逾期（${overdue.length}）</div><div class="flist">`;
  h += overdue.length ? overdue.map(focusRow).join("") : emptyCute("没有逾期，棒棒哒 🎉", "flower");
  h += '</div></div></div>';
  return h;
}
function render() {
  try {
    const view = document.getElementById("view");
    view.innerHTML = state.view === "week" ? renderWeek() : state.view === "month" ? renderMonth() : renderFocus();
    const a = state.anchor;
    if (state.view === "week") { const mon = mondayOf(a), sun = addDays(mon, 6); document.getElementById("rangeLabel").textContent = `${fmt(mon)} ~ ${fmt(sun)}`; }
    else if (state.view === "month") document.getElementById("rangeLabel").textContent = `${a.getFullYear()}年${a.getMonth() + 1}月`;
    else document.getElementById("rangeLabel").textContent = "今日聚焦";

    const occs = scopeOccs();
    const total = occs.length, done = occs.filter((x) => x.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById("progressFill").style.width = pct + "%";
    document.getElementById("progressText").textContent = total ? `完成率 ${pct}%（${done}/${total}）` : "完成率 —（本期无条目）";
    document.getElementById("overdueText").hidden = !occs.some((x) => !x.done && x.ds < todayStr());
    refreshTagFilter();
    bindDnD();
  } catch (e) {
    console.error("render error:", e);
    const view = document.getElementById("view");
    if (view) view.innerHTML = '<div class="empty">渲染出错，请刷新页面重试（' + (e && e.message || e) + '）</div>';
  }
}

/* ============ 标签筛选 ============ */
function refreshTagFilter() {
  const sel = document.getElementById("tagFilter");
  const cur = sel.value;
  const tags = [...new Set(state.items.map((i) => i.tag).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部标签</option>' + tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  sel.value = tags.includes(cur) ? cur : "";
}

/* ============ 弹窗：新增/编辑 ============ */
function openAdd(dateStr) {
  editingId = null;
  document.getElementById("modalTitle").textContent = "新建备忘";
  document.getElementById("fDate").value = dateStr || todayStr();
  document.getElementById("fContent").value = "";
  document.getElementById("fNotes").value = "";
  document.getElementById("fTag").value = "";
  document.getElementById("fPriority").value = "medium";
  document.getElementById("fRecur").value = "none";
  document.getElementById("fRecurEnd").value = "";
  document.getElementById("fDone").checked = false;
  document.getElementById("recurEndWrap").style.display = "";
  document.getElementById("doneWrap").style.display = "";
  document.getElementById("recurHint").hidden = true;
  document.getElementById("deleteBtn").classList.add("hidden");
  showModal();
}
function openEdit(it) {
  editingId = it.id;
  document.getElementById("modalTitle").textContent = "编辑备忘";
  document.getElementById("fDate").value = it.date;
  document.getElementById("fContent").value = it.content;
  document.getElementById("fNotes").value = it.notes || "";
  document.getElementById("fTag").value = it.tag || "";
  document.getElementById("fPriority").value = it.priority;
  const rt = isRecur(it) ? it.recur.type : "none";
  document.getElementById("fRecur").value = rt;
  document.getElementById("fRecurEnd").value = isRecur(it) && it.recur.endDate ? it.recur.endDate : "";
  document.getElementById("recurEndWrap").style.display = isRecur(it) ? "" : "none";
  document.getElementById("doneWrap").style.display = isRecur(it) ? "none" : "";
  document.getElementById("recurHint").hidden = !isRecur(it);
  document.getElementById("deleteBtn").classList.remove("hidden");
  showModal();
}
function showModal() { modalOpen = true; document.getElementById("modal").classList.remove("hidden"); document.getElementById("fContent").focus(); }
function closeModal() { modalOpen = false; document.getElementById("modal").classList.add("hidden"); }
function saveModal() {
  const content = document.getElementById("fContent").value.trim();
  if (!content) { alert("请填写内容"); return; }
  const recurType = document.getElementById("fRecur").value;
  const obj = {
    date: document.getElementById("fDate").value || todayStr(),
    content, notes: document.getElementById("fNotes").value.trim(),
    tag: document.getElementById("fTag").value.trim(),
    priority: document.getElementById("fPriority").value,
  };
  if (recurType !== "none") {
    obj.recur = { type: recurType, endDate: document.getElementById("fRecurEnd").value || null };
    if (!isRecur({ ...obj })) obj.recur = null;
  } else obj.recur = null;
  if (editingId) {
    const it = state.items.find((x) => x.id === editingId);
    Object.assign(it, obj);
  } else {
    state.items.push({ id: uid(), createdAt: new Date().toISOString(), status: "pending", completed: {}, ...obj });
  }
  closeModal(); render(); save();
}
function deleteItem() {
  if (!editingId) return;
  if (!confirm("确定删除这条备忘？")) return;
  state.items = state.items.filter((x) => x.id !== editingId);
  closeModal(); render(); save();
}

/* ============ 统计 ============ */
function computeStats() {
  const occs = scopeOccs();
  const total = occs.length, done = occs.filter((o) => o.done).length;
  const overdue = occs.filter((o) => !o.done && o.ds < todayStr()).length;
  const byP = { high: { t: 0, d: 0 }, medium: { t: 0, d: 0 }, low: { t: 0, d: 0 } };
  for (const o of occs) { const p = o.it.priority; byP[p].t++; if (o.done) byP[p].d++; }
  let streak = 0, cur = new Date();
  while (streak < 3650) { if (occOn(fmt(cur)).some((o) => o.done)) { streak++; cur = addDays(cur, -1); } else break; }
  return { total, done, pending: total - done, overdue, byP, streak, rate: total ? Math.round((done / total) * 100) : 0 };
}
function openStats() {
  const s = computeStats();
  document.getElementById("statsScope").textContent = state.view === "month" ? "本月" : state.view === "focus" ? "今日聚焦" : "本周";
  const color = (p) => p === "high" ? "var(--high)" : p === "low" ? "var(--low)" : "var(--mid)";
  let h = `<div class="statGrid">
    <div class="statCard"><div class="num">${s.total}</div><div class="lab">总条目</div></div>
    <div class="statCard"><div class="num" style="color:var(--low)">${s.done}</div><div class="lab">已完成</div></div>
    <div class="statCard"><div class="num" style="color:var(--brand)">${s.pending}</div><div class="lab">待办</div></div>
    <div class="statCard"><div class="num" style="color:var(--high)">${s.overdue}</div><div class="lab">逾期</div></div>
  </div>`;
  h += `<div class="statHead">完成率 ${s.rate}%</div><div class="bars">
    <div class="bar"><span class="blabel">总进度</span><div class="btrack"><div class="bfill" style="width:${s.rate}%;background:var(--brand)"></div></div><span class="bval">${s.rate}%</span></div>
    <div class="bar"><span class="blabel">连续打卡</span><div class="btrack"><div class="bfill" style="width:${Math.min(100, s.streak)}%;background:var(--low)"></div></div><span class="bval">${s.streak}天</span></div>
  </div>`;
  h += `<div class="statHeader">按优先级</div><div class="bars">`;
  for (const p of ["high", "medium", "low"]) {
    const r = s.byP[p], pct = r.t ? Math.round((r.d / r.t) * 100) : 0;
    h += `<div class="bar"><span class="blabel">${priName(p)}</span><div class="btrack"><div class="bfill" style="width:${pct}%;background:${color(p)}"></div></div><span class="bval">${r.d}/${r.t}</span></div>`;
  }
  h += "</div>";
  document.getElementById("statsBody").innerHTML = h;
  document.getElementById("stats").classList.remove("hidden");
}

/* ============ 设置 ============ */
function openSettings() {
  document.getElementById("sUser").value = cfg.user || "";
  document.getElementById("sToken").value = cfg.token || "";
  document.getElementById("sNotify").checked = !!cfg.notify;
  document.getElementById("settings").classList.remove("hidden");
}
function closeSettings() { document.getElementById("settings").classList.add("hidden"); }

/* ============ 快捷添加 + 自然语言解析 ============ */
function nextWeekday(cn, isNext) {
  const target = WD[cn]; const now = new Date();
  let d = addDays(mondayOf(now), target - 1);
  if (isNext) d = addDays(d, 7);
  else if (fmt(d) < fmt(now)) d = addDays(d, 7);
  return fmt(d);
}
function makeDate(y, mo, day) { const yr = y || new Date().getFullYear(); let d = new Date(yr, mo, day); if (d < new Date()) d = new Date(yr + 1, mo, day); return fmt(d); }
function parseQuick(raw) {
  let text = raw.trim(); let priority = "medium";
  const pm = text.match(/!(高|中|低|紧急|重要)/);
  if (pm) { priority = ({ "高": "high", "紧急": "high", "重要": "high", "中": "medium", "低": "low" })[pm[1]] || "medium"; text = text.replace(pm[0], "").trim(); }
  let tag = ""; const tm = text.match(/#(\S+)/); if (tm) { tag = tm[1]; text = text.replace(tm[0], "").trim(); }
  let date = todayStr(), m;
  if ((m = text.match(/(今天|今日)/))) date = todayStr();
  else if ((m = text.match(/(明天|明日)/))) date = fmt(addDays(new Date(), 1));
  else if ((m = text.match(/后天/))) date = fmt(addDays(new Date(), 2));
  else if ((m = text.match(/大后天/))) date = fmt(addDays(new Date(), 3));
  else if ((m = text.match(/下(周|星期|礼拜)([一二三四五六日天])/))) { date = nextWeekday(m[2], true); text = text.replace(m[0], ""); }
  else if ((m = text.match(/(周|星期|礼拜)([一二三四五六日天])/))) { date = nextWeekday(m[2], false); text = text.replace(m[0], ""); }
  else if ((m = text.match(/(\d{1,2})月(\d{1,2})[日号]/))) { date = makeDate(null, +m[1] - 1, +m[2]); text = text.replace(m[0], ""); }
  else if ((m = text.match(/(\d{1,2})[月]/))) { date = makeDate(null, +m[1] - 1, new Date().getDate()); text = text.replace(m[0], ""); }
  else if ((m = text.match(/(\d{1,2})[日号]/))) { let day = +m[1], mo = new Date().getMonth(); if (day < new Date().getDate()) mo++; date = fmt(new Date(new Date().getFullYear(), mo, day)); text = text.replace(m[0], ""); }
  else if ((m = text.match(/(\d{1,2})\/(\d{1,2})/))) { date = makeDate(null, +m[1] - 1, +m[2]); text = text.replace(m[0], ""); }
  return { date, priority, tag, content: text.trim() };
}
function quickAdd() {
  const v = document.getElementById("quick").value;
  if (!v.trim()) return;
  const p = parseQuick(v);
  if (!p.content) { alert("未能识别内容，请直接输入文字"); return; }
  state.items.push({ id: uid(), date: p.date, content: p.content, notes: "", tag: p.tag, priority: p.priority, status: "pending", createdAt: new Date().toISOString(), completed: {} });
  document.getElementById("quick").value = "";
  render(); save();
}

/* ============ 通知 ============ */
function checkNotif() {
  if (!cfg.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  const today = todayStr();
  for (const o of occOn(today)) {
    if (!o.done) {
      const k = o.it.id + "@" + o.ds;
      if (!notified.has(k)) {
        try { new Notification("待办提醒 · " + (o.it.tag ? o.it.tag + " · " : "") + o.it.content, { body: "今天 " + o.ds.slice(5) + (isRecur(o.it) ? "（重复）" : "") }); } catch (e) {}
        notified.add(k);
      }
    }
  }
  try { localStorage.setItem("memonotified", JSON.stringify([...notified].slice(-200))); } catch (e) {}
}
async function enableNotify() {
  if (!("Notification" in window)) { alert("当前浏览器不支持通知"); return; }
  try { const p = await Notification.requestPermission(); cfg.notify = p === "granted"; saveCfg(); } catch (e) {}
}

/* ============ 拖拽改期 ============ */
function moveItem(id, newDate) {
  const it = state.items.find((x) => x.id === id);
  if (!it || isRecur(it)) return;
  it.date = newDate; render(); save();
}
function bindDnD() {
  document.querySelectorAll(".item.nodrag").forEach((el) => {
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", el.dataset.id); el.classList.add("dragging"); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
  document.querySelectorAll(".day, .mcell").forEach((cell) => {
    cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("dragover"); });
    cell.addEventListener("dragleave", () => cell.classList.remove("dragover"));
    cell.addEventListener("drop", (e) => {
      e.preventDefault(); cell.classList.remove("dragover");
      const id = e.dataTransfer.getData("text/plain");
      if (id) moveItem(id, cell.dataset.date);
    });
  });
}

/* ============ 事件绑定 ============ */
document.getElementById("viewSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]"); if (!b) return;
  state.view = b.dataset.view;
  document.querySelectorAll("#viewSeg button").forEach((x) => x.classList.toggle("active", x === b));
  render();
});
document.getElementById("prevBtn").addEventListener("click", () => {
  state.anchor = state.view === "week" ? addDays(state.anchor, -7) : state.view === "month" ? new Date(state.anchor.getFullYear(), state.anchor.getMonth() - 1, 1) : addDays(state.anchor, -1);
  render();
});
document.getElementById("nextBtn").addEventListener("click", () => {
  state.anchor = state.view === "week" ? addDays(state.anchor, 7) : state.view === "month" ? new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1) : addDays(state.anchor, 1);
  render();
});
document.getElementById("todayBtn").addEventListener("click", () => { state.anchor = new Date(); render(); });
document.getElementById("filter").addEventListener("change", (e) => { state.filter = e.target.value; render(); });
document.getElementById("tagFilter").addEventListener("change", (e) => { state.tagFilter = e.target.value; render(); });
document.getElementById("search").addEventListener("input", (e) => { state.search = e.target.value.trim(); render(); });
document.getElementById("refreshBtn").addEventListener("click", () => load());
document.getElementById("addFab").addEventListener("click", () => openAdd(todayStr()));
document.getElementById("quickAddBtn").addEventListener("click", quickAdd);
document.getElementById("quick").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
document.getElementById("statsBtn").addEventListener("click", openStats);
document.getElementById("statsClose").addEventListener("click", () => document.getElementById("stats").classList.add("hidden"));
document.getElementById("saveBtn").addEventListener("click", saveModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
document.getElementById("deleteBtn").addEventListener("click", deleteItem);
document.getElementById("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.getElementById("gearBtn").addEventListener("click", openSettings);
document.getElementById("sCancel").addEventListener("click", closeSettings);
document.getElementById("sSave").addEventListener("click", () => {
  cfg.user = document.getElementById("sUser").value.trim();
  cfg.token = document.getElementById("sToken").value.trim();
  if (!cfg.user || !cfg.token) { alert("用户名和 Token 都要填写"); return; }
  saveCfg(); closeSettings();
  if (document.getElementById("sNotify").checked) enableNotify(); else { cfg.notify = false; saveCfg(); }
  load();
});
document.getElementById("cfOverwrite").addEventListener("click", () => { document.getElementById("conflict").classList.add("hidden"); doSave(conflictSha); });
document.getElementById("cfMerge").addEventListener("click", () => { document.getElementById("conflict").classList.add("hidden"); state.items = mergeItems(conflictRemote, state.items); render(); doSave(conflictSha); });
document.getElementById("cfDiscard").addEventListener("click", () => { document.getElementById("conflict").classList.add("hidden"); state.items = conflictRemote || []; render(); lastSync = new Date(); cacheData(); updateStatus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalOpen) closeModal(); });

document.getElementById("view").addEventListener("click", (e) => {
  const chk = e.target.closest(".chk");
  if (chk) { e.stopPropagation(); const o = occOn(chk.dataset.date).find((x) => x.it.id === chk.dataset.id); if (o) { occDoneSet(o, !o.done); render(); save(); } return; }
  const add = e.target.closest(".dadd");
  if (add) { openAdd(add.dataset.date); return; }
  const cell = e.target.closest(".mcell");
  if (cell) { openAdd(cell.dataset.date); return; }
  const card = e.target.closest(".item");
  if (card) { const it = state.items.find((x) => x.id === card.dataset.id); if (it) openEdit(it); return; }
  const row = e.target.closest(".frow");
  if (row) { const it = state.items.find((x) => x.id === row.dataset.id); if (it) openEdit(it); }
});

/* ============ PWA / 初始化 ============ */
if ("serviceWorker" in navigator) window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => {}); });
window.addEventListener("online", () => { if (outbox) { setStatus("已联网，正在同步…"); doSave(); } });
setInterval(() => { if (configured() && !modalOpen && !outbox) load(); }, 30000);
setInterval(checkNotif, 60000);

load();
