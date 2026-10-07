import * as THREE from 'three';
import { MAP, PLAYER, WEAPONS, moveBody, aimDir, rayWorld, rayBox, hitboxes } from '/shared/game.js';
import { createRenderer, buildWorld, loadSoldier, makeSoldier, makeViewmodel, makeEffects } from '/render.js';

// ---------------------------------------------------------------- setup
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) { document.body.classList.add('touch'); $('keys').textContent = 'Left stick move · Drag right side to aim · FIRE to shoot'; }
const TEAM = { A: { name: 'CYAN', color: 0x3fd0ff, css: 'ta' }, B: { name: 'EMBER', color: 0xff8a3d, css: 'tb' } };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

const params = new URLSearchParams(location.search);
const quality = params.get('q') || store.get('pf_quality') || (isTouch ? 'fast' : 'high');
for (const q of ['high', 'fast']) {
  const a = $('q-' + q); a.classList.toggle('on', q === quality);
  a.onclick = (e) => { e.preventDefault(); store.set('pf_quality', q); const u = new URL(location.href); u.searchParams.set('q', q); location.href = u; };
}
const debugCam = params.get('cam')?.split(',').map(Number);
const canvas = $('gl');
const R = createRenderer(canvas, { quality, touch: isTouch });
const { scene, camera } = R;
const vm = makeViewmodel(camera);
const fx = makeEffects(scene);
R.aoHide.push(fx.group, vm.view);
const ready = Promise.all([buildWorld(scene, quality, R), loadSoldier()]);

// ray against the map that also returns the surface normal (for decals / particles)
function rayHit(o, d, max) {
  let best = max, nrm = null;
  for (const b of MAP.boxes) {
    const t = rayBox(o, d, b, best);
    if (t < best) {
      best = t;
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const faces = [[Math.abs(p[0] - b[0]), [-1, 0, 0]], [Math.abs(p[0] - b[3]), [1, 0, 0]], [Math.abs(p[1] - b[1]), [0, -1, 0]],
        [Math.abs(p[1] - b[4]), [0, 1, 0]], [Math.abs(p[2] - b[2]), [0, 0, -1]], [Math.abs(p[2] - b[5]), [0, 0, 1]]];
      nrm = faces.sort((a, c) => a[0] - c[0])[0][1];
    }
  }
  if (d[1] < 0) { const t = -o[1] / d[1]; if (t < best) { best = t; nrm = [0, 1, 0]; } }
  return { t: best, n: nrm };
}

function nameSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(text, 128, 32);
  g.fillStyle = color; g.fillText(text, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
  s.scale.set(1.6, 0.4, 1); s.position.y = 2.2;
  R.aoHide.push(s);
  return s;
}

// ---------------------------------------------------------------- audio
let ac = null, master = null, noiseBuf = null;
function initAudio() {
  if (ac) return;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.4, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { ac = null; }
}
function sfxShot(w, vol = 1) {
  if (!ac || vol < 0.02) return;
  const t = ac.currentTime, src = ac.createBufferSource(); src.buffer = noiseBuf;
  const bp = ac.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = w === 'pistol' ? 2600 : 1800;
  const g = ac.createGain(); g.gain.setValueAtTime(0.9 * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + (w === 'pistol' ? 0.16 : 0.22));
  src.connect(bp).connect(g).connect(master); src.start(t); src.stop(t + 0.3);
  const o = ac.createOscillator(), og = ac.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  og.gain.setValueAtTime(0.6 * vol, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.14); o.connect(og).connect(master); o.start(t); o.stop(t + 0.15);
}
function sfxTone(f, dur, vol = 0.25, type = 'sine') {
  if (!ac) return;
  const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g).connect(master); o.start(t); o.stop(t + dur);
}
const sfxHit = (head) => sfxTone(head ? 1500 : 980, 0.08, 0.22, 'square');
const sfxKill = () => { sfxTone(660, 0.1, 0.25); setTimeout(() => sfxTone(990, 0.16, 0.25), 70); };
const sfxClick = () => sfxTone(2400, 0.03, 0.12, 'square');

