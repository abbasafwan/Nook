'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');
const { attachRelay } = require('./relay');

const PORT = Number(process.env.PORT) || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // change this on Render!
const ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : null;

// SQLite database holding logged messages.
// ':memory:' resets on every restart; use './nook.db' to persist between restarts.
const db = new sqlite3.Database(':memory:');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT NOT NULL,
    senderCid TEXT NOT NULL,
    senderName TEXT,
    text TEXT,
    timestamp INTEGER,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

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

// Public pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html'), { maxAge: '10m' }));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html'), { maxAge: '10m' }));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css'), { maxAge: '10m' }));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js'), { maxAge: '10m' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html'), { maxAge: '10m' }));

// Admin API: view recent messages, or one room's messages
app.post('/api/admin/messages', express.json(), (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  db.all('SELECT * FROM messages ORDER BY createdAt DESC LIMIT 100', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/admin/room/:roomId', express.json(), (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  db.all('SELECT * FROM messages WHERE roomId = ? ORDER BY createdAt DESC', [req.params.roomId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 8 * 1024,
  pingInterval: 20000,
  pingTimeout: 20000,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!ORIGINS || !origin) return cb(null, true);
    cb(null, ORIGINS.includes(origin));
  }
});
attachRelay(io, { maxPerRoom: 2, maxConnPerIp: 10, trustProxy: TRUST_PROXY, db });

server.listen(PORT, () => console.log('nook listening on :' + PORT));
const stop = () => { io.close(); db.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
