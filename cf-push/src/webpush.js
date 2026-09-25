const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64StdEncode(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < u.length; i += 3) {
    const a = u[i];
    const b = i + 1 < u.length ? u[i + 1] : 0;
    const c = i + 2 < u.length ? u[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < u.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < u.length ? B64[n & 63] : "=";
  }
  return out;
}

function b64urlEncode(bytes) {
  return b64StdEncode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/g, "");
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i]);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

function pad32(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length === 32) return u;
  if (u.length > 32) return u.slice(u.length - 32);
  const out = new Uint8Array(32);
  out.set(u, 32 - u.length);
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
  const d = pad32(b64urlDecode(vapid.privateKey));
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64StdEncode(pub.slice(1, 33)).replace(/=+$/g, ""),
    y: b64StdEncode(pub.slice(33, 65)).replace(/=+$/g, ""),
    d: b64StdEncode(d).replace(/=+$/g, ""),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function ecdsaToJose(sig) {
  const u = sig instanceof Uint8Array ? sig : new Uint8Array(sig);
  if (u.length === 64) return u;
  if (u.length === 65 && u[0] === 0x00) return u.slice(1);
  if (u[0] !== 0x30) return pad32(u.slice(-32)).length === 32 && u.length >= 64 ? u.slice(-64) : u;
  let i = 2;
  if (u[1] & 0x80) i += u[1] & 0x7f;
  if (u[i] !== 0x02) return u;
  const rl = u[i + 1];
  let r = u.slice(i + 2, i + 2 + rl);
  i = i + 2 + rl;
  if (u[i] !== 0x02) return u;
  const sl = u[i + 1];
  let s = u.slice(i + 2, i + 2 + sl);
  while (r.length > 1 && r[0] === 0) r = r.slice(1);
  while (s.length > 1 && s[0] === 0) s = s.slice(1);
  return concat(pad32(r), pad32(s));
}

async function vapidJwt(vapid, aud) {
  const origin = String(aud || "").replace(/\/+$/, "");
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject
  })));
  const unsigned = header + "." + payload;
  const key = await importVapidSignKey(vapid);
  const sig = ecdsaToJose(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned)
  )));
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
  const jwtAud = /push\.apple\.com$/.test(new URL(endpoint).hostname) || origin.includes("push.apple.com")
    ? "https://web.push.apple.com"
    : origin;
  const jwt = await vapidJwt(vapid, jwtAud);
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
