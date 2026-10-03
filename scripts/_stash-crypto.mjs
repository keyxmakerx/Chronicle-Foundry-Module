/**
 * Confidential replies on the module socket.
 *
 * Socket traffic on the module channel may reach every client, so a reply
 * (a player's view of stashes) is encrypted to the asking window alone. The
 * window makes an ephemeral ECDH P-256 key pair per request and sends the
 * public half (JWK) with the request. The GM client makes its own ephemeral
 * pair, derives an AES-GCM key from the two, and sends
 * `{gmPublicKey, iv, ciphertext}`. Only the holder of the window's private key
 * can derive the same key; the request carries nothing secret.
 */

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const AES = { name: 'AES-GCM', length: 256 };

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is unavailable');
  return s;
}

function toB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(str) {
  const s = atob(String(str));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(privateKey, peerPublicJwk) {
  const peer = await subtle().importKey('jwk', peerPublicJwk, CURVE, false, []);
  return subtle().deriveKey({ name: 'ECDH', public: peer }, privateKey, AES, false, ['encrypt', 'decrypt']);
}

/**
 * A fresh key pair for one request.
 * @returns {Promise<{publicJwk: object, privateKey: CryptoKey}>}
 */
export async function generateRequestKeys() {
  const pair = await subtle().generateKey(CURVE, false, ['deriveKey']);
  const publicJwk = await subtle().exportKey('jwk', pair.publicKey);
  return { publicJwk, privateKey: pair.privateKey };
}

/**
 * Encrypt a reply to the holder of `requesterPublicJwk`.
 * @param {object} requesterPublicJwk
 * @param {any} value - JSON-serializable.
 * @returns {Promise<{gmPublicKey: object, iv: string, ciphertext: string}>}
 */
export async function encryptReply(requesterPublicJwk, value) {
  const pair = await subtle().generateKey(CURVE, false, ['deriveKey']);
  const key = await deriveKey(pair.privateKey, requesterPublicJwk);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    gmPublicKey: await subtle().exportKey('jwk', pair.publicKey),
    iv: toB64(iv),
    ciphertext: toB64(ct),
  };
}

/**
 * Decrypt a reply with the request's private key.
 * @param {CryptoKey} privateKey
 * @param {{gmPublicKey: object, iv: string, ciphertext: string}} envelope
 * @returns {Promise<any>} the value; rejects if it was not made for this key.
 */
export async function decryptReply(privateKey, envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('no envelope');
  const key = await deriveKey(privateKey, envelope.gmPublicKey);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(pt));
}

/**
 * Is this a plausible P-256 public JWK from a request?
 * @param {any} jwk
 * @returns {boolean}
 */
export function isPublicJwk(jwk) {
  return !!jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && jwk.d === undefined;
}
