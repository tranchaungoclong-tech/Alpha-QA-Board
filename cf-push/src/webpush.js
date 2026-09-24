function b64urlEncode(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const arrs = parts.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function hkdf(ikm, salt, info, len) {
  const prk = await hmacSha256(salt.length ? salt : new Uint8Array(32), ikm);
  const t = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return t.slice(0, len);
}

async function importVapidSignKey(vapid) {
  const pub = b64urlDecode(vapid.publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: String(vapid.privateKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidJwt(vapid, aud) {
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject
  })));
  const unsigned = header + "." + payload;
  const key = await importVapidSignKey(vapid);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned)
  ));
  return unsigned + "." + b64urlEncode(sig);
}

export async function sendPushNotification(subscription, payload, vapid, opts) {
  const endpoint = subscription && subscription.endpoint;
  const keys = subscription && subscription.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw new Error("bad subscription");
  const p256dh = b64urlDecode(keys.p256dh);
  const auth = b64urlDecode(keys.auth);
  const plaintext = new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload));

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const userPub = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userPub }, local.privateKey, 256));

  const ikm = await hkdf(secret, auth, concat(new TextEncoder().encode("WebPush: info\0"), p256dh, localPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aes,
    concat(plaintext, new Uint8Array([2]))
  ));

  const header = new Uint8Array(21 + localPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPub.length;
  header.set(localPub, 21);
  const body = concat(header, ciphertext);

  const origin = new URL(endpoint).origin;
  const jwt = await vapidJwt(vapid, origin);
  const pub = String(vapid.publicKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + pub,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String((opts && opts.ttl) || 86400),
      Urgency: (opts && opts.urgency) || "high"
    },
    body
  });
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error("push " + res.status + " " + text);
    err.statusCode = res.status;
    throw err;
  }
  return true;
}
