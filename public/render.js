// Postfire rendering: PBR world, physical sky + image-based lighting, animated soldiers,
// weapon viewmodel, impact effects and (on "high") GTAO + bloom + SMAA post-processing.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MAP } from '/shared/game.js';

export const TEAM_COLORS = { A: 0x3fd0ff, B: 0xff8a3d };

export function createRenderer(canvas, { quality, touch }) {
  const high = quality === 'high';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !high && !touch, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 1.5 : touch ? 1.15 : 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;
  renderer.shadowMap.enabled = high || !touch;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(74, 1, 0.05, 900);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  // ---- physical sky + environment lighting from it
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 52), THREE.MathUtils.degToRad(205));
  const sky = new Sky();
  sky.scale.setScalar(800);
  const u = sky.material.uniforms;
  u.turbidity.value = 2.2; u.rayleigh.value = 0.9; u.mieCoefficient.value = 0.003; u.mieDirectionalG.value = 0.86;
  u.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); const skyEnv = sky.clone(); envScene.add(skyEnv);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc8b08c }));
  ground.position.y = -1; envScene.add(ground);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.32;
  scene.add(sky);
  scene.fog = new THREE.Fog(0xc9d8e6, 90, 520);

  const hemi = new THREE.HemisphereLight(0xe3e6ea, 0xd2a774, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 4.2);
  sun.position.copy(sunDir).multiplyScalar(60);
  sun.castShadow = renderer.shadowMap.enabled;
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 32, bottom: -32, near: 1, far: 160 });
  sun.shadow.mapSize.set(high ? 4096 : 1024, high ? 4096 : 1024);
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun);

  // ---- post-processing
  let composer = null, gtao = null;
  const aoHide = [];
  if (high) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 }));
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    gtao.blendIntensity = 0.95;
    const orig = gtao.render.bind(gtao);
    gtao.render = (...a) => { const hidden = aoHide.filter((o) => o.visible); for (const o of hidden) o.visible = false; orig(...a); for (const o of hidden) o.visible = true; };
    composer.addPass(gtao);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.14, 0.45, 1.4));
    composer.addPass(new OutputPass());
    composer.addPass(new SMAAPass(1, 1));
  }

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 88 : 74;
    camera.updateProjectionMatrix();
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
  }
  addEventListener('resize', resize); resize();

  return { renderer, scene, camera, sun, sky, pmrem, high, resize, aoHide, render: () => (composer ? composer.render() : renderer.render(scene, camera)) };
}

// ======================================================================= procedural PBR textures
// Tileable value-noise fBm -> height field -> albedo, normal and roughness maps.
function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const m = (a) => ((a % p) + p) % p;
  const a = hash(m(xi), m(yi), s), b = hash(m(xi + 1), m(yi), s), c = hash(m(xi), m(yi + 1), s), d = hash(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, base, oct, s) {
  let sum = 0, amp = 0.5, f = base;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f, y * f, f, s + i * 17); amp *= 0.5; f *= 2; }
  return sum;
}

function bake(size, fn, normalStrength = 2) {
  const n = size * size;
  const H = new Float32Array(n), C = new Float32Array(n * 3), R = new Float32Array(n), M = new Float32Array(n);
  const out = { h: 0, r: 0.5, g: 0.5, b: 0.5, rough: 0.8, metal: 0 };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    out.metal = 0;
    fn(x / size, y / size, out);
    H[i] = out.h; C[i * 3] = out.r; C[i * 3 + 1] = out.g; C[i * 3 + 2] = out.b; R[i] = out.rough; M[i] = out.metal;
  }
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); return [c, g, g.createImageData(size, size)]; };
  const [ca, ga, ia] = mk(), [cn, gn, inn] = mk(), [cr, gr, ir] = mk();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, o = i * 4;
    ia.data[o] = Math.min(255, C[i * 3] * 255); ia.data[o + 1] = Math.min(255, C[i * 3 + 1] * 255); ia.data[o + 2] = Math.min(255, C[i * 3 + 2] * 255); ia.data[o + 3] = 255;
    const l = H[y * size + ((x - 1 + size) % size)], r = H[y * size + ((x + 1) % size)];
    const t = H[((y - 1 + size) % size) * size + x], b = H[((y + 1) % size) * size + x];
    let nx = (l - r) * normalStrength * size / 64, ny = (b - t) * normalStrength * size / 64, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    inn.data[o] = (nx * 0.5 + 0.5) * 255; inn.data[o + 1] = (ny * 0.5 + 0.5) * 255; inn.data[o + 2] = (nz * 0.5 + 0.5) * 255; inn.data[o + 3] = 255;
    ir.data[o] = 255; ir.data[o + 1] = R[i] * 255; ir.data[o + 2] = M[i] * 255; ir.data[o + 3] = 255;   // G = roughness, B = metalness
  }
  ga.putImageData(ia, 0, 0); gn.putImageData(inn, 0, 0); gr.putImageData(ir, 0, 0);
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { map: tex(ca, true), normalMap: tex(cn), roughnessMap: tex(cr), metalnessMap: tex(cr) };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;

