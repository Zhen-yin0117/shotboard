/* Shotboard 图形模块：姿势识别 + 姿势线稿 + 俯视布光图 */
(function () {
  const PALETTE = {
    dark:  { mfill: "#34302b", mfillL: "#5a3324", mfar: "#272420", mfarL: "#40261c", mstroke: "#ece7e0", bg: "#1b1a18", paper: "#22201d", line: "#3b3833", text: "#ece7e0", sub: "#a39d94", body: "#ece7e0", left: "#e8643c", frame: "#5a554e", beam: "rgba(255,214,140,.10)", subject: "#ece7e0", accent: "#e8643c" },
    light: { mfill: "#ffffff", mfillL: "#fde1d5", mfar: "#ebe7e1", mfarL: "#f2c9b7", mstroke: "#2a2622", bg: "#ffffff", paper: "#ffffff", line: "#d8d2c8", text: "#1d1b18", sub: "#6f6a63", body: "#2a2622", left: "#e2552c", frame: "#b9b1a5", beam: "rgba(240,170,60,.16)", subject: "#2a2622", accent: "#e2552c" },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ================= 姿势识别（MediaPipe Holistic：身体 + 手 + 脸，完全在本机浏览器里运行） ================= */
  const POSE_VERSION = 2;
  // 脸部只存画结构线需要的点：脸轮廓 36 个 + 眼角、鼻子、嘴
  const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const FACE_EXTRA = [33, 133, 362, 263, 1, 168, 61, 291, 13, 14];
  const FACE_IDX = [...FACE_OVAL, ...FACE_EXTRA];
  const FX = { eyeA1: 36, eyeA2: 37, eyeB1: 38, eyeB2: 39, noseTip: 40, bridge: 41, mouthL: 42, mouthR: 43, lipTop: 44, lipBot: 45, forehead: 0, chin: 18 };

  let lib = null, queue = Promise.resolve();

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("加载失败：" + src));
      document.head.append(s);
    });
  }

  async function getLib() {
    if (lib) return lib;
    if (!window.Holistic) await loadScript("/static/vendor/holistic/holistic.js");
    const h = new window.Holistic({ locateFile: (f) => `/static/vendor/holistic/${f}` });
    h.setOptions({ modelComplexity: 1, smoothLandmarks: false, refineFaceLandmarks: false, minDetectionConfidence: 0.3 });
    await h.initialize();
    lib = h;
    return h;
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("图片加载失败"));
      img.src = url;
    });
  }

  const r4 = (n) => +(+n).toFixed(4);

  /** 识别一张图里的人物：身体 33 点 + 双手各 21 点 + 脸部结构点。没有人物时 points 为 null */
  function detectPose(imageUrl) {
    const job = queue.then(async () => {
      const [h, img] = await Promise.all([getLib(), loadImage(imageUrl)]);
      const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      const r = await new Promise((res, rej) => { h.onResults(res); h.send({ image: cv }).catch(rej); });
      const lm = r.poseLandmarks;
      const out = { v: POSE_VERSION, w: img.naturalWidth, h: img.naturalHeight, points: null, hands: {}, face: null };
      if (lm) out.points = lm.map((p) => [r4(p.x), r4(p.y), +(p.visibility ?? 1).toFixed(2), r4(p.z || 0)]);
      // 把检测到的手按距离分给身体的左手腕(15)/右手腕(16)，不依赖模型自己的左右判断
      for (const hand of [r.leftHandLandmarks, r.rightHandLandmarks]) {
        if (!hand) continue;
        let side = "L";
        if (lm) {
          const d = (i) => Math.hypot(lm[i].x - hand[0].x, lm[i].y - hand[0].y);
          side = d(15) <= d(16) ? "L" : "R";
          if (out.hands[side]) side = side === "L" ? "R" : "L";
        }
        out.hands[side] = hand.map((p) => [r4(p.x), r4(p.y), r4(p.z || 0)]);
      }
      if (r.faceLandmarks) out.face = FACE_IDX.map((i) => { const p = r.faceLandmarks[i]; return [r4(p.x), r4(p.y), r4(p.z || 0)]; });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }

  /* ================= 姿势线稿：人体模型（美术人偶）画法 ================= */
  const V = {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    mul: (a, k) => ({ x: a.x * k, y: a.y * k }), len: (a) => Math.hypot(a.x, a.y),
    norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
    perp: (a) => ({ x: -a.y, y: a.x }), lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    mid: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  };
  const f1 = (n) => Math.round(n * 10) / 10;
  const pt = (p) => `${f1(p.x)} ${f1(p.y)}`;

  // 平滑闭合曲线（Catmull-Rom → 贝塞尔）
  function smoothClosed(ps, k = 1) {
    const n = ps.length;
    let d = `M${pt(ps[0])}`;
    for (let i = 0; i < n; i++) {
      const p0 = ps[(i - 1 + n) % n], p1 = ps[i], p2 = ps[(i + 1) % n], p3 = ps[(i + 2) % n];
      const c1 = V.add(p1, V.mul(V.sub(p2, p0), k / 6)), c2 = V.sub(p2, V.mul(V.sub(p3, p1), k / 6));
      d += ` C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
    }
    return d + "Z";
  }
  function smoothOpen(ps) {
    let d = `M${pt(ps[0])}`;
    for (let i = 0; i < ps.length - 1; i++) {
      const p0 = ps[Math.max(0, i - 1)], p1 = ps[i], p2 = ps[i + 1], p3 = ps[Math.min(ps.length - 1, i + 2)];
      d += ` C${pt(V.add(p1, V.mul(V.sub(p2, p0), 1 / 6)))} ${pt(V.sub(p2, V.mul(V.sub(p3, p1), 1 / 6)))} ${pt(p2)}`;
    }
    return d;
  }

  // 一段肢体：两头圆、中间略鼓（肌肉），粗细从 rA 渐变到 rB
  function limbPath(A, B, rA, rB, bulge = 0.12, peak = 0.4) {
    const L = V.dist(A, B);
    if (L < 1e-3) return "";
    const u = V.norm(V.sub(B, A)), n = V.perp(u);
    const rm = (rA + (rB - rA) * peak) * (1 + bulge);
    const cm = V.add(A, V.mul(u, L * peak));
    const a1 = V.add(A, V.mul(n, rA)), b1 = V.add(B, V.mul(n, rB));
    const b2 = V.sub(B, V.mul(n, rB)), a2 = V.sub(A, V.mul(n, rA));
    const q1 = V.add(cm, V.mul(n, rm * 1.05)), q2 = V.sub(cm, V.mul(n, rm * 1.05));
    return `M${pt(a1)} Q${pt(q1)} ${pt(b1)} A${f1(rB)} ${f1(rB)} 0 0 0 ${pt(b2)} Q${pt(q2)} ${pt(a2)} A${f1(rA)} ${f1(rA)} 0 0 0 ${pt(a1)}Z`;
  }

  function poseSVG(pose, opt = {}) {
    const C = PALETTE[opt.theme || "dark"];
    if (!pose || !pose.points) {
      return `<div class="fig-empty">${pose ? "没识别到人物" : "姿势识别中…"}</div>`;
    }
    const W = pose.w || 1000, H = pose.h || 1000, M = !!opt.mirror;
    const map = (x, y) => ({ x: (M ? 1 - x : x) * W, y: y * H });
    const pts = pose.points.map(([x, y, v, z]) => ({ ...map(x, y), v, z: z || 0 }));
    const ok = (i, min = 0.2) => {
      const p = pts[i];
      return p && p.v >= min && p.x > -0.2 * W && p.x < 1.2 * W && p.y > -0.2 * H && p.y < 1.2 * H;
    };
    const P = (i) => pts[i];

    // —— 身体尺度 S：以肩宽为主，侧身时用躯干长度兜底 ——
    const shOk = ok(11) && ok(12), hipOk = ok(23) && ok(24);
    const shW = shOk ? V.dist(P(11), P(12)) : 0;
    const torsoL = shOk && hipOk ? V.dist(V.mid(P(11), P(12)), V.mid(P(23), P(24))) : 0;
    const earW = ok(7, 0.3) && ok(8, 0.3) ? V.dist(P(7), P(8)) : 0;
    const S = Math.max(shW, torsoL * 0.68, earW * 2.2, Math.min(W, H) * 0.08);
    const sw = Math.max(S * 0.022, Math.max(W, H) * 0.0022);

    const parts = [];   // {z, svg}
    const shade = (side, z, refZ) => {
      const far = z > refZ + S / W * 0.15; // 在躯干后面的部位稍微压暗
      if (side === "L") return far ? C.mfarL : C.mfillL;
      return far ? C.mfar : C.mfill;
    };
    const torsoZ = shOk ? (P(11).z + P(12).z + (hipOk ? P(23).z + P(24).z : P(11).z + P(12).z)) / 4 : 0;
    const style = (fill, weak) => `fill="${fill}" stroke="${C.mstroke}" stroke-width="${f1(sw)}" stroke-linejoin="round"${weak ? ` stroke-dasharray="${f1(sw * 2.2)} ${f1(sw * 1.6)}" opacity=".55"` : ""}`;

    // —— 四肢 ——
    const LIMB_SPECS = [
      // [起点, 终点, 侧, 起点半径, 终点半径, 鼓起, 鼓起位置]  半径单位：S
      [11, 13, "L", 0.095, 0.074, 0.14, 0.35], [13, 15, "L", 0.074, 0.05, 0.12, 0.3],
      [12, 14, "R", 0.095, 0.074, 0.14, 0.35], [14, 16, "R", 0.074, 0.05, 0.12, 0.3],
      [23, 25, "L", 0.13, 0.088, 0.1, 0.35], [25, 27, "L", 0.088, 0.054, 0.22, 0.28],
      [24, 26, "R", 0.13, 0.088, 0.1, 0.35], [26, 28, "R", 0.088, 0.054, 0.22, 0.28],
    ];
    const JOINT_R = { 11: 0.105, 12: 0.105, 13: 0.068, 14: 0.068, 15: 0.046, 16: 0.046, 23: 0.11, 24: 0.11, 25: 0.08, 26: 0.08, 27: 0.05, 28: 0.05 };
    for (const [a, b, side, ra, rb, bulge, peak] of LIMB_SPECS) {
      if (!ok(a) || !ok(b)) continue;
      const weak = P(a).v < 0.5 || P(b).v < 0.5;
      const z = (P(a).z + P(b).z) / 2;
      const fill = shade(side, z, torsoZ);
      let svg = `<path d="${limbPath(P(a), P(b), ra * S, rb * S, bulge, peak)}" ${style(fill, weak)}/>`;
      // 关节球：肘、膝画在远端那节上更自然，这里统一画在两端
      for (const j of [a, b]) svg += `<circle cx="${f1(P(j).x)}" cy="${f1(P(j).y)}" r="${f1(JOINT_R[j] * S)}" ${style(fill, weak)}/>`;
      parts.push({ z, svg });
    }

    // —— 手 ——
    for (const [side, wr, pinky, index, thumb] of [["L", 15, 17, 19, 21], ["R", 16, 18, 20, 22]]) {
      if (!ok(wr, 0.3)) continue;
      const fill = shade(side, P(wr).z - 0.01, torsoZ);
      const hand = pose.hands && pose.hands[side];
      let svg = "";
      if (hand && hand.length === 21) {
        // 有手部关键点：画出手掌和每根手指的三节
        const h = hand.map(([x, y]) => map(x, y));
        const hs = V.dist(h[0], h[9]);                         // 手掌长度
        svg += `<path d="${smoothClosed([h[0], h[1], h[2], h[5], h[9], h[13], h[17]].map((p, i, arr) => i === 0 ? V.add(p, V.mul(V.norm(V.sub(p, V.mid(arr[3], arr[6]))), hs * 0.05)) : p), 0.8)}" ${style(fill)}/>`;
        const FINGERS = [[1, 2, 3, 4, 0.13], [5, 6, 7, 8, 0.1], [9, 10, 11, 12, 0.105], [13, 14, 15, 16, 0.098], [17, 18, 19, 20, 0.085]];
        for (const [a, b, c, d, w] of FINGERS) {
          const segs = [[a, b], [b, c], [c, d]];
          segs.forEach(([p, q], k) => {
            const r1 = hs * w * (1 - k * 0.12), r2 = hs * w * (1 - (k + 1) * 0.12);
            svg += `<path d="${limbPath(h[p], h[q], r1, r2, 0.05)}" ${style(fill)}/>`;
          });
        }
      } else if (ok(index, 0.3) && ok(pinky, 0.3)) {
        // 没有手部细节：按手腕、食指、小指、拇指画一个「连指手套」形状
        const w0 = P(wr), tipMid = V.mid(P(index), P(pinky));
        const dir = V.norm(V.sub(tipMid, w0)), n = V.perp(dir);
        const L = Math.max(V.dist(w0, tipMid), S * 0.12);
        const half = Math.max(V.dist(P(index), P(pinky)) / 2, S * 0.05);
        const sideSign = Math.sign((P(index).x - P(pinky).x) * n.x + (P(index).y - P(pinky).y) * n.y) || 1;
        const ns = V.mul(n, sideSign);
        const shape = [
          V.add(w0, V.mul(ns, half * 0.75)), V.add(V.add(w0, V.mul(dir, L)), V.mul(ns, half * 1.05)),
          V.add(w0, V.mul(dir, L * 1.85)), V.sub(V.add(w0, V.mul(dir, L)), V.mul(ns, half * 1.0)),
          V.sub(w0, V.mul(ns, half * 0.7)),
        ];
        svg += `<path d="${smoothClosed(shape, 0.9)}" ${style(fill)}/>`;
        if (ok(thumb, 0.3)) {
          const tb = V.add(w0, V.mul(ns, half * 0.6));
          const tt = V.add(P(thumb), V.mul(V.norm(V.sub(P(thumb), tb)), L * 0.35));
          svg += `<path d="${limbPath(tb, tt, half * 0.42, half * 0.3, 0.1)}" ${style(fill)}/>`;
        }
      }
      if (svg) parts.push({ z: P(wr).z - 0.01, svg });
    }

    // —— 脚 ——
    for (const [side, an, heel, toe] of [["L", 27, 29, 31], ["R", 28, 30, 32]]) {
      if (!ok(an) || !ok(heel, 0.15) || !ok(toe, 0.15)) continue;
      const A = P(an), He = P(heel), T = P(toe);
      const u = V.norm(V.sub(T, He)), n = V.perp(u);
      const wT = S * 0.065, wH = S * 0.045;
      const shape = [
        V.add(A, V.mul(n, S * 0.05)), V.add(He, V.mul(n, wH)), V.sub(He, V.mul(u, S * 0.025)), V.sub(He, V.mul(n, wH)),
        V.sub(T, V.mul(n, wT)), V.add(T, V.mul(u, S * 0.045)), V.add(T, V.mul(n, wT)), V.sub(A, V.mul(n, S * 0.05)),
      ];
      const z = (A.z + T.z) / 2;
      parts.push({ z, svg: `<path d="${smoothClosed(shape, 0.7)}" ${style(shade(side, z, torsoZ), A.v < 0.5)}/>` });
    }

    // —— 躯干：胸廓 + 骨盆分开画，扭转和侧弯一眼能看出来 ——
    let neckBase = null, down = { x: 0, y: 1 };
    if (shOk) {
      const sL = P(11), sR = P(12);
      neckBase = V.mid(sL, sR);
      let hL, hR;
      if (hipOk) { hL = P(23); hR = P(24); }
      else {     // 胯部不在画面里：按肩线往下估计
        let dn = V.perp(V.norm(V.sub(sR, sL)));
        if (dn.y < 0) dn = V.mul(dn, -1);
        hL = V.add(V.lerp(sL, sR, 0.08), V.mul(dn, S * 1.25)); hR = V.add(V.lerp(sL, sR, 0.92), V.mul(dn, S * 1.25));
      }
      const hipMid = V.mid(hL, hR);
      down = V.norm(V.sub(hipMid, neckBase));
      const side0 = V.perp(down);                           // 垂直于脊柱、指向画面的「右」
      const across = (a, b) => {                             // 从左到右的方向；侧身时退回到垂直脊柱的方向
        const v = V.sub(b, a);
        return V.len(v) < S * 0.25 ? side0 : V.norm(v);
      };
      const aS = across(sL, sR), aH = across(hL, hR);
      // 侧身时肩宽/胯宽会被压扁，给一个最小厚度（胸腔厚度）
      const halfS = Math.max(V.dist(sL, sR) / 2, S * 0.2), halfH = Math.max(V.dist(hL, hR) / 2, S * 0.2);
      const cS = neckBase, cH = hipMid;
      const sL2 = V.sub(cS, V.mul(aS, halfS + S * 0.05)), sR2 = V.add(cS, V.mul(aS, halfS + S * 0.05));
      const hL2 = V.sub(cH, V.mul(aH, halfH + S * 0.09)), hR2 = V.add(cH, V.mul(aH, halfH + S * 0.09));
      // 沿身体两侧的轮廓：t=0 肩，t=1 胯；腰部向内收
      const edge = (top, bot, t, inset) => {
        const p = V.lerp(top, bot, t);
        const toC = V.norm(V.sub(V.lerp(cS, cH, t), p));
        return V.add(p, V.mul(toC, inset * S));
      };
      const neckTop = V.sub(cS, V.mul(down, S * 0.07));
      const outline = [
        V.lerp(neckTop, sL2, 0.45),
        V.sub(sL2, V.mul(down, S * 0.01)),
        edge(sL2, hL2, 0.2, -0.015),
        edge(sL2, hL2, 0.42, 0.03),
        edge(sL2, hL2, 0.64, 0.085),                         // 腰
        edge(sL2, hL2, 0.86, 0.02),
        V.add(hL2, V.mul(down, S * 0.06)),
        V.add(V.lerp(hL2, cH, 0.35), V.mul(down, S * 0.22)), // 大腿根
        V.add(cH, V.mul(down, S * 0.24)),                    // 裆部
        V.add(V.lerp(hR2, cH, 0.35), V.mul(down, S * 0.22)),
        V.add(hR2, V.mul(down, S * 0.06)),
        edge(sR2, hR2, 0.86, 0.02),
        edge(sR2, hR2, 0.64, 0.085),
        edge(sR2, hR2, 0.42, 0.03),
        edge(sR2, hR2, 0.2, -0.015),
        V.sub(sR2, V.mul(down, S * 0.01)),
        V.lerp(neckTop, sR2, 0.45),
        neckTop,
      ];
      const weak = sL.v < 0.5 && sR.v < 0.5;
      let svg = `<path d="${smoothClosed(outline, 0.9)}" ${style(C.mfill, weak)}/>`;
      // 结构线：胸廓下缘、骨盆（腰带）线、脊柱中线、肩线和胯线
      const ls = `stroke="${C.mstroke}" stroke-width="${f1(sw * 0.6)}" fill="none" stroke-linecap="round" opacity=".7"`;
      const ribL = edge(sL2, hL2, 0.55, 0.06), ribR = edge(sR2, hR2, 0.55, 0.06);
      svg += `<path d="M${pt(ribL)} Q${pt(V.add(V.lerp(cS, cH, 0.6), V.mul(down, S * 0.1)))} ${pt(ribR)}" ${ls}/>`;
      if (hipOk) {
        const pL = edge(sL2, hL2, 0.84, 0.03), pR = edge(sR2, hR2, 0.84, 0.03);
        svg += `<path d="M${pt(pL)} Q${pt(V.add(V.lerp(cS, cH, 0.86), V.mul(down, S * 0.14)))} ${pt(pR)}" ${ls}/>`;
      }
      const al = `stroke="${C.accent}" stroke-width="${f1(sw * 0.7)}" fill="none" stroke-linecap="round"`;
      svg += `<path d="${smoothOpen([V.sub(cS, V.mul(down, S * 0.04)), V.lerp(cS, cH, 0.5), V.add(cH, V.mul(down, S * 0.2))])}" ${al} stroke-dasharray="${f1(sw * 2)} ${f1(sw * 1.5)}"/>`;
      const ext = (a, b, k) => [V.add(a, V.mul(V.norm(V.sub(a, b)), S * k)), V.add(b, V.mul(V.norm(V.sub(b, a)), S * k))];
      if (V.dist(sL, sR) > S * 0.25) { const [x1, x2] = ext(sL, sR, 0.2); svg += `<path d="M${pt(x1)} L${pt(x2)}" ${al} opacity=".85"/>`; }
      if (hipOk && V.dist(hL, hR) > S * 0.2) { const [y1, y2] = ext(hL, hR, 0.24); svg += `<path d="M${pt(y1)} L${pt(y2)}" ${al} opacity=".85"/>`; }
      parts.push({ z: torsoZ, svg, torso: true });
    }

    // —— 头和脖子 ——
    let head = "";
    const face = pose.face ? pose.face.map(([x, y]) => map(x, y)) : null;
    let headCenter = null, headUp = { x: 0, y: -1 }, headH = S * 0.62, chin = null;
    if (face) {
      const oval = face.slice(0, FACE_OVAL.length);
      const top = face[FX.forehead], bot = face[FX.chin];
      headH = V.dist(top, bot) * 1.12;
      headUp = V.norm(V.sub(top, bot));
      const c = oval.reduce((a, p) => V.add(a, V.mul(p, 1 / oval.length)), { x: 0, y: 0 });
      chin = bot;
      // 后脑勺：侧脸时朝耳朵方向延伸
      let back = { x: 0, y: 0 };
      if (ok(7, 0.3) && ok(8, 0.3)) {
        const ears = V.mid(P(7), P(8));
        back = V.mul(V.sub(ears, c), 0.45);
      }
      const skullC = V.add(V.add(c, back), V.mul(headUp, headH * 0.12));
      const ang = Math.atan2(headUp.y, headUp.x) * 180 / Math.PI + 90;
      headCenter = skullC;
      const fl = `stroke="${C.mstroke}" stroke-width="${f1(sw * 0.8)}" fill="none" stroke-linecap="round"`;
      const cl = `stroke="${C.accent}" stroke-width="${f1(sw * 0.6)}" fill="none" stroke-linecap="round"`;
      head += `<ellipse cx="${f1(skullC.x)}" cy="${f1(skullC.y)}" rx="${f1(headH * 0.44)}" ry="${f1(headH * 0.47)}" transform="rotate(${f1(ang)} ${f1(skullC.x)} ${f1(skullC.y)})" ${style(C.mfill)}/>`;
      head += `<path d="${smoothClosed(oval, 0.9)}" ${style(C.mfill)}/>`;
      // 五官结构线：眼线、鼻梁、嘴，和面部中线
      const eA = V.mid(face[FX.eyeA1], face[FX.eyeA2]), eB = V.mid(face[FX.eyeB1], face[FX.eyeB2]);
      for (const [p, q] of [[FX.eyeA1, FX.eyeA2], [FX.eyeB1, FX.eyeB2]]) {
        const m = V.mid(face[p], face[q]), n = V.mul(V.perp(V.norm(V.sub(face[q], face[p]))), V.dist(face[p], face[q]) * 0.22);
        head += `<path d="M${pt(face[p])} Q${pt(V.sub(m, n))} ${pt(face[q])} Q${pt(V.add(m, n))} ${pt(face[p])}" ${fl}/>`;
      }
      head += `<path d="M${pt(face[FX.bridge])} L${pt(face[FX.noseTip])}" ${fl}/>`;
      const mouthMid = V.mid(face[FX.lipTop], face[FX.lipBot]);
      head += `<path d="M${pt(face[FX.mouthL])} Q${pt(mouthMid)} ${pt(face[FX.mouthR])}" ${fl}/>`;
      head += `<path d="${smoothOpen([top, face[FX.bridge], face[FX.noseTip], mouthMid, bot])}" ${cl} stroke-dasharray="${f1(sw * 1.6)} ${f1(sw * 1.2)}"/>`;
      const eyeDir = V.norm(V.sub(eB, eA)), em = V.mid(eA, eB), ew = headH * 0.45;
      head += `<path d="M${pt(V.sub(em, V.mul(eyeDir, ew)))} L${pt(V.add(em, V.mul(eyeDir, ew)))}" ${cl} stroke-dasharray="${f1(sw * 1.6)} ${f1(sw * 1.2)}"/>`;
    } else {
      // 没有脸部细节：用耳朵/眼睛/鼻子估计头的位置和朝向
      const eyesOk = ok(2, 0.3) && ok(5, 0.3);
      const earsOk = ok(7, 0.3) && ok(8, 0.3);
      const c = earsOk ? V.mid(P(7), P(8)) : eyesOk ? V.mid(P(2), P(5)) : ok(0) ? P(0) : null;
      if (c) {
        if (neckBase) headUp = V.norm(V.sub(c, neckBase));
        headH = Math.max(earW * 1.5, S * 0.6);
        headCenter = V.add(c, V.mul(headUp, headH * 0.05));
        chin = V.sub(headCenter, V.mul(headUp, headH * 0.5));
        const ang = Math.atan2(headUp.y, headUp.x) * 180 / Math.PI + 90;
        head += `<ellipse cx="${f1(headCenter.x)}" cy="${f1(headCenter.y)}" rx="${f1(headH * 0.4)}" ry="${f1(headH * 0.5)}" transform="rotate(${f1(ang)} ${f1(headCenter.x)} ${f1(headCenter.y)})" ${style(C.mfill)}/>`;
        const cl = `stroke="${C.accent}" stroke-width="${f1(sw * 0.6)}" fill="none" stroke-linecap="round"`;
        if (eyesOk) {
          const eA = P(2), eB = P(5), d = V.norm(V.sub(eB, eA)), m = V.mid(eA, eB);
          head += `<path d="M${pt(V.sub(m, V.mul(d, headH * 0.4)))} L${pt(V.add(m, V.mul(d, headH * 0.4)))}" ${cl}/>`;
          if (ok(0)) head += `<path d="${smoothOpen([V.add(m, V.mul(headUp, headH * 0.3)), m, P(0), chin])}" ${cl} stroke-dasharray="${f1(sw * 1.6)} ${f1(sw * 1.2)}"/>`;
        }
        if (ok(0)) head += `<circle cx="${f1(P(0).x)}" cy="${f1(P(0).y)}" r="${f1(sw * 1.2)}" fill="${C.accent}"/>`;
      }
    }
    if (head) {
      let neck = "";
      if (neckBase && chin) {
        const top = V.add(V.lerp(chin, headCenter, 0.35), V.mul(headUp, 0));
        const bottom = V.sub(neckBase, V.mul(down, S * 0.02));
        neck = `<path d="${limbPath(bottom, top, S * 0.125, S * 0.105, 0.02)}" ${style(C.mfill)}/>`;
      }
      const hz = ok(0) ? P(0).z : torsoZ - 0.01;
      if (neck) parts.push({ z: torsoZ + 1e-4, svg: neck });            // 脖子在躯干后面，只露出上半截
      parts.push({ z: Math.min(hz, torsoZ) - 0.001, svg: head, head: true });
    }

    // 远的先画、近的后画（MediaPipe 的 z 越小离镜头越近）
    parts.sort((a, b) => b.z - a.z);
    const g = parts.map((p) => p.svg).join("");

    // 画布 = 取景框 + 人物范围
    const vis = pts.filter((_, i) => ok(i));
    const padB = S * 0.35;
    let minX = Math.min(0, ...vis.map((p) => p.x - padB)), maxX = Math.max(W, ...vis.map((p) => p.x + padB));
    let minY = Math.min(0, ...vis.map((p) => p.y - padB)), maxY = Math.max(H, ...vis.map((p) => p.y + padB));
    const pad = Math.max(W, H) * 0.03;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const fs = Math.max(W, H) * 0.026;
    return `<svg class="pose-svg" viewBox="${f1(minX)} ${f1(minY)} ${f1(maxX - minX)} ${f1(maxY - minY)}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
      <rect x="${f1(minX)}" y="${f1(minY)}" width="${f1(maxX - minX)}" height="${f1(maxY - minY)}" fill="${C.paper}"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${C.frame}" stroke-width="${f1(sw * 0.5)}" stroke-dasharray="${f1(sw * 2.4)} ${f1(sw * 1.6)}"/>
      <text x="${f1(fs * 0.6)}" y="${f1(fs * 1.4)}" font-size="${f1(fs)}" fill="${C.sub}" font-family="-apple-system, PingFang SC, sans-serif">取景框${M ? " · 已镜像" : ""}</text>
      ${g}
    </svg>`;
  }

  /** 旧版本识别结果（没有手和脸、没有深度）需要重新识别 */
  const poseOutdated = (pose) => !!(pose && pose.points && (pose.v || 1) < POSE_VERSION);


  /* ================= 俯视布光图 ================= */
  const SUBJ = { x: 160, y: 140 };
  const R = 100;

  // 角度：0° = 从相机方向打过来（正面），90° = 相机左侧，180° = 人物正后方
  function polar(angle, r = R) {
    const a = (angle * Math.PI) / 180;
    return { x: Math.round(SUBJ.x - r * Math.sin(a)), y: Math.round(SUBJ.y + r * Math.cos(a)) };
  }

  const LIGHT_TYPES = {
    softbox: "柔光箱", strobe: "闪光灯", led: "LED 灯", window: "窗户", sun: "太阳", sky: "开阔天空",
    reflector: "反光板", neon: "霓虹/环境光", top: "顶光", gobo: "遮挡物", camera: "相机",
  };

  function defaultDiagram(tags = {}) {
    const P = tags.lighting_pattern || [], src = tags.light_source || [];
    const q = (tags.light_quality || [])[0], time = (tags.time_of_day || [])[0];
    const has = (arr, v) => arr.includes(v);

    // 主光类型
    let keyType = "softbox";
    if (has(src, "窗光")) keyType = "window";
    else if (has(src, "闪光灯/影室灯")) keyType = q === "硬光" ? "strobe" : "softbox";
    else if (has(src, "持续灯/LED")) keyType = "led";
    else if (has(src, "环境光/霓虹")) keyType = "neon";
    else if (time === "阴天/散射光") keyType = "sky";
    else if (has(src, "自然光") || ["黄金时刻", "白天直射", "蓝调时刻"].includes(time)) keyType = time === "蓝调时刻" ? "sky" : "sun";

    // 主光角度（按布光类型，优先级从上到下）
    const RULES = [
      ["逆光", 175, "人物正后方"], ["分割光", 90, "人物侧面 90°"], ["侧光", 80, "侧面略靠前"],
      ["窄光", 55, "偏向背对相机的那半边脸"], ["伦勃朗光", 45, "侧前方 45°，略高于头"], ["宽光", 50, "偏向朝向相机的那半边脸"],
      ["环形光", 30, "侧前方 30°，略高于头"], ["蝴蝶光", 0, "正前方，高于头顶向下打"], ["顺光/平光", 22, "相机旁边，正对人物"],
    ];
    const rule = RULES.find(([name]) => has(P, name));
    let angle = rule ? rule[1] : 40;
    const butterfly = rule && rule[0] === "蝴蝶光", flat = rule && rule[0] === "顺光/平光";
    const r = butterfly ? 74 : flat ? 122 : keyType === "sun" ? 118 : R;
    const items = [];
    const timeTxt = keyType === "sun" && time ? `（${time}）` : "";
    items.push({ id: "key", type: keyType, ...polar(angle, r), label: `主光 · ${LIGHT_TYPES[keyType]}${timeTxt}`, note: rule ? rule[2] : "" });

    if (has(P, "顶光")) items.push({ id: "top", type: "top", x: SUBJ.x + 34, y: SUBJ.y - 34, label: "顶光（头顶）" });
    if (has(P, "斑驳光影")) {
      const g = polar(angle, r * 0.55);
      items.push({ id: "gobo", type: "gobo", ...g, label: "树叶/百叶遮挡" });
    }
    if (butterfly) items.push({ id: "fill", type: "reflector", ...polar(0, 40), label: "反光板（胸前）" });
    else if (has(src, "反光板补光") || has(P, "逆光")) items.push({ id: "fill", type: "reflector", ...polar(angle >= 150 ? 20 : -50, 72), label: "反光板补光" });
    if (has(P, "轮廓光/发丝光") && angle < 150) {
      items.push({ id: "rim", type: keyType === "sun" || keyType === "window" ? "strobe" : keyType === "softbox" ? "strobe" : keyType, ...polar(-145, R), label: "轮廓光" });
    }
    if (has(src, "环境光/霓虹") && keyType !== "neon") items.push({ id: "amb", type: "neon", ...polar(-120, 95), label: "环境光/霓虹" });
    items.push({ id: "camera", type: "camera", x: SUBJ.x, y: 256, label: "相机" });
    return { v: 1, items };
  }

  function iconSVG(it, C) {
    const L = C.text, F = C.paper;
    switch (it.type) {
      case "softbox": return `<rect x="-6" y="-22" width="10" height="44" rx="2" fill="${L}"/><rect x="4" y="-22" width="3" height="44" fill="#fff" stroke="${L}" stroke-width="1"/><circle cx="-12" cy="0" r="4" fill="${L}"/>`;
      case "strobe": return `<circle cx="-6" cy="0" r="7" fill="${L}"/><path d="M0 -6 L12 -13 L12 13 L0 6 Z" fill="${L}"/>`;
      case "led": return `<rect x="-9" y="-9" width="14" height="18" rx="2" fill="${L}"/><path d="M5 -7 L13 -11 L13 11 L5 7 Z" fill="${C.accent}" opacity=".8"/>`;
      case "window": return `<rect x="-4" y="-32" width="9" height="64" fill="#cfe3f3" stroke="${L}" stroke-width="1.5"/><line x1="-4" y1="-11" x2="5" y2="-11" stroke="${L}" stroke-width="1"/><line x1="-4" y1="11" x2="5" y2="11" stroke="${L}" stroke-width="1"/>`;
      case "sky": return `<path d="M-4 -34 Q -16 0 -4 34" fill="none" stroke="#9fb7c9" stroke-width="7" stroke-linecap="round"/>`;
      case "reflector": return `<rect x="-2" y="-20" width="5" height="40" rx="2.5" fill="#f2f2f2" stroke="#9a9a9a" stroke-width="1.5"/>`;
      case "neon": return `<rect x="-3" y="-20" width="6" height="40" rx="3" fill="#d4459b"/><rect x="-3" y="-20" width="6" height="40" rx="3" fill="none" stroke="#ff7ad0" stroke-width="2" opacity=".5"/>`;
      case "gobo": return `<rect x="-2" y="-18" width="4" height="36" fill="none" stroke="${L}" stroke-width="2" stroke-dasharray="4 3"/>`;
      case "camera": return `<rect x="-14" y="-9" width="28" height="18" rx="3" fill="${L}"/><rect x="-6" y="-15" width="12" height="7" rx="1.5" fill="${L}"/><circle cx="0" cy="0" r="5" fill="${F}"/>`;
      default: return "";
    }
  }

  function labelSVG(it, C) {
    const text = it.label || LIGHT_TYPES[it.type];
    const w = [...text].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 6.2 : 11), 0);
    let dx = it.x - SUBJ.x, dy = it.y - SUBJ.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    if (it.type === "gobo" || it.type === "fill" || it.id === "fill" || d < 60) { const t = dx; dx = -dy; dy = t; } // 靠近人物的放侧面
    if (it.type === "camera") { dx = 0; dy = 1; }
    let x = it.x + dx * 34, y = it.y + dy * 30 + 4;
    let anchor = dx < -0.35 ? "end" : dx > 0.35 ? "start" : "middle";
    if (it.type !== "camera" && anchor === "middle" && dy > 0) { x = it.x + 28; y = it.y + 4; anchor = "start"; } // 正前方的灯：标签放右边，别压住相机
    let left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    if (left < 6 || left + w > 314 || y < 14) {  // 贴边放不下：改放到图标下方
      x = it.x; anchor = "middle"; y = it.y + (it.type === "window" || it.type === "sky" ? 46 : 36);
      left = x - w / 2;
    }
    if (left < 6) x += 6 - left;
    if (left + w > 314) x -= left + w - 314;
    y = Math.max(14, Math.min(294, y));
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="${it.type === "camera" ? C.sub : C.text}" font-weight="${it.id === "key" ? 600 : 400}" pointer-events="none">${esc(text)}</text>`;
  }

  function diagramSVG(diagram, opt = {}) {
    const C = PALETTE[opt.theme || "dark"];
    const items = diagram?.items || [];
    let beams = "", icons = "", labels = "";
    for (const it of items) {
      const isLight = !["camera", "reflector", "gobo", "top"].includes(it.type);
      const ang = Math.atan2(SUBJ.y - it.y, SUBJ.x - it.x) * 180 / Math.PI;
      if (isLight && it.type !== "sun") {
        const a = Math.atan2(SUBJ.y - it.y, SUBJ.x - it.x), spread = it.type === "strobe" ? 0.18 : 0.42;
        const d = Math.hypot(SUBJ.x - it.x, SUBJ.y - it.y) + 22;
        const p1 = [it.x + Math.cos(a - spread) * d, it.y + Math.sin(a - spread) * d];
        const p2 = [it.x + Math.cos(a + spread) * d, it.y + Math.sin(a + spread) * d];
        beams += `<path d="M${it.x} ${it.y} L${p1} L${p2} Z" fill="${C.beam}"/>`;
      }
      if (it.type === "sun") {
        const a = Math.atan2(SUBJ.y - it.y, SUBJ.x - it.x);
        beams += `<path d="M${it.x + Math.cos(a - 0.5) * 30} ${it.y + Math.sin(a - 0.5) * 30} L${SUBJ.x + Math.cos(a - 1.3) * 30} ${SUBJ.y + Math.sin(a - 1.3) * 30} L${SUBJ.x + Math.cos(a + 1.3) * 30} ${SUBJ.y + Math.sin(a + 1.3) * 30} L${it.x + Math.cos(a + 0.5) * 30} ${it.y + Math.sin(a + 0.5) * 30} Z" fill="${C.beam}"/>`;
      }
      let inner;
      if (it.type === "sun") {
        inner = `<circle r="11" fill="#f5b942"/>` + Array.from({ length: 8 }, (_, k) => {
          const a = k * Math.PI / 4;
          return `<line x1="${Math.cos(a) * 15}" y1="${Math.sin(a) * 15}" x2="${Math.cos(a) * 20}" y2="${Math.sin(a) * 20}" stroke="#f5b942" stroke-width="2.5" stroke-linecap="round"/>`;
        }).join("");
      } else if (it.type === "top") {
        inner = `<circle r="13" fill="none" stroke="${C.accent}" stroke-width="2" stroke-dasharray="4 3"/><circle r="4" fill="${C.accent}"/>`;
      } else if (it.type === "camera") {
        inner = `<g transform="rotate(${ang + 90})">${iconSVG(it, C)}</g>`;
      } else {
        inner = `<g transform="rotate(${ang})">${iconSVG(it, C)}</g>`;
      }
      const sel = opt.selected === it.id ? `<circle r="30" fill="none" stroke="${C.accent}" stroke-width="1.5" stroke-dasharray="3 3"/>` : "";
      icons += `<g class="lt" data-li="${esc(it.id)}" transform="translate(${it.x} ${it.y})" style="cursor:${opt.editable ? "grab" : "default"}">
        <circle r="26" fill="transparent"/>${sel}${inner}</g>`;
      labels += labelSVG(it, C);
    }
    // 人物（俯视：肩膀 + 头 + 鼻子朝相机）
    const cam = items.find((i) => i.type === "camera") || { x: SUBJ.x, y: 256 };
    const face = Math.atan2(cam.y - SUBJ.y, cam.x - SUBJ.x) * 180 / Math.PI - 90;
    const subject = `<g transform="translate(${SUBJ.x} ${SUBJ.y}) rotate(${face})">
      <ellipse rx="25" ry="11" fill="${C.subject}" opacity=".9"/>
      <circle r="10" cy="1" fill="${C.paper}" stroke="${C.subject}" stroke-width="2.5"/>
      <path d="M-3 10 L0 15 L3 10 Z" fill="${C.accent}"/></g>
      <text x="${SUBJ.x}" y="${SUBJ.y - 24}" text-anchor="middle" font-size="11" fill="${C.sub}">模特</text>`;
    return `<svg class="diagram-svg" viewBox="0 0 320 300" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, PingFang SC, sans-serif">
      <rect width="320" height="300" rx="10" fill="${C.paper}"/>
      <circle cx="${SUBJ.x}" cy="${SUBJ.y}" r="${R}" fill="none" stroke="${C.line}" stroke-dasharray="2 5"/>
      ${beams}${subject}${icons}${labels}
    </svg>`;
  }

  /* ================= 文字建议 ================= */
  const FOCAL = {
    "大特写": "100–135mm", "特写": "85–135mm", "近景": "85mm 左右", "中景": "50–85mm",
    "七分身": "50–70mm", "全身": "35–50mm", "远景": "24–35mm（环境人像）",
  };
  const TIME_TIP = {
    "黄金时刻": "日落前约 1 小时 / 日出后 1 小时", "蓝调时刻": "日落后 15–30 分钟",
    "阴天/散射光": "阴天，或找建筑背阴处", "白天直射": "白天直射光，注意眼窝阴影", "夜景": "天黑后，带补光灯",
  };
  function shotFacts(tags = {}) {
    const f = [];
    const size = (tags.shot_size || [])[0], angle = (tags.angle || [])[0], time = (tags.time_of_day || [])[0];
    if (size) f.push(["景别", size + (FOCAL[size] ? ` · 建议焦段 ${FOCAL[size]}` : "")]);
    if (angle) f.push(["机位", angle]);
    if (time && TIME_TIP[time]) f.push(["时间", TIME_TIP[time]]);
    if (tags.scene?.length) f.push(["场景", tags.scene.join("、")]);
    if (tags.outfit?.length) f.push(["服装", tags.outfit.join("、")]);
    if (tags.mood?.length) f.push(["情绪", tags.mood.join("、")]);
    return f;
  }

  window.Figures = { detectPose, poseSVG, poseOutdated, defaultDiagram, diagramSVG, shotFacts, LIGHT_TYPES, SUBJ, PALETTE };
})();
