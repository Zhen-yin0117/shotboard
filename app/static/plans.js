/* Shotboard 拍摄方案 */
(function () {
  const F = window.Figures;
  const P = {
    plans: [], plan: null,      // 当前打开的方案
    target: null,               // 从方案页跳去样片库挑图时的目标方案 {id, name}
    sel: null,                  // 布光图里选中的元素 {shot, item}
  };
  const view = () => $("#viewPlans");
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmtDate = (d) => d ? d.replace(/^(\d{4})-(\d{2})-(\d{2}).*/, "$1.$2.$3") : "";

  /* ================= 路由 ================= */
  function route() {
    const h = location.hash || "#/";
    const m = h.match(/^#\/plans(?:\/(\d+))?/);
    const isPlans = !!m;
    document.body.dataset.view = isPlans ? "plans" : "library";
    $("#viewLibrary").hidden = isPlans;
    view().hidden = !isPlans;
    $$("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.view === (isPlans ? "plans" : "library")));
    if (isPlans) {
      P.target = null;
      setSelecting(false);
      m[1] ? openPlan(+m[1]) : listPlans();
    } else {
      P.plan = null;
      updateSelbar();
    }
    scrollTo(0, 0);
  }
  addEventListener("hashchange", route);

  /* ================= 方案列表 ================= */
  async function listPlans() {
    view().innerHTML = `<div class="plans-wrap"><div class="muted">加载中…</div></div>`;
    try { P.plans = await api("/api/plans"); } catch (e) { return toast(e.message, true); }
    const cards = P.plans.map((p) => `
      <a class="plan-card" href="#/plans/${p.id}">
        <div class="plan-covers n${Math.min(p.covers.length, 4)}">${p.covers.map((c) => `<img src="${c}" alt="" loading="lazy">`).join("") || `<div class="plan-nocover">还没有镜头</div>`}</div>
        <div class="plan-info">
          <div class="plan-name">${esc(p.name)}</div>
          <div class="plan-sub">${[fmtDate(p.shoot_date), p.location, p.model_name].filter(Boolean).map(esc).join(" · ") || "未填写日期和地点"}</div>
          <div class="plan-count">${p.shot_count} 个镜头</div>
        </div>
      </a>`).join("");
    view().innerHTML = `
      <div class="plans-wrap">
        <div class="plans-head">
          <div><h1>拍摄方案</h1><p class="muted">从样片库挑出想拍的镜头，自动生成姿势线稿和布光图，导出一张长图发给模特。</p></div>
          <button class="btn primary" data-pact="new-plan">＋ 新建方案</button>
        </div>
        ${P.plans.length ? `<div class="plan-grid">${cards}</div>` : `
          <div class="plans-empty">
            <p>还没有拍摄方案。</p>
            <p class="muted">两种开始方式：点右上角「新建方案」；或者在样片库里点「批量选择」，选好几张后「加入拍摄方案」。</p>
          </div>`}
      </div>`;
  }

  async function newPlan(imageIds = []) {
    const name = prompt("给这次拍摄起个名字：", "未命名拍摄");
    if (name === null) return null;
    const plan = await api("/api/plans", { method: "POST", body: { name, image_ids: imageIds } });
    return plan;
  }

  /* ================= 方案编辑 ================= */
  async function openPlan(id) {
    if (!P.plan || P.plan.id !== id) view().innerHTML = `<div class="plans-wrap"><div class="muted">加载中…</div></div>`;
    try { P.plan = await api(`/api/plans/${id}`); }
    catch (e) { toast(e.message, true); location.hash = "#/plans"; return; }
    renderPlan();
    detectMissingPoses();
  }

  function shotDiagram(shot) {
    return shot.diagram || F.defaultDiagram(shot.image?.tags);
  }

  function shotHTML(shot, i) {
    const im = shot.image || { tags: {} };
    const facts = F.shotFacts(im.tags);
    const sel = P.sel && P.sel.shot === shot.id ? P.sel.item : null;
    return `
    <section class="shot" data-shot="${shot.id}">
      <header class="shot-head">
        <span class="shot-num">${String(i + 1).padStart(2, "0")}</span>
        <input class="shot-title" data-sf="title" value="${esc(shot.title || "")}" placeholder="${esc(im.description || "镜头 " + (i + 1))}">
        <div class="shot-tools">
          <button class="icon-btn" data-pact="up" title="上移" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-btn" data-pact="down" title="下移" ${i === P.plan.shots.length - 1 ? "disabled" : ""}>↓</button>
          <button class="icon-btn" data-pact="remove-shot" title="从方案中移除">✕</button>
        </div>
      </header>
      <div class="shot-visuals">
        <figure class="fig-ref">
          <div class="fig-box"><img src="${im.thumb_url}" alt="" loading="lazy"></div>
          <figcaption>参考样片${im.platform ? ` · <a href="${esc(im.source_url || "#")}" target="_blank" rel="noopener">${esc(im.platform)}</a>` : ""}</figcaption>
        </figure>
        <figure class="fig-pose">
          <div class="fig-box" data-pose="${im.id}">${F.poseSVG(!im.pose || F.poseOutdated(im.pose) ? undefined : im.pose, { mirror: shot.mirror })}</div>
          <figcaption>姿势线稿 <span class="legend"><i></i>模特的左侧</span>
            <button class="link" data-pact="mirror">${shot.mirror ? "取消镜像" : "镜像"}</button>
            ${im.pose ? `<button class="link" data-pact="redetect">重新识别</button>` : ""}</figcaption>
        </figure>
        <figure class="fig-light">
          <div class="fig-box diag" data-diag="${shot.id}">${F.diagramSVG(shotDiagram(shot), { editable: true, selected: sel })}</div>
          <figcaption>布光图 · 拖动调整，双击改名
            <select data-pact="add-light"><option value="">＋ 加一个</option>${Object.entries(F.LIGHT_TYPES).filter(([k]) => k !== "camera").map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
            ${sel ? `<button class="link" data-pact="rename-light">改名</button>` : ""}
            ${sel && sel !== "camera" ? `<button class="link danger" data-pact="del-light">删除</button>` : ""}
            ${shot.diagram ? `<button class="link" data-pact="reset-diagram">恢复自动</button>` : ""}
          </figcaption>
        </figure>
      </div>
      <div class="shot-text">
        <div class="facts">${facts.map(([k, v]) => `<span><b>${k}</b>${esc(v)}</span>`).join("") || `<span class="muted">这张样片还没打标签，打完标签后这里会显示景别、焦段等建议</span>`}</div>
        <div class="shot-fields">
          <label><span>姿势指导（给模特）</span><textarea data-sf="pose_hint" rows="3">${esc(shot.pose_hint ?? im.pose_hint ?? "")}</textarea></label>
          <label><span>布光说明（给自己/助理）</span><textarea data-sf="lighting_hint" rows="3">${esc(shot.lighting_hint ?? im.lighting_hint ?? "")}</textarea></label>
          <label><span>备注</span><textarea data-sf="notes" rows="3" placeholder="表情、道具、注意事项…">${esc(shot.notes || "")}</textarea></label>
        </div>
      </div>
    </section>`;
  }

  function renderPlan() {
    const p = P.plan;
    view().innerHTML = `
      <div class="plans-wrap plan-editor">
        <a class="back" href="#/plans">← 全部方案</a>
        <div class="pe-head">
          <input class="pe-name" data-pf="name" value="${esc(p.name)}" placeholder="方案名称">
          <div class="pe-meta">
            <label>日期<input type="date" data-pf="shoot_date" value="${esc(p.shoot_date || "")}"></label>
            <label>地点<input data-pf="location" value="${esc(p.location || "")}" placeholder="例如：某某公园"></label>
            <label>模特<input data-pf="model_name" value="${esc(p.model_name || "")}" placeholder="名字或昵称"></label>
          </div>
          <textarea class="pe-notes" data-pf="notes" rows="2" placeholder="整体说明：风格、服装和道具清单、集合时间…">${esc(p.notes || "")}</textarea>
          <div class="pe-actions">
            <button class="btn" data-pact="add-shots">＋ 从样片库添加镜头</button>
            <button class="btn primary" data-pact="export" ${p.shots.length ? "" : "disabled"}>导出 / 发给模特</button>
            <span class="pe-saved muted small" id="peSaved"></span>
            <button class="btn small danger" data-pact="delete-plan">删除方案</button>
          </div>
        </div>
        <div class="shots">
          ${p.shots.map(shotHTML).join("") || `<div class="plans-empty"><p>这个方案还没有镜头。</p><p class="muted">点上面的「从样片库添加镜头」，在样片库里选几张想拍的。</p></div>`}
        </div>
      </div>`;
  }

  function rerenderShot(shotId) {
    const i = P.plan.shots.findIndex((s) => s.id === shotId);
    const el = $(`.shot[data-shot="${shotId}"]`);
    if (i < 0 || !el) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = shotHTML(P.plan.shots[i], i);
    el.replaceWith(tmp.firstElementChild);
  }

  function flashSaved() {
    const el = $("#peSaved");
    if (!el) return;
    el.textContent = "已保存";
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => (el.textContent = ""), 1500);
  }

  // 每个字段单独计时，快速连续改几个字段时都能保存上
  const planTimers = {};
  function savePlanField(field, value) {
    const planId = P.plan.id;
    clearTimeout(planTimers[field]);
    planTimers[field] = setTimeout(async () => {
      try { await api(`/api/plans/${planId}`, { method: "PATCH", body: { [field]: value } }); flashSaved(); }
      catch (e) { toast(e.message, true); }
    }, 500);
  }

  const shotSavers = {};
  function saveShot(shotId, body, delay = 500) {
    const key = shotId + Object.keys(body).join();
    clearTimeout(shotSavers[key]);
    shotSavers[key] = setTimeout(async () => {
      try { await api(`/api/shots/${shotId}`, { method: "PATCH", body }); flashSaved(); }
      catch (e) { toast(e.message, true); }
    }, delay);
  }

  /* ---------- 姿势识别 ---------- */
  let detecting = false;
  async function detectMissingPoses() {
    if (detecting || !P.plan) return;
    detecting = true;
    try {
      for (const shot of [...(P.plan?.shots || [])]) {
        const im = shot.image;
        if (!im || (im.pose && !F.poseOutdated(im.pose))) continue;   // 旧版识别结果会自动升级成带手和脸的新版
        let pose;
        try { pose = await F.detectPose(im.image_url); }
        catch (e) { pose = { points: null, w: im.width, h: im.height, error: String(e.message || e) }; }
        im.pose = pose;
        P.plan?.shots.filter((s) => s.image?.id === im.id).forEach((s) => (s.image.pose = pose));
        api(`/api/images/${im.id}`, { method: "PATCH", body: { pose } }).catch(() => {});
        $$(`[data-pose="${im.id}"]`).forEach((box) => {
          const s = P.plan?.shots.find((x) => x.image?.id === im.id);
          box.innerHTML = F.poseSVG(pose, { mirror: s?.mirror });
        });
      }
    } finally { detecting = false; }
  }

  /* ---------- 布光图拖动 ---------- */
  let drag = null;
  function svgPoint(box, e) {
    const svg = box.querySelector("svg");
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  document.addEventListener("pointerdown", (e) => {
    const lt = e.target.closest("[data-li]");
    const box = e.target.closest(".diag[data-diag]");
    if (!box) return;
    const shot = P.plan?.shots.find((s) => s.id === +box.dataset.diag);
    if (!shot) return;
    if (!lt) { if (P.sel) { P.sel = null; rerenderShot(shot.id); } return; }
    e.preventDefault();
    const diagram = structuredClone(shotDiagram(shot));
    const item = diagram.items.find((x) => x.id === lt.dataset.li);
    const p = svgPoint(box, e);
    drag = { box, shot, diagram, item, dx: item.x - p.x, dy: item.y - p.y, moved: false };
    box.setPointerCapture(e.pointerId);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = svgPoint(drag.box, e);
    const nx = Math.round(Math.max(12, Math.min(308, p.x + drag.dx)));
    const ny = Math.round(Math.max(12, Math.min(288, p.y + drag.dy)));
    if (!drag.moved && Math.hypot(nx - drag.item.x, ny - drag.item.y) < 3) return;
    drag.moved = true;
    drag.item.x = nx; drag.item.y = ny;
    drag.box.innerHTML = F.diagramSVG(drag.diagram, { editable: true, selected: drag.item.id });
  });
  document.addEventListener("pointerup", () => {
    if (!drag) return;
    const { shot, diagram, item, moved } = drag;
    drag = null;
    const same = P.sel && P.sel.shot === shot.id && P.sel.item === item.id;
    P.sel = { shot: shot.id, item: item.id };
    if (moved) {
      shot.diagram = diagram;
      saveShot(shot.id, { diagram }, 0);
    }
    if (moved || !same) rerenderShot(shot.id);
  });
  document.addEventListener("dblclick", (e) => {
    const lt = e.target.closest("[data-li]"), box = e.target.closest(".diag[data-diag]");
    if (!lt || !box) return;
    renameItem(P.plan.shots.find((s) => s.id === +box.dataset.diag), lt.dataset.li);
  });

  function renameItem(shot, itemId) {
    const diagram = structuredClone(shotDiagram(shot));
    const item = diagram.items.find((x) => x.id === itemId);
    if (!item) return;
    const label = prompt("这个元素叫什么？", item.label || F.LIGHT_TYPES[item.type]);
    if (label === null) return;
    item.label = label.trim();
    shot.diagram = diagram;
    saveShot(shot.id, { diagram }, 0);
    rerenderShot(shot.id);
  }

  function deleteSelected() {
    if (!P.sel || P.sel.item === "camera") return;
    const shot = P.plan.shots.find((s) => s.id === P.sel.shot);
    const diagram = structuredClone(shotDiagram(shot));
    diagram.items = diagram.items.filter((x) => x.id !== P.sel.item);
    shot.diagram = diagram;
    P.sel = null;
    saveShot(shot.id, { diagram }, 0);
    rerenderShot(shot.id);
  }

  function addLight(shot, type) {
    const diagram = structuredClone(shotDiagram(shot));
    const used = diagram.items.map((i) => Math.atan2(i.y - F.SUBJ.y, i.x - F.SUBJ.x));
    // 找一个离已有元素最远的角度
    let best = 0, bestGap = -1;
    for (let a = -Math.PI; a < Math.PI; a += Math.PI / 12) {
      const gap = Math.min(...used.map((u) => Math.abs(Math.atan2(Math.sin(a - u), Math.cos(a - u)))));
      if (gap > bestGap) { bestGap = gap; best = a; }
    }
    const r = type === "top" ? 40 : type === "gobo" || type === "reflector" ? 70 : 100;
    const id = type + "-" + Date.now().toString(36);
    const roles = { reflector: "反光板", gobo: "遮挡物", top: "顶光", neon: "环境光" };
    diagram.items.push({
      id, type, x: Math.round(F.SUBJ.x + Math.cos(best) * r), y: Math.round(F.SUBJ.y + Math.sin(best) * r),
      label: roles[type] || `辅光 · ${F.LIGHT_TYPES[type]}`,
    });
    shot.diagram = diagram;
    P.sel = { shot: shot.id, item: id };
    saveShot(shot.id, { diagram }, 0);
    rerenderShot(shot.id);
  }

  /* ================= 样片库：批量选择 & 加入方案 ================= */
  function setSelecting(on) {
    state.selecting = on;
    if (!on) state.picked.clear();
    document.body.classList.toggle("selecting", on);
    $$(".card.picked").forEach((c) => c.classList.toggle("picked", state.picked.has(+c.dataset.id)));
    $("#selectBtn").textContent = on ? "取消选择" : "批量选择";
    updateSelbar();
  }

  function togglePick(id, card) {
    state.picked.has(id) ? state.picked.delete(id) : state.picked.add(id);
    card?.classList.toggle("picked", state.picked.has(id));
    updateSelbar();
  }

  function updateSelbar() {
    const bar = $("#selbar");
    const show = state.selecting && document.body.dataset.view !== "plans";
    bar.hidden = !show;
    if (!show) return;
    const n = state.picked.size;
    bar.innerHTML = P.target
      ? `<span>正在为「<b>${esc(P.target.name)}</b>」挑选镜头 · 已选 <b>${n}</b> 张</span>
         <button class="btn" data-pact="sel-cancel">返回方案</button>
         <button class="btn primary" data-pact="sel-add-target" ${n ? "" : "disabled"}>加入方案</button>`
      : `<span>已选 <b>${n}</b> 张 · 点卡片选择或取消</span>
         <button class="btn" data-pact="sel-cancel">取消</button>
         <button class="btn primary" data-pact="sel-add" ${n ? "" : "disabled"}>加入拍摄方案…</button>`;
  }

  /** 弹出「加入哪个方案」 */
  async function pick(imageIds) {
    let plans = [];
    try { plans = await api("/api/plans"); } catch {}
    $("#planPickerBody").innerHTML = `
      <h3>加入拍摄方案</h3>
      <p class="muted small">已选 ${imageIds.length} 张样片</p>
      <div class="pick-list">
        ${plans.map((p) => `<button class="pick-item" data-pact="pick-plan" data-id="${p.id}">
          <span>${esc(p.name)}</span><span class="muted small">${p.shot_count} 个镜头${p.shoot_date ? " · " + fmtDate(p.shoot_date) : ""}</span></button>`).join("")}
      </div>
      <form class="pick-new" data-pact="pick-new">
        <input placeholder="新方案名称，例如：周六海边逆光" required>
        <button class="btn primary">新建并加入</button>
      </form>
      <div class="dialog-actions"><button class="btn" data-pact="pick-close">取消</button></div>`;
    $("#planPicker").hidden = false;
    $("#planPicker").dataset.ids = JSON.stringify(imageIds);
    $(".pick-new input").focus();
  }

  async function addToPlan(planId, imageIds, planName) {
    const r = await api(`/api/plans/${planId}/shots`, { method: "POST", body: { image_ids: imageIds } });
    const msg = `已加入「${planName}」：${r.added} 张` + (r.skipped ? `（${r.skipped} 张已在方案里）` : "");
    showToastLink(msg, `#/plans/${planId}`);
  }

  function showToastLink(msg, href) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `${esc(msg)} · <a href="${href}">去看看</a>`;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), 5000);
  }

  /* ================= 导出 ================= */
  function openExport() {
    $("#exportBody").innerHTML = `
      <h3>导出拍摄方案</h3>
      <div class="exp-options">
        <label class="exp-card"><input type="radio" name="ver" value="model" checked>
          <div><b>模特版</b><span>姿势线稿 + 姿势指导 + 服装和情绪，不含布光等技术细节</span></div></label>
        <label class="exp-card"><input type="radio" name="ver" value="pro">
          <div><b>摄影师版</b><span>完整内容：布光图、焦段建议、布光说明，给自己或助理</span></div></label>
      </div>
      <label class="check"><input type="checkbox" id="expRef"> 包含参考样片原图</label>
      <p class="muted small" id="expRefNote">参考图是别人的作品，私下发给模特没问题，但不要公开发布。</p>
      <div class="dialog-actions">
        <button class="btn" data-pact="export-close">取消</button>
        <button class="btn" data-pact="export-print">打印 / 存为 PDF</button>
        <button class="btn primary" data-pact="export-png">导出长图</button>
      </div>`;
    $("#expRef").checked = false;
    $("#exportDlg").hidden = false;
  }

  function exportOptions() {
    return { pro: $('#exportBody input[name="ver"]:checked').value === "pro", ref: $("#expRef").checked };
  }

  function buildSheet({ pro, ref }) {
    const p = P.plan;
    const meta = [fmtDate(p.shoot_date), p.location, p.model_name ? "模特 " + p.model_name : ""].filter(Boolean);
    const shots = p.shots.map((s, i) => {
      const im = s.image || { tags: {} };
      const facts = F.shotFacts(im.tags).filter(([k]) => pro || ["场景", "服装", "情绪"].includes(k));
      const hasPose = !!im.pose?.points;
      const visuals = [
        ref ? `<div class="sx-fig sx-ref"><img src="${im.thumb_url}"><span>参考</span></div>` : "",
        hasPose ? `<div class="sx-fig">${F.poseSVG(im.pose, { mirror: s.mirror, theme: "light" })}<span>姿势 · <i class="lg"></i>橙色为模特左侧${s.mirror ? " · 已镜像" : ""}</span></div>` : "",
        pro ? `<div class="sx-fig">${F.diagramSVG(shotDiagram(s), { theme: "light" })}<span>布光（俯视）</span></div>` : "",
      ].filter(Boolean);
      const pose = s.pose_hint ?? im.pose_hint, light = s.lighting_hint ?? im.lighting_hint;
      const text = `<div class="sx-text">
          ${pose ? `<p><b>姿势</b>${esc(pose)}</p>` : ""}
          ${pro && light ? `<p><b>布光</b>${esc(light)}</p>` : ""}
          ${facts.map(([k, v]) => `<p><b>${k}</b>${esc(v)}</p>`).join("")}
          ${s.notes ? `<p><b>备注</b>${esc(s.notes)}</p>` : ""}
        </div>`;
      const title = `<div class="sx-title"><span class="sx-num">${String(i + 1).padStart(2, "0")}</span>${esc(s.title || im.description || "镜头 " + (i + 1))}</div>`;
      // 只有一张图时，图文左右排；多张图时图在上、文字在下
      const body = visuals.length <= 1
        ? `<div class="sx-side">${visuals.join("")}${text}</div>`
        : `<div class="sx-row n${visuals.length}">${visuals.join("")}</div>${text}`;
      return `<section class="sx-shot">${title}${body}</section>`;
    }).join("");
    $("#exportSheet").innerHTML = `
      <div class="sx">
        <header class="sx-head">
          <div class="sx-brand">● SHOTBOARD · ${pro ? "拍摄方案（摄影师版）" : "拍摄方案"}</div>
          <h1>${esc(p.name)}</h1>
          ${meta.length ? `<div class="sx-meta">${meta.map(esc).join("　·　")}　·　${p.shots.length} 个镜头</div>` : `<div class="sx-meta">${p.shots.length} 个镜头</div>`}
          ${p.notes ? `<p class="sx-notes">${esc(p.notes)}</p>` : ""}
        </header>
        ${shots}
        <footer class="sx-foot">用 Shotboard 片板 制作</footer>
      </div>`;
    return $("#exportSheet .sx");
  }

  async function exportPNG() {
    const opt = exportOptions();
    const btn = $('[data-pact="export-png"]');
    btn.disabled = true; btn.textContent = "生成中…";
    try {
      if (!window.htmlToImage) await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "/static/vendor/html-to-image.js"; s.onload = res; s.onerror = () => rej(new Error("导出组件加载失败"));
        document.head.append(s);
      });
      const node = buildSheet(opt);
      await Promise.all([...node.querySelectorAll("img")].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
      const h = node.offsetHeight;
      const ratio = Math.max(1, Math.min(2, 30000 / h));
      const blob = await window.htmlToImage.toBlob(node, { pixelRatio: ratio, backgroundColor: "#f6f3ee", cacheBust: false });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${P.plan.name}-${opt.pro ? "摄影师版" : "模特版"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      $("#exportDlg").hidden = true;
      toast("长图已下载，可以直接发微信给模特");
    } catch (e) {
      toast("导出失败：" + (e.message || e), true);
    } finally {
      btn.disabled = false; btn.textContent = "导出长图";
    }
  }

  function exportPrint() {
    const opt = exportOptions();
    buildSheet(opt);
    $("#exportDlg").hidden = true;
    document.title = `${P.plan.name}-${opt.pro ? "摄影师版" : "模特版"}`;
    setTimeout(() => { print(); document.title = "Shotboard 片板"; }, 300);
  }

  /* ================= 事件 ================= */
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-pact]");
    if (!t) {
      if (e.target.id === "planPicker") $("#planPicker").hidden = true;
      if (e.target.id === "exportDlg") $("#exportDlg").hidden = true;
      return;
    }
    if (t.tagName === "SELECT" || t.tagName === "FORM") return;
    e.preventDefault();
    const act = t.dataset.pact;
    const shotEl = t.closest(".shot");
    const shot = shotEl && P.plan?.shots.find((s) => s.id === +shotEl.dataset.shot);
    try {
      switch (act) {
        case "new-plan": {
          const plan = await newPlan();
          if (plan) location.hash = `#/plans/${plan.id}`;
          return;
        }
        case "delete-plan":
          if (!confirm(`删除方案「${P.plan.name}」？样片库里的图不会被删除。`)) return;
          await api(`/api/plans/${P.plan.id}`, { method: "DELETE" });
          location.hash = "#/plans";
          return;
        case "add-shots":
          P.target = { id: P.plan.id, name: P.plan.name };
          location.hash = "#/";
          setTimeout(() => setSelecting(true), 0);
          return;
        case "up": case "down": {
          const arr = P.plan.shots, i = arr.indexOf(shot), j = act === "up" ? i - 1 : i + 1;
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          renderPlan();
          await api(`/api/plans/${P.plan.id}/reorder`, { method: "POST", body: { shot_ids: arr.map((s) => s.id) } });
          flashSaved();
          return;
        }
        case "remove-shot":
          if (!confirm("从方案中移除这个镜头？（样片库里的图不受影响）")) return;
          await api(`/api/shots/${shot.id}`, { method: "DELETE" });
          P.plan.shots = P.plan.shots.filter((s) => s !== shot);
          renderPlan();
          return;
        case "mirror":
          shot.mirror = !shot.mirror;
          saveShot(shot.id, { mirror: shot.mirror }, 0);
          rerenderShot(shot.id);
          return;
        case "redetect":
          shot.image.pose = null;
          P.plan.shots.forEach((s) => { if (s.image?.id === shot.image.id) s.image.pose = null; });
          rerenderShot(shot.id);
          detectMissingPoses();
          return;
        case "del-light": return deleteSelected();
        case "rename-light": return renameItem(shot, P.sel?.item);
        case "reset-diagram":
          shot.diagram = null; P.sel = null;
          saveShot(shot.id, { reset_diagram: true }, 0);
          rerenderShot(shot.id);
          return;
        case "export": return openExport();
        case "export-close": $("#exportDlg").hidden = true; return;
        case "export-png": return exportPNG();
        case "export-print": return exportPrint();

        // 样片库批量选择
        case "sel-cancel": {
          const back = P.target;
          setSelecting(false);
          P.target = null;
          if (back) location.hash = `#/plans/${back.id}`;
          return;
        }
        case "sel-add": return pick([...state.picked]);
        case "sel-add-target": {
          const target = P.target;
          await addToPlan(target.id, [...state.picked], target.name);
          setSelecting(false);
          P.target = null;
          location.hash = `#/plans/${target.id}`;
          return;
        }
        case "pick-close": $("#planPicker").hidden = true; return;
        case "pick-plan": {
          const ids = JSON.parse($("#planPicker").dataset.ids);
          const name = t.querySelector("span").textContent;
          await addToPlan(+t.dataset.id, ids, name);
          $("#planPicker").hidden = true;
          if (state.selecting) setSelecting(false);
          return;
        }
      }
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.dataset.pact !== "pick-new") return;
    e.preventDefault();
    const name = $("input", e.target).value.trim();
    if (!name) return;
    try {
      const ids = JSON.parse($("#planPicker").dataset.ids);
      const plan = await api("/api/plans", { method: "POST", body: { name, image_ids: ids } });
      $("#planPicker").hidden = true;
      if (state.selecting) setSelecting(false);
      showToastLink(`已新建「${plan.name}」，加入 ${plan.shot_count} 张`, `#/plans/${plan.id}`);
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset.pact === "add-light" && e.target.value) {
      const shotEl = e.target.closest(".shot");
      const shot = P.plan.shots.find((s) => s.id === +shotEl.dataset.shot);
      addLight(shot, e.target.value);
    }
  });

  document.addEventListener("input", (e) => {
    const pf = e.target.dataset.pf, sf = e.target.dataset.sf;
    if (pf && P.plan) { P.plan[pf] = e.target.value; savePlanField(pf, e.target.value); }
    if (sf && P.plan) {
      const shot = P.plan.shots.find((s) => s.id === +e.target.closest(".shot").dataset.shot);
      shot[sf] = e.target.value;
      saveShot(shot.id, { [sf]: e.target.value });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && P.sel && document.body.dataset.view === "plans") { e.preventDefault(); deleteSelected(); }
    if (e.key === "Escape") { $("#planPicker").hidden = true; $("#exportDlg").hidden = true; if (state.selecting && document.body.dataset.view !== "plans") setSelecting(false); }
  });

  $("#selectBtn").addEventListener("click", () => setSelecting(!state.selecting));

  window.Plans = { pick, togglePick, setSelecting };
  route();
})();