const RECIPES = {
  // sun-bleached sandstone flagstones in offset rows
  floor: (u, v, o) => {
    const rows = 8, row = Math.floor(v * rows), rv = (v * rows) % 1;
    const cols = 6 + (row % 3), off = hash(row, 7, 1);
    const cu = (u * cols + off) % 1, col = Math.floor(u * cols + off);
    const ed = Math.min(rv, 1 - rv, cu * rows / cols * 1.0, (1 - cu) * rows / cols * 1.0);
    const grout = ed < 0.035;
    const n = fbm(u, v, 12, 4, 2), dust = fbm(u, v, 3, 4, 3), tint = hash(col, row, 5);
    const bevel = clamp01(ed / 0.08);
    o.h = grout ? 0 : 0.5 * bevel + n * 0.12;
    const base = 0.7 + (tint - 0.5) * 0.08 + (n - 0.5) * 0.1 - clamp01((dust - 0.55) * 2) * 0.06;
    o.r = base; o.g = base * 0.9; o.b = base * 0.74;
    if (grout) { o.r *= 0.72; o.g *= 0.7; o.b *= 0.68; }
    o.rough = grout ? 0.98 : 0.88;
  },
  // limestone ashlar blocks (walls)
  wall: (u, v, o) => {
    const rows = 6, row = Math.floor(v * rows), rv = (v * rows) % 1;
    const cols = 3 + (row % 2), off = hash(row, 3, 11) * 0.7;
    const cu = ((u + off) * cols) % 1, col = Math.floor((u + off) * cols);
    const ed = Math.min(rv, 1 - rv, cu * 2 / cols * 0.5 * rows / 3, (1 - cu) * rows / cols * 0.5);
    const joint = ed < 0.018;
    const n = fbm(u, v, 10, 5, 12), pit = fbm(u, v, 40, 2, 14), tint = hash(col, row, 13);
    const erode = clamp01(ed / 0.12);
    o.h = joint ? 0 : 0.3 * Math.sqrt(erode) + n * 0.3 + pit * 0.08;
    const base = 0.74 + (tint - 0.5) * 0.1 + (n - 0.5) * 0.16;
    o.r = base; o.g = base * 0.85; o.b = base * 0.66;
    if (joint) { o.r *= 0.78; o.g *= 0.76; o.b *= 0.72; }
    o.rough = 0.9;
  },
  // bigger, more weathered blocks for the perimeter
  outer: (u, v, o) => {
    const rows = 4, row = Math.floor(v * rows), rv = (v * rows) % 1;
    const off = row % 2 ? 0.25 : 0;
    const cu = ((u + off) * 2) % 1, col = Math.floor((u + off) * 2);
    const ed = Math.min(rv, 1 - rv, cu * 0.5, (1 - cu) * 0.5);
    const joint = ed < 0.025;
    const n = fbm(u, v, 8, 5, 21), stain = fbm(u * 0.5, v * 2, 3, 4, 23), tint = hash(col, row, 22);
    o.h = joint ? 0 : 0.5 * Math.sqrt(clamp01(ed / 0.1)) + n * 0.2;
    const base = 0.76 + (tint - 0.5) * 0.1 + (n - 0.5) * 0.12 - clamp01((stain - 0.55) * 2) * 0.1;
    o.r = base; o.g = base * 0.85; o.b = base * 0.66;
    if (joint) { o.r *= 0.75; o.g *= 0.73; o.b *= 0.7; }
    o.rough = 0.92;
  },
  // wooden shipping crate face: frame + planks + grain
  crate: (u, v, o) => {
    const edge = Math.min(u, v, 1 - u, 1 - v);
    const frame = edge < 0.09;
    const plank = Math.floor(v * 5), pv = (v * 5) % 1;
    const gap = !frame && (pv < 0.03 || pv > 0.97);
    const grain = fbm(frame ? v * 0.15 : u * 0.15, frame ? u * 6 : v * 6 + plank * 3.1, 8, 4, 31 + plank);
    const ring = Math.sin(grain * 40) * 0.5 + 0.5;
    const tint = hash(plank, 1, 33) * 0.12;
    o.h = gap ? 0 : (frame ? 0.9 : 0.6) + ring * 0.05 + grain * 0.1;
    let r = 0.55 + ring * 0.08 - tint, g = 0.39 + ring * 0.05 - tint * 0.8, b = 0.23 + ring * 0.03 - tint * 0.6;
    if (frame) { r *= 0.82; g *= 0.8; b *= 0.78; }
    if (gap) { r *= 0.3; g *= 0.3; b *= 0.3; }
    const diag = !frame && Math.abs(u - v) < 0.045;
    if (diag) { o.h = 0.95; r *= 0.85; g *= 0.83; b *= 0.8; }
    o.r = r; o.g = g; o.b = b; o.rough = 0.78;
  },
  // diamond tread plate with rust patches
  plat: (u, v, o) => {
    const cu = (u * 16) % 1, cv = (v * 16) % 1, odd = Math.floor(u * 16 + v * 16) % 2;
    const a = odd ? (cu - 0.5) + (cv - 0.5) : (cu - 0.5) - (cv - 0.5);
    const b = odd ? (cu - 0.5) - (cv - 0.5) : (cu - 0.5) + (cv - 0.5);
    const lug = Math.abs(a) < 0.32 && Math.abs(b) < 0.08 ? 1 : 0;
    const rust = clamp01((fbm(u, v, 4, 5, 41) - 0.58) * 4);
    const n = fbm(u, v, 30, 2, 42);
    o.h = lug * 0.6 + n * 0.1;
    const steel = 0.5 + n * 0.08;
    o.r = mix(steel, 0.45, rust); o.g = mix(steel, 0.25, rust); o.b = mix(steel * 1.03, 0.14, rust);
    o.rough = mix(0.42 - lug * 0.12, 0.9, rust); o.metal = mix(0.9, 0.2, rust);
  },
  // worn yellow/black hazard paint on concrete
  low: (u, v, o) => {
    const stripe = ((u + v) * 4) % 1 < 0.5;
    const wear = fbm(u, v, 8, 5, 51), chip = wear > 0.66;
    o.h = chip ? 0.3 : 0.5 + fbm(u, v, 40, 2, 52) * 0.1;
    if (chip) { o.r = 0.45; o.g = 0.44; o.b = 0.42; o.rough = 0.9; }
    else if (stripe) { o.r = 0.86; o.g = 0.62; o.b = 0.08; o.rough = 0.6; }
    else { o.r = 0.07; o.g = 0.07; o.b = 0.075; o.rough = 0.55; }
  },
  // painted steel drum
  barrel: (u, v, o) => {
    const rib = Math.abs(((v * 3) % 1) - 0.5) < 0.04;
    const scratch = fbm(u * 0.3, v * 4, 12, 4, 61);
    const rust = clamp01((fbm(u, v, 3, 5, 62) - 0.6) * 4);
    o.h = rib ? 1 : 0.5 + scratch * 0.05;
    o.r = mix(0.12, 0.42, rust); o.g = mix(0.24, 0.22, rust); o.b = mix(0.36, 0.12, rust);
    o.rough = mix(0.45, 0.9, rust); o.metal = mix(0.6, 0.1, rust);
  },
};

