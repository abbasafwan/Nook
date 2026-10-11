'use strict';

// Room ids are "r" + 32 hex chars, derived in the browser from the invite code.
const ROOM_RE = /^r[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const isRoomId = v => typeof v === 'string' && ROOM_RE.test(v);

// A packet is { i: base64 AES-GCM IV (12 bytes -> 16 chars), c: base64 ciphertext }.
// The server never decrypts it; it only checks the shape and size.
function isPacket(p){
  return !!p && typeof p === 'object' &&
    typeof p.i === 'string' && p.i.length === 16 && B64_RE.test(p.i) &&
    typeof p.c === 'string' && p.c.length >= 24 && p.c.length <= 4400 && B64_RE.test(p.c);
}

class TokenBucket {
  constructor(capacity, perSecond, now = Date.now){
    this.cap = capacity; this.rate = perSecond; this.now = now;
    this.tokens = capacity; this.t = now();
  }
  take(n = 1){
    const t = this.now();
    this.tokens = Math.min(this.cap, this.tokens + ((t - this.t) / 1000) * this.rate);
    this.t = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

module.exports = { isRoomId, isPacket, TokenBucket };
