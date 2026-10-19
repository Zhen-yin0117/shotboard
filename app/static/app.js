/* Shotboard 前端 */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|bmp|tiff?|gif)$/i;
const STATUS_LABEL = { pending: "待打标", tagging: "打标中", error: "出错", done: "" };
const CARD_DIMS = ["shot_size", "lighting_pattern", "scene", "outfit"]; // 卡片上显示的维度

const state = {
  tax: null, facets: null, settings: null,
  filters: {},            // {dimKey: Set}
  quick: "all",           // all | fav | pending | error
  q: "", sort: "new",
  items: [], page: 1, total: 0, loading: false, done: false,
  closedDims: new Set(JSON.parse(localStorageGet("closedDims") || "[]")),
  detail: -1,
  selecting: false, picked: new Set(),   // 批量选择
};

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3200);
}

/* ---------- 查询 ---------- */
function queryString(page) {
  const p = new URLSearchParams();
  for (const [k, set] of Object.entries(state.filters)) for (const v of set) p.append(k, v);
  if (state.q) p.set("q", state.q);
  if (state.quick === "fav") p.set("favorite", 1);
  if (state.quick === "pending") p.set("status", "pending");
  if (state.quick === "error") p.set("status", "error");
  if (state.quick.startsWith("platform:")) p.set("platform", state.quick.slice(9));
  p.set("sort", state.sort);
  p.set("page", page);
  return p.toString();
}

async function loadImages(reset = false) {
  if (reset) {
    state.page = 1; state.items = []; state.done = false;
    $("#grid").innerHTML = "";
  }
  if (state.loading || state.done) return;
  state.loading = true;
  try {
    const data = await api("/api/images?" + queryString(state.page));
    state.total = data.total;
    state.items.push(...data.items);
    appendCards(data.items);
    state.done = state.items.length >= data.total || data.items.length === 0;
    state.page++;
    renderMeta();
  } catch (e) { toast(e.message, true); }
  state.loading = false;
  if (!state.done && isSentinelVisible()) loadImages();
}

function isSentinelVisible() {
  return $("#sentinel").getBoundingClientRect().top < innerHeight + 600;
}

function renderMeta() {
  const total = state.facets?.total ?? 0;
  $("#empty").hidden = total > 0;
  $("#emptyKeyHint").hidden = !!state.settings?.has_key || !!state.settings?.mock;
  const filtered = hasFilters();
  $("#resultMeta").textContent = total === 0 ? "" :
    filtered ? `找到 ${state.total} 张` : `共 ${state.total} 张样片`;
  if (total > 0 && state.total === 0) $("#resultMeta").textContent = "没有符合条件的样片，试试减少筛选条件";
}

const hasFilters = () => Object.values(state.filters).some((s) => s.size) || state.q || state.quick !== "all";

