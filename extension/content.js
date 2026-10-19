/* Shotboard 内容脚本：在小红书笔记 / Pinterest Pin 页面显示「存入片板」按钮 */
(() => {
  if (window.__shotboardLoaded) return;
  window.__shotboardLoaded = true;

  const host = location.hostname;
  const SITE = /xiaohongshu\.com$/.test(host) ? "xhs" : /pinterest\./.test(host) ? "pinterest" : null;
  if (!SITE) return;

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r)); }
    catch { res(null); } // 插件刚更新、页面还没刷新时会走到这里
  });
  const stripQuery = (u) => u.split("?")[0].split("!")[0];

  /* ---------- 识别当前页面 ---------- */
  function currentKey() {
    if (SITE === "xhs") {
      const m = location.pathname.match(/\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-f]{24})/i);
      return m ? m[1] : null;
    }
    const m = location.pathname.match(/\/pin\/([\w-]+)/);
    return m ? m[1] : null;
  }

  /* ---------- 小红书：从页面元素读取（备用方案） ---------- */
  function xhsFromDom() {
    const box = document.querySelector("#noteContainer, .note-container, [class*='note-detail']") || document;
    const skip = ".author-wrapper, .author-container, .author, .comments-container, .comments-el, .comment-item, .avatar, .interactions, .bottom-container";
    let imgs = [...box.querySelectorAll(".swiper-slide:not(.swiper-slide-duplicate) img, .note-slider-img, .media-container img, .img-container img")];
    if (!imgs.length) imgs = [...box.querySelectorAll("img")];
    const seen = new Set(), images = [];
    for (const img of imgs) {
      if (img.closest(skip)) continue;
      const src = img.currentSrc || img.src || img.dataset.src;
      if (!src || src.startsWith("data:")) continue;
      const big = (img.naturalWidth || img.width) >= 240 || /xhscdn/.test(src);
      if (!big) continue;
      const k = stripQuery(src);
      if (seen.has(k)) continue;
      seen.add(k);
      images.push({ urls: [src], width: img.naturalWidth, height: img.naturalHeight });
    }
    const text = (sel) => box.querySelector(sel)?.textContent?.trim() || document.querySelector(sel)?.textContent?.trim() || "";
    return {
      title: text("#detail-title") || text(".note-content .title") || document.title.replace(/ - 小红书$/, ""),
      author: text(".author-wrapper .username") || text(".author-container .name") || text(".author .name"),
      type: box.querySelector("video") ? "video" : "normal",
      images,
    };
  }

  async function collectXhs(noteId) {
    const state = await send({ type: "xhs-state", noteId });
    const dom = xhsFromDom();
    const base = state && state.images?.length ? state : dom;
    return {
      title: base.title || dom.title,
      author: base.author || dom.author,
      type: base.type,
      images: base.images,
      platform: "小红书",
      source_url: location.origin + location.pathname, // 去掉追踪参数
    };
  }

  /* ---------- Pinterest ---------- */
  function collectPinterest() {
    const cand = [...document.querySelectorAll(
      "[data-test-id='pin-closeup-image'] img, [data-test-id='closeup-image'] img, [data-test-id='visual-content-container'] img, img[elementtiming]"
    )];
    let img = cand.find((i) => /pinimg/.test(i.src));
    if (!img) {
      img = [...document.images].filter((i) => /pinimg/.test(i.src))
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    }
    const images = [];
    if (img) {
      const src = img.currentSrc || img.src;
      const urls = [src.replace(/\/\d+x(\d+)?\//, "/originals/"), src.replace(/\/\d+x(\d+)?\//, "/736x/"), src];
      images.push({ urls: [...new Set(urls)], thumb: src });
    }
    const title = document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\s*\|\s*Pinterest.*$/, "");
    const author = document.querySelector("[data-test-id='creator-profile-name'], [data-test-id='official-user-attribution'] a, [data-test-id='pinner-name']")?.textContent?.trim() || "";
    return { title, author, images, platform: "Pinterest", source_url: location.origin + location.pathname };
  }

  /* ---------- 界面（放在 Shadow DOM 里，不受网站样式影响） ---------- */
  const root = document.createElement("div");
  root.id = "shotboard-root";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    [hidden] { display: none !important; }   /* 否则 .panel/.fab 的 display:flex 会让 hidden 失效，X 关不掉 */
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .fab {
      position: fixed; right: 22px; bottom: 140px; z-index: 2147483646;
      display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 16px 0 13px;
      border: 0; border-radius: 99px; cursor: pointer; font-size: 14px; font-weight: 600;
      background: #161412; color: #f2ede6; box-shadow: 0 6px 24px rgba(0,0,0,.28);
      transition: transform .15s, box-shadow .15s;
    }
    .fab:hover { transform: translateY(-1px); box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    .fab .dot { width: 10px; height: 10px; border-radius: 50%; background: #e8643c; box-shadow: 0 0 10px #e8643c; }
    .panel {
      position: fixed; right: 22px; bottom: 194px; z-index: 2147483647; width: 360px; max-height: min(620px, calc(100vh - 220px));
      display: flex; flex-direction: column; background: #191816; color: #ece7e0;
      border: 1px solid #3b3833; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.45); overflow: hidden;
      font-size: 13px; line-height: 1.5;
    }
    .head { padding: 14px 16px 10px; border-bottom: 1px solid #2e2b27; flex: none; }
    .head .t { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 22px; }
    .head .a { color: #a39d94; font-size: 12px; margin-top: 2px; }
    .x { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border: 0; border-radius: 6px; background: none; color: #a39d94; cursor: pointer; font-size: 15px; }
    .x:hover { background: #2b2824; color: #fff; }
    .grid { scrollbar-width: thin; scrollbar-color: #3b3833 transparent; }
    .grid::-webkit-scrollbar { width: 8px; } .grid::-webkit-scrollbar-thumb { background: #3b3833; border-radius: 4px; }
    .grid { padding: 12px; display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: max-content; align-content: start;
      gap: 8px; overflow-y: auto; flex: 1 1 auto; min-height: 0; overscroll-behavior: contain; }
    .cell { position: relative; aspect-ratio: 3/4; border-radius: 8px; overflow: hidden; cursor: pointer; background: #22201d; outline: 2px solid transparent; outline-offset: -2px; }
    .cell img { width: 100%; height: 100%; object-fit: cover; display: block; transition: opacity .15s; }
    .cell.off img { opacity: .3; }
    .cell.on { outline-color: #e8643c; }
    .cell .ck { position: absolute; top: 5px; right: 5px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
      background: rgba(0,0,0,.55); color: #fff; font-size: 12px; border: 1.5px solid rgba(255,255,255,.7); }
    .cell.on .ck { background: #e8643c; border-color: #e8643c; }
    .cell .st { position: absolute; inset: auto 0 0 0; font-size: 11px; padding: 3px 6px; background: rgba(0,0,0,.7); text-align: center; }
    .cell .st.ok { color: #9fd49a; } .cell .st.dup { color: #c9c3ba; } .cell .st.err { color: #ff8a80; }
    .foot { padding: 12px 14px; border-top: 1px solid #2e2b27; display: flex; align-items: center; gap: 10px; flex: none; }
    .foot .sel { background: none; border: 0; color: #a39d94; cursor: pointer; font-size: 12.5px; text-decoration: underline; padding: 0; }
    .save { margin-left: auto; height: 34px; padding: 0 16px; border: 0; border-radius: 8px; background: #e8643c; color: #1a0d07; font-weight: 700; cursor: pointer; font-size: 13px; }
    .save:disabled { opacity: .5; cursor: default; }
    .msg { padding: 10px 16px 0; color: #a39d94; font-size: 12.5px; flex: none; }
    .msg.bad { color: #ff8a80; }
    .msg a { color: #e8643c; cursor: pointer; }
    .empty { padding: 28px 16px; text-align: center; color: #a39d94; }
    .toast { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); z-index: 2147483647; background: #161412; color: #f2ede6;
      padding: 10px 18px; border-radius: 10px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  </style>
  <button class="fab" hidden><span class="dot"></span><span class="label">存入片板</span></button>
  <div class="panel" hidden></div>`;
  (document.body || document.documentElement).append(root);

  const fab = shadow.querySelector(".fab");
  const panel = shadow.querySelector(".panel");
  let data = null, selected = [], saving = false, panelKey = null;
  const savedKeys = new Set();          // 这次浏览中已经存过的图（重新打开面板时记得）
  const imgKey = (im) => stripQuery(im.urls[0] || "");

  function toast(text) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = text;
    shadow.append(t);
    setTimeout(() => t.remove(), 3500);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderPanel(msg = "", bad = false) {
    if (!data) return;
    const n = selected.filter(Boolean).length;
    const todo = data.images.filter((im, i) => selected[i] && im.status !== "ok" && im.status !== "dup").length;
    const video = data.type === "video";
    panel.innerHTML = `
      <button class="x" title="关闭">✕</button>
      <div class="head"><div class="t">${esc(data.title || "未命名")}</div>
        <div class="a">${esc(data.platform)}${data.author ? " · " + esc(data.author) : ""} · ${data.images.length} 张${video ? "（视频笔记，只能存封面）" : ""}</div></div>
      ${data.images.length ? `<div class="grid">${data.images.map((im, i) => `
        <div class="cell ${selected[i] ? "on" : "off"}" data-i="${i}">
          <img src="${esc(im.thumb || im.urls[im.urls.length - 1])}" referrerpolicy="no-referrer-when-downgrade" loading="lazy">
          <span class="ck">${selected[i] ? "✓" : ""}</span>
          ${im.status ? `<span class="st ${im.status}">${{ ok: "已保存", dup: "库里已有", err: "失败", ing: "保存中…" }[im.status]}</span>` : ""}
        </div>`).join("")}</div>` : `<div class="empty">没有在这个页面找到图片。<br>等图片加载出来再点一次试试。</div>`}
      ${msg ? `<div class="msg ${bad ? "bad" : ""}">${msg}</div>` : ""}
      <div class="foot">
        ${data.images.length > 1 ? `<button class="sel">${data.images.every((im, i) => im.status === "ok" || selected[i]) ? "全不选" : "全选"}</button>` : ""}
        <button class="save" ${!todo || saving ? "disabled" : ""}>${saving ? "保存中…" : todo ? `保存 ${todo} 张` : n ? "已全部保存" : "保存"}</button>
      </div>`;
  }

  async function openPanel() {
    const key = currentKey();
    panelKey = key;
    panel.hidden = false;
    panel.innerHTML = `<div class="empty">正在读取图片…</div>`;
    data = SITE === "xhs" ? await collectXhs(key) : collectPinterest();
    data.images.forEach((im) => { if (savedKeys.has(imgKey(im))) im.status = "ok"; });
    selected = data.images.map((im) => im.status !== "ok");   // 已经存过的默认不选
    renderPanel();
    const p = await send({ type: "ping" });
    if (!p?.ok) renderPanel(`片板没有在运行。先在 Mac 上双击 <b>start.command</b>，再回来点保存。`, true);
  }

  const STATUS_TEXT = { ok: "已保存", dup: "库里已有", err: "失败", ing: "保存中…" };

  // 保存过程中只改状态文字，不重画整个面板（否则缩略图会全部重新加载、闪一下）
  function setCellStatus(i, status) {
    const cell = panel.querySelector(`.cell[data-i="${i}"]`);
    if (!cell) return;
    let st = cell.querySelector(".st");
    if (!status) { st && st.remove(); return; }
    if (!st) { st = document.createElement("span"); cell.append(st); }
    st.className = "st " + status;
    st.textContent = STATUS_TEXT[status];
  }
  function setMsg(html, bad = false) {
    let m = panel.querySelector(".msg");
    if (!m) { m = document.createElement("div"); panel.querySelector(".foot").before(m); }
    m.className = "msg" + (bad ? " bad" : "");
    m.innerHTML = html;
  }
  function setSaveButton(text, disabled) {
    const b = panel.querySelector(".save");
    if (b) { b.textContent = text; b.disabled = disabled; }
  }

  async function saveSelected() {
    saving = true;
    let ok = 0, dup = 0, err = 0, lastErr = "";
    const total = selected.filter(Boolean).length;
    setSaveButton("保存中…", true);
    for (let i = 0; i < data.images.length; i++) {
      if (!selected[i]) continue;
      const im = data.images[i];
      if (im.status === "ok" || im.status === "dup") { dup++; continue; }
      im.status = "ing"; setCellStatus(i, "ing");
      setMsg(`正在保存 ${ok + dup + err + 1} / ${total}…`);
      const r = await send({ type: "save", item: {
        urls: im.urls, source_url: data.source_url, title: data.title, author: data.author, platform: data.platform } });
      if (!r) { im.status = "err"; setCellStatus(i, "err"); err++; lastErr = "插件刚更新过，请刷新这个页面后再试"; break; }
      if (r.offline) { im.status = null; saving = false; return renderPanel("片板没有在运行。先在 Mac 上双击 <b>start.command</b>，再回来点保存。", true); }
      if (r.ok) { im.status = r.new ? "ok" : "dup"; r.new ? ok++ : dup++; savedKeys.add(imgKey(im)); }
      else { im.status = "err"; err++; lastErr = r.error; }
      setCellStatus(i, im.status);
    }
    saving = false;
    const parts = [];
    if (ok) parts.push(`新存入 ${ok} 张`);
    if (dup) parts.push(`${dup} 张库里已有`);
    if (err) parts.push(`${err} 张失败（${esc(lastErr)}）`);
    setMsg(parts.join("，") + (ok ? ' · <a class="open">打开片板</a>' : ""), err > 0 && !ok);
    const left = data.images.filter((im, i) => selected[i] && im.status !== "ok" && im.status !== "dup").length;
    setSaveButton(left ? `保存 ${left} 张` : "已全部保存", !left);
    fab.querySelector(".label").textContent = ok || dup ? "已存入片板 ✓" : "存入片板";
  }

  shadow.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest(".fab")) return panel.hidden ? openPanel() : (panel.hidden = true);
    if (t.closest(".x")) { panel.hidden = true; return; }
    if (t.closest(".open")) { send({ type: "open-app" }); return; }
    if (saving) return;
    const cell = t.closest(".cell");
    if (cell) { const i = +cell.dataset.i; selected[i] = !selected[i]; return renderPanel(); }
    if (t.closest(".sel")) {
      const open = data.images.map((im, i) => i).filter((i) => data.images[i].status !== "ok");
      const all = open.every((i) => selected[i]);
      open.forEach((i) => (selected[i] = !all));
      return renderPanel();
    }
    if (t.closest(".save")) return saveSelected();
  });

  // 小红书是单页应用，切换笔记时网址会变，定时检查一下
  let lastKey;
  setInterval(() => {
    const key = currentKey();
    if (key === lastKey) return;
    lastKey = key;
    fab.hidden = !key;
    fab.querySelector(".label").textContent = "存入片板";
    if (key !== panelKey) { panel.hidden = true; data = null; }
  }, 600);

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "toast") toast(msg.text); });
})();
