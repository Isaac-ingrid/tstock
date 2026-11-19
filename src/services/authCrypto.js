/**
 * src/services/authCrypto.js
 * 零外部依赖纯 JS SHA-256 / HMAC-SHA256 / SCRAM 挑战证明计算模块
 * 兼容非 HTTPS 公网 IP 环境（如 http://115.29.164.8 下 window.crypto.subtle 不可用的场景），
 * 与后端 backend/auth.py (derive_scram_credentials / verify_scram_proof) 逐字节严格一致。
 */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function utf8ToBytes(str) {
  return new TextEncoder().encode(String(str ?? ''));
}

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex) {
  const clean = String(hex || '').trim().toLowerCase();
  const out = new Uint8Array(clean.length >>> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function sha256Bytes(msgBytes) {
  const len = msgBytes.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;
  const padLen = ((len + 9 + 63) & ~63);
  const buf = new Uint8Array(padLen);
  buf.set(msgBytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, bitLenHi, false);
  dv.setUint32(padLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = dv.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, h0, false);
  outDv.setUint32(4, h1, false);
  outDv.setUint32(8, h2, false);
  outDv.setUint32(12, h3, false);
  outDv.setUint32(16, h4, false);
  outDv.setUint32(20, h5, false);
  outDv.setUint32(24, h6, false);
  outDv.setUint32(28, h7, false);
  return out;
}

export function hmacSha256Bytes(keyBytes, msgBytes) {
  const blockSize = 64;
  let k = keyBytes;
  if (k.length > blockSize) {
    k = sha256Bytes(k);
  }
  const keyPad = new Uint8Array(blockSize);
  keyPad.set(k);

  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    oKeyPad[i] = keyPad[i] ^ 0x5c;
    iKeyPad[i] = keyPad[i] ^ 0x36;
  }

  const inner = sha256Bytes(concatBytes(iKeyPad, msgBytes));
  return sha256Bytes(concatBytes(oKeyPad, inner));
}

export function randomSaltHex16() {
  const buf = new Uint8Array(16);
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 16; i += 1) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(buf);
}

/**
 * 在浏览器本地派生加盐凭证（明文密码绝不离开浏览器）
 * @returns {{ salt: string, clientKey: string, storedKey: string }}
 */
export function deriveScramCredentials(username, password, saltHex = '', rounds = 2048) {
  const u = String(username || '').trim().toLowerCase();
  const sHex = (saltHex ? String(saltHex).trim().toLowerCase() : randomSaltHex16());
  const saltBytes = hexToBytes(sHex);

  const seed = utf8ToBytes(`tstock-scram-v1:${u}:${sHex}:${String(password || '')}`);
  let digest = sha256Bytes(seed);
  const iter = Math.max(1, Number(rounds) || 2048);
  for (let i = 0; i < iter - 1; i += 1) {
    digest = sha256Bytes(concatBytes(digest, saltBytes));
  }

  const clientKeyBytes = hmacSha256Bytes(digest, utf8ToBytes('tstock-client-key'));
  const storedKeyBytes = sha256Bytes(clientKeyBytes);

  return {
    salt: sHex,
    clientKey: bytesToHex(clientKeyBytes),
    storedKey: bytesToHex(storedKeyBytes),
  };
}

/**
 * 计算单次随机挑战证明 clientProof = hex(clientKey XOR HMAC(storedKey, nonce))
 */
export function computeScramProof(clientKeyHex, storedKeyHex, nonce) {
  const ck = hexToBytes(clientKeyHex);
  const sk = hexToBytes(storedKeyHex);
  const sig = hmacSha256Bytes(sk, utf8ToBytes(String(nonce || '')));
  const out = new Uint8Array(ck.length);
  for (let i = 0; i < ck.length; i += 1) {
    out[i] = ck[i] ^ sig[i];
  }
  return bytesToHex(out);
}