async function loadManifest() {
  try { const r = await fetch('/assets/tex/manifest.json', { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Image-based lighting from a photographed sky (Poly Haven, CC0). If it is a "pure sky" HDRI it also
// becomes the background, and the sun light is aimed at the brightest pixel so shadows match the photo.
async function setupEnvironment(R, manifest) {
  const url = manifest?.hdri ? '/assets/tex/' + manifest.hdri.file : '/assets/env.hdr';
  const hdr = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(url);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  R.scene.environment = R.pmrem.fromEquirectangular(hdr).texture;
  R.scene.environmentIntensity = manifest?.hdri ? 0.7 : 0.45;
  if (manifest?.hdri?.puresky) {
    const { width: w, height: h, data } = hdr.image;
    // background copy with the sun disc clamped so it doesn't blow out bloom
    const bgData = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) bgData[i] = (i & 3) === 3 ? 1 : Math.min(data[i], 3);
    const bg = new THREE.DataTexture(bgData, w, h, THREE.RGBAFormat, THREE.FloatType);
    bg.mapping = THREE.EquirectangularReflectionMapping; bg.magFilter = bg.minFilter = THREE.LinearFilter; bg.needsUpdate = true;
    R.scene.background = bg; R.scene.remove(R.sky);
    let best = 0, bi = 0;
    for (let i = 0; i < w * h; i++) { const l = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722; if (l > best) { best = l; bi = i; } }
    const u = (bi % w) / w, v = Math.floor(bi / w) / h;
    const phi = v * Math.PI, theta = u * Math.PI * 2;
    const dir = new THREE.Vector3(-Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    if (dir.y > 0.15) R.sun.position.copy(dir).multiplyScalar(60);
  }
}

function photoMaterial(slot, entry, loader) {
  const t = (k, srgb) => {
    if (!entry.files[k]) return null;
    const tex = loader.load('/assets/tex/' + entry.files[k]);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 8;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  const m = new THREE.MeshStandardMaterial({ map: t('diff', true), normalMap: t('nor'), roughnessMap: t('rough'), aoMap: t('ao'), roughness: 1,
    metalness: slot === 'plat' ? 0.7 : 0 });
  m.userData.tile = entry.size || 2;
  m.userData.photo = true;
  return m;
}

export async function buildWorld(scene, quality, R) {
  const manifest = await loadManifest();
  if (R) await setupEnvironment(R, manifest).catch((e) => console.warn('HDRI failed', e));
  const size = quality === 'high' ? 512 : 256;
  const mats = {};
  const list = Object.keys(RECIPES);
  for (const k of list) {
    const t = bake(size, RECIPES[k], { plat: 3, crate: 2.5, floor: 1.3, wall: 1.5, outer: 1.7, low: 1, barrel: 1.5 }[k]);
    mats[k] = new THREE.MeshStandardMaterial({ ...t, roughness: 1, metalness: k === 'plat' || k === 'barrel' ? 1 : 0, normalScale: new THREE.Vector2(1, 1) });
    if (!(k === 'plat' || k === 'barrel')) mats[k].metalnessMap = null;
    await new Promise((r) => setTimeout(r));   // keep the page responsive while baking
  }
  const loader = new THREE.TextureLoader();
  for (const [slot, entry] of Object.entries(manifest?.slots || {})) mats[slot] = photoMaterial(slot, entry, loader);
  mats.pillar = mats.wall;
  const tileOf = (m, def) => mats[m]?.userData?.tile || def;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(66, 46), mats.floor.clone());
  const ft = tileOf('floor', 7);
  for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) { if (!mats.floor[key]) continue; floor.material[key] = mats.floor[key].clone(); floor.material[key].repeat.set(66 / ft, 46 / ft); floor.material[key].needsUpdate = true; }
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);

  // terrain beyond the walls
  const outside = new THREE.Mesh(new THREE.RingGeometry(40, 600, 48, 1), new THREE.MeshStandardMaterial({ color: 0xc4ab86, roughness: 1 }));
  outside.rotation.x = -Math.PI / 2; outside.position.y = -0.02; scene.add(outside);

  for (const b of MAP.boxes) {
    const [x1, y1, z1, x2, y2, z2, m] = b;
    const w = x2 - x1, h = y2 - y1, d = z2 - z1;
    let mesh;
    if (m === 'palm') { const p = makePalm(9 + Math.random() * 2.5); p.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2); scene.add(p); continue; }
    if (m === 'barrel') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 24, 1), mats.barrel);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 - 0.02, w / 2 - 0.02, 0.02, 24), mats.plat);
      lid.position.y = h / 2; mesh.add(lid);
    } else {
      const geo = m === 'crate' && !mats.crate.userData.photo ? new THREE.BoxGeometry(w, h, d) : boxGeo(w, h, d, m === 'crate' ? tileOf('crate', 2) : m === 'low' ? 1.2 : tileOf(m === 'pillar' ? 'wall' : m, m === 'plat' ? 2 : m === 'outer' ? 4 : 3));
      mesh = new THREE.Mesh(geo, mats[m] || mats.wall);
      if (m === 'wall' || m === 'pillar') addCap(mesh, w, h, d);
      if (m === 'outer') addCap(mesh, w, h, d, 0xcbb592);
    }
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    mesh.castShadow = m !== 'outer'; mesh.receiveShadow = true;
    scene.add(mesh);
    if (m === 'crate' && y1 === 0) scene.add(makePallet((x1 + x2) / 2, (z1 + z2) / 2, w, d));
    if (m === 'crate' && mats.crate.userData.photo) addCrateFrame(mesh, w, h, d);
  }
  addTown(scene, mats);

  // spawn floor markings
  for (const [t, x] of [['A', -28], ['B', 28]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.6, 48), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[t], transparent: true, opacity: 0.55, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, 1.215, 0); scene.add(ring);
  }

  return mats;
}

