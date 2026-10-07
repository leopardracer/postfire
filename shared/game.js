// Shared between server (Node) and client (browser). Pure ES module, no deps.

export const TEAM_SIZE = 5;            // 5v5
export const MAX_ACTIVE = TEAM_SIZE * 2;
export const ROUNDS_TO_WIN = 7;
export const TIMES = { freeze: 4, round: 115, post: 4, matchOver: 9, warmupRespawn: 2 };

export const PLAYER = { r: 0.38, h: 1.8, eye: 1.62, speed: 6.2, walk: 3.0, jump: 5.6, gravity: 18, step: 0.55 };

export const WEAPONS = {
  rifle:  { name: 'VX-7 Rifle',  dmg: 27, head: 4.0, rpm: 600, mag: 30, reserve: 90, reload: 2.3, auto: true,  spread: 0.006, moveSpread: 0.045, recoil: 0.012, range: 120 },
  pistol: { name: 'P-12 Sidearm', dmg: 31, head: 3.4, rpm: 340, mag: 12, reserve: 36, reload: 1.6, auto: false, spread: 0.008, moveSpread: 0.03,  recoil: 0.02,  range: 80 },
};

// ---------------------------------------------------------------- map
// Boxes: [x1, y1, z1, x2, y2, z2, material]. Ground is y = 0.
// The left half is written once and mirrored across x = 0 for a fair layout.
const half = [
  // lane walls (separate north / mid / south lanes)
  [-21, 0, 7.5, -5, 4, 8.5, 'wall'],
  [-21, 0, -8.5, -5, 4, -7.5, 'wall'],
  // spawn platform + stairs
  [-31, 0, -4, -25, 1.2, 4, 'plat'],
  [-25, 0, -2, -24, 0.8, 2, 'plat'],
  [-24, 0, -2, -23, 0.4, 2, 'plat'],
  // spawn side cover
  [-26, 0, 9, -24, 1.4, 11, 'crate'],
  [-26, 0, -11, -24, 1.4, -9, 'crate'],
  // mid lane
  [-15.5, 0, -1, -14.5, 5, 1, 'pillar'],
  [-11, 0, 2.5, -9, 1.2, 4.5, 'crate'],
  [-11, 0, -4.5, -9, 1.2, -2.5, 'crate'],
  [-19, 0, -4, -18, 1.1, 4, 'low'],
  // north lane
  [-14, 0, 13, -12, 1.6, 15, 'crate'],
  [-14, 1.6, 13.4, -12.4, 2.8, 14.6, 'crate'],
  [-6, 0, 16, -4, 1.2, 21, 'crate'],
  [-18, 0, 18, -16, 1.2, 20, 'crate'],
  // south lane
  [-9, 0, -15, -7, 1.6, -13, 'crate'],
  [-16, 0, -19, -13, 1.2, -16, 'crate'],
  [-4, 0, -12, -2.5, 2.2, -10.5, 'crate'],
  // props
  [-23.4, 0, 18.4, -22.6, 1.1, 19.2, 'barrel'],
  [-22.3, 0, 19.6, -21.5, 1.1, 20.4, 'barrel'],
  [-31, 0, -21, -30.2, 1.1, -20.2, 'barrel'],
  [-7, 0, -21, -6.2, 1.1, -20.2, 'barrel'],
  [-12, 0, 6.4, -11.2, 1.1, 7.2, 'barrel'],
  [-31.6, 0, 20.4, -30.8, 3, 21.2, 'palm'],
  [-19.4, 0, -21.6, -18.6, 3, -20.8, 'palm'],
];

const center = [
  [-1.4, 0, -1.4, 1.4, 1.5, 1.4, 'crate'],
  [-0.9, 1.5, -0.9, 0.9, 2.6, 0.9, 'crate'],
  [-0.5, 0, 15.5, 0.5, 4, 22, 'wall'],     // splits north lane end
  [-0.5, 0, -22, 0.5, 4, -15.5, 'wall'],  // splits south lane end
];

const outer = [
  [-33, 0, -23, 33, 7, -22, 'outer'],
  [-33, 0, 22, 33, 7, 23, 'outer'],
  [-33, 0, -23, -32, 7, 23, 'outer'],
  [32, 0, -23, 33, 7, 23, 'outer'],
];

function mirror(b) { return [-b[3], b[1], b[2], -b[0], b[4], b[5], b[6]]; }