// ---------------------------------------------------------------- state
const me = { id: 0, team: null, alive: false, hp: 100, w: 'rifle', mag: 30, res: 90, reloading: false, queuePos: 0 };
const body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ground: true };
let yaw = 0, pitch = 0;
const game = { state: 'warmup', round: 0, score: { A: 0, B: 0 }, ends: 0, queue: 0 };
const roster = new Map();       // id -> {name, team, k, d, ping, bot, alive}
const remotes = new Map();      // id -> {model, buf: [], alive, team, sprite, w}
let ws = null, timeOffset = 0, rtt = 80, specTarget = 0, boardOpen = false;
const serverNow = () => Date.now() + timeOffset;
const INTERP = 100;

// ---------------------------------------------------------------- network
function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?world=${encodeURIComponent(window.WORLD)}&name=${encodeURIComponent(name)}`);
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = (e) => { if (e.code !== 4001) showMsg('Disconnected. <a href="" style="color:#ff8a3d">Rejoin</a>'); };
  setInterval(() => sendMsg({ t: 'ping', c: Date.now(), rtt }), 1000);
}
const sendMsg = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

function onMsg(m) {
  switch (m.t) {
    case 'welcome': me.id = m.id; timeOffset = m.now - Date.now(); break;
    case 'pong': { const r = Date.now() - m.c; rtt = rtt * 0.7 + r * 0.3; timeOffset = timeOffset * 0.8 + (m.s - (m.c + r / 2)) * 0.2; break; }
    case 'full': showMsg('This world is full right now.<br><br><a class="btn" href="/" target="_blank" style="text-decoration:none;display:inline-block">Make your own world ↗</a>'); break;
    case 'snap': onSnap(m); break;
    case 'roster':
      roster.clear(); for (const p of m.list) roster.set(p.id, p);
      Object.assign(game, { state: m.state, score: m.score, round: m.round, ends: m.ends, queue: m.queue });
      if (boardOpen) renderBoard();
      break;
    case 'round': onRound(m); break;
    case 'team':
      me.team = m.team; if (!m.team) { me.alive = false; }
      if (m.note) banner('Back in the queue', m.note, 3500);
      else if (m.team) banner(`You joined ${TEAM[m.team].name}`, game.state === 'warmup' ? 'Spawning…' : 'You spawn next round', 2500, TEAM[m.team].css);
      break;
    case 'queue': me.queuePos = m.pos; game.queue = m.of; break;
    case 'spawn':
      Object.assign(body, { x: m.x, y: m.y, z: m.z, vx: 0, vy: 0, vz: 0, ground: true });
      yaw = m.yaw; pitch = 0; me.alive = true; me.hp = 100; recoil = 0;
      break;
    case 'pos': Object.assign(body, { x: m.x, y: m.y, z: m.z, vx: 0, vy: 0, vz: 0 }); break;
    case 'you': {
      const wasAlive = me.alive;
      Object.assign(me, { hp: m.hp, alive: m.alive, team: m.team, w: m.w, mag: m.mag, res: m.res, reloading: m.reloading });
      if (wasAlive && !m.alive) specTarget = 0;
      break;
    }
    case 'shot': onRemoteShot(m); break;
    case 'hit':
      flashHitmarker(m.head); sfxHit(m.head);
      if (m.kill) sfxKill();
      break;
    case 'hurt': {
      me.hp = m.hp; const el = $('dmg'); el.style.opacity = Math.min(1, 0.35 + m.dmg / 60);
      setTimeout(() => (el.style.opacity = 0), 160);
      break;
    }
    case 'kill': onKill(m); break;
    case 'left': { const r = remotes.get(m.id); if (r) { scene.remove(r.model.group); remotes.delete(m.id); } break; }
  }
}

function onSnap(m) {
  const seen = new Set();
  for (const [id, x, y, z, yw, pt, alive, team, pistol] of m.ps) {
    seen.add(id);
    if (id === me.id) { me.team = team; continue; }
    let r = remotes.get(id);
    if (!r || r.team !== team) {
      if (r) scene.remove(r.model.group);
      const model = makeSoldier(team); scene.add(model.group);
      r = { model, buf: [], team, alive, sprite: null, name: '' };
      remotes.set(id, r);
    }
    r.buf.push({ t: m.now, x, y, z, yaw: yw, pitch: pt });
    if (r.buf.length > 30) r.buf.shift();
    r.alive = !!alive; r.w = pistol ? 'pistol' : 'rifle';
    const name = roster.get(id)?.name || '';
    if (name !== r.name) {
      if (r.sprite) { r.model.group.remove(r.sprite); R.aoHide.splice(R.aoHide.indexOf(r.sprite), 1); }
      r.sprite = nameSprite(name, team === 'A' ? '#8fe6ff' : '#ffc194'); r.model.group.add(r.sprite); r.name = name;
    }
  }
  for (const [id, r] of remotes) if (!seen.has(id)) { scene.remove(r.model.group); remotes.delete(id); }
}

function sampleRemote(r, t) {
  const b = r.buf;
  if (!b.length) return null;
  if (t <= b[0].t) return b[0];
  for (let i = b.length - 1; i > 0; i--) {
    if (b[i - 1].t <= t) {
      const a = b[i - 1], c = b[i], k = Math.min(1, (t - a.t) / Math.max(1, c.t - a.t));
      let dy = c.yaw - a.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k, yaw: a.yaw + dy * k, pitch: a.pitch + (c.pitch - a.pitch) * k };
    }
  }
  return b[b.length - 1];
}

function onRound(m) {
  Object.assign(game, { state: m.state, round: m.round, score: m.score, ends: m.ends });
  const W = (t) => `<span class="${TEAM[t].css}">${TEAM[t].name}</span>`;
  if (m.state === 'freeze') fx.clearHoles();
  if (m.state === 'freeze') banner(`Round ${m.round}`, `${TEAM.A.name} ${m.score.A} – ${m.score.B} ${TEAM.B.name}`, 2600);
  else if (m.state === 'live') banner('Fight!', '', 900);
  else if (m.state === 'post') banner(m.winner ? `${W(m.winner)} wins the round` : 'Draw', m.reason === 'time' ? 'Time ran out' : 'Team eliminated', 3500);
  else if (m.state === 'matchover') {
    banner(`${W(m.matchWinner)} wins the match`, `${m.score.A} – ${m.score.B} · winners stay on, new match soon`, 8000);
  } else if (m.state === 'warmup') banner('Warmup', 'Waiting for both teams', 2000);
}

function onKill(m) {
  const k = roster.get(m.k), v = roster.get(m.v);
  const nm = (p) => p ? `<span class="${TEAM[p.team]?.css || ''}">${esc(p.name)}</span>` : '?';
  const div = document.createElement('div');
  div.innerHTML = `${nm(k)} <span style="color:#9aa3ad">[${m.w === 'pistol' ? 'P-12' : 'VX-7'}]${m.head ? ' <span class="hs">⌖</span>' : ''}</span> ${nm(v)}`;
  if (m.k === me.id || m.v === me.id) div.style.outline = '1px solid #ffffff55';
  $('feed').prepend(div); while ($('feed').children.length > 5) $('feed').lastChild.remove();
  setTimeout(() => div.remove(), 5200);
  if (m.v === me.id) { me.alive = false; specTarget = m.k; banner('You died', `Killed by ${esc(k?.name || '?')}${m.head ? ' (headshot)' : ''}`, 2200); }
  const r = remotes.get(m.v); if (r) r.alive = false;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function onRemoteShot(m) {
  const r = remotes.get(m.id); if (!r) return;
  const g = r.model.group, yw = g.rotation.y;
  const from = new THREE.Vector3(g.position.x - Math.sin(yw) * 0.6 + Math.cos(yw) * 0.2, g.position.y + 1.4, g.position.z - Math.cos(yw) * 0.6 - Math.sin(yw) * 0.2);
  const end = new THREE.Vector3(...m.end);
  fx.tracer(from, end);
  const dir = end.clone().sub(from).normalize();
  const hit = rayHit([from.x, from.y, from.z], [dir.x, dir.y, dir.z], from.distanceTo(end) + 0.1);
  if (hit.n && hit.t >= from.distanceTo(end) - 0.15) fx.impact(end, new THREE.Vector3(...hit.n), false);
  const d = Math.hypot(from.x - camera.position.x, from.z - camera.position.z);
  sfxShot(m.w, Math.min(1, 6 / (d + 3)));
  r.flash = 0.05;
}

// ---------------------------------------------------------------- input
const keys = {};
let firing = false, firedThisPress = false, pointerLocked = false, lookFallback = isTouch;
const touchMove = { f: 0, s: 0 };
let jumpQueued = false;
const SENS = +(store.get('pf_sens') || 0.0022);

addEventListener('keydown', (e) => {
  if (document.activeElement === $('name')) { if (e.code === 'Enter') start(); return; }
  keys[e.code] = true;
  if (e.code === 'Space') { jumpQueued = true; if (!me.alive) cycleSpec(); }
  if (e.code === 'KeyR') reload();
  if (e.code === 'Digit1') switchWeapon('rifle');
  if (e.code === 'Digit2') switchWeapon('pistol');
  if (e.code === 'KeyQ') switchWeapon(me.w === 'rifle' ? 'pistol' : 'rifle');
  if (e.code === 'Tab') { e.preventDefault(); boardOpen = true; renderBoard(); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'Tab') { boardOpen = false; $('board').style.display = 'none'; } });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; firing = false; });

canvas.addEventListener('mousedown', (e) => {
  if (isTouch) return;
  initAudio();
  if (!pointerLocked && !lookFallback) { lockPointer(); return; }
  if (e.button === 0) { firing = true; firedThisPress = false; if (!me.alive) cycleSpec(); }
  if (e.button === 2) dragLook = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; if (e.button === 2) dragLook = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', () => switchWeapon(me.w === 'rifle' ? 'pistol' : 'rifle'), { passive: true });
let dragLook = false;
addEventListener('mousemove', (e) => {
  if (pointerLocked || (lookFallback && dragLook && !isTouch)) look(e.movementX, e.movementY);
});
let lookDX = 0, lookDY = 0; const sway = [0, 0];
function look(dx, dy, mul = 1) {
  lookDX += dx; lookDY += dy;
  yaw -= dx * SENS * mul; pitch -= dy * SENS * mul;
  pitch = Math.max(-1.5, Math.min(1.5, pitch));
}
function lockPointer() {
  try { const p = canvas.requestPointerLock?.(); p?.catch?.(() => enableFallback()); } catch { enableFallback(); }
}
function enableFallback() {
  lookFallback = true;
  $('lock').style.display = 'block';
  $('lock').innerHTML = `Mouse aim is limited inside the post: hold <b>right mouse</b> to look. <a href="${location.pathname}" target="_blank" style="color:#ff8a3d">Open full screen ↗</a>`;
  setTimeout(() => ($('lock').style.display = 'none'), 7000);
}
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (!lookFallback) $('lock').style.display = pointerLocked || $('start').style.display !== 'none' ? 'none' : 'block';
});
document.addEventListener('pointerlockerror', enableFallback);

// touch controls
if (isTouch) {
  $('touch').style.display = 'block';
  const stick = $('stick'), knob = $('knob');
  let stickId = null, lookId = null, lastLook = null;
  const area = $('touch');
  area.addEventListener('touchstart', (e) => {
    initAudio();
    for (const t of e.changedTouches) {
      const el = t.target;
      if (el === stick || el === knob) { stickId = t.identifier; moveStick(t); }
      else if (el.id === 'tfire') { firing = true; firedThisPress = false; if (!me.alive) cycleSpec(); }
      else if (el.id === 'tjump') jumpQueued = true;
      else if (el.id === 'treload') reload();
      else if (el.id === 'tswap') switchWeapon(me.w === 'rifle' ? 'pistol' : 'rifle');
      else if (el.id === 'tboard') { boardOpen = !boardOpen; boardOpen ? renderBoard() : ($('board').style.display = 'none'); }
      else if (t.clientX > innerWidth * 0.35 && lookId === null) { lookId = t.identifier; lastLook = [t.clientX, t.clientY]; if (!me.alive) cycleSpec(); }
    }
    e.preventDefault();
  }, { passive: false });
  area.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) moveStick(t);
      if (t.identifier === lookId) { look(t.clientX - lastLook[0], t.clientY - lastLook[1], 1.5); lastLook = [t.clientX, t.clientY]; }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; touchMove.f = touchMove.s = 0; knob.style.transform = ''; }
      if (t.identifier === lookId) lookId = null;
      if (t.target.id === 'tfire') firing = false;
    }
  };
  area.addEventListener('touchend', end); area.addEventListener('touchcancel', end);
  function moveStick(t) {
    const r = stick.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy), max = r.width / 2;
    if (len > max) { dx *= max / len; dy *= max / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    touchMove.s = dx / max; touchMove.f = -dy / max;
  }
}

// ---------------------------------------------------------------- weapons
let nextShot = 0, recoil = 0;
function canAct() { return me.alive && me.team && (game.state === 'live' || game.state === 'warmup'); }
function reload() {
  const W = WEAPONS[me.w];
  if (!me.alive || me.reloading || me.mag >= W.mag || me.res <= 0) return;
  me.reloading = true; sendMsg({ t: 'reload' });
}
function switchWeapon(w) {
  if (!me.alive || w === me.w) return;
  me.w = w; me.reloading = false; nextShot = performance.now() + 350; sendMsg({ t: 'switch', w });
  const a = WEAPONS[w]; $('wname').textContent = a.name;
}
function tryFire() {
  if (!firing || !canAct()) return;
  const W = WEAPONS[me.w], now = performance.now();
  if (!W.auto && firedThisPress) return;
  if (now < nextShot || me.reloading) return;
  if (me.mag <= 0) { firedThisPress = true; sfxClick(); reload(); return; }
  nextShot = now + 60000 / W.rpm; firedThisPress = true;
  const moving = Math.hypot(body.vx, body.vz) > 3.2;
  const spread = W.spread + (moving ? W.moveSpread : 0) + (body.ground ? 0 : 0.09) + recoil;
  const sy = yaw + (Math.random() - 0.5) * 2 * spread, sp = pitch + (Math.random() - 0.5) * 2 * spread;
  sendMsg({ t: 'fire', w: me.w, yaw: sy, pitch: sp });
  me.mag--;
  // local prediction of where the bullet lands (visual only; server decides damage)
  const o = [body.x, body.y + PLAYER.eye, body.z], d = aimDir(sy, sp);
  const wh = rayHit(o, d, W.range);
  let t = wh.t, blood = false, nrm = wh.n;
  const rt = serverNow() - INTERP;
  for (const [, r] of remotes) {
    if (!r.alive) continue;
    const s = sampleRemote(r, rt); if (!s) continue;
    const hb = hitboxes(s.x, s.y, s.z);
    const th = Math.min(rayBox(o, d, hb.head, t), rayBox(o, d, hb.body, t));
    if (th < t) { t = th; blood = true; nrm = [-d[0], -d[1], -d[2]]; }
  }
  const end = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const muzzle = vm.muzzle(new THREE.Vector3(), me.w), endV = new THREE.Vector3(...end);
  fx.tracer(muzzle, endV);
  if (nrm) fx.impact(endV, new THREE.Vector3(...nrm), blood);
  pitch = Math.min(1.5, pitch + W.recoil * (0.6 + Math.random() * 0.4));
  yaw += (Math.random() - 0.5) * W.recoil * 0.6;
  recoil = Math.min(0.06, recoil + (me.w === 'rifle' ? 0.005 : 0.012));
  vm.fire();
  sfxShot(me.w, 0.8);
  if (me.mag === 0 && me.res > 0) setTimeout(reload, 150);
}

// ---------------------------------------------------------------- spectate
function aliveList() {
  const l = [...remotes.entries()].filter(([, r]) => r.alive);
  const mine = l.filter(([, r]) => r.team === me.team);
  return (me.team && mine.length ? mine : l).map(([id]) => id);
}
function cycleSpec() {
  const l = aliveList(); if (!l.length) return;
  specTarget = l[(l.indexOf(specTarget) + 1) % l.length];
}

// ---------------------------------------------------------------- HUD
function banner(title, sub = '', ms = 2000, cls = '') {
  const b = $('banner'); b.innerHTML = `<span class="${cls}">${title}</span>${sub ? `<small>${sub}</small>` : ''}`;
  b.style.opacity = 1; clearTimeout(banner.t); banner.t = setTimeout(() => (b.style.opacity = 0), ms);
}
function flashHitmarker(head) {
  const h = $('hitm'); h.className = 'hud' + (head ? ' head' : ''); h.style.opacity = 1;
  clearTimeout(flashHitmarker.t); flashHitmarker.t = setTimeout(() => (h.style.opacity = 0), 120);
}
function showMsg(html) { const m = $('msg'); m.innerHTML = html; m.style.display = 'block'; document.exitPointerLock?.(); }
function fmt(s) { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function renderBoard() {
  const b = $('board'); b.style.display = 'block';
  const rows = (t) => [...roster.values()].filter((p) => p.team === t).sort((a, c) => c.k - a.k).map((p) =>
    `<tr class="${p.id === me.id ? 'me' : ''} ${p.alive ? '' : 'dead'}"><td>${esc(p.name)}</td><td class="num">${p.k}</td><td class="num">${p.d}</td><td class="num">${p.bot ? 'BOT' : p.ping}</td></tr>`).join('');
  const head = '<tr><th>Player</th><th class="num">K</th><th class="num">D</th><th class="num">Ping</th></tr>';
  const waiting = [...roster.values()].filter((p) => !p.team).length;
  b.innerHTML = `<h3 class="ta">${TEAM.A.name} · ${game.score.A}</h3><table>${head}${rows('A')}</table>
    <h3 class="tb">${TEAM.B.name} · ${game.score.B}</h3><table>${head}${rows('B')}</table>
    <div style="margin-top:10px;color:#9aa3ad;font-size:12px">World ${esc(window.WORLD)} · ${game.queue} in queue · ${waiting} watching · first to 7 rounds</div>`;
}

let lastHud = 0;
function updateHud(now) {
  if (now - lastHud < 100) return; lastHud = now;
  $('sa').textContent = game.score.A; $('sb').textContent = game.score.B;
  const left = (game.ends - serverNow()) / 1000;
  $('clock').textContent = game.state === 'warmup' ? 'WARMUP' : game.state === 'freeze' ? `GO ${Math.ceil(Math.max(0, left))}` : game.state === 'live' ? fmt(left) : '—';
  $('clock').style.color = game.state === 'live' && left < 15 ? '#ff6b6b' : '';
  $('hp').textContent = Math.max(0, me.hp);
  const bar = $('hpbar').firstElementChild; bar.style.width = Math.max(0, me.hp) + '%';
  bar.style.background = me.hp > 50 ? '#6ef08a' : me.hp > 25 ? '#ffc94d' : '#ff5b5b';
  $('mag').textContent = me.reloading ? '··' : me.mag; $('res').textContent = me.res;
  $('wname').textContent = WEAPONS[me.w].name;
  const show = me.alive && me.team;
  for (const id of ['vitals', 'ammo', 'cross']) $(id).style.display = show ? '' : 'none';
  vm.view.visible = !!show;
  const spec = $('spec');
  if (!show && $('start').style.display === 'none') {
    const tname = roster.get(specTarget)?.name;
    const who = tname ? `Watching <b>${esc(tname)}</b> · ${isTouch ? 'tap' : 'click'} to switch` : 'Spectating';
    let line;
    if (!me.team) line = `You're <b>#${me.queuePos || '?'}</b> in line · ${game.queue} waiting · next slot opens at round end`;
    else if (game.state === 'warmup') line = 'Respawning…';
    else line = 'You spawn next round';
    spec.innerHTML = `${line}<div style="color:#9aa3ad;font-weight:500;margin-top:4px">${who}</div>`;
    spec.style.display = '';
  } else spec.style.display = 'none';
  $('net').textContent = `${Math.round(rtt)} ms · ${roster.size} online · ${window.WORLD}`;
}