/* ---------- 卡片 ---------- */
function cardHTML(it) {
  const ratio = it.width && it.height ? `aspect-ratio:${it.width}/${it.height}` : "";
  const tags = CARD_DIMS.flatMap((d) => it.tags[d] || []).slice(0, 4);
  const badge = it.status !== "done" ? `<span class="badge ${it.status}">${STATUS_LABEL[it.status]}</span>` : "";
  return `<img src="${it.thumb_url}" alt="${esc(it.description || "")}" loading="lazy" style="${ratio}">
    ${badge}<span class="pickmark">✓</span>
    <span class="fav ${it.favorite ? "on" : ""}" data-fav="${it.id}" role="button" aria-label="收藏">${it.favorite ? "♥" : "♡"}</span>
    ${tags.length ? `<div class="meta">${tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}`;
}

function appendCards(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const el = document.createElement("button");
    el.className = "card" + (state.picked.has(it.id) ? " picked" : "");
    el.dataset.id = it.id;
    el.innerHTML = cardHTML(it);
    frag.append(el);
  }
  $("#grid").append(frag);
}

function updateCard(it) {
  const idx = state.items.findIndex((x) => x.id === it.id);
  if (idx >= 0) state.items[idx] = it;
  const el = $(`.card[data-id="${it.id}"]`);
  if (el) el.innerHTML = cardHTML(it);
}

/* ---------- 侧栏 ---------- */
function renderSidebar() {
  const f = state.facets;
  if (!f || !state.tax) return;
  const st = f.status || {};
  const quick = [
    ["all", "全部样片", f.total],
    ["fav", "♥ 收藏", f.favorite],
    ["pending", "待打标", st.pending || 0],
    ["error", "打标出错", st.error || 0],
  ];
  const platforms = Object.entries(f.platforms || {}).map(([p, n]) => [`platform:${p}`, `来自 ${p}`, n]);
  $("#quick").innerHTML = [...quick, ...platforms]
    .filter(([k, , n]) => k === "all" || k === "fav" || n > 0)
    .map(([k, label, n]) => `<button data-quick="${esc(k)}" class="${state.quick === k ? "on" : ""} ${k === "error" ? "err" : ""}">
      <span>${esc(label)}</span><span class="n">${n}</span></button>`).join("");

  const dims = [...state.tax.dimensions];
  if (f.tags.custom) dims.push({ key: "custom", label: "自定义标签", options: Object.keys(f.tags.custom) });
  $("#facets").innerHTML = dims.map((d) => {
    const counts = f.tags[d.key] || {};
    const sel = state.filters[d.key] || new Set();
    const closed = state.closedDims.has(d.key);
    const chips = d.options.map((o) => {
      const n = counts[o] || 0;
      return `<button class="chip ${sel.has(o) ? "on" : ""} ${n ? "" : "zero"}" data-dim="${d.key}" data-tag="${esc(o)}">
        ${esc(o)}${n ? `<span class="n">${n}</span>` : ""}</button>`;
    }).join("");
    return `<section class="facet ${closed ? "closed" : ""}" data-facet="${d.key}">
      <button class="facet-head" data-toggle="${d.key}">
        <span>${esc(d.label)}${sel.size ? `<span class="sel">已选 ${sel.size}</span>` : ""}</span><span class="chev">▼</span>
      </button>
      <div class="chips">${chips}</div></section>`;
  }).join("");
}

function renderFilterbar() {
  const parts = [];
  const labelOf = (k) => state.tax.dimensions.find((d) => d.key === k)?.label || "自定义";
  for (const [k, set] of Object.entries(state.filters))
    for (const v of set) parts.push(`<span class="chip on" data-dim="${k}" data-tag="${esc(v)}">${esc(labelOf(k))}：${esc(v)} <span class="x">✕</span></span>`);
  $("#filterbar").hidden = parts.length === 0;
  $("#filterbar").innerHTML = parts.join("") + (parts.length ? `<button class="clear" data-act="clear-filters">清除全部</button>` : "");
}

function toggleFilter(dim, tag) {
  const set = state.filters[dim] || (state.filters[dim] = new Set());
  set.has(tag) ? set.delete(tag) : set.add(tag);
  if (!set.size) delete state.filters[dim];
  refresh();
}

function refresh() {
  renderSidebar();
  renderFilterbar();
  loadImages(true);
}

/* ---------- 状态轮询 ---------- */
let lastSig = "";
async function pollFacets() {
  try {
    state.facets = await api("/api/facets");
    const st = state.facets.status || {};
    const busy = state.facets.queue + (st.tagging || 0);
    const pill = $("#queuePill");
    pill.classList.remove("paused");
    if (state.facets.paused) {
      pill.hidden = false;
      pill.classList.add("paused");
      pill.innerHTML = `⚠ 打标已暂停 <button data-act="show-paused">看原因</button> <button data-act="tag-all">重试</button>`;
    } else if (busy > 0) {
      pill.hidden = false;
      pill.innerHTML = `<span class="dot"></span>正在打标，剩余 ${state.facets.queue} 张`;
    } else if ((st.pending || 0) + (st.error || 0) > 0 && (state.settings?.has_key || state.settings?.mock)) {
      pill.hidden = false;
      pill.innerHTML = `${(st.pending || 0) + (st.error || 0)} 张未打标 <button data-act="tag-all">全部打标</button>`;
    } else pill.hidden = true;

    const sig = JSON.stringify([st, state.facets.total]);
    if (sig !== lastSig) {
      lastSig = sig;
      renderSidebar();
      renderMeta();
      // 刷新还没打完标的卡片
      const stale = state.items.filter((x) => x.status !== "done").slice(0, 40);
      for (const it of stale) {
        api(`/api/images/${it.id}`).then((fresh) => {
          if (fresh.status !== it.status) {
            updateCard(fresh);
            if (state.detail >= 0 && state.items[state.detail]?.id === fresh.id) renderDetail();
          }
        }).catch(() => {});
      }
    }
  } catch {}
  setTimeout(pollFacets, (state.facets?.queue || state.facets?.status?.tagging) ? 2000 : 6000);
}

/* ---------- 导入 ---------- */
async function uploadFiles(files) {
  files = files.filter((f) => IMAGE_EXT.test(f.name));
  if (!files.length) return toast("没有找到图片文件", true);
  const batch = 8;
  let added = 0, skipped = 0, failed = 0;
  const t = document.createElement("div");
  t.className = "toast";
  $("#toasts").append(t);
  for (let i = 0; i < files.length; i += batch) {
    t.textContent = `正在导入 ${Math.min(i + batch, files.length)} / ${files.length}…`;
    const fd = new FormData();
    files.slice(i, i + batch).forEach((f) => fd.append("files", f, f.name));
    try {
      const r = await api("/api/import", { method: "POST", body: fd });
      added += r.added; skipped += r.skipped; failed += r.failed.length;
    } catch (e) { failed += Math.min(batch, files.length - i); }
  }
  t.remove();
  toast(`导入 ${added} 张` + (skipped ? `，${skipped} 张已存在已跳过` : "") + (failed ? `，${failed} 张失败` : ""), failed > 0);
  if (added && !state.settings?.has_key && !state.settings?.mock)
    toast("还没设置 API Key，图片已保存，设置后点「全部打标」即可");
  await pollFacets.once();
  loadImages(true);
}
pollFacets.once = async () => {
  try { state.facets = await api("/api/facets"); renderSidebar(); renderMeta(); } catch {}
};

async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

async function importFromUrl() {
  const url = prompt("粘贴图片链接（右键图片 →「复制图片地址」）：");
  if (!url) return;
  const source = prompt("原帖链接（可选，方便以后找回出处）：") || null;
  try {
    const r = await api("/api/import-url", { method: "POST", body: { image_url: url.trim(), source_url: source } });
    toast(r.new ? "已导入" : "这张图已经在库里了");
    await pollFacets.once();
    loadImages(true);
  } catch (e) { toast(e.message, true); }
}

/* ---------- 详情 ---------- */
function openDetail(idx) {
  state.detail = idx;
  $("#detail").hidden = false;
  document.body.style.overflow = "hidden";
  renderDetail();
}
function closeDetail() {
  state.detail = -1;
  $("#detail").hidden = true;
  document.body.style.overflow = "";
}
async function stepDetail(d) {
  let i = state.detail + d;
  if (i >= state.items.length && !state.done) await loadImages();
  if (i < 0 || i >= state.items.length) return;
  openDetail(i);
}

function renderDetail() {
  const it = state.items[state.detail];
  if (!it) return closeDetail();
  $("#detailImg").src = it.image_url;
  const dims = state.tax.dimensions;
  const statusBox = it.status === "done" ? "" :
    `<div class="dp-status ${it.status === "pending" && it.error ? "error" : it.status}">${it.status === "error" ? "打标失败：" + esc(it.error) :
      it.status === "tagging" ? "正在识别中…" : it.error ? "上次打标没成功：" + esc(it.error) : "还没有打标签"}</div>`;
  const dimHTML = dims.map((d) => {
    const sel = new Set(it.tags[d.key] || []);
    return `<div class="dp-dim ${sel.size ? "collapsed" : ""}" data-dpdim="${d.key}">
      <div class="lbl"><span>${esc(d.label)}</span>${sel.size ? `<button class="more" data-act="expand-dim">修改</button>` : ""}</div>
      <div class="chips">${d.options.map((o) => `<button class="chip ${sel.has(o) ? "on" : ""}" data-edit-dim="${d.key}" data-tag="${esc(o)}">${esc(o)}</button>`).join("")}</div>
    </div>`;
  }).join("");
  const custom = it.tags.custom || [];
  $("#detailPanel").innerHTML = `
    <div class="dp-top">
      <button class="btn small fav-btn ${it.favorite ? "on" : ""}" data-act="toggle-fav">${it.favorite ? "♥ 已收藏" : "♡ 收藏"}</button>
      <button class="btn small" data-act="add-to-plan">＋ 加入拍摄方案</button>
      <span class="muted small">${it.width || "?"} × ${it.height || "?"}</span>
      <span class="saved-flag" id="savedFlag"></span>
    </div>
    ${it.description ? `<p class="dp-desc">${esc(it.description)}</p>` : ""}
    <div class="dp-source">${it.source_url ? `来源：<a href="${esc(it.source_url)}" target="_blank" rel="noopener">${esc(it.platform || "原帖")}</a>${it.author ? " · " + esc(it.author) : ""}` :
      `<a href="#" data-act="add-source">＋ 添加来源链接</a>`}</div>
    ${statusBox}

    <div class="dp-section">
      <h4>拍摄指导</h4>
      <div class="hint-box"><label>姿势怎么摆（可以直接发给模特）</label>
        <textarea data-field="pose_hint" rows="2" placeholder="例如：侧身靠墙，肩膀放松，看向窗外">${esc(it.pose_hint)}</textarea></div>
      <div class="hint-box"><label>光怎么打</label>
        <textarea data-field="lighting_hint" rows="2" placeholder="例如：窗光从左前方进来，右侧补反光板">${esc(it.lighting_hint)}</textarea></div>
      <div class="hint-box"><label>我的备注</label>
        <textarea data-field="notes" rows="2" placeholder="想在哪次拍摄里用、和谁拍…">${esc(it.notes)}</textarea></div>
    </div>

    <div class="dp-section">
      <h4>标签（点击修改）</h4>
      ${dimHTML}
      <div class="dp-dim">
        <div class="lbl"><span>自定义标签</span></div>
        <div class="chips">${custom.map((t) => `<button class="chip on" data-edit-dim="custom" data-tag="${esc(t)}">${esc(t)} ✕</button>`).join("")}</div>
        <form class="custom-add" data-act="add-custom"><input placeholder="加一个自己的标签，回车确认" maxlength="20"><button class="btn small">添加</button></form>
      </div>
    </div>

    <div class="dp-actions">
      <button class="btn small" data-act="retag">${it.status === "done" ? "重新打标" : "立即打标"}</button>
      <a class="btn small" href="${it.image_url}" download style="display:inline-grid;place-items:center;text-decoration:none;color:inherit">下载原图</a>
      <button class="btn small danger" data-act="delete" style="margin-left:auto">删除</button>
    </div>`;
}

async function patchCurrent(body) {
  const it = state.items[state.detail];
  try {
    const fresh = await api(`/api/images/${it.id}`, { method: "PATCH", body });
    updateCard(fresh);
    const flag = $("#savedFlag");
    if (flag) { flag.textContent = "已保存"; setTimeout(() => (flag.textContent = ""), 1500); }
    pollFacets.once();
    return fresh;
  } catch (e) { toast(e.message, true); }
}

function toggleDetailTag(dim, tag) {
  const it = state.items[state.detail];
  const d = state.tax.dimensions.find((x) => x.key === dim);
  const tags = structuredClone(it.tags);
  const cur = new Set(tags[dim] || []);
  if (cur.has(tag)) cur.delete(tag);
  else { if (d && !d.multi) cur.clear(); cur.add(tag); }
  tags[dim] = [...cur];
  if (!tags[dim].length) delete tags[dim];
  it.tags = tags;
  // 只更新这一组的样式，不整体重绘（保留展开状态）
  const box = $(`[data-dpdim="${dim}"]`);
  if (box) $$(".chip", box).forEach((c) => c.classList.toggle("on", cur.has(c.dataset.tag)));
  else renderDetail();
  patchCurrent({ tags });
}

/* ---------- 设置 ---------- */
async function loadSettings() {
  state.settings = await api("/api/settings");
}
function openSettings() {
  const s = state.settings, f = $("#settingsForm");
  f.api_key.value = s.api_key || "";
  f.region.value = s.region;
  if (![...f.model.options].some((o) => o.value === s.model)) f.model.add(new Option(s.model, s.model));
  f.model.value = s.model;
  f.auto_tag.checked = s.auto_tag;
  $("#testResult").textContent = s.mock ? "当前为测试模式（不调用真实 API）" : "";
  $("#settings").hidden = false;
}
async function saveSettings(e) {
  e?.preventDefault();
  const f = $("#settingsForm");
  state.settings = await api("/api/settings", { method: "POST", body: {
    api_key: f.api_key.value, region: f.region.value, model: f.model.value, auto_tag: f.auto_tag.checked } });
  return state.settings;
}

/* ---------- 事件 ---------- */
let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); renderMeta(); loadImages(true); }, 300);
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; loadImages(true); });
$("#toggleSidebar").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

$("#importBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#importMenu"), r = e.currentTarget.getBoundingClientRect();
  m.hidden = !m.hidden;
  m.style.top = r.bottom + 6 + "px";
  m.style.left = Math.min(r.left, innerWidth - 210) + "px";
});
$("#fileInput").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
$("#folderInput").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
$("#settingsBtn").addEventListener("click", openSettings);
$("#settingsForm").addEventListener("submit", async (e) => {
  try { await saveSettings(e); $("#settings").hidden = true; toast("设置已保存"); renderMeta(); pollFacets.once(); }
  catch (err) { toast(err.message, true); }
});
$("#testBtn").addEventListener("click", async () => {
  const out = $("#testResult");
  out.className = "small"; out.textContent = "测试中…";
  try {
    await saveSettings();
    const r = await api("/api/settings/test", { method: "POST" });
    out.className = "small " + (r.ok ? "ok" : "bad");
    out.textContent = r.ok ? "✓ 连接成功" : "✕ " + r.error;
  } catch (e) { out.className = "small bad"; out.textContent = "✕ " + e.message; }
});

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!t.closest("#importMenu") && !t.closest("#importBtn")) $("#importMenu").hidden = true;

  const fav = t.closest("[data-fav]");
  if (fav) {
    e.stopPropagation();
    const it = state.items.find((x) => x.id == fav.dataset.fav);
    const fresh = await api(`/api/images/${it.id}`, { method: "PATCH", body: { favorite: !it.favorite } });
    updateCard(fresh); pollFacets.once();
    return;
  }
  const card = t.closest(".card");
  if (card) {
    if (state.selecting) return window.Plans?.togglePick(+card.dataset.id, card);
    return openDetail(state.items.findIndex((x) => x.id == card.dataset.id));
  }

  const q = t.closest("[data-quick]");
  if (q) { state.quick = q.dataset.quick; $("#sidebar").classList.remove("open"); return refresh(); }
  const tog = t.closest("[data-toggle]");
  if (tog) {
    const k = tog.dataset.toggle;
    state.closedDims.has(k) ? state.closedDims.delete(k) : state.closedDims.add(k);
    localStorageSet("closedDims", JSON.stringify([...state.closedDims]));
    return tog.parentElement.classList.toggle("closed");
  }
  const fchip = t.closest("[data-dim]");
  if (fchip && !fchip.closest(".detail-panel")) return toggleFilter(fchip.dataset.dim, fchip.dataset.tag);
  const ed = t.closest("[data-edit-dim]");
  if (ed) {
    if (ed.dataset.editDim === "custom") {
      const it = state.items[state.detail];
      const tags = structuredClone(it.tags);
      tags.custom = (tags.custom || []).filter((x) => x !== ed.dataset.tag);
      it.tags = tags; await patchCurrent({ tags }); return renderDetail();
    }
    return toggleDetailTag(ed.dataset.editDim, ed.dataset.tag);
  }

  const act = t.closest("[data-act]")?.dataset.act;
  if (!act) {
    if (t.id === "settings") $("#settings").hidden = true;
    if (t.classList.contains("detail-photo") || t.id === "detail") closeDetail();
    return;
  }
  if (t.closest("form") && act === "add-custom") return;
  e.preventDefault();
  const it = state.items[state.detail];
  switch (act) {
    case "pick-files": $("#importMenu").hidden = true; return $("#fileInput").click();
    case "pick-folder": $("#importMenu").hidden = true; return $("#folderInput").click();
    case "import-url": $("#importMenu").hidden = true; return importFromUrl();
    case "open-settings": return openSettings();
    case "close-settings": $("#settings").hidden = true; return;
    case "clear-filters": state.filters = {}; return refresh();
    case "close-detail": return closeDetail();
    case "prev": return stepDetail(-1);
    case "next": return stepDetail(1);
    case "expand-dim": return t.closest(".dp-dim").classList.remove("collapsed");
    case "toggle-fav": { const f = await patchCurrent({ favorite: !it.favorite }); if (f) { state.items[state.detail] = f; renderDetail(); } return; }
    case "add-source": {
      const url = prompt("原帖链接：");
      if (url) { const f = await patchCurrent({ source_url: url.trim() }); if (f) { state.items[state.detail] = f; renderDetail(); } }
      return;
    }
    case "retag":
      try { await api(`/api/tag/${it.id}`, { method: "POST" }); it.status = "pending"; updateCard(it); renderDetail(); toast("已加入打标队列"); pollFacets.once(); }
      catch (err) { toast(err.message, true); }
      return;
    case "delete":
      if (!confirm("确定删除这张样片吗？原图也会从库里删掉。")) return;
      await api(`/api/images/${it.id}`, { method: "DELETE" });
      $(`.card[data-id="${it.id}"]`)?.remove();
      state.items.splice(state.detail, 1); state.total--;
      pollFacets.once();
      if (!state.items.length) return closeDetail();
      state.detail = Math.min(state.detail, state.items.length - 1);
      return renderDetail();
    case "add-to-plan":
      return window.Plans?.pick([it.id]);
    case "show-paused":
      return alert(state.facets?.paused || "");
    case "tag-all":
      try { const r = await api("/api/tag-all", { method: "POST" }); toast(`已加入队列：${r.queued} 张`); pollFacets(); }
      catch (err) { toast(err.message, true); }
      return;
  }
});

document.addEventListener("submit", async (e) => {
  if (e.target.dataset.act !== "add-custom") return;
  e.preventDefault();
  const input = $("input", e.target), v = input.value.trim();
  if (!v) return;
  const it = state.items[state.detail];
  const tags = structuredClone(it.tags);
  tags.custom = [...new Set([...(tags.custom || []), v])];
  it.tags = tags;
  await patchCurrent({ tags });
  renderDetail();
});

let textTimer;
document.addEventListener("input", (e) => {
  const field = e.target.dataset?.field;
  if (!field || state.detail < 0) return;
  const it = state.items[state.detail];
  it[field] = e.target.value;
  clearTimeout(textTimer);
  textTimer = setTimeout(() => patchCurrent({ [field]: e.target.value }), 600);
});

document.addEventListener("keydown", (e) => {
  if (!$("#detail").hidden) {
    if (e.target.matches("textarea, input")) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Escape") closeDetail();
    if (e.key === "ArrowLeft") stepDetail(-1);
    if (e.key === "ArrowRight") stepDetail(1);
  } else if (e.key === "Escape") { $("#settings").hidden = true; $("#importMenu").hidden = true; }
  if (e.key === "/" && !e.target.matches("input, textarea")) { e.preventDefault(); $("#search").focus(); }
});

// 拖拽导入
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#dropOverlay").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true;
  uploadFiles(await filesFromDrop(e.dataTransfer));
});

// 无限滚动
new IntersectionObserver((es) => { if (es[0].isIntersecting) loadImages(); }, { rootMargin: "600px" }).observe($("#sentinel"));

/* ---------- 启动 ---------- */
(async function init() {
  try {
    [state.tax] = await Promise.all([api("/api/taxonomy"), loadSettings()]);
    state.facets = await api("/api/facets");
    renderSidebar();
    await loadImages(true);
    pollFacets();
    if (!state.settings.has_key && !state.settings.mock && state.facets.total === 0) openSettings();
  } catch (e) {
    toast("连接本地服务失败：" + e.message, true);
  }
})();
