(() => {
'use strict';
const $ = s => document.querySelector(s);

/* =====================================================================
   Crypto: the invite code is the only secret. Room id and AES key are
   both derived from it, so whatever carries the packets sees ciphertext.
   ===================================================================== */
// <crypto>
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const enc = new TextEncoder(), dec = new TextDecoder();
function newSecret(){ const b = crypto.getRandomValues(new Uint8Array(25)); let s = ''; for (const x of b) s += ALPHABET[x & 31]; return s; }
function fmt(s){ return s.match(/.{1,5}/g).join('-'); }
function normCode(v){ let s = ''; for (const ch of String(v).toUpperCase()) if (ALPHABET.includes(ch)) s += ch; return s; }
const hex = u => Array.from(u, x => x.toString(16).padStart(2, '0')).join('');
const b64 = u => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
const unb64 = s => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
async function derive(secret){
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const r = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode('nook:room:v1')));
  const k = await crypto.subtle.sign('HMAC', base, enc.encode('nook:key:v1'));
  const key = await crypto.subtle.importKey('raw', k, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { roomId: 'r' + hex(r.slice(0, 16)), key };
}
// Encryption removed: packets are just base64 of the JSON, so the server can read them.
// "i" is only a random id used to drop duplicate packets; "c" holds the message data.
async function seal(key, roomId, obj){
  return { i: b64(crypto.getRandomValues(new Uint8Array(12))), c: b64(enc.encode(JSON.stringify(obj))) };
}
async function unseal(key, roomId, pkt){
  try { return JSON.parse(dec.decode(unb64(pkt.c))); } catch (e) { return null; }
}
// </crypto>

/* =====================================================================
   3D stage: a glass orb that shows who is in the room. Light pulses
   travel between people whenever a message is sent or received.
   ===================================================================== */
const Stage = (() => {
  const host = $('#stage'), canvas = $('#gl');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const noop = { setMode(){}, setPeers(){}, pulse(){}, typing(){} };
  if (!window.THREE) { host.classList.add('no-gl'); return noop; }
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch (e) { host.classList.add('no-gl'); return noop; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const COL = { you: 0xFF9F6B, peer: 0x7CF2CB, lav: 0x9A8CFF };
  const lavC = new THREE.Color(COL.lav), peerC = new THREE.Color(COL.peer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
  camera.position.set(0, 0, 7.4);
  const root = new THREE.Group(); scene.add(root);

  function glowTexture(){
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }
  const glowTex = glowTexture();
  const add = THREE.AdditiveBlending;

  // Glass shell with a fresnel rim that shifts from violet to mint once someone joins.
  const shellMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: lavC.clone() }, uB: { value: peerC.clone() }, uSeal: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uA; uniform vec3 uB; uniform float uSeal; uniform float uTime; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2); vec3 c = mix(uA, uB, uSeal); float sh = 0.85 + 0.15 * sin(uTime * 1.5 + vN.y * 6.0); gl_FragColor = vec4(c * sh * 1.25, f + 0.035); }',
    transparent: true, blending: add, depthWrite: false
  });
  root.add(new THREE.Mesh(new THREE.SphereGeometry(2.0, 64, 48), shellMat));

  const cage = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.06, 2)),
    new THREE.LineBasicMaterial({ color: COL.lav, transparent: true, opacity: .16 })
  );
  root.add(cage);

  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.55, .012, 8, 160), new THREE.MeshBasicMaterial({ color: COL.lav, transparent: true, opacity: .45 }));
  ring1.rotation.x = 1.15; root.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.85, .01, 8, 160), new THREE.MeshBasicMaterial({ color: COL.lav, transparent: true, opacity: .22 }));
  ring2.rotation.set(.4, 1.0, 0); root.add(ring2);
  const flashMat = new THREE.MeshBasicMaterial({ color: COL.peer, transparent: true, opacity: 0, blending: add, depthWrite: false });
  const flashRing = new THREE.Mesh(new THREE.TorusGeometry(2.1, .035, 8, 128), flashMat);
  root.add(flashRing);

  const N = 650, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 2.8 + Math.random() * 2.2, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph) * .8; pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ map: glowTex, size: .16, transparent: true, opacity: .55, depthWrite: false, blending: add, color: COL.lav }));
  root.add(dust);

  // People
  const nodeG = new THREE.Group(); root.add(nodeG);
  const coreGeo = new THREE.SphereGeometry(.2, 24, 16), haloGeo = new THREE.RingGeometry(.32, .345, 48);
  const nodes = new Map();
  let order = [], mode = 'demo', sealTarget = 0, seal = 0, flash = 0, prevCount = 0, demoTimer = null, time = 0;
  const ghostPos = new THREE.Vector3(1.15, 0, -.1);
  const ghost = new THREE.Mesh(new THREE.RingGeometry(.2, .235, 48), new THREE.MeshBasicMaterial({ color: COL.lav, transparent: true, opacity: .4, side: THREE.DoubleSide }));
  ghost.position.copy(ghostPos); ghost.visible = false; nodeG.add(ghost);

  function addNode(key, color){
    const g = new THREE.Group();
    const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, blending: add, depthWrite: false, opacity: .9 }));
    glow.scale.setScalar(1.5);
    const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .5, side: THREE.DoubleSide }));
    g.add(core, glow, halo); g.scale.setScalar(.0001); nodeG.add(g);
    const n = { key, g, core, glow, halo, color, base: new THREE.Vector3(), appear: 0, typing: false, leaving: false, phase: Math.random() * 6.28 };
    nodes.set(key, n); return n;
  }
  function removeNode(k, n){
    nodeG.remove(n.g); n.core.material.dispose(); n.glow.material.dispose(); n.halo.material.dispose(); nodes.delete(k);
  }

  // Links between people
  let links = []; const curves = new Map();
  function curveBetween(a, b){
    const mid = a.clone().add(b).multiplyScalar(.5); mid.y += .5; mid.z += .5;
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }
  function rebuildLinks(){
    links.forEach(o => { nodeG.remove(o); o.geometry.dispose(); o.material.dispose(); }); links = []; curves.clear();
    const me = nodes.get('me'); if (!me) return;
    if (order.length === 0) {
      if (mode === 'room') {
        const c = curveBetween(me.base, ghostPos); curves.set('ghost', c);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.getPoints(40)),
          new THREE.LineDashedMaterial({ color: COL.lav, dashSize: .07, gapSize: .07, transparent: true, opacity: .6 }));
        line.computeLineDistances(); nodeG.add(line); links.push(line);
      }
    } else {
      order.forEach(k => {
        const n = nodes.get(k); if (!n) return;
        const c = curveBetween(me.base, n.base); curves.set(k, c);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.getPoints(40)),
          new THREE.LineBasicMaterial({ color: COL.peer, transparent: true, opacity: .55 }));
        nodeG.add(line); links.push(line);
      });
    }
    ghost.visible = (order.length === 0 && mode === 'room');
  }
  function layout(){
    const me = nodes.get('me'); if (!me) return;
    me.base.set(-1.15, 0, .1);
    const n = order.length;
    order.forEach((k, i) => {
      const node = nodes.get(k); if (!node) return;
      const a = n === 1 ? 0 : (-.9 + 1.8 * i / (n - 1));
      node.base.set(Math.cos(a) * 1.15, Math.sin(a) * 1.15, -.1);
    });
    rebuildLinks();
  }

  function setPeers(list){
    if (!nodes.has('me')) addNode('me', COL.you);
    const want = new Set(list);
    list.forEach(k => { const ex = nodes.get(k); if (!ex) addNode(k, COL.peer); else ex.leaving = false; });
    nodes.forEach((n, k) => { if (k !== 'me' && !want.has(k)) n.leaving = true; });
    const cnt = list.length;
    sealTarget = cnt > 0 ? 1 : 0;
    if (prevCount === 0 && cnt > 0) flash = 1;
    prevCount = cnt; order = list.slice(); layout();
  }

  // Light pulses and ripples
  const pulses = [], ripples = [];
  const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  function pulse(fromKey, toKey){
    const other = fromKey === 'me' ? toKey : fromKey;
    const c = curves.get(other); if (!c) return;
    const color = fromKey === 'me' ? COL.you : COL.peer;
    const sprites = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, blending: add, depthWrite: false, opacity: 0 }));
      nodeG.add(s); sprites.push(s);
    }
    pulses.push({ c, forward: fromKey === 'me', sprites, t: 0, dur: reduce ? .5 : .95, toKey, arrived: false });
  }
  function addRipple(key){
    const n = nodes.get(key); if (!n) return;
    const m = new THREE.Mesh(new THREE.RingGeometry(.2, .235, 48),
      new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: .8, blending: add, side: THREE.DoubleSide, depthWrite: false }));
    m.position.copy(n.base); nodeG.add(m); ripples.push({ m, age: 0 });
  }
  function typing(key, on){ const n = nodes.get(key); if (n) n.typing = !!on; }

  function setMode(m){
    mode = m;
    clearInterval(demoTimer); demoTimer = null;
    if (m === 'demo') {
      setPeers(['demo']);
      let flip = false;
      demoTimer = setInterval(() => {
        if (document.hidden) return;
        flip = !flip; pulse(flip ? 'me' : 'demo', flip ? 'demo' : 'me');
      }, 1900);
    } else { setPeers([]); }
  }

  // Sizing: keep the whole orb in view whatever the shape of the stage
  function resize(){
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.position.z = Math.max(7.4, 7.0 / camera.aspect);
    camera.updateProjectionMatrix(); renderer.render(scene, camera);
  }
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(host); else window.addEventListener('resize', resize);

  const ptr = { x: 0, y: 0 };
  host.addEventListener('pointermove', e => {
    const r = host.getBoundingClientRect();
    ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1; ptr.y = ((e.clientY - r.top) / r.height) * 2 - 1;
  });
  host.addEventListener('pointerleave', () => { ptr.x = 0; ptr.y = 0; });
  canvas.addEventListener('webglcontextlost', e => e.preventDefault());

  const clock = new THREE.Clock();
  function frame(){
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), .05); time += dt;
    const m = reduce ? .2 : 1, k = Math.min(1, dt * 3);
    cage.rotation.y += dt * .10 * m; cage.rotation.x += dt * .03 * m;
    dust.rotation.y -= dt * .04 * m;
    ring1.rotation.z += dt * .15 * m; ring2.rotation.x += dt * .08 * m;
    shellMat.uniforms.uTime.value = time;
    seal += (sealTarget - seal) * Math.min(1, dt * 2.5); shellMat.uniforms.uSeal.value = seal;
    cage.material.color.copy(lavC).lerp(peerC, seal * .7);
    ring1.material.color.copy(lavC).lerp(peerC, seal * .8);
    root.rotation.y += ((reduce ? 0 : ptr.x * .35 + Math.sin(time * .3) * .08) - root.rotation.y) * k;
    root.rotation.x += ((reduce ? 0 : ptr.y * .2) - root.rotation.x) * k;

    if (flash > 0) {
      flash = Math.max(0, flash - dt * 1.2);
      flashRing.scale.setScalar(1 + (1 - flash) * .38); flashMat.opacity = flash * .9;
    }
    if (ghost.visible) ghost.material.opacity = .3 + .25 * Math.sin(time * 2.2);

    nodes.forEach((n, key) => {
      if (n.leaving) { n.appear -= dt * 3; if (n.appear <= 0) { removeNode(key, n); return; } }
      else if (n.appear < 1) n.appear = Math.min(1, n.appear + dt * 2.2);
      const s = n.leaving ? n.appear : easeOutBack(n.appear);
      n.g.scale.setScalar(Math.max(.0001, s));
      const bob = reduce ? 0 : Math.sin(time * 1.3 + n.phase) * .07;
      n.g.position.set(n.base.x, n.base.y + bob, n.base.z);
      n.glow.scale.setScalar(1.5 + (n.typing ? .45 + .25 * Math.sin(time * 10) : 0));
      n.halo.material.opacity = n.typing ? .9 : .5;
    });

    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]; p.t += dt / p.dur;
      p.sprites.forEach((s, j) => {
        const lt = p.t - j * .04, tt = Math.min(1, Math.max(0, lt)), e = easeInOut(tt);
        s.position.copy(p.c.getPoint(p.forward ? e : 1 - e));
        s.material.opacity = (lt > 0 && lt < 1.02) ? (1 - j / 6) * .95 : 0;
        s.scale.setScalar(.7 - j * .07);
      });
      if (!p.arrived && p.t >= 1) { p.arrived = true; addRipple(p.toKey); }
      if (p.t >= 1.3) {
        p.sprites.forEach(s => { nodeG.remove(s); s.material.dispose(); }); pulses.splice(i, 1);
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i]; r.age += dt / .8;
      r.m.scale.setScalar(1 + r.age * 3.2); r.m.material.opacity = Math.max(0, (1 - r.age) * .8);
      if (r.age >= 1) { nodeG.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); ripples.splice(i, 1); }
    }
    renderer.render(scene, camera);
  }
  resize(); setMode('demo'); frame();
  return { setMode, setPeers, pulse, typing };
})();