function addCap(mesh, w, h, d, color = 0xd9c6a4) {
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.12, d + 0.12), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  cap.position.y = h / 2 + 0.06; cap.castShadow = true; cap.receiveShadow = true; mesh.add(cap);
}

function facadeTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#c9c0b3'; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    g.fillStyle = Math.random() < 0.2 ? '#5d6b78' : '#34404c';
    g.fillRect(x * 32 + 7, y * 32 + 8, 18, 16);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---- desert-town dressing (visual only, outside the playable area or inside collision boxes)
function canvasTexture(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const frondTex = canvasTexture(256, (g, s) => {
  g.clearRect(0, 0, s, s);
  g.strokeStyle = '#4b5a23'; g.lineWidth = 6; g.beginPath(); g.moveTo(s / 2, s); g.lineTo(s / 2, 0); g.stroke();
  for (let i = 0; i < 46; i++) {
    const y = s - (i / 46) * s, len = Math.sin((i / 46) * Math.PI) * s * 0.48 + 6;
    const hue = 70 + Math.random() * 18, l = 24 + Math.random() * 12;
    g.strokeStyle = `hsl(${hue},45%,${l}%)`; g.lineWidth = 5;
    for (const sgn of [-1, 1]) { g.beginPath(); g.moveTo(s / 2, y); g.quadraticCurveTo(s / 2 + sgn * len * 0.5, y - 8, s / 2 + sgn * len, y + 14); g.stroke(); }
  }
});
const trunkTex = canvasTexture(128, (g, s) => {
  g.fillStyle = '#7a6448'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 10) { g.fillStyle = `rgba(40,28,16,${0.35 + Math.random() * 0.2})`; g.fillRect(0, y, s, 3); g.fillStyle = 'rgba(200,180,140,.15)'; g.fillRect(0, y + 4, s, 2); }
});
trunkTex.wrapS = trunkTex.wrapT = THREE.RepeatWrapping;
const trunkMat = new THREE.MeshStandardMaterial({ map: trunkTex, roughness: 0.95 });
const frondMat = new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 });

