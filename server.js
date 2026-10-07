// Postfire server: static files + X Player Card pages + WebSocket game rooms.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  MAP, PLAYER, WEAPONS, TIMES, MAX_ACTIVE, TEAM_SIZE, ROUNDS_TO_WIN,
  moveBody, aimDir, rayWorld, rayBox, hitboxes, eyePos, lineOfSight,
} from './shared/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8080;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const X_HANDLE = process.env.X_HANDLE || '';           // e.g. @leopardracer, shown as card attribution
const BOT_FILL = +(process.env.BOT_FILL ?? 4);           // keep at least this many players in a match using bots
const MAX_SPECTATORS = +process.env.MAX_SPECTATORS || 150;
const TICK_HZ = 20;
const AFK_SECONDS = 40;
const INTERP_MS = 100;

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const STATIC = {
  '/vendor/three.module.js': path.join(__dirname, 'node_modules/three/build/three.module.min.js'),
  '/shared/game.js': path.join(__dirname, 'shared/game.js'),
};
const playTemplate = () => fs.readFileSync(path.join(__dirname, 'public/play.html'), 'utf8');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validId = (id) => /^[a-z0-9-]{3,24}$/.test(id);

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    // must be embeddable inside X's player iframe
    'Content-Security-Policy': "frame-ancestors *",
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
    ...extra,
  });
  res.end(body);
}

function worldPage(id) {
  const room = rooms.get(id);
  const title = `Join world "${id}" · Postfire`;
  const desc = 'A 5v5 shooter that runs inside this post. Everyone who opens it fights in the same arena.';
  const url = `${BASE_URL}/w/${id}`;
  const meta = [
    ['twitter:card', 'player'],
    ['twitter:title', title],
    ['twitter:description', desc],
    ['twitter:player', `${url}?embed=1`],
    ['twitter:player:width', '1280'],
    ['twitter:player:height', '720'],
    ['twitter:image', `${BASE_URL}/card.jpg`],
    ...(X_HANDLE ? [['twitter:site', X_HANDLE]] : []),
  ].map(([n, c]) => `<meta name="${n}" content="${esc(c)}">`).join('\n    ') +
    `\n    <meta property="og:title" content="${esc(title)}">\n    <meta property="og:description" content="${esc(desc)}">` +
    `\n    <meta property="og:image" content="${BASE_URL}/card.jpg">\n    <meta property="og:url" content="${url}">`;
  return playTemplate().replace('<!--META-->', meta).replace(/{{WORLD}}/g, esc(id))
    .replace('{{ONLINE}}', room ? String(room.clients.size) : '0');
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p === '/api/new') {
    let id; do { id = crypto.randomBytes(4).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6); } while (!validId(id) || rooms.has(id));
    return send(res, 200, JSON.stringify({ id, url: `${BASE_URL}/w/${id}` }), MIME['.json']);
  }
  if (p.startsWith('/api/world/')) {
    const id = p.slice(11); const r = rooms.get(id);
    return send(res, 200, JSON.stringify(r ? r.summary() : { id, active: 0, queue: 0, spectators: 0 }), MIME['.json'], { 'Cache-Control': 'no-cache' });
  }
  if (p.startsWith('/w/')) {
    const id = p.slice(3).toLowerCase();
    if (!validId(id)) return send(res, 404, 'Unknown world');
    return send(res, 200, worldPage(id), MIME['.html']);
  }
  let file = STATIC[p] || (p.startsWith('/vendor/addons/') ? path.join(__dirname, 'node_modules/three/examples/jsm', p.slice(15))
    : path.join(__dirname, 'public', p === '/' ? 'index.html' : p));
  if (!file.startsWith(__dirname)) return send(res, 403, 'no');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();
