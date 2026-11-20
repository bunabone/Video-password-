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
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    $("tab-" + x.dataset.tab).classList.toggle("hidden", x.dataset.tab !== name);
  });
  if (name === "views") loadViews();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

async function refreshAll() {
  await Promise.all([loadVideos(), loadCodes()]);
}

// ---------------- views log
let views = [];
async function loadViews() {
  try {
    const res = await api("views");
    views = res.views;
    if (res.disabled) {
      $("viewsBody").innerHTML =
        '<tr><td colspan="9" class="error">רשימת הצפיות לא מופעלת: חסר מסד D1 בהגדרות (ראה README, שלב 3).</td></tr>';
      return;
    }
    renderViews();
  } catch (ex) {
    $("viewsBody").innerHTML = `<tr><td colspan="9" class="error">${esc(ex.message)}</td></tr>`;
  }
}

function dur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function device(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "?";
  const br = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}
function pct(v) {
  return v.duration ? Math.min(100, Math.round((v.max_pos / v.duration) * 100)) : null;
}
function filteredViews() {
  const q = $("vfText").value.trim().toLowerCase();
  const vid = $("vfVideo").value;
  return views.filter(
    (v) => (!vid || v.video === vid) && (!q || (v.name || "").toLowerCase().includes(q) || v.code.toLowerCase().includes(q))
  );
}

function renderViews() {
  const rows = filteredViews();
  const people = new Set(rows.map((v) => v.code)).size;
  const total = rows.reduce((s, v) => s + (v.watched || 0), 0);
  $("vStats").innerHTML =
    `<div><b>${rows.length}</b><span>צפיות</span></div>` +
    `<div><b>${people}</b><span>צופים שונים</span></div>` +
    `<div><b>${dur(total)}</b><span>סה"כ זמן צפייה</span></div>`;
  if (!rows.length) {
    $("viewsBody").innerHTML = '<tr><td colspan="9" class="muted">אין צפיות עדיין</td></tr>';
    return;
  }
  $("viewsBody").innerHTML = rows
    .map((v) => {
      const p = pct(v);
      const place = [v.city, v.country].filter(Boolean).join(", ") || "—";
      return `<tr>
        <td>${esc(v.name)}</td>
        <td class="code">${esc(v.code)}</td>
        <td>${esc(v.video)}</td>
        <td>${fmt(v.started_at)}</td>
        <td>${fmt(v.last_seen)}</td>
        <td>${dur(v.watched)}</td>
        <td>${p === null ? dur(v.max_pos) : `<span class="bar"><i style="width:${p}%"></i></span> ${p}%`}</td>
        <td title="${esc(v.ua)}">${esc(device(v.ua))}</td>
        <td title="IP: ${esc(v.ip || "")}">${esc(place)}</td>
      </tr>`;
    })
    .join("");
}
$("vfText").addEventListener("input", renderViews);
$("vfVideo").addEventListener("change", renderViews);
$("vRefresh").addEventListener("click", loadViews);
$("vCsv").addEventListener("click", () => {
  const head = ["צופה", "קוד", "סרטון", "התחלה", "פעילות אחרונה", "זמן צפייה (דקות)", "הגיע עד (%)", "מכשיר", "עיר", "מדינה", "IP"];
  const lines = filteredViews().map((v) => [
    v.name, v.code, v.video, fmt(v.started_at), fmt(v.last_seen), ((v.watched || 0) / 60).toFixed(1),
    pct(v) ?? "", device(v.ua), v.city || "", v.country || "", v.ip || "",
  ]);
  const csv = [head, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "views-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

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
        <button class="ghost small" data-act="views">צפיות</button>
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
      case "views":
        $("vfText").value = c.code;
        $("vfVideo").value = "";
        showTab("views");
        return;
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
  const vf = $("vfVideo"), vprev = vf.value;
  vf.innerHTML = '<option value="">כל הסרטונים</option>' + videos.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("");
  vf.value = vprev;

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