function makePalm(height) {
  const g = new THREE.Group();
  const lean = (Math.random() - 0.5) * 0.25, dir = Math.random() * Math.PI * 2, segs = 8;
  let top = new THREE.Vector3();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const p0 = new THREE.Vector3(Math.cos(dir) * lean * t0 * t0 * height, t0 * height, Math.sin(dir) * lean * t0 * t0 * height);
    const p1 = new THREE.Vector3(Math.cos(dir) * lean * t1 * t1 * height, t1 * height, Math.sin(dir) * lean * t1 * t1 * height);
    const r0 = 0.24 - t0 * 0.08, r1 = 0.24 - t1 * 0.08;
    const len = p0.distanceTo(p1);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 10), trunkMat);
    m.material.map.repeat.set(1, len); m.position.copy(p0).lerp(p1, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
    m.castShadow = true; g.add(m); top = p1;
  }
  const n = 11;
  for (let i = 0; i < n; i++) {
    const geo = new THREE.PlaneGeometry(1.1, 4.2, 1, 8);
    geo.translate(0, 2.1, 0); geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k++) { const z = -pos.getZ(k); pos.setY(k, pos.getY(k) - z * z * 0.12 + z * 0.35); }
    geo.computeVertexNormals();
    const f = new THREE.Mesh(geo, frondMat);
    f.position.copy(top); f.rotation.y = (i / n) * Math.PI * 2 + Math.random() * 0.3; f.rotation.z = (Math.random() - 0.5) * 0.3;
    f.castShadow = true; g.add(f);
  }
  return g;
}

function makePallet(x, z, w, d) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.1, 0.12), wood);
    b.position.set(0, 0.05, (i - 1) * (d / 2)); b.castShadow = b.receiveShadow = true; g.add(b);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.03, d + 0.12), wood);
  top.position.y = 0.115; top.receiveShadow = true; g.add(top);
  g.position.set(x, 0, z); return g;
}

function addTown(scene, mats) {
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const plaster = [0xe0cfb0, 0xd8c3a0, 0xe7d8bf, 0xcfa98a, 0xd9b8a0];
  const win = new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 0.9 });
  const shutter = [0x3f6f7a, 0x6b4a33, 0x7a3f33];
  const awn = [0xb5452f, 0x2f6fa0, 0xd8b04a, 0x5e8a4a];
  const place = (cx, cz, w, d, h, face) => {
    const src = mats.plaster || mats.wall;
    const mat = src.clone(); mat.color.set(plaster[Math.floor(rnd() * plaster.length)]);
    const b = new THREE.Mesh(boxGeo(w, h, d, src.userData.tile || 3), mat);
    b.position.set(cx, h / 2, cz); b.rotation.y = face; b.castShadow = b.receiveShadow = true; scene.add(b);
    // roof parapet
    const par = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.5, d + 0.2), mat); par.position.y = h / 2 + 0.25; b.add(par);
    // windows with shutters on the side facing the arena
    const rows = Math.max(1, Math.floor(h / 3.2)), cols = Math.max(1, Math.floor(w / 3));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (rnd() < 0.25) continue;
      const wx = -w / 2 + (c + 0.5) * (w / cols), wy = -h / 2 + 1.6 + r * 3.2;
      const wm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.1), win); wm.position.set(wx, wy, d / 2 + 0.01); b.add(wm);
      if (rnd() < 0.6) { const sm = new THREE.MeshStandardMaterial({ color: shutter[Math.floor(rnd() * 3)], roughness: 0.8 });
        for (const sx of [-0.7, 0.7]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.35, 0.06), sm); s.position.set(wx + sx, wy, d / 2 + 0.04); b.add(s); } }
    }
    if (rnd() < 0.4) { const a = new THREE.Mesh(new THREE.BoxGeometry(Math.min(4, w * 0.6), 0.05, 1.4), new THREE.MeshStandardMaterial({ color: awn[Math.floor(rnd() * 4)], roughness: 0.9, side: THREE.DoubleSide }));
      a.position.set(0, -h / 2 + 2.9, d / 2 + 0.65); a.rotation.x = 0.35; a.castShadow = true; b.add(a); }
    if (rnd() < 0.25) { const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.3, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: rnd() < 0.5 ? 0x3d7ea6 : 0xe9e1cf, roughness: 0.6 }));
      dome.position.y = h / 2 + 0.5; b.add(dome); }
  };
  // ring of houses hugging the perimeter, facing inward
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2;
    const ex = 42 + rnd() * 18, ez = 32 + rnd() * 14;
    const x = Math.cos(a) * ex, z = Math.sin(a) * ez;
    place(x, z, 7 + rnd() * 8, 6 + rnd() * 6, 8 + rnd() * 9, -a - Math.PI / 2);
  }
  // a minaret-like watchtower
  const tower = new THREE.Mesh(boxGeo(4, 22, 4, 3), mats.outer); tower.position.set(-12, 11, -40); tower.castShadow = true; scene.add(tower);
  const merl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), mats.outer, 260);
  const mtx = new THREE.Matrix4(); let n = 0;
  for (const [x, z] of [[-1.6, -1.6], [-1.6, 1.6], [1.6, -1.6], [1.6, 1.6], [0, -1.6], [0, 1.6], [-1.6, 0], [1.6, 0]]) { mtx.makeTranslation(-12 + x, 22.45, -40 + z); merl.setMatrixAt(n++, mtx); }
  // crenellations along the arena's outer walls
  for (let x = -32; x <= 32; x += 2.2) for (const z of [-22.5, 22.5]) { mtx.makeTranslation(x, 7.45, z); merl.setMatrixAt(n++, mtx); }
  for (let z = -20.5; z <= 20.5; z += 2.2) for (const x of [-32.5, 32.5]) { mtx.makeTranslation(x, 7.45, z); merl.setMatrixAt(n++, mtx); }
  merl.count = n; merl.castShadow = true; merl.receiveShadow = true; scene.add(merl);
  // palms around town
  for (const [x, z] of [[-38, -12], [-40, 14], [37, 8], [39, -16], [-6, 28], [14, 29], [-20, -29], [22, -28], [-46, 0], [47, 2]]) {
    const p = makePalm(10 + rnd() * 4); p.position.set(x, 0, z); scene.add(p);
  }
}