export const MAP = {
  name: 'Saltyard',
  bounds: { x: 32, z: 22 },
  boxes: [...outer, ...center, ...half, ...half.map(mirror)],
  spawns: {
    A: [[-28, 1.2, 0], [-28, 1.2, 2.5], [-28, 1.2, -2.5], [-27, 0, 7], [-27, 0, -7], [-29, 0, 13], [-29, 0, -13]],
    B: [[28, 1.2, 0], [28, 1.2, 2.5], [28, 1.2, -2.5], [27, 0, 7], [27, 0, -7], [29, 0, 13], [29, 0, -13]],
  },
  spawnYaw: { A: -Math.PI / 2, B: Math.PI / 2 },
  // loose waypoints bots wander between
  waypoints: [
    [-20, 14], [-8, 12], [0, 11], [8, 12], [20, 14],
    [-20, 0], [-8, 0], [-4, 3], [4, -3], [8, 0], [20, 0],
    [-20, -14], [-8, -18], [0, -11], [8, -18], [20, -14],
    [-27, 0], [27, 0],
  ],
};

// ---------------------------------------------------------------- physics
function overlaps(p, b) {
  const r = PLAYER.r;
  return p.x + r > b[0] && p.x - r < b[3] &&
         p.y + PLAYER.h > b[1] && p.y < b[4] &&
         p.z + r > b[2] && p.z - r < b[5];
}

function freeAt(p, boxes) {
  for (const b of boxes) if (overlaps(p, b)) return false;
  return true;
}

// p: {x,y,z,vx,vy,vz,ground}. inp: {f, s, jump, walk, yaw}. Mutates p.
export function moveBody(p, inp, dt, boxes, frozen = false) {
  const speed = inp.walk ? PLAYER.walk : PLAYER.speed;
  let f = frozen ? 0 : (inp.f || 0), s = frozen ? 0 : (inp.s || 0);
  const len = Math.hypot(f, s);
  if (len > 1) { f /= len; s /= len; }
  const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);
  const tx = (-sy * f + cy * s) * speed;
  const tz = (-cy * f - sy * s) * speed;
  const k = p.ground ? 14 : 2.5;
  const a = Math.min(1, k * dt);
  p.vx += (tx - p.vx) * a;
  p.vz += (tz - p.vz) * a;
  if (inp.jump && p.ground && !frozen) { p.vy = PLAYER.jump; p.ground = false; }
  p.vy -= PLAYER.gravity * dt;

  // substep to avoid tunnelling on low framerates
  const steps = Math.max(1, Math.ceil(dt / 0.02));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    stepAxis(p, 'x', p.vx * h, boxes);
    stepAxis(p, 'z', p.vz * h, boxes);
    p.y += p.vy * h;
    p.ground = false;
    if (p.y <= 0) { p.y = 0; p.vy = 0; p.ground = true; }
    for (const b of boxes) {
      if (!overlaps(p, b)) continue;
      if (p.vy <= 0 && p.y - p.vy * h >= b[4] - 0.05) { p.y = b[4]; p.vy = 0; p.ground = true; }
      else if (p.vy > 0) { p.y = b[1] - PLAYER.h; p.vy = 0; }
      else { p.y = b[4]; p.vy = 0; p.ground = true; }
    }
  }
  return p;
}

function stepAxis(p, axis, d, boxes) {
  if (!d) return;
  p[axis] += d;
  const r = PLAYER.r;
  for (const b of boxes) {
    if (!overlaps(p, b)) continue;
    const rise = b[4] - p.y;
    if (rise > 0 && rise <= PLAYER.step && (p.ground || p.vy <= 0)) {
      const oy = p.y; p.y = b[4];
      if (freeAt(p, boxes)) { p.vy = Math.max(p.vy, 0); continue; }
      p.y = oy;
    }
    const lo = axis === 'x' ? b[0] : b[2], hi = axis === 'x' ? b[3] : b[5];
    p[axis] = d > 0 ? lo - r - 1e-4 : hi + r + 1e-4;
    if (axis === 'x') p.vx = 0; else p.vz = 0;
  }
}

// ---------------------------------------------------------------- rays
export function aimDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

// slab test, returns distance or Infinity
export function rayBox(o, d, b, max = 1e9) {
  let t0 = 0, t1 = max;
  for (let i = 0; i < 3; i++) {
    const lo = b[i], hi = b[i + 3];
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return Infinity; continue; }
    let a = (lo - o[i]) / d[i], c = (hi - o[i]) / d[i];
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

export function rayWorld(o, d, boxes, max = 200) {
  let best = max;
  for (const b of boxes) { const t = rayBox(o, d, b, best); if (t < best) best = t; }
  if (d[1] < 0) { const t = -o[1] / d[1]; if (t < best) best = t; }
  return best;
}

export function hitboxes(x, y, z) {
  return {
    head: [x - 0.21, y + 1.42, z - 0.21, x + 0.21, y + 1.86, z + 0.21],
    body: [x - 0.34, y, z - 0.34, x + 0.34, y + 1.42, z + 0.34],
  };
}

export function eyePos(p) { return [p.x, p.y + PLAYER.eye, p.z]; }

export function lineOfSight(a, b, boxes) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  d[0] /= len; d[1] /= len; d[2] /= len;
  return rayWorld(a, d, boxes, len) >= len - 0.01;
}
