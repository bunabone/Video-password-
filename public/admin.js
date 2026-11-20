const $ = (id) => document.getElementById(id);
let codes = [];
let videos = [];

async function api(path, opts = {}) {
  const r = await fetch("/api/admin/" + path, {
    ...opts,
    headers: opts.body && typeof opts.body === "string" ? { "Content-Type": "application/json" } : opts.headers,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "login") showLogin();
  if (!r.ok) throw new Error(data.error || "שגיאה " + r.status);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(d) {
  return d ? new Date(d).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—";
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------- auth
function showLogin() {
  $("appView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
}
function showApp() {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  refreshAll();
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginErr").textContent = "";
  try {
    await api("login", { method: "POST", body: JSON.stringify({ password: $("pw").value }) });
    $("pw").value = "";
    showApp();
  } catch (ex) {
    $("loginErr").textContent = ex.message;
  }
});
$("logout").addEventListener("click", async () => {
  await api("logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin();
});

// ---------------- tabs
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $("tab-codes").classList.toggle("hidden", b.dataset.tab !== "codes");
    $("tab-videos").classList.toggle("hidden", b.dataset.tab !== "videos");
  })
);

async function refreshAll() {
  await Promise.all([loadVideos(), loadCodes()]);
}

// ---------------- codes
async function loadCodes() {
  try {
    codes = (await api("codes")).codes;
    renderCodes();
  } catch (ex) {
    $("codesBody").innerHTML = `<tr><td colspan="8" class="error">${esc(ex.message)}</td></tr>`;
  }
}

function status(c) {
  if (c.revoked) return '<span class="badge bad">בוטל</span>';
  if (Date.now() > Date.parse(c.expires)) return '<span class="badge warn">פג תוקף</span>';
  return '<span class="badge ok">פעיל</span>';
}

function renderCodes() {
  const q = $("filter").value.trim().toLowerCase();
  const rows = codes.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
  if (!rows.length) {
    $("codesBody").innerHTML = '<tr><td colspan="8" class="muted">אין קודים עדיין</td></tr>';
    return;
  }
  $("codesBody").innerHTML = rows
    .map(
      (c) => `<tr data-code="${esc(c.code)}">
      <td>${esc(c.name)}</td>
      <td class="code">${esc(c.code)}</td>
      <td>${esc(c.video)}</td>
      <td>${fmt(c.expires)}</td>
      <td>${status(c)}</td>
      <td>${c.devicesUsed}/${c.maxDevices || "∞"}</td>
      <td title="כניסה אחרונה: ${esc(fmt(c.lastUsed))}">${c.uses}</td>
      <td class="actions">
        <button class="ghost small" data-act="copy">העתק הודעה</button>
        <button class="ghost small" data-act="extend">שנה תוקף</button>
        <button class="ghost small" data-act="reset" title="מאפשר לצופה להיכנס ממכשיר חדש">אפס מכשירים</button>
        <button class="danger small" data-act="${c.revoked ? "restore" : "revoke"}">${c.revoked ? "שחזר" : "בטל"}</button>
        <button class="danger small" data-act="delete">מחק</button>
      </td>
    </tr>`
    )
    .join("");
}

$("filter").addEventListener("input", renderCodes);

$("codesBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const code = btn.closest("tr").dataset.code;
  const c = codes.find((x) => x.code === code);
  try {
    switch (btn.dataset.act) {
      case "copy": {
        const msg =
          `שלום ${c.name},\nלצפייה בסרטון היכנס/י לקישור:\n${location.origin}/\n` +
          `קוד הצפייה האישי שלך: ${c.code}\nהקוד בתוקף עד ${fmt(c.expires)}.`;
        await navigator.clipboard.writeText(msg);
        toast("ההודעה הועתקה");
        return;
      }
      case "extend": {
        const cur = toLocalInput(new Date(c.expires)).replace("T", " ");
        const v = prompt("תאריך ושעת תפוגה חדשים (YYYY-MM-DD HH:MM):", cur);
        if (!v) return;
        const d = new Date(v.trim().replace(" ", "T"));
        if (isNaN(d)) return alert("תאריך לא תקין");
        await api("codes/" + code, { method: "PATCH", body: JSON.stringify({ expires: d.toISOString() }) });
        break;
      }
      case "reset":
        if (!confirm("לאפס את המכשירים של " + c.name + "? הצופה יצטרך להזין את הקוד מחדש.")) return;
        await api("codes/" + code, { method: "PATCH", body: JSON.stringify({ resetDevices: true }) });
        break;
      case "revoke":
        if (!confirm("לבטל את הקוד של " + c.name + "? הצפייה תיחסם מיד.")) return;
        await api("codes/" + code, { method: "PATCH", body: JSON.stringify({ revoked: true }) });
        break;
      case "restore":
        await api("codes/" + code, { method: "PATCH", body: JSON.stringify({ revoked: false }) });
        break;
      case "delete":
        if (!confirm("למחוק לצמיתות את הקוד של " + c.name + "?")) return;
        await api("codes/" + code, { method: "DELETE" });
        break;
    }
    await loadCodes();
  } catch (ex) {
    alert(ex.message);
  }
});

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("createErr").textContent = "";
  const names = $("names").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    const res = await api("codes", {
      method: "POST",
      body: JSON.stringify({
        names,
        video: $("video").value,
        expires: new Date($("expires").value).toISOString(),
        maxDevices: $("maxDevices").value,
      }),
    });
    $("names").value = "";
    toast(res.codes.length === 1 ? "נוצר קוד: " + res.codes[0].code : `נוצרו ${res.codes.length} קודים`);
    await loadCodes();
  } catch (ex) {
    $("createErr").textContent = ex.message;
  }
});

