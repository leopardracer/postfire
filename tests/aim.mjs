// One "human" with perfect aim vs bots: verifies server-side hit registration incl. lag compensation path.
import WebSocket from 'ws';
import { MAP, moveBody, lineOfSight } from '../shared/game.js';
const ws = new WebSocket('ws://localhost:8080/ws?world=aim' + Date.now() % 1e5 + '&name=aimer');
const me = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ground: true }; let id = 0, team = null, alive = false, ps = [], state = '', yaw = 0;
let hits = 0, heads = 0, kills = 0, shots = 0;
ws.on('message', (r) => { const m = JSON.parse(r);
  if (m.t === 'welcome') id = m.id; if (m.t === 'spawn') { Object.assign(me, { x: m.x, y: m.y, z: m.z }); alive = true; yaw = m.yaw; }
  if (m.t === 'you') { alive = m.alive; team = m.team; } if (m.t === 'snap') ps = m.ps; if (m.t === 'round') state = m.state;
  if (m.t === 'hit') { hits++; if (m.head) heads++; if (m.kill) kills++; } });
setInterval(() => {
  if (!alive || ws.readyState !== 1) return;
  const eye = [me.x, me.y + 1.62, me.z];
  const t = ps.find((p) => p[7] !== team && p[6] && lineOfSight(eye, [p[1], p[2] + 1.1, p[3]], MAP.boxes));
  let f = 1;
  if (t) { const dx = t[1] - me.x, dz = t[3] - me.z; yaw = Math.atan2(-dx, -dz); f = 0;
    const pitch = Math.atan2(t[2] + 1.1 - eye[1], Math.hypot(dx, dz)); shots++; ws.send(JSON.stringify({ t: 'fire', w: 'rifle', yaw, pitch })); }
  moveBody(me, { f, yaw }, 0.05, MAP.boxes, state === 'freeze');
  ws.send(JSON.stringify({ t: 'st', x: me.x, y: me.y, z: me.z, yaw, pitch: 0 }));
}, 50);
setInterval(() => ws.send(JSON.stringify({ t: 'reload' })), 2500);
setTimeout(() => { console.log({ shots, hits, heads, kills }); console.log(hits > 0 ? 'PASS: hits register' : 'FAIL'); process.exit(hits > 0 ? 0 : 1); }, 40000);
