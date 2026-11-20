// Video Vault — password-protected video streaming on Cloudflare Workers + R2 + KV.
//
// Routes:
//   POST /api/login                 viewer enters a code -> session cookie
//   GET  /api/me                    current viewer session info
//   POST /api/logout
//   GET  /v/<video>/index.m3u8      HLS playlist      (full check: code valid, not expired, device allowed)
//   GET  /v/<video>/key             AES-128 key       (full check)
//   GET  /v/<video>/<seg>.ts        encrypted segment (session signature check)
//   /api/admin/*                    admin panel API (admin password)

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const VIDEO_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "שגיאת שרת" }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/login" && m === "POST") return viewerLogin(request, env);
  if (p === "/api/me" && m === "GET") return viewerMe(request, env);
  if (p === "/api/logout" && m === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie("sess") });
  }

  const v = p.match(/^\/v\/([^/]+)\/([^/]+)$/);
  if (v && (m === "GET" || m === "HEAD")) return serveVideoFile(request, env, v[1], v[2]);

  if (p.startsWith("/api/admin/")) return adminRoute(request, env, p.slice("/api/admin/".length), m);

  return json({ error: "לא נמצא" }, 404);
}

// ---------------------------------------------------------------- viewer

async function viewerLogin(request, env) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  if (!code) throw new HttpError(400, "נא להזין קוד");

  const rec = await getCode(env, code);
  const problem = codeProblem(rec);
  if (problem) {
    await sleep(400); // slow down guessing
    throw new HttpError(401, problem);
  }

  // Device binding: each code may be used on up to `maxDevices` browsers.
  const cookies = parseCookies(request);
  let did = cookies.did && /^[a-f0-9]{32}$/.test(cookies.did) ? cookies.did : randomHex(16);
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", cookie("did", did, 400 * 86400));

  rec.devices = rec.devices || [];
  if (!rec.devices.includes(did)) {
    if (rec.maxDevices > 0 && rec.devices.length >= rec.maxDevices) {
      return new Response(
        JSON.stringify({ error: "הקוד הזה כבר הופעל במכשיר אחר. פנה לשולח הסרטון." }),
        { status: 403, headers }
      );
    }
    rec.devices.push(did);
  }
  rec.uses = (rec.uses || 0) + 1;
  rec.lastUsed = new Date().toISOString();
  await putCode(env, rec);

  const hours = Number(env.SESSION_HOURS || 12);
  const exp = Math.min(Date.now() + hours * 3600e3, Date.parse(rec.expires));
  const token = await sign(env, { t: "v", c: code, v: rec.video, d: did, exp });
  headers.append("Set-Cookie", cookie("sess", token, Math.floor((exp - Date.now()) / 1000)));
  return new Response(JSON.stringify({ ok: true, name: rec.name, video: rec.video }), { headers });
}

async function viewerMe(request, env) {
  const s = await viewerSession(request, env, true);
  return json({ name: s.rec.name, video: s.rec.video, expires: s.rec.expires, code: s.code });
}

// Validates the session cookie. With `full`, also re-checks the code in KV
// (revoked / expired / device removed) so admin changes take effect immediately.
async function viewerSession(request, env, full) {
  const tok = parseCookies(request).sess;
  const s = tok && (await verify(env, tok));
  if (!s || s.t !== "v") throw new HttpError(401, "יש להזין קוד צפייה");
  if (!full) return { code: s.c, video: s.v };
  const rec = await getCode(env, s.c);
  const problem = codeProblem(rec);
  if (problem) throw new HttpError(401, problem);
  if (rec.video !== s.v || !(rec.devices || []).includes(s.d)) {
    throw new HttpError(401, "ההרשאה למכשיר זה בוטלה");
  }
  return { code: s.c, video: s.v, rec };
}

function codeProblem(rec) {
  if (!rec) return "קוד שגוי";
  if (rec.revoked) return "הקוד בוטל";
  if (Date.now() > Date.parse(rec.expires)) return "תוקף הקוד פג";
  return null;
}

