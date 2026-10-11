'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { attachRelay } = require('./relay');

const PORT = Number(process.env.PORT) || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // set to 1 behind Render, Railway, Nginx, etc.
const ORIGINS = process.env.ALLOWED_ORIGINS                      // e.g. https://chat.example.com (default: same origin only)
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : null;

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://cdnjs.cloudflare.com",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
// Serve only the three public files (the server's own code stays private).
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' };
Object.keys(PAGES).forEach(route => {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, PAGES[route]), { maxAge: '10m' }));
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 8 * 1024,
  pingInterval: 20000,
  pingTimeout: 20000,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!ORIGINS || !origin) return cb(null, true); // same-origin requests may send no Origin header
    cb(null, ORIGINS.includes(origin));
  }
});
attachRelay(io, { maxPerRoom: 2, maxConnPerIp: 10, trustProxy: TRUST_PROXY });

server.listen(PORT, () => console.log('nook listening on :' + PORT));
const stop = () => { io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
