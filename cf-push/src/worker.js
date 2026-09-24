import { sendPushNotification } from "./webpush.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}

function vnNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour, minute,
    mins: hour * 60 + minute
  };
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function hashEndpoint(endpoint) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function slotsOf(arm) {
  if (!arm || !arm.on || !arm.time) return [];
  const parts = String(arm.time).split(":");
  const start = Number(parts[0]) * 60 + Number(parts[1] || 0);
  const n = Math.max(1, Math.min(3, Number(arm.times) || 1));
  const out = [];
  for (let i = 0; i < n; i++) out.push(start + i * 15);
  return out;
}

function inSlot(arm, mins) {
  return slotsOf(arm).some(slot => mins >= slot && mins <= slot + 2);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}

function parseDateCell(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    const month = a > 12 ? b : a, day = a > 12 ? a : b;
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return "";
}

function jobsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const col = names => names.map(n => head.indexOf(n)).find(i => i >= 0) ?? -1;
  const iDate = col(["date"]);
  const iPic = col(["pic"]);
  const iFac = col(["factory"]);
  const iType = col(["type"]);
  const iCust = col(["customer"]);
  return rows.slice(1).map(r => {
    const get = i => (i >= 0 ? String(r[i] || "").trim() : "");
    const date = parseDateCell(get(iDate));
    const pic = get(iPic).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!date || !pic) return null;
    const type = get(iType).toLowerCase() || "final";
    return { date, pic, factory: get(iFac), type, customer: get(iCust) };
  }).filter(Boolean);
}

async function loadJobs(env) {
  const csv = env.SHEET_CSV;
  if (!csv) return [];
  const url = csv + (csv.includes("?") ? "&" : "?") + "t=" + Date.now();
  const res = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error("csv " + res.status);
  return jobsFromCsv(await res.text());
}

function linesFor(jobs, arm) {
  if (arm && Array.isArray(arm.lines) && arm.lines.length) return arm.lines.slice(0, 6);
  const dayJobs = jobs || [];
  if (!dayJobs.length) return ["No inspect tomorrow."];
  return dayJobs.filter(j => j.type !== "leave").slice(0, 6).map(j => {
    const type = j.type ? j.type[0].toUpperCase() + j.type.slice(1) : "Visit";
    return `${j.pic} · ${j.factory || "-"} · ${j.customer || "-"} · ${type}`;
  });
}

function vapidOf(env) {
  const privateKey = env.VAPID_PRIVATE_KEY;
  const publicKey = env.VAPID_PUBLIC_KEY;
  if (!privateKey || !publicKey) throw new Error("VAPID keys missing");
  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT || "mailto:qa-board@alpha-fashion.local"
  };
}

async function sendOne(env, rec, title, body, date) {
  const ok = await sendPushNotification(
    rec.subscription,
    {
      title,
      body,
      url: env.BOARD_URL || "./",
      tag: "qa-bell",
      date,
      pic: rec.pic
    },
    vapidOf(env),
    { ttl: 86400, urgency: "high" }
  );
  return ok;
}

async function listSubs(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: "sub:", cursor, limit: 100 });
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, "json");
      if (rec && rec.subscription && rec.subscription.endpoint) out.push({ key: k.name, rec });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function fireFor(env, rec, key, jobs, force) {
  const arm = rec.arm || {};
  const now = vnNow();
  const tomorrow = addDays(now.date, 1);
  const who = arm.who && arm.who !== "all" ? arm.who : rec.pic;
  const mine = (jobs || []).filter(j => {
    if (j.date !== tomorrow) return false;
    if (j.type === "leave") return false;
    if (who && who !== "all" && j.pic !== who) return false;
    return true;
  });
  const lines = linesFor(mine, arm);
  const body = lines.join("\n");
  try {
    const ok = await sendOne(env, rec, "QA Board · tomorrow", body, tomorrow);
    if (ok === false) {
      await env.SUBS.delete(key);
      return { gone: true };
    }
    return { ok: true, n: mine.length };
  } catch (err) {
    const code = err && (err.statusCode || err.status);
    if (code === 404 || code === 410) {
      await env.SUBS.delete(key);
      return { gone: true };
    }
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function cronTick(env, forcePic) {
  if (!env.SUBS) return { ok: false, error: "KV missing" };
  const now = vnNow();
  let jobs = [];
  try { jobs = await loadJobs(env); } catch (err) { jobs = []; }
  const subs = await listSubs(env);
  const result = [];
  for (const { key, rec } of subs) {
    const arm = rec.arm || {};
    if (!forcePic && !arm.on) continue;
    if (forcePic && rec.pic !== forcePic && arm.who !== forcePic && arm.who !== "all") continue;
    const slotList = slotsOf(arm);
    if (!forcePic && !inSlot(arm, now.mins)) continue;
    const slotIdx = forcePic ? "test" : String(slotList.findIndex(slot => now.mins >= slot && now.mins <= slot + 2));
    const sentKey = `sent:${now.date}:${key}:${slotIdx}`;
    if (!forcePic) {
      const already = await env.SUBS.get(sentKey);
      if (already) continue;
    }
    const out = await fireFor(env, rec, key, jobs, !!forcePic);
    if (out.ok && !forcePic) await env.SUBS.put(sentKey, "1", { expirationTtl: 48 * 3600 });
    result.push({ pic: rec.pic, ...out });
  }
  return { ok: true, vn: now, n: result.length, result };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        const n = env.SUBS ? (await env.SUBS.list({ prefix: "sub:", limit: 100 })).keys.length : 0;
        return json({ ok: true, subs: n, vn: vnNow(), publicKey: env.VAPID_PUBLIC_KEY || "" });
      }
      if (req.method === "GET" && url.pathname === "/vapidPublicKey") {
        return json({ publicKey: env.VAPID_PUBLIC_KEY || "" });
      }
      if (req.method === "POST" && url.pathname === "/subscribe") {
        const body = await req.json();
        const subscription = body.subscription;
        const pic = String(body.pic || body.who || "all").toLowerCase();
        if (!subscription || !subscription.endpoint) return json({ error: "subscription required" }, 400);
        const id = await hashEndpoint(subscription.endpoint);
        const rec = {
          pic,
          subscription,
          arm: body.arm || { on: true, time: "20:10", times: 1, who: pic },
          at: new Date().toISOString()
        };
        await env.SUBS.put("sub:" + id, JSON.stringify(rec));
        return json({ ok: true, pic, id });
      }
      if (req.method === "POST" && url.pathname === "/unsubscribe") {
        const body = await req.json();
        const endpoint = body.endpoint || (body.subscription && body.subscription.endpoint);
        if (!endpoint) return json({ error: "endpoint required" }, 400);
        const id = await hashEndpoint(endpoint);
        await env.SUBS.delete("sub:" + id);
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/test") {
        const body = await req.json().catch(() => ({}));
        const pic = String(body.pic || "").toLowerCase();
        const out = await cronTick(env, pic || null);
        return json(out);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronTick(env));
  }
};