async function serveVideoFile(request, env, video, file) {
  if (!VIDEO_RE.test(video) || !FILE_RE.test(file)) throw new HttpError(404, "לא נמצא");

  let key, type, cache;
  if (file === "key") {
    key = `${video}/enc.key`;
    type = "application/octet-stream";
    cache = "private, no-store";
  } else if (file.endsWith(".m3u8")) {
    key = `${video}/${file}`;
    type = "application/vnd.apple.mpegurl";
    cache = "private, no-store";
  } else if (file.endsWith(".ts")) {
    key = `${video}/${file}`;
    type = "video/mp2t";
    cache = "private, max-age=3600";
  } else {
    throw new HttpError(404, "לא נמצא");
  }

  const full = !file.endsWith(".ts");
  const s = await viewerSession(request, env, full);
  if (s.video !== video) throw new HttpError(403, "אין הרשאה לסרטון זה");

  const obj = await env.VIDEOS.get(key);
  if (!obj) throw new HttpError(404, "הקובץ לא נמצא");
  return new Response(request.method === "HEAD" ? null : obj.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": cache,
      "Content-Length": String(obj.size),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------- admin

async function adminRoute(request, env, sub, m) {
  if (sub === "login" && m === "POST") {
    const body = await readJson(request);
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
      throw new HttpError(500, "חסרים ADMIN_PASSWORD / SESSION_SECRET בהגדרות השרת");
    }
    if (!(await safeEqual(String(body.password || ""), env.ADMIN_PASSWORD))) {
      await sleep(800);
      throw new HttpError(401, "סיסמה שגויה");
    }
    const exp = Date.now() + 7 * 86400e3;
    const token = await sign(env, { t: "a", exp });
    return json({ ok: true }, 200, { "Set-Cookie": cookie("adm", token, 7 * 86400) });
  }
  if (sub === "logout" && m === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie("adm") });
  }

  const tok = parseCookies(request).adm;
  const s = tok && (await verify(env, tok));
  if (!s || s.t !== "a") throw new HttpError(401, "נדרשת התחברות מנהל");

  // Simple CSRF guard: state-changing admin calls must come from our own pages.
  if (m !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "בקשה חסומה");
  }

  if (sub === "codes" && m === "GET") return listCodes(env);
  if (sub === "codes" && m === "POST") return createCodes(request, env);

  let mm = sub.match(/^codes\/([A-Z0-9-]+)$/);
  if (mm && m === "PATCH") return updateCode(request, env, mm[1]);
  if (mm && m === "DELETE") {
    await env.CODES.delete("code:" + normalizeCode(mm[1]));
    return json({ ok: true });
  }

  if (sub === "videos" && m === "GET") return listVideos(env);
  mm = sub.match(/^videos\/([^/]+)$/);
  if (mm && m === "DELETE") return deleteVideo(env, mm[1]);

  mm = sub.match(/^upload\/([^/]+)\/([^/]+)$/);
  if (mm && m === "PUT") return uploadFile(request, env, mm[1], mm[2]);

  throw new HttpError(404, "לא נמצא");
}