// ---------------------------------------------------------------- main loop
let lastSend = 0, lastT = performance.now(), bob = 0;
const tmp = new THREE.Vector3();
function frame(t) {
  ready.then(() => requestAnimationFrame(frame));
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;

  // local movement
  if (me.alive && me.team) {
    const inp = {
      f: (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) + touchMove.f,
      s: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + touchMove.s,
      jump: jumpQueued || keys.Space, walk: keys.ShiftLeft, yaw,
    };
    if (keys.ArrowLeft) yaw += 2.2 * dt; if (keys.ArrowRight) yaw -= 2.2 * dt;
    moveBody(body, inp, dt, MAP.boxes, game.state === 'freeze');
    jumpQueued = false;
    tryFire();
    recoil = Math.max(0, recoil - dt * 0.12);
    if (t - lastSend > 33) { lastSend = t; sendMsg({ t: 'st', x: +body.x.toFixed(3), y: +body.y.toFixed(3), z: +body.z.toFixed(3), yaw: +yaw.toFixed(4), pitch: +pitch.toFixed(4) }); }
    const speed = Math.hypot(body.vx, body.vz);
    bob += dt * speed * 1.6 * (body.ground ? 1 : 0);
    camera.position.set(body.x, body.y + PLAYER.eye + Math.sin(bob * 2) * 0.03 * Math.min(1, speed / 5), body.z);
    camera.rotation.set(pitch, yaw, 0);
    // viewmodel
    sway[0] += (-lookDX * 0.00025 - sway[0]) * Math.min(1, dt * 10); sway[1] += (lookDY * 0.00025 - sway[1]) * Math.min(1, dt * 10);
    sway[0] = Math.max(-0.03, Math.min(0.03, sway[0])); sway[1] = Math.max(-0.03, Math.min(0.03, sway[1])); lookDX = lookDY = 0;
    vm.update(dt, me.w, bob, speed, me.reloading, sway);
  } else {
    // spectator camera
    let target = remotes.get(specTarget);
    if (!target || !target.alive) { const l = aliveList(); specTarget = l[0] || 0; target = remotes.get(specTarget); }
    const s = target && sampleRemote(target, serverNow() - INTERP);
    if (s) {
      const back = 4.2;
      tmp.set(s.x + Math.sin(s.yaw) * back, s.y + 2.4, s.z + Math.cos(s.yaw) * back);
      // keep camera out of walls
      const o = [s.x, s.y + 1.7, s.z], d = [tmp.x - o[0], tmp.y - o[1], tmp.z - o[2]], len = Math.hypot(...d);
      const hit = rayWorld(o, d.map((v) => v / len), MAP.boxes, len);
      if (hit < len) tmp.set(o[0] + d[0] / len * (hit - 0.3), o[1] + d[1] / len * (hit - 0.3), o[2] + d[2] / len * (hit - 0.3));
      camera.position.lerp(tmp, Math.min(1, dt * 8));
      camera.lookAt(s.x - Math.sin(s.yaw) * 4, s.y + 1.4, s.z - Math.cos(s.yaw) * 4);
    } else {
      const a = t / 9000;
      camera.position.set(Math.cos(a) * 30, 22, Math.sin(a) * 20);
      camera.lookAt(0, 0, 0);
    }
  }

  // remote players
  const rt = serverNow() - INTERP;
  for (const [id, r] of remotes) {
    const s = sampleRemote(r, rt); if (!s) continue;
    const g = r.model.group;
    const v = Math.hypot(s.x - g.position.x, s.z - g.position.z) / Math.max(dt, 0.001);
    r.speed = (r.speed || 0) * 0.85 + Math.min(v, 8) * 0.15;
    g.position.set(s.x, s.y, s.z);
    g.rotation.set(0, s.yaw, 0);
    r.model.update(r.speed, dt, r.alive);
    if (r.sprite) r.sprite.visible = r.alive && id !== (me.alive ? -1 : specTarget) && (r.team === me.team || !me.team || !me.alive);
  }

  updateHud(t);
  if (debugCam) { camera.position.set(debugCam[0], debugCam[1], debugCam[2]); camera.lookAt(debugCam[3], debugCam[4], debugCam[5]); vm.view.visible = false; }
  fx.tick(dt);
  R.render();
}

// ---------------------------------------------------------------- start
$('name').value = store.get('pf_name') || '';
fetch(`/api/world/${encodeURIComponent(window.WORLD)}`).then((r) => r.json()).then((s) => {
  $('online').textContent = `${s.active} playing · ${s.queue} in queue`;
}).catch(() => {});
function start() {
  const name = $('name').value.trim() || 'player' + Math.floor(Math.random() * 900 + 100);
  store.set('pf_name', name);
  initAudio();
  $('start').style.display = 'none';
  connect(name);
  if (!isTouch) lockPointer();
}
$('go').addEventListener('click', start);
ready.then(() => { $('go').disabled = false; $('go').textContent = 'Play'; }).catch((e) => { $('go').textContent = 'Error'; console.error(e); });
ready.then(() => requestAnimationFrame(frame));