/* =====================================================================
   Transport: packets are already encrypted when they get here. The server
   only relays them between the (at most two) people in a room.
   ===================================================================== */
function makeTransport(roomId, onPacket, onState){
  if (typeof io !== 'function') { setTimeout(() => onState('none'), 0); return { send(){ return Promise.resolve(); }, close(){} }; }
  let closed = false, joined = false, tries = 0;
  const sock = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
  const join = () => {
    sock.emit('join', roomId, res => {
      if (closed) return;
      if (res && res.ok) { joined = true; tries = 0; onState('live'); return; }
      const err = res && res.error;
      if (err === 'full' && tries < 3) { tries++; setTimeout(() => { if (!closed && sock.connected) join(); }, 1500); return; }
      onState(err === 'full' ? 'full' : 'none');
    });
  };
  sock.on('connect', () => { joined = false; join(); });
  sock.on('disconnect', () => { joined = false; if (!closed) onState('connecting'); });
  sock.on('connect_error', () => { if (!closed) onState('connecting'); });
  sock.on('p', pkt => onPacket(pkt));
  return {
    send(pkt){ if (joined && sock.connected) sock.emit('p', pkt); return Promise.resolve(); },
    close(){ closed = true; sock.disconnect(); }
  };
}

/* =====================================================================
   App
   ===================================================================== */