async function listCodes(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.CODES.list({ prefix: "code:", cursor });
    for (const k of page.keys) {
      if (k.metadata) out.push(publicRecord(k.metadata));
      else {
        const rec = await env.CODES.get(k.name, "json");
        if (rec) out.push(publicRecord(rec));
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  return json({ codes: out });
}

function publicRecord(r) {
  return {
    code: r.code,
    name: r.name,
    video: r.video,
    expires: r.expires,
    maxDevices: r.maxDevices,
    devicesUsed: (r.devices || []).length,
    uses: r.uses || 0,
    lastUsed: r.lastUsed || null,
    created: r.created,
    revoked: !!r.revoked,
  };
}

async function createCodes(request, env) {
  const b = await readJson(request);
  const names = (Array.isArray(b.names) ? b.names : [b.name])
    .map((n) => String(n || "").trim().slice(0, 60))
    .filter(Boolean);
  if (!names.length) throw new HttpError(400, "נא להזין שם צופה");
  if (names.length > 100) throw new HttpError(400, "עד 100 קודים בפעם אחת");
  const video = String(b.video || "");
  if (!VIDEO_RE.test(video)) throw new HttpError(400, "שם סרטון לא תקין");
  const expires = new Date(b.expires);
  if (isNaN(expires)) throw new HttpError(400, "תאריך תפוגה לא תקין");
  const maxDevices = Math.max(0, Math.min(20, parseInt(b.maxDevices ?? 1, 10) || 0));

  const created = [];
  for (const name of names) {
    let code;
    do code = generateCode();
    while (await env.CODES.get("code:" + code));
    const rec = {
      code,
      name,
      video,
      expires: expires.toISOString(),
      maxDevices,
      devices: [],
      uses: 0,
      created: new Date().toISOString(),
      revoked: false,
    };
    await putCode(env, rec);
    created.push(publicRecord(rec));
  }
  return json({ codes: created });
}

async function updateCode(request, env, rawCode) {
  const b = await readJson(request);
  const rec = await getCode(env, normalizeCode(rawCode));
  if (!rec) throw new HttpError(404, "קוד לא נמצא");
  if (b.expires !== undefined) {
    const d = new Date(b.expires);
    if (isNaN(d)) throw new HttpError(400, "תאריך לא תקין");
    rec.expires = d.toISOString();
  }
  if (b.maxDevices !== undefined) rec.maxDevices = Math.max(0, Math.min(20, parseInt(b.maxDevices, 10) || 0));
  if (b.revoked !== undefined) rec.revoked = !!b.revoked;
  if (b.resetDevices) rec.devices = [];
  if (b.name !== undefined) rec.name = String(b.name).trim().slice(0, 60) || rec.name;
  await putCode(env, rec);
  return json({ code: publicRecord(rec) });
}

async function listVideos(env) {
  const videos = [];
  let cursor;
  do {
    const page = await env.VIDEOS.list({ delimiter: "/", cursor });
    for (const pref of page.delimitedPrefixes || []) videos.push(pref.replace(/\/$/, ""));
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  const details = await Promise.all(
    videos.map(async (name) => {
      const [pl, key] = await Promise.all([env.VIDEOS.head(`${name}/index.m3u8`), env.VIDEOS.head(`${name}/enc.key`)]);
      return { name, ready: !!(pl && key), uploaded: pl ? pl.uploaded : null };
    })
  );
  return json({ videos: details });
}

async function deleteVideo(env, video) {
  if (!VIDEO_RE.test(video)) throw new HttpError(400, "שם סרטון לא תקין");
  let deleted = 0;
  for (;;) {
    const page = await env.VIDEOS.list({ prefix: video + "/", limit: 1000 });
    if (!page.objects.length) break;
    await env.VIDEOS.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
  }
  return json({ ok: true, deleted });
}

async function uploadFile(request, env, video, file) {
  if (!VIDEO_RE.test(video)) throw new HttpError(400, "שם סרטון לא תקין (אותיות אנגליות קטנות, ספרות, - או _)");
  if (!FILE_RE.test(file) || !/(\.ts|\.m3u8|^enc\.key)$/.test(file)) throw new HttpError(400, "קובץ לא צפוי: " + file);
  const len = Number(request.headers.get("Content-Length") || 0);
  if (!len) throw new HttpError(411, "חסר Content-Length");
  await env.VIDEOS.put(`${video}/${file}`, request.body);
  return json({ ok: true });
}

// ---------------------------------------------------------------- storage helpers

async function getCode(env, code) {
  if (!code) return null;
  return env.CODES.get("code:" + code, "json");
}

async function putCode(env, rec) {
  // Store the record as metadata too, so the admin list needs a single KV call.
  const meta = { ...rec, devices: (rec.devices || []).slice(0, 20) };
  await env.CODES.put("code:" + rec.code, JSON.stringify(rec), { metadata: meta });
}

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

function normalizeCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 8) return null;
  return s.slice(0, 4) + "-" + s.slice(4);
}

// ---------------------------------------------------------------- crypto / http helpers

async function hmacKey(env) {
  if (!env.SESSION_SECRET) throw new HttpError(500, "חסר SESSION_SECRET בהגדרות השרת");
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body));
  return body + "." + b64url(new Uint8Array(sig));
}

async function verify(env, token) {
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, maxAge)}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "בקשה לא תקינה");
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