const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 0.85 });
function addCrateFrame(mesh, w, h, d) {
  const t = 0.09, o = 0.012;
  const bar = (sx, sy, sz, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frameMat); b.position.set(x, y, z); b.castShadow = true; mesh.add(b); };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(t, h, t, sx * (w / 2 - t / 2 + o), 0, sz * (d / 2 - t / 2 + o));
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) bar(w + o * 2, t, t, 0, sy * (h / 2 - t / 2), sz * (d / 2 - t / 2 + o));
    for (const sx of [-1, 1]) bar(t, t, d + o * 2, sx * (w / 2 - t / 2 + o), sy * (h / 2 - t / 2), 0);
  }
}

// world-scaled UVs so materials keep their real-world size on every box
export function boxGeo(w, h, d, tile = 2) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i;
    uv.setXY(k, uv.getX(k) * dims[f][0] / tile, uv.getY(k) * dims[f][1] / tile);
  }
  return geo;
}

// ======================================================================= soldiers
let soldier = null;
export async function loadSoldier() {
  const gltf = await new GLTFLoader().loadAsync('/assets/soldier.glb');
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const s = 1.82 / (box.max.y - box.min.y);
  soldier = { scene: gltf.scene, clips: gltf.animations, scale: s };
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
}

const gunMat = new THREE.MeshStandardMaterial({ color: 0x1f2125, roughness: 0.45, metalness: 0.8 });
export function makeSoldier(team) {
  const group = new THREE.Group();
  const body = SkeletonUtils.clone(soldier.scene);
  body.scale.setScalar(soldier.scale);
  body.rotation.y = Math.PI;                       // model faces +z, game forward is -z
  const tint = new THREE.Color(team === 'A' ? 0xa9e4ff : 0xffc29a);
  body.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      if (o.material.name === 'VanguardBodyMat') o.material.color.copy(tint);
      else o.material.color.set(TEAM_COLORS[team]);
      o.material.envMapIntensity = 0.8;
    }
  });
  group.add(body);
  // team armband (emissive so it reads at distance)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 6, 12, 1, true), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team], emissive: TEAM_COLORS[team], emissiveIntensity: 0.6, side: THREE.DoubleSide }));
  const arm = body.getObjectByName('mixamorig:LeftArm');
  if (arm) { band.position.y = 12; arm.add(band); }
  // rifle in the right hand
  const gun = new THREE.Group();
  const part = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gunMat); m.position.set(x, y, z); m.castShadow = true; gun.add(m); };
  part(4, 6, 48, 0, 0, 8); part(3, 12, 5, 0, -7, 2); part(3.5, 4, 14, 0, -1, -14);
  const hand = body.getObjectByName('mixamorig:RightHand');
  if (hand) { gun.rotation.set(Math.PI / 2, 0, 0); gun.position.set(-2, 8, 4); hand.add(gun); }

  const mixer = new THREE.AnimationMixer(body);
  const clip = (n) => mixer.clipAction(THREE.AnimationClip.findByName(soldier.clips, n));
  const actions = { Idle: clip('Idle'), Walk: clip('Walk'), Run: clip('Run') };
  for (const a of Object.values(actions)) { a.play(); a.setEffectiveWeight(0); }
  actions.Idle.setEffectiveWeight(1);
  const weights = { Idle: 1, Walk: 0, Run: 0 };
  return {
    group,
    update(speed, dt, alive) {
      const target = speed < 0.4 ? 'Idle' : speed < 3.6 ? 'Walk' : 'Run';
      for (const k in weights) {
        weights[k] += ((k === target ? 1 : 0) - weights[k]) * Math.min(1, dt * 8);
        actions[k].setEffectiveWeight(weights[k]);
      }
      actions.Walk.timeScale = Math.max(0.6, speed / 2.2);
      actions.Run.timeScale = Math.max(0.7, speed / 5.5);
      if (alive) mixer.update(dt);
      body.rotation.x = alive ? 0 : -Math.PI / 2;
      body.position.y = alive ? 0 : 0.18;
    },
  };
}