const app = $('#app'), landing = $('#landing'), roomEl = $('#room');
const logEl = $('#log'), typingEl = $('#typing'), emptyEl = $('#empty'), input = $('#input'), sendBtn = $('#sendBtn');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = window.matchMedia('(pointer: coarse)').matches;
const ADJ = ['Amber','Quiet','Brisk','Mossy','Lunar','Dapper','Glassy','Sunny','Velvet','Cedar'];
const ANI = ['Heron','Fox','Otter','Lynx','Finch','Gecko','Marten','Wren','Ibis','Newt'];
const pick = a => a[Math.floor(Math.random() * a.length)];
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

const S = { secret: null, roomId: null, key: null, cid: rnd(6), name: pick(ADJ) + ' ' + pick(ANI),
  peers: new Map(), seen: new Set(), msgs: new Map(), tx: null, timers: [], lastTyping: 0, lastMine: null };

function saveSession(){ try { sessionStorage.setItem('nook', JSON.stringify({ secret: S.secret, cid: S.cid, name: S.name })); } catch (e) {} }
function clearSession(){ try { sessionStorage.removeItem('nook'); } catch (e) {} }
function readSession(){ try { const v = JSON.parse(sessionStorage.getItem('nook') || 'null'); return v && normCode(v.secret).length === 25 ? v : null; } catch (e) { return null; } }