let nextId = 1;
const BOT_NAMES = ['Kestrel', 'Basalt', 'Moth', 'Juniper', 'Rook', 'Vesper', 'Tallow', 'Quill', 'Ember', 'Sable'];

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Map();   // id -> player (humans + bots)
    this.queue = [];            // ids waiting for a slot (FIFO)
    this.state = 'warmup';      // warmup | freeze | live | post | matchover
    this.round = 0;
    this.score = { A: 0, B: 0 };
    this.stateEnds = 0;
    this.emptySince = Date.now();
    this.rosterDirty = true;
    this.lastRoster = 0;
    this.spawnCursor = { A: 0, B: 0 };
  }

  summary() {
    const act = [...this.clients.values()].filter((p) => p.team);
    return { id: this.id, active: act.filter((p) => !p.bot).length, bots: act.filter((p) => p.bot).length,
      queue: this.queue.length, spectators: this.clients.size - act.length - this.queue.length, state: this.state };
  }

  active() { return [...this.clients.values()].filter((p) => p.team); }
  humans() { return [...this.clients.values()].filter((p) => !p.bot); }
  teamOf(t) { return this.active().filter((p) => p.team === t); }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const p of this.clients.values()) if (p.ws && p !== except && p.ws.readyState === 1) p.ws.send(s);
  }

  // ---------------- membership
  join(p) {
    this.clients.set(p.id, p);
    this.emptySince = 0;
    p.team = null; p.alive = false;
    this.queue.push(p.id);
    this.fillSlots(this.state === 'warmup');
    this.rosterDirty = true;
  }

  leave(p) {
    this.clients.delete(p.id);
    this.queue = this.queue.filter((id) => id !== p.id);
    if (p.team) this.broadcast({ t: 'left', id: p.id });
    this.rosterDirty = true;
    if (!this.humans().length) { this.emptySince = Date.now(); }
    this.fillSlots(this.state === 'warmup');
    this.checkRoundEnd();
  }

  smallerTeam() {
    const a = this.teamOf('A').length, b = this.teamOf('B').length;
    return a <= b ? 'A' : 'B';
  }

  // move queued humans into free slots (bots give up their seats first)
  fillSlots(spawnNow) {
    while (this.queue.length) {
      let act = this.active();
      if (act.length >= MAX_ACTIVE) {
        const bot = act.find((p) => p.bot);
        if (!bot) break;
        this.removeBot(bot);
        act = this.active();
      }
      const p = this.clients.get(this.queue.shift());
      if (!p) continue;
      p.team = this.smallerTeam();
      p.alive = false;
      p.lastActive = Date.now();
      this.sendTo(p, { t: 'team', team: p.team });
      if (spawnNow) this.spawn(p);
    }
    this.balanceBots(spawnNow);
    this.sendQueuePositions();
    this.rosterDirty = true;
    if (this.state === 'warmup' && !this.starting) this.maybeStartMatch();
  }

  balanceBots(spawnNow) {
    const humans = this.active().filter((p) => !p.bot).length;
    if (!this.humans().length) { for (const b of this.active().filter((p) => p.bot)) this.removeBot(b); return; }
    const want = Math.max(0, Math.min(MAX_ACTIVE, BOT_FILL) - humans);
    let bots = this.active().filter((p) => p.bot);
    while (bots.length > want) { this.removeBot(bots.pop()); }
    while (bots.length < want) {
      const b = makeBot(this);
      this.clients.set(b.id, b);
      b.team = this.smallerTeam();
      if (spawnNow) this.spawn(b);
      bots.push(b);
    }
    // keep teams within one of each other by moving bots
    for (let i = 0; i < 4; i++) {
      const a = this.teamOf('A'), bb = this.teamOf('B');
      const [big, small] = a.length > bb.length + 1 ? [a, 'B'] : bb.length > a.length + 1 ? [bb, 'A'] : [null];
      if (!big) break;
      const mover = big.find((p) => p.bot) || big[big.length - 1];
      mover.team = small; mover.alive = false;
      this.sendTo(mover, { t: 'team', team: small });
      if (spawnNow) this.spawn(mover);
    }
    this.rosterDirty = true;
  }

  removeBot(b) {
    this.clients.delete(b.id);
    this.broadcast({ t: 'left', id: b.id });
    this.rosterDirty = true;
  }

  sendQueuePositions() {
    this.queue.forEach((id, i) => this.sendTo(this.clients.get(id), { t: 'queue', pos: i + 1, of: this.queue.length }));
  }

  sendTo(p, msg) { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }

  // ---------------- spawning
  spawn(p) {
    const list = MAP.spawns[p.team];
    const s = list[this.spawnCursor[p.team]++ % list.length];
    Object.assign(p, { x: s[0] + (Math.random() - 0.5) * 0.4, y: s[1], z: s[2] + (Math.random() - 0.5) * 0.4,
      vx: 0, vy: 0, vz: 0, ground: true, yaw: MAP.spawnYaw[p.team], pitch: 0, hp: 100, alive: true, history: [], lastMoveAt: Date.now() });
    p.ammo = { rifle: { mag: WEAPONS.rifle.mag, res: WEAPONS.rifle.reserve }, pistol: { mag: WEAPONS.pistol.mag, res: WEAPONS.pistol.reserve } };
    p.weapon = 'rifle'; p.reloadUntil = 0; p.nextShot = 0;
    p.respawnAt = 0;
    this.sendTo(p, { t: 'spawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    this.sendYou(p);
  }

  sendYou(p) {
    if (!p.ws) return;
    const a = p.ammo?.[p.weapon];
    this.sendTo(p, { t: 'you', hp: p.hp ?? 0, alive: !!p.alive, team: p.team, w: p.weapon, mag: a?.mag ?? 0, res: a?.res ?? 0,
      reloading: p.reloadUntil > Date.now() });
  }

  // ---------------- round flow
  setState(state, seconds, extra = {}) {
    this.state = state;
    this.stateEnds = Date.now() + seconds * 1000;
    this.broadcast({ t: 'round', state, round: this.round, score: this.score, ends: this.stateEnds, ...extra });
  }

  maybeStartMatch() {
    if (this.state !== 'warmup') return;
    if (this.teamOf('A').length && this.teamOf('B').length && this.humans().some((p) => p.team)) {
      this.score = { A: 0, B: 0 }; this.round = 0;
      for (const p of this.active()) { p.kills = 0; p.deaths = 0; }
      this.startRound();
    }
  }

  startRound() {
    this.starting = true;
    this.fillSlots(false);
    this.starting = false;
    if (!this.teamOf('A').length || !this.teamOf('B').length) { this.toWarmup(); return; }
    this.round++;
    for (const p of this.active()) this.spawn(p);
    this.setState('freeze', TIMES.freeze);
    this.rosterDirty = true;
  }

  toWarmup() {
    this.setState('warmup', 0);
    for (const p of this.active()) if (!p.alive) this.spawn(p);
  }

  checkRoundEnd() {
    if (this.state === 'warmup') { if (!this.teamOf('A').length || !this.teamOf('B').length) return; this.maybeStartMatch(); return; }
    if (this.state !== 'live' && this.state !== 'freeze') return;
    const aliveA = this.teamOf('A').filter((p) => p.alive).length;
    const aliveB = this.teamOf('B').filter((p) => p.alive).length;
    if (!this.teamOf('A').length || !this.teamOf('B').length) { this.toWarmup(); return; }
    if (aliveA && aliveB) return;
    this.endRound(aliveA ? 'A' : aliveB ? 'B' : null, 'elimination');
  }

  endRound(winner, reason) {
    if (winner) this.score[winner]++;
    const over = this.score.A >= ROUNDS_TO_WIN || this.score.B >= ROUNDS_TO_WIN;
    if (over) this.setState('matchover', TIMES.matchOver, { winner, reason, matchWinner: winner });
    else this.setState('post', TIMES.post, { winner, reason });
  }

  // winners stay on: losing team rotates to the back of the queue when people are waiting
  rotateAfterMatch(winner) {
    const waiting = this.queue.filter((id) => !this.clients.get(id)?.bot).length;
    if (!waiting) return;
    const losers = this.teamOf(winner === 'A' ? 'B' : 'A').filter((p) => !p.bot).slice(0, waiting);
    for (const p of losers) {
      p.team = null; p.alive = false; this.queue.push(p.id);
      this.sendTo(p, { t: 'team', team: null, note: 'Rotated out so people in the queue can play. You are back in line.' });
    }
  }

  // ---------------- combat
  positionAt(p, t) {
    const h = p.history;
    if (!h || !h.length) return p;
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (a.t <= t && t <= b.t) {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return h[0];
  }

  recordHistory(p, now) {
    p.history.push({ t: now, x: p.x, y: p.y, z: p.z });
    while (p.history.length > 2 && p.history[0].t < now - 1000) p.history.shift();
  }

  fire(p, w, yaw, pitch) {
    const now = Date.now();
    if (!p.alive || !p.team || (this.state !== 'live' && this.state !== 'warmup')) return;
    const W = WEAPONS[w]; if (!W || p.weapon !== w) return;
    const a = p.ammo[w];
    if (now < p.reloadUntil || a.mag <= 0) return;
    if (now < p.nextShot - 15) return;                    // small tolerance for jitter
    p.nextShot = Math.max(now, p.nextShot) + 60000 / W.rpm;
    a.mag--;
    p.lastActive = now;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    pitch = Math.max(-1.55, Math.min(1.55, pitch));

    const o = eyePos(p), d = aimDir(yaw, pitch);
    const wallT = rayWorld(o, d, MAP.boxes, W.range);
    const rewind = now - Math.min(300, (p.rtt || 80) / 2 + INTERP_MS);
    let best = { t: wallT, target: null, head: false };
    for (const q of this.active()) {
      if (q === p || !q.alive) continue;
      const pos = p.bot ? q : this.positionAt(q, rewind);
      const hb = hitboxes(pos.x, pos.y, pos.z);
      const th = rayBox(o, d, hb.head, best.t), tb = rayBox(o, d, hb.body, best.t);
      if (th < best.t) best = { t: th, target: q, head: true };
      if (tb < best.t) best = { t: tb, target: q, head: false };
    }
    const end = [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t].map((v) => Math.round(v * 100) / 100);
    this.broadcast({ t: 'shot', id: p.id, w, end }, p);
    this.sendYou(p);
    const q = best.target;
    if (!q || q.team === p.team) return;                  // no friendly fire
    const falloff = Math.max(0.75, 1 - best.t / 200);
    const dmg = Math.round(W.dmg * (best.head ? W.head : 1) * falloff);
    q.hp -= dmg;
    this.sendTo(p, { t: 'hit', dmg, head: best.head, kill: q.hp <= 0 });
    this.sendTo(q, { t: 'hurt', dmg, from: [p.x, p.z], hp: Math.max(0, q.hp) });
    if (q.bot) q.aggro = p.id;
    if (q.hp <= 0) this.kill(p, q, w, best.head);
    else this.sendYou(q);
  }

  kill(killer, victim, w, head) {
    victim.alive = false; victim.hp = 0;
    victim.deaths = (victim.deaths || 0) + 1;
    killer.kills = (killer.kills || 0) + 1;
    if (this.state === 'warmup') victim.respawnAt = Date.now() + TIMES.warmupRespawn * 1000;
    this.broadcast({ t: 'kill', k: killer.id, v: victim.id, w, head });
    this.sendYou(victim);
    this.rosterDirty = true;
    this.checkRoundEnd();
  }

  // ---------------- tick
  tick(dt) {
    const now = Date.now();
    // state timers
    if (this.state !== 'warmup' && now >= this.stateEnds) {
      if (this.state === 'freeze') this.setState('live', TIMES.round);
      else if (this.state === 'live') {
        const aA = this.teamOf('A').filter((p) => p.alive), aB = this.teamOf('B').filter((p) => p.alive);
        const hp = (l) => l.reduce((s, p) => s + p.hp, 0);
        const w = aA.length !== aB.length ? (aA.length > aB.length ? 'A' : 'B') : hp(aA) !== hp(aB) ? (hp(aA) > hp(aB) ? 'A' : 'B') : null;
        this.endRound(w, 'time');
      } else if (this.state === 'post') this.startRound();
      else if (this.state === 'matchover') {
        const winner = this.score.A > this.score.B ? 'A' : 'B';
        this.rotateAfterMatch(winner);
        this.score = { A: 0, B: 0 }; this.round = 0;
        for (const p of this.active()) { p.kills = 0; p.deaths = 0; }
        this.startRound();
      }
    }
    // warmup respawns
    if (this.state === 'warmup') for (const p of this.active()) if (!p.alive && p.respawnAt && now >= p.respawnAt) this.spawn(p);
    // reload completion
    for (const p of this.active()) {
      if (p.reloadUntil && now >= p.reloadUntil) {
        const a = p.ammo[p.weapon], W = WEAPONS[p.weapon];
        const take = Math.min(W.mag - a.mag, a.res); a.mag += take; a.res -= take; p.reloadUntil = 0;
        this.sendYou(p);
      }
    }
    // AFK: only enforced when someone is waiting for the slot
    if (this.queue.length) {
      for (const p of this.active()) {
        if (!p.bot && now - (p.lastActive || now) > AFK_SECONDS * 1000) {
          p.team = null; p.alive = false; this.queue.push(p.id);
          this.broadcast({ t: 'left', id: p.id });
          this.sendTo(p, { t: 'team', team: null, note: 'You were idle, so your slot went to the next player in line.' });
          this.fillSlots(this.state === 'warmup');
          this.checkRoundEnd();
        }
      }
    }
    // bots
    for (const p of this.active()) if (p.bot && p.alive) botThink(this, p, dt, now);

    // snapshot
    const ps = this.active().map((p) => [p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch), p.alive ? 1 : 0, p.team, p.weapon === 'pistol' ? 1 : 0]);
    this.broadcast({ t: 'snap', now, ps });
    if (this.rosterDirty || now - this.lastRoster > 2000) this.sendRoster(now);
  }

  sendRoster(now) {
    this.rosterDirty = false; this.lastRoster = now;
    const list = [...this.clients.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, k: p.kills || 0, d: p.deaths || 0,
      ping: p.bot ? 0 : Math.round(p.rtt || 0), bot: !!p.bot, alive: !!p.alive }));
    this.broadcast({ t: 'roster', list, queue: this.queue.length, state: this.state, score: this.score, round: this.round, ends: this.stateEnds });
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) { r = new Room(id); rooms.set(id, r); }
  return r;
}

