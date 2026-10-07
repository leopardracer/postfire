// Connects N fake human clients to one world and checks slots, queue, rounds and hits.
// usage: node tests/load.mjs [players=12] [seconds=25] [url=ws://localhost:8080]
import WebSocket from 'ws';
import { MAP, moveBody, aimDir } from '../shared/game.js';

const N = +process.argv[2] || 12, SECS = +process.argv[3] || 25, URL = process.argv[4] || 'ws://localhost:8080';
const world = 'load' + Math.floor(Math.random() * 1e5);
const stats = { kills: 0, hits: 0, rounds: new Set(), states: new Set(), maxActive: 0, queued: 0, corrections: 0 };
const clients = [];

for (let i = 0; i < N; i++) {
  const c = { i, id: 0, team: null, alive: false, body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ground: true }, yaw: 0, others: [], state: '' };
  const ws = new WebSocket(`${URL}/ws?world=${world}&name=tester${i}`);
  c.ws = ws;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') c.id = m.id;
    if (m.t === 'spawn') { Object.assign(c.body, { x: m.x, y: m.y, z: m.z, vx: 0, vy: 0, vz: 0 }); c.yaw = m.yaw; c.alive = true; }
    if (m.t === 'you') { c.alive = m.alive; c.team = m.team; }
    if (m.t === 'pos') { stats.corrections++; Object.assign(c.body, { x: m.x, y: m.y, z: m.z }); }
    if (m.t === 'round') { stats.states.add(m.state); if (m.round) stats.rounds.add(m.round); c.state = m.state; }
    if (m.t === 'hit') stats.hits++;
    if (m.t === 'kill' && i === 0) stats.kills++;
    if (m.t === 'snap') {
      c.others = m.ps;
      if (i === 0) stats.maxActive = Math.max(stats.maxActive, m.ps.length);
    }
    if (m.t === 'roster' && i === 0) stats.queued = m.queue;
  });
  clients.push(c);
}

const timer = setInterval(() => {
  for (const c of clients) {
    if (!c.alive || c.ws.readyState !== 1) continue;
    const enemy = c.others.find((p) => p[7] && p[7] !== c.team && p[6]);
    let f = 1;
    if (enemy) {
      const dx = enemy[1] - c.body.x, dz = enemy[3] - c.body.z;
      c.yaw = Math.atan2(-dx, -dz);
      f = Math.hypot(dx, dz) > 10 ? 1 : 0;
      const pitch = Math.atan2(enemy[2] + 1.2 - (c.body.y + 1.62), Math.hypot(dx, dz));
      c.ws.send(JSON.stringify({ t: 'fire', w: 'rifle', yaw: c.yaw + (Math.random() - .5) * .04, pitch }));
    }
    moveBody(c.body, { f, s: 0, yaw: c.yaw }, 0.05, MAP.boxes, c.state === 'freeze');
    c.ws.send(JSON.stringify({ t: 'st', x: c.body.x, y: c.body.y, z: c.body.z, yaw: c.yaw, pitch: 0 }));
    if (Math.random() < 0.02) c.ws.send(JSON.stringify({ t: 'reload' }));
  }
}, 50);

setTimeout(async () => {
  clearInterval(timer);
  const summary = await (await fetch(URL.replace('ws', 'http') + '/api/world/' + world)).json();
  console.log(JSON.stringify({ world, ...stats, rounds: [...stats.rounds], states: [...stats.states], summary }, null, 1));
  // checks
  const ok = summary.active + summary.bots <= 10 && summary.queue === Math.max(0, N - 10) && stats.maxActive <= 10;
  console.log(ok ? 'PASS: slot cap + queue' : 'FAIL: slot cap / queue');
  for (const c of clients) c.ws.close();
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}, SECS * 1000);