async function send(obj){
  if (!S.tx || !S.key) return;
  const pkt = await seal(S.key, S.roomId, Object.assign({}, obj, { cid: S.cid, name: S.name, ts: Date.now() }));
  return S.tx.send(pkt);
}

function scrollDown(){ logEl.scrollTo({ top: logEl.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' }); }
function addNote(text){
  emptyEl.hidden = true;
  const n = el('div', 'note'); n.textContent = text; logEl.insertBefore(n, typingEl); scrollDown();
}
function setStatus(){
  const n = S.peers.size, first = n ? S.peers.values().next().value.name : '';
  $('#dot').className = 'dot' + (n ? ' on' : '');
  $('#statusText').textContent = n === 0 ? 'Waiting for someone to join' : n === 1 ? 'Connected with ' + first : 'Connected · ' + (n + 1) + ' people';
}
function syncStage(){ Stage.setPeers([...S.peers.keys()]); }
function updateTyping(){
  const now = Date.now(); let any = false;
  S.peers.forEach((p, cid) => { const on = now < p.typingUntil; Stage.typing(cid, on); if (on) any = true; });
  const was = typingEl.hidden === false;
  typingEl.hidden = !any;
  if (any && !was) scrollDown();
}
function updateMeta(m){
  if (!m.mine) return;
  const isLast = S.lastMine === m;
  m.metaEl.className = 'meta' + (m.status === 'undelivered' ? ' bad' : '');
  m.metaEl.textContent = !isLast ? '' : m.status === 'delivered' ? 'Delivered' : m.status === 'undelivered' ? 'Not delivered yet' : '';
}
function addMessage(m){
  emptyEl.hidden = true;
  const wrap = el('div', 'msg ' + (m.mine ? 'me' : 'them'));
  if (!m.mine) { const w = el('div', 'who'); w.textContent = m.name; wrap.append(w); }
  const b = el('div', 'bubble'); b.textContent = m.text; wrap.append(b);
  if (m.mine) { m.metaEl = el('div', 'meta'); wrap.append(m.metaEl); const prev = S.lastMine; S.lastMine = m; if (prev) updateMeta(prev); }
  logEl.insertBefore(wrap, typingEl); S.msgs.set(m.id, m); updateMeta(m); scrollDown();
}

function touch(o){
  let p = S.peers.get(o.cid); const fresh = !p;
  if (!p) { p = { cid: o.cid, name: String(o.name || 'Someone').slice(0, 24), last: 0, typingUntil: 0 }; S.peers.set(o.cid, p); }
  p.last = Date.now();
  if (fresh) { addNote(p.name + ' joined'); syncStage(); setStatus(); }
  return fresh;
}
function dropPeer(cid){
  const p = S.peers.get(cid); if (!p) return;
  S.peers.delete(cid); Stage.typing(cid, false); addNote(p.name + ' left'); syncStage(); setStatus(); updateTyping();
}

async function onPacket(pkt){
  if (!S.key || !pkt || typeof pkt.i !== 'string' || typeof pkt.c !== 'string') return;
  if (S.seen.has(pkt.i)) return;
  S.seen.add(pkt.i); if (S.seen.size > 4000) S.seen.delete(S.seen.values().next().value);
  const o = await unseal(S.key, S.roomId, pkt);
  if (!o || typeof o.cid !== 'string' || o.cid === S.cid) return;
  if (o.t === 'hi') { if (touch(o)) send({ t: 'hi' }); return; }
  if (o.t === 'bye') { dropPeer(o.cid); return; }
  touch(o);
  const p = S.peers.get(o.cid);
  if (o.t === 'ty') { p.typingUntil = Date.now() + 3500; updateTyping(); }
  else if (o.t === 'm' && typeof o.text === 'string' && typeof o.id === 'string' && !S.msgs.has(o.id)) {
    p.typingUntil = 0; updateTyping();
    addMessage({ id: o.id, text: o.text.slice(0, 600), mine: false, name: p.name });
    Stage.pulse(o.cid, 'me');
    send({ t: 'ack', id: o.id });
  }
  else if (o.t === 'ack') {
    const m = S.msgs.get(o.id);
    if (m && m.mine && m.status !== 'delivered') { m.status = 'delivered'; clearTimeout(m.timer); updateMeta(m); }
  }
}

function onRelay(state){
  const note = $('#relayNote');
  note.hidden = state === 'live';
  note.textContent = state === 'none' ? "Can't reach the server right now." : 'Connecting…';
  if (state === 'live') send({ t: 'hi' });
  if (state === 'full') leaveRoom().then(() => { openJoin(true); joinErr.textContent = 'That room already has two people.'; });
}

async function sendMessage(){
  const text = input.value.trim(); if (!text || !S.key) return;
  input.value = ''; autosize(); sendBtn.disabled = true;
  const m = { id: rnd(8), text, mine: true, status: 'sending' };
  addMessage(m);
  if (S.peers.size) S.peers.forEach((_, cid) => Stage.pulse('me', cid)); else Stage.pulse('me', 'ghost');
  m.timer = setTimeout(() => { if (m.status !== 'delivered') { m.status = 'undelivered'; updateMeta(m); } }, 4000);
  try { await send({ t: 'm', id: m.id, text }); } catch (e) { m.status = 'undelivered'; updateMeta(m); }
}
function autosize(){ input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }

input.addEventListener('input', () => {
  autosize(); sendBtn.disabled = !input.value.trim();
  const now = Date.now();
  if (S.peers.size && now - S.lastTyping > 2500) { S.lastTyping = now; send({ t: 'ty' }); }
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !coarse) { e.preventDefault(); sendMessage(); }
});
sendBtn.addEventListener('click', () => { sendMessage(); input.focus(); });

async function copyText(t){
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}
const inviteLink = () => location.origin + location.pathname + '#' + fmt(S.secret);
$('#copyBtn').addEventListener('click', async () => {
  const b = $('#copyBtn'); const ok = await copyText(inviteLink());
  b.textContent = ok ? 'Copied' : 'Press and hold the code to copy';
  setTimeout(() => { b.textContent = 'Copy link'; }, 1800);
});
if (navigator.share) {
  $('#shareBtn').hidden = false;
  $('#shareBtn').addEventListener('click', async () => {
    try { await navigator.share({ title: 'nook', text: 'Join me in a private chat.', url: inviteLink() }); } catch (e) {}
  });
}

function resetRoomUI(){
  [...logEl.children].forEach(c => { if (c !== emptyEl && c !== typingEl) c.remove(); });
  emptyEl.hidden = false; typingEl.hidden = true; input.value = ''; autosize(); sendBtn.disabled = true;
  S.peers.clear(); S.seen.clear(); S.msgs.clear(); S.lastMine = null;
}

async function enterRoom(secret){
  let k;
  try { k = await derive(secret); } catch (e) { $('#joinErr').textContent = "This browser can't encrypt messages, so rooms are turned off."; return false; }
  S.secret = secret; S.roomId = k.roomId; S.key = k.key;
  resetRoomUI();
  $('#codeText').textContent = fmt(secret);
  app.className = 'room'; landing.hidden = true; roomEl.hidden = false; $('#hud').hidden = false;
  Stage.setMode('room'); setStatus();
  S.tx = makeTransport(S.roomId, onPacket, onRelay);
  send({ t: 'hi' }); saveSession();
  S.timers.push(setInterval(() => send({ t: 'hi' }), 5000));
  S.timers.push(setInterval(() => {
    const now = Date.now();
    S.peers.forEach((p, cid) => { if (now - p.last > 15000) dropPeer(cid); });
    updateTyping();
  }, 700));
  if (!coarse) input.focus();
  return true;
}

async function leaveRoom(){
  try { await Promise.race([send({ t: 'bye' }), sleep(300)]); } catch (e) {}
  S.timers.forEach(clearInterval); S.timers = [];
  if (S.tx) S.tx.close(); S.tx = null; S.key = null; S.secret = null; clearSession();
  resetRoomUI();
  app.className = 'landing'; roomEl.hidden = true; landing.hidden = false; $('#hud').hidden = true;
  Stage.setMode('demo');
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.key) send({ t: 'hi' }); });
$('#leaveBtn').addEventListener('click', leaveRoom);