// ---------------------------------------------------------------- bots
function makeBot(room) {
  const used = new Set([...room.clients.values()].map((p) => p.name));
  const name = 'BOT ' + (BOT_NAMES.find((n) => !used.has('BOT ' + n)) || 'Unit' + nextId);
  return { id: nextId++, name, bot: true, kills: 0, deaths: 0, alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    history: [], wp: null, stuckT: 0, seenAt: 0, reaction: 0.35 + Math.random() * 0.3, aimErr: 0.035 + Math.random() * 0.03 };
}

function botThink(room, b, dt, now) {
  const frozen = room.state === 'freeze' || room.state === 'post' || room.state === 'matchover';
  const eye = eyePos(b);
  let target = null, bestD = 1e9;
  for (const q of room.active()) {
    if (!q.alive || q.team === b.team) continue;
    const d = Math.hypot(q.x - b.x, q.z - b.z);
    if (d < bestD && d < 45 && lineOfSight(eye, [q.x, q.y + 1.2, q.z], MAP.boxes)) { bestD = d; target = q; }
  }
  const inp = { f: 0, s: 0, jump: false, walk: false, yaw: b.yaw };
  if (target) {
    if (!b.target || b.target !== target.id) { b.target = target.id; b.seenAt = now; }
    const dx = target.x - b.x, dz = target.z - b.z, dy = target.y + 1.25 - eye[1];
    const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    b.yaw = turn(b.yaw, wantYaw, 7 * dt); b.pitch += (wantPitch - b.pitch) * Math.min(1, 7 * dt);
    inp.yaw = b.yaw;
    inp.s = Math.sin(now / 700 + b.id) > 0 ? 0.7 : -0.7;
    inp.f = bestD > 14 ? 0.6 : 0;
    const aligned = Math.abs(angleDiff(b.yaw, wantYaw)) < 0.12;
    if (!frozen && aligned && (now - b.seenAt) / 1000 > b.reaction) {
      const a = b.ammo[b.weapon];
      if (a.mag <= 0 && !b.reloadUntil) b.reloadUntil = now + WEAPONS[b.weapon].reload * 1000;
      else if (now >= b.nextShot && Math.random() < 0.8) {
        const err = b.aimErr * (1 + bestD / 25);
        room.fire(b, b.weapon, b.yaw + (Math.random() - 0.5) * err, b.pitch + (Math.random() - 0.5) * err);
      }
    }
  } else {
    b.target = null;
    if (b.aggro) { const q = room.clients.get(b.aggro); if (q && q.alive) b.wp = [q.x, q.z]; b.aggro = null; }
    if (!b.wp || Math.hypot(b.wp[0] - b.x, b.wp[1] - b.z) < 1.5) {
      const enemySide = b.team === 'A' ? 1 : -1;
      const opts = MAP.waypoints.filter((w) => Math.sign(w[0]) !== -enemySide || Math.random() < 0.3);
      b.wp = opts[Math.floor(Math.random() * opts.length)];
    }
    const dx = b.wp[0] - b.x, dz = b.wp[1] - b.z;
    b.yaw = turn(b.yaw, Math.atan2(-dx, -dz), 4 * dt); b.pitch *= 0.9;
    inp.yaw = b.yaw; inp.f = 1;
    const a = b.ammo[b.weapon];
    if (a.mag < WEAPONS[b.weapon].mag / 2 && a.res > 0 && !b.reloadUntil) b.reloadUntil = now + WEAPONS[b.weapon].reload * 1000;
  }
  const px = b.x, pz = b.z;
  moveBody(b, inp, dt, MAP.boxes, frozen);
  if (!frozen && inp.f > 0.5 && Math.hypot(b.x - px, b.z - pz) < 0.05) {
    b.stuckT += dt;
    if (b.stuckT > 0.4) moveBody(b, { ...inp, jump: true }, 0, MAP.boxes);
    if (b.stuckT > 1.2) { b.wp = null; b.stuckT = 0; b.yaw += Math.PI / 2; }
  } else b.stuckT = 0;
  room.recordHistory(b, now);
}

const angleDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const turn = (a, b, k) => a + angleDiff(a, b) * Math.min(1, k);

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const worldId = (u.searchParams.get('world') || '').toLowerCase();
  if (!validId(worldId)) return ws.close(4000, 'bad world');
  const room = getRoom(worldId);
  if (room.humans().length >= MAX_ACTIVE + MAX_SPECTATORS) {
    ws.send(JSON.stringify({ t: 'full' }));
    return ws.close(4001, 'full');
  }
  const name = (u.searchParams.get('name') || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'player' + nextId;
  const p = { id: nextId++, name, ws, kills: 0, deaths: 0, rtt: 80, history: [], lastActive: Date.now(), x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  let msgs = 0;
  const limiter = setInterval(() => { msgs = 0; }, 1000);

  ws.send(JSON.stringify({ t: 'welcome', id: p.id, world: worldId, now: Date.now(), map: MAP.name }));
  room.join(p);
  room.sendRoster(Date.now());
  room.sendTo(p, { t: 'round', state: room.state, round: room.round, score: room.score, ends: room.stateEnds });

  ws.on('message', (raw) => {
    if (++msgs > 120) return;                       // flood guard
    let m; try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    switch (m.t) {
      case 'ping': room.sendTo(p, { t: 'pong', c: m.c, s: now }); if (typeof m.rtt === 'number') p.rtt = Math.min(1000, Math.max(0, m.rtt)); break;
      case 'st': {
        if (!p.alive || !p.team) return;
        const x = +m.x, y = +m.y, z = +m.z;
        if (![x, y, z, +m.yaw, +m.pitch].every(Number.isFinite)) return;
        const frozen = room.state === 'freeze';
        const dt = Math.max(0.016, (now - (p.lastMoveAt || now)) / 1000);
        const allowed = frozen ? 0.3 : PLAYER.speed * 1.5 * dt + 0.6;
        const moved = Math.hypot(x - p.x, z - p.z);
        if (moved > allowed || y < -0.5 || y > 12 || Math.abs(x) > MAP.bounds.x || Math.abs(z) > MAP.bounds.z) {
          room.sendTo(p, { t: 'pos', x: p.x, y: p.y, z: p.z });  // reject and correct
        } else {
          if (moved > 0.01 || Math.abs((+m.yaw) - p.yaw) > 0.01) p.lastActive = now;
          p.x = x; p.y = y; p.z = z;
        }
        p.yaw = +m.yaw; p.pitch = Math.max(-1.55, Math.min(1.55, +m.pitch));
        p.lastMoveAt = now;
        room.recordHistory(p, now);
        break;
      }
      case 'fire': room.fire(p, m.w, +m.yaw, +m.pitch); break;
      case 'reload': {
        if (!p.alive) return;
        const a = p.ammo[p.weapon], W = WEAPONS[p.weapon];
        if (a.mag < W.mag && a.res > 0 && !p.reloadUntil) { p.reloadUntil = now + W.reload * 1000; room.sendYou(p); room.broadcast({ t: 'reload', id: p.id }, p); }
        p.lastActive = now;
        break;
      }
      case 'switch': {
        if (!p.alive || !WEAPONS[m.w] || m.w === p.weapon) return;
        p.weapon = m.w; p.reloadUntil = 0; p.nextShot = Math.max(p.nextShot, now + 350); p.lastActive = now;
        room.sendYou(p);
        break;
      }
    }
  });

  ws.on('close', () => { clearInterval(limiter); room.leave(p); });
});

// ---------------------------------------------------------------- loop
let last = Date.now();
setInterval(() => {
  const now = Date.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const [id, r] of rooms) {
    if (!r.humans().length) {
      if (r.emptySince && now - r.emptySince > 5 * 60 * 1000) rooms.delete(id);
      continue;
    }
    r.tick(dt);
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => console.log(`Postfire on ${BASE_URL}  (port ${PORT})`));