// ---------------- videos
async function loadVideos() {
  try {
    videos = (await api("videos")).videos;
  } catch (ex) {
    $("videosBody").innerHTML = `<tr><td colspan="4" class="error">${esc(ex.message)}</td></tr>`;
    return;
  }
  const sel = $("video");
  const prev = sel.value;
  sel.innerHTML = videos.length
    ? videos.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}${v.ready ? "" : " (לא מוכן)"}</option>`).join("")
    : '<option value="">— קודם יש להעלות סרטון —</option>';
  if (prev) sel.value = prev;

  $("videosBody").innerHTML = videos.length
    ? videos
        .map(
          (v) => `<tr data-video="${esc(v.name)}">
        <td>${esc(v.name)}</td>
        <td>${v.ready ? '<span class="badge ok">מוכן לצפייה</span>' : '<span class="badge warn">חסרים קבצים</span>'}</td>
        <td>${fmt(v.uploaded)}</td>
        <td><button class="danger small" data-act="del">מחק סרטון</button></td>
      </tr>`
        )
        .join("")
    : '<tr><td colspan="4" class="muted">עדיין לא הועלו סרטונים</td></tr>';
}

$("videosBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act=del]");
  if (!btn) return;
  const name = btn.closest("tr").dataset.video;
  if (!confirm(`למחוק את הסרטון "${name}" מהאתר? (הקודים יישארו אבל לא יוכלו לנגן)`)) return;
  try {
    await api("videos/" + encodeURIComponent(name), { method: "DELETE" });
    await loadVideos();
  } catch (ex) {
    alert(ex.message);
  }
});

$("folder").addEventListener("change", () => {
  const files = [...$("folder").files];
  if (!$("vname").value && files[0]?.webkitRelativePath) {
    const dir = files[0].webkitRelativePath.split("/")[0];
    $("vname").value = dir.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }
});

$("uploadBtn").addEventListener("click", async () => {
  $("uploadErr").textContent = "";
  const name = $("vname").value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    $("uploadErr").textContent = "שם הסרטון: אותיות אנגליות קטנות, ספרות, מקף או קו תחתון בלבד";
    return;
  }
  const all = [...$("folder").files].filter((f) => /(\.ts|\.m3u8|^enc\.key)$/.test(f.name));
  const segs = all.filter((f) => f.name.endsWith(".ts"));
  const playlist = all.find((f) => f.name === "index.m3u8");
  const key = all.find((f) => f.name === "enc.key");
  if (!playlist || !key || !segs.length) {
    $("uploadErr").textContent = "התיקייה צריכה להכיל index.m3u8, enc.key וקבצי .ts (הכן אותה עם הסקריפט prepare-video)";
    return;
  }
  if (videos.some((v) => v.name === name) && !confirm(`סרטון בשם "${name}" כבר קיים. להחליף אותו?`)) return;

  const order = [...segs, key, playlist]; // playlist last => video becomes "ready" only when complete
  const total = order.reduce((s, f) => s + f.size, 0);
  let done = 0, doneFiles = 0;
  const bar = $("prog").firstElementChild;
  $("prog").classList.remove("hidden");
  $("uploadBtn").disabled = true;
  const update = () => {
    bar.style.width = ((done / total) * 100).toFixed(1) + "%";
    $("progText").textContent = `${doneFiles}/${order.length} קבצים · ${(done / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`;
  };
  update();

  async function put(f) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`/api/admin/upload/${name}/${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
        done += f.size;
        doneFiles++;
        update();
        return;
      } catch (ex) {
        if (attempt >= 4) throw new Error(`נכשלה העלאת ${f.name}: ${ex.message}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  try {
    const queue = segs.slice();
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) await put(queue.shift());
    });
    await Promise.all(workers);
    await put(key);
    await put(playlist);
    toast("ההעלאה הושלמה");
    $("progText").textContent += " ✓ הושלם";
    await loadVideos();
  } catch (ex) {
    $("uploadErr").textContent = ex.message + " — אפשר ללחוץ שוב על העלאה כדי לנסות מחדש.";
  } finally {
    $("uploadBtn").disabled = false;
  }
});

// ---------------- init
$("expires").value = toLocalInput(new Date(Date.now() + 7 * 86400e3));
fetch("/api/admin/codes").then((r) => (r.ok ? showApp() : showLogin()));