// ======================================================================= viewmodel
export function makeViewmodel(camera) {
  const view = new THREE.Group(); camera.add(view);
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.38, metalness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, metalness: 0.6 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x3b3a34, roughness: 0.85, metalness: 0 });
  const tan = new THREE.MeshStandardMaterial({ color: 0x8a7656, roughness: 0.8, metalness: 0 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x2b2a27, roughness: 0.95 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x5b5848, roughness: 0.95 });
  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m; };
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const C = (r, l, s = 16) => new THREE.CylinderGeometry(r, r, l, s).rotateX(Math.PI / 2);

  const rifle = new THREE.Group();
  add(rifle, B(0.056, 0.07, 0.3), metal, 0, 0, 0);                  // receiver
  add(rifle, B(0.06, 0.02, 0.5), dark, 0, 0.043, -0.08);             // top rail
  for (let i = 0; i < 18; i++) add(rifle, B(0.05, 0.007, 0.008), dark, 0, 0.055, -0.3 + i * 0.026);
  add(rifle, B(0.066, 0.066, 0.26), tan, 0, 0.002, -0.28);           // handguard
  add(rifle, C(0.012, 0.26), metal, 0, 0.004, -0.52);                // barrel
  add(rifle, C(0.019, 0.06), dark, 0, 0.004, -0.66);                 // muzzle brake
  add(rifle, B(0.04, 0.15, 0.07), polymer, 0, -0.1, -0.02, 0.18);    // magazine
  add(rifle, B(0.04, 0.06, 0.07), polymer, 0, -0.18, -0.005, 0.32);
  add(rifle, B(0.036, 0.1, 0.045), polymer, 0, -0.08, 0.12, -0.35); // grip
  add(rifle, B(0.03, 0.05, 0.2), tan, 0, -0.01, 0.25);               // stock
  add(rifle, B(0.045, 0.09, 0.03), polymer, 0, -0.02, 0.36);
  const dot = add(rifle, C(0.022, 0.07, 20), dark, 0, 0.09, -0.05);  // red dot housing
  add(rifle, B(0.03, 0.03, 0.04), dark, 0, 0.065, -0.05);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.004, 12), new THREE.MeshBasicMaterial({ color: 0xff2a2a, toneMapped: false }));
  lens.position.set(0, 0.09, -0.017); rifle.add(lens);
  add(rifle, B(0.055, 0.06, 0.09), glove, 0.005, -0.075, 0.12, -0.3);  // trigger hand
  add(rifle, B(0.075, 0.07, 0.3), sleeve, 0.03, -0.14, 0.3, 0.45);     // forearm
  add(rifle, B(0.06, 0.05, 0.1), glove, -0.012, -0.05, -0.3);          // support hand
  add(rifle, B(0.07, 0.065, 0.34), sleeve, -0.06, -0.15, -0.2, 0.75, 0.35);
  rifle.userData.tip = new THREE.Vector3(0, 0.004, -0.7);

  const pistol = new THREE.Group();
  add(pistol, B(0.034, 0.04, 0.2), metal, 0, 0.01, -0.04);            // slide
  for (let i = 0; i < 6; i++) add(pistol, B(0.036, 0.03, 0.004), dark, 0, 0.012, 0.03 + i * 0.008);
  add(pistol, B(0.032, 0.03, 0.17), polymer, 0, -0.02, -0.03);          // frame
  add(pistol, B(0.03, 0.1, 0.045), polymer, 0, -0.08, 0.035, -0.22);    // grip
  add(pistol, B(0.06, 0.07, 0.08), glove, 0, -0.08, 0.05, -0.22);
  add(pistol, B(0.09, 0.08, 0.36), sleeve, 0.03, -0.14, 0.27, 0.25);
  pistol.userData.tip = new THREE.Vector3(0, 0.012, -0.15);

  for (const g of [rifle, pistol]) { g.position.set(0.2, -0.2, -0.48); view.add(g); g.traverse((o) => { if (o.material) o.material.fog = false; }); }

  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({ map: flashTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false, color: 0xffc58a }));
  flash.visible = false; view.add(flash);
  const light = new THREE.PointLight(0xffa860, 0, 7, 2); view.add(light);
  let kick = 0, flashT = 0;
  const tipWorld = new THREE.Vector3();
  return {
    view,
    fire() { kick = 1; flashT = 0.045; },
    muzzle(out, weapon) { const g = weapon === 'pistol' ? pistol : rifle; g.updateWorldMatrix(true, false); return out.copy(g.userData.tip).applyMatrix4(g.matrixWorld); },
    update(dt, weapon, bob, speed, reloading, sway) {
      rifle.visible = weapon === 'rifle'; pistol.visible = weapon === 'pistol';
      const g = weapon === 'rifle' ? rifle : pistol;
      kick = Math.max(0, kick - dt * 11);
      const dip = reloading ? 0.16 : 0;
      const m = Math.min(1, speed / 5);
      g.position.set(0.2 + Math.cos(bob) * 0.01 * m + sway[0], -0.2 - Math.abs(Math.sin(bob)) * 0.012 * m - dip + sway[1], -0.48 + kick * 0.035);
      g.rotation.set(kick * 0.06 - dip * 1.4, sway[0] * 2, reloading ? 0.5 : 0);
      flashT -= dt;
      flash.visible = flashT > 0; light.intensity = flashT > 0 ? 6 : 0;
      if (flash.visible) {
        g.updateWorldMatrix(true, false);
        tipWorld.copy(g.userData.tip); g.localToWorld(tipWorld); view.worldToLocal(tipWorld);
        flash.position.copy(tipWorld); flash.rotation.z = Math.random() * 6; flash.scale.setScalar(0.8 + Math.random() * 0.5);
        light.position.copy(tipWorld);
      }
    },
  };
}

function flashTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.25, 'rgba(255,200,120,.9)'); r.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = r; g.beginPath();
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2, rr = i % 2 ? 9 : 32; g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr); }
  g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ======================================================================= effects
export function makeEffects(root) {
  const scene = new THREE.Group(); root.add(scene);
  const live = [];
  const soft = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,.9)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); return t; })();
  const holeTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const r = g.createRadialGradient(32, 32, 2, 32, 32, 30); r.addColorStop(0, 'rgba(10,8,6,1)'); r.addColorStop(0.25, 'rgba(25,20,16,.9)'); r.addColorStop(0.5, 'rgba(60,50,40,.45)'); r.addColorStop(1, 'rgba(60,50,40,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const holeMat = new THREE.MeshStandardMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1 });
  const holeGeo = new THREE.PlaneGeometry(0.11, 0.11);
  const holes = [];
  const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false });
  const tracerGeo = new THREE.CylinderGeometry(0.006, 0.006, 1, 4, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const v = new THREE.Vector3();

  function push(obj, life, upd) { scene.add(obj); live.push({ obj, life, max: life, upd }); }
  return {
    group: scene,
    tracer(from, to) {
      const m = new THREE.Mesh(tracerGeo, tracerMat.clone());
      m.position.copy(from); v.copy(to); m.lookAt(v);
      const len = from.distanceTo(to); m.scale.set(1, 1, len);
      push(m, 0.07, (e, k) => { e.obj.material.opacity = 0.85 * k; });
    },
    impact(point, normal, blood) {
      const count = blood ? 5 : 4;
      for (let i = 0; i < count; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color: blood ? 0x8a1010 : 0xb8ab98, transparent: true, depthWrite: false, opacity: 0.7 }));
        s.position.copy(point).addScaledVector(normal, 0.05);
        const vel = normal.clone().multiplyScalar(0.6 + Math.random() * 0.8).add(new THREE.Vector3((Math.random() - .5) * .8, Math.random() * .6, (Math.random() - .5) * .8));
        s.scale.setScalar(0.08);
        push(s, 0.5 + Math.random() * 0.3, (e, k, dt) => { e.obj.position.addScaledVector(vel, dt); vel.multiplyScalar(0.92); e.obj.scale.setScalar(0.08 + (1 - k) * (blood ? 0.25 : 0.45)); e.obj.material.opacity = 0.65 * k; });
      }
      const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color: 0xffd28a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      spark.position.copy(point).addScaledVector(normal, 0.03); spark.scale.setScalar(blood ? 0 : 0.18);
      push(spark, 0.06, (e, k) => { e.obj.material.opacity = k; });
      if (!blood) {
        const h = new THREE.Mesh(holeGeo, holeMat);
        h.position.copy(point).addScaledVector(normal, 0.004);
        h.lookAt(v.copy(h.position).add(normal)); h.rotation.z = Math.random() * 6;
        scene.add(h); holes.push(h);
        if (holes.length > 80) scene.remove(holes.shift());
      }
    },
    clearHoles() { for (const h of holes) scene.remove(h); holes.length = 0; },
    tick(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const e = live[i]; e.life -= dt;
        const k = Math.max(0, e.life / e.max);
        e.upd?.(e, k, dt);
        if (e.life <= 0) { scene.remove(e.obj); e.obj.material.dispose(); live.splice(i, 1); }
      }
    },
  };
}
