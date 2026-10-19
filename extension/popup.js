const $ = (id) => document.getElementById(id);

async function check() {
  const r = await chrome.runtime.sendMessage({ type: "ping" });
  const box = $("status");
  if (r?.ok) {
    box.className = "status ok";
    $("statusText").textContent = `片板运行中 · 库里 ${r.total} 张` + (r.queue ? ` · 正在打标 ${r.queue} 张` : "");
    $("open").disabled = false;
  } else {
    box.className = "status bad";
    $("statusText").innerHTML = "片板没有在运行<br><span style='color:#a39d94'>在 Mac 上双击 start.command 启动</span>";
    $("open").disabled = true;
  }
  $("server").value = r?.server || "";
}

$("open").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-app" }).then(() => window.close()));
$("saveServer").addEventListener("click", async () => {
  const v = $("server").value.trim();
  await chrome.storage.local.set({ server: v || null });
  check();
});
check();
