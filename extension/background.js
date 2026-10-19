/* Shotboard 插件后台：下载图片 → 发给本地片板 */
const DEFAULT_SERVER = "http://127.0.0.1:8765";
// 这些图床插件有权限直接下载；其他网站交给本地片板去下载
const DIRECT_HOSTS = /(^|\.)(xhscdn\.com|xiaohongshu\.com|pinimg\.com|pinterest\.com|127\.0\.0\.1|localhost)$/;

async function serverUrl() {
  const { server } = await chrome.storage.local.get("server");
  return (server || DEFAULT_SERVER).replace(/\/+$/, "");
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function downloadDirect(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!DIRECT_HOSTS.test(host)) return null;
  try {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "";
    if (type && !type.startsWith("image/") && !type.includes("octet-stream")) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 2000) return null; // 太小，多半是占位图
    return `data:${type || "image/jpeg"};base64,` + toBase64(buf);
  } catch { return null; }
}

/** item: { urls: [候选地址，按清晰度从高到低], source_url, title, author, platform } */
async function saveItem(item) {
  const server = await serverUrl();
  const urls = item.urls || [item.url];
  let image_data = null, image_url = urls[urls.length - 1];
  for (const u of urls) {
    image_data = await downloadDirect(u);
    if (image_data) break;
  }
  const body = {
    source_url: item.source_url || null,
    title: item.title || null,
    author: item.author || null,
    platform: item.platform || null,
    ...(image_data ? { image_data } : { image_url }),
  };
  let r;
  try {
    r = await fetch(server + "/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, offline: true, error: "片板没有在运行" };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data.detail || `保存失败 (${r.status})` };
  return { ok: true, new: data.new, id: data.image?.id };
}

async function ping() {
  const server = await serverUrl();
  try {
    const r = await fetch(server + "/api/facets", { cache: "no-store" });
    if (!r.ok) throw new Error();
    const d = await r.json();
    return { ok: true, total: d.total, queue: d.queue, server };
  } catch {
    return { ok: false, server };
  }
}

/* 在小红书页面的主环境里读取笔记数据（比只看页面元素更完整、更清晰） */
function readXhsState(noteId) {
  try {
    const unwrap = (x) => {
      for (let i = 0; i < 4 && x && typeof x === "object"; i++) {
        if ("_value" in x) x = x._value;
        else if ("_rawValue" in x) x = x._rawValue;
        else if ("value" in x && "dep" in x) x = x.value;
        else break;
      }
      return x;
    };
    const st = window.__INITIAL_STATE__;
    if (!st) return null;
    const map = unwrap(unwrap(st.note)?.noteDetailMap);
    if (!map) return null;
    const entry = unwrap(map[noteId]);
    const note = unwrap(entry?.note);
    if (!note || !note.noteId && !note.imageList) return null;
    const images = (unwrap(note.imageList) || []).map((im) => {
      im = unwrap(im);
      const info = (unwrap(im.infoList) || []).map(unwrap);
      const best = info.find((i) => /DFT/i.test(i.imageScene || "")) || info[info.length - 1];
      return { urls: [im.urlDefault, best?.url, im.urlPre, im.url].filter(Boolean), width: im.width, height: im.height };
    }).filter((i) => i.urls.length);
    const user = unwrap(note.user) || {};
    return {
      title: note.title || (note.desc || "").split("\n")[0].slice(0, 40),
      author: user.nickname || user.nickName || "",
      type: note.type,
      images,
    };
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "save": return sendResponse(await saveItem(msg.item));
      case "ping": return sendResponse(await ping());
      case "xhs-state": {
        try {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
            world: "MAIN",
            func: readXhsState,
            args: [msg.noteId],
          });
          return sendResponse(res?.result || null);
        } catch { return sendResponse(null); }
      }
      case "open-app": {
        chrome.tabs.create({ url: await serverUrl() });
        return sendResponse(true);
      }
    }
  })();
  return true; // 异步回复
});

/* ---------- 右键菜单：任意网站的图片都能存 ---------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "save-image", title: "存到 Shotboard 片板", contexts: ["image"] });
});

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "save-image" || !info.srcUrl) return;
  if (info.srcUrl.startsWith("blob:")) return flashBadge("✕", "#e0605a");
  flashBadge("…", "#6f6a63");
  const r = await saveItem({ urls: [info.srcUrl], source_url: info.pageUrl || tab?.url, title: tab?.title });
  if (r.ok) flashBadge(r.new ? "✓" : "有", r.new ? "#5f9a5a" : "#6f6a63");
  else flashBadge("✕", "#e0605a");
  if (!r.ok && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toast", text: r.offline ? "片板没有在运行：先双击 start.command" : r.error }).catch(() => {});
  }
});
