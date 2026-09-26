const CACHE = "qa-board-v68";
const PRECACHE = ["./", "./index.html", "./manifest.json", "./icon-180.png", "./icon-192.png"];
let bellArm = null;

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  const msg = event.data || {};
  if (msg.type === "qa-bell-arm") {
    bellArm = msg.payload || null;
  }
});

function inSlot(arm) {
  if (!arm || !arm.on || !arm.time) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const date = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const parts = String(arm.time).split(":");
  const start = Number(parts[0]) * 60 + Number(parts[1] || 0);
  const n = Math.max(1, Math.min(3, Number(arm.times) || 1));
  const skip = (arm.skipDate === date && Array.isArray(arm.skipSlots)) ? arm.skipSlots : [];
  for (let i = 0; i < n; i++) {
    const slot = start + i * 15;
    if (mins >= slot && mins <= slot + 2) {
      if (skip.indexOf(i) >= 0 || skip.indexOf(slot) >= 0) return false;
      return true;
    }
  }
  return false;
}

function isIos() {
  return /iP(hone|ad|od)/.test(self.navigator.userAgent || "");
}

function osToast(title, opts, clients) {
  const list = clients || [];
  const focused = list.some(c => c.focused);
  if (!isIos() && focused) return Promise.resolve();
  const next = Object.assign({}, opts);
  if (!isIos() && list.length) next.silent = true;
  return self.registration.showNotification(title, next);
}

function fireBell() {
  const lines = (bellArm && bellArm.lines) || ["Tomorrow inspect"];
  const body = lines.slice(0, 6).join("\n");
  const opts = {
    body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "qa-bell",
    renotify: true,
    requireInteraction: true
  };
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    list.forEach(c => c.postMessage({ type: "qa-bell-fire" }));
    return osToast("QA Board · tomorrow", opts, list);
  });
}

self.addEventListener("periodicsync", event => {
  if (event.tag !== "qa-bell") return;
  event.waitUntil(Promise.resolve().then(() => {
    if (inSlot(bellArm)) return fireBell();
  }));
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || "QA Board · tomorrow";
  const body = data.body || (Array.isArray(data.lines) ? data.lines.join("\n") : "Tomorrow inspect");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      list.forEach(c => c.postMessage({ type: "qa-bell-fire", payload: data }));
      return osToast(title, {
        body,
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        tag: data.tag || "qa-bell",
        renotify: true,
        requireInteraction: true,
        data
      }, list);
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      if (list[0]) return list[0].focus();
      return self.clients.openWindow("./");
    })
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (
    url.hostname.includes("google.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com") ||
    url.hostname.includes("googleusercontent.com")
  ) {
    return;
  }
  if (url.pathname.endsWith("sheet-config.js")) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});
