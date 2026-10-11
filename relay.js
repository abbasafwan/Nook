'use strict';
const { isRoomId, isPacket, TokenBucket } = require('./validate');

function clientIp(socket, trustProxy){
  if (trustProxy) {
    const xff = socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
    if (xff) { const parts = String(xff).split(','); return parts[parts.length - 1].trim(); }
  }
  return socket.handshake.address;
}

/**
 * Blind relay: puts sockets in rooms (max two per room) and forwards opaque
 * encrypted packets between them. Nothing is logged, stored or decrypted.
 */
function attachRelay(io, opts = {}){
  const maxPerRoom = opts.maxPerRoom || 2;
  const maxConnPerIp = opts.maxConnPerIp || 10;
  const trustProxy = !!opts.trustProxy;
  const joinWaitMs = opts.joinWaitMs || 15000;
  const ipConns = new Map();
  const ipJoins = new Map(); // ip -> { bucket, seen }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [ip, v] of ipJoins) if (v.seen < cutoff) ipJoins.delete(ip);
  }, 10 * 60 * 1000);
  if (sweep.unref) sweep.unref();

  io.on('connection', socket => {
    const ip = clientIp(socket, trustProxy);
    const n = (ipConns.get(ip) || 0) + 1;
    if (n > maxConnPerIp) { socket.disconnect(true); return; }
    ipConns.set(ip, n);

    let roomId = null;
    const msgBucket = new TokenBucket(30, 15);
    // Drop sockets that connect but never join a room.
    const idle = setTimeout(() => { if (!roomId) socket.disconnect(true); }, joinWaitMs);
    if (idle.unref) idle.unref();

    socket.on('join', (id, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (roomId) return reply({ ok: false, error: 'already' });
      if (!isRoomId(id)) return reply({ ok: false, error: 'invalid' });
      let entry = ipJoins.get(ip);
      if (!entry) { entry = { bucket: new TokenBucket(30, 1), seen: 0 }; ipJoins.set(ip, entry); }
      entry.seen = Date.now();
      if (!entry.bucket.take()) return reply({ ok: false, error: 'slow' });
      const members = io.sockets.adapter.rooms.get(id);
      if (members && members.size >= maxPerRoom) return reply({ ok: false, error: 'full' });
      socket.join(id); // synchronous with the in-memory adapter, so the check above can't race
      roomId = id;
      reply({ ok: true });
    });

    socket.on('p', pkt => {
      if (!roomId || !msgBucket.take() || !isPacket(pkt)) return;
      socket.to(roomId).emit('p', { i: pkt.i, c: pkt.c });
    });

    socket.on('disconnect', () => {
      clearTimeout(idle);
      const left = (ipConns.get(ip) || 1) - 1;
      if (left <= 0) ipConns.delete(ip); else ipConns.set(ip, left);
    });
  });
}

module.exports = { attachRelay, clientIp };