/* Landing */
const joinBox = $('#joinBox'), codeIn = $('#codeIn'), joinErr = $('#joinErr');
function openJoin(show){
  joinBox.hidden = !show; $('#haveCodeBtn').setAttribute('aria-expanded', String(show));
  if (show) codeIn.focus();
}
$('#createBtn').addEventListener('click', () => enterRoom(newSecret()));
$('#haveCodeBtn').addEventListener('click', () => openJoin(joinBox.hidden));
async function tryJoin(){
  const code = normCode(codeIn.value);
  if (code.length !== 25) { joinErr.textContent = "That code doesn't look right. It has 25 letters and numbers."; return; }
  joinErr.textContent = ''; codeIn.value = ''; await enterRoom(code);
}
$('#joinBtn').addEventListener('click', tryJoin);
codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin(); });
codeIn.addEventListener('input', () => { joinErr.textContent = ''; });

/* Start */
if (!(window.crypto && crypto.subtle)) {
  $('#createBtn').disabled = true; $('#haveCodeBtn').disabled = true;
  $('#fine').textContent = "This browser can't encrypt messages, so rooms are turned off.";
} else {
  let fromHash = '';
  try { fromHash = normCode(decodeURIComponent((location.hash || '').slice(1))); } catch (e) {}
  if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  const saved = readSession();
  if (saved) { S.cid = saved.cid || S.cid; S.name = saved.name || S.name; enterRoom(normCode(saved.secret)); }
  else if (fromHash.length === 25) { openJoin(true); codeIn.value = fromHash; }
}
})();
