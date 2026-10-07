// Downloads photo-scanned CC0 PBR textures + a sky HDRI from Poly Haven (polyhaven.com, public domain)
// into public/assets/tex/. The game uses them automatically when present, procedural textures otherwise.
//
//   npm run assets          # 1k textures (fast, good for mobile)
//   npm run assets -- --2k  # 2k textures (sharper on desktop)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = process.argv.includes('--2k') ? '2k' : '1k';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/assets/tex');
const UA = { 'User-Agent': 'postfire-asset-fetcher/1.0' };

// slot -> preferred Poly Haven ids, then keyword fallback (matched against id + tags + categories)
const SLOTS = {
  wall:    { ids: ['sandstone_blocks_08', 'sandstone_blocks_04', 'castle_brick_07', 'large_sandstone_blocks'], kw: ['sandstone', 'block'] },
  outer:   { ids: ['sandstone_brick_wall_01', 'castle_wall_slates', 'old_sandstone_02'], kw: ['sandstone', 'wall'] },
  floor:   { ids: ['sandstone_cracks', 'patterned_paving_02', 'floor_tiles_08', 'cobblestone_floor_08'], kw: ['paving'] },
  plaster: { ids: ['beige_wall_001', 'plastered_wall_04', 'painted_plaster_wall'], kw: ['plaster'] },
  crate:   { ids: ['wood_planks', 'old_planks_02', 'weathered_planks'], kw: ['planks'] },
  plat:    { ids: ['metal_plate', 'rusty_metal_02', 'metal_plate_02'], kw: ['metal', 'plate'] },
};
const HDRI = { ids: ['kloofendal_48d_partly_cloudy_puresky', 'qwantani_puresky', 'syferfontein_1d_clear_puresky', 'kloppenheim_06_puresky'], kw: ['skies'] };

const get = async (url) => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r; };
const json = async (url) => (await get(url)).json();

function pick(all, slot, used) {
  for (const id of slot.ids) if (all[id] && !used.has(id)) return id;
  const hits = Object.entries(all).filter(([id, a]) => !used.has(id) &&
    slot.kw.every((k) => (id + ' ' + (a.tags || []).join(' ') + ' ' + (a.categories || []).join(' ')).toLowerCase().includes(k)));
  hits.sort((a, b) => (b[1].download_count || 0) - (a[1].download_count || 0));
  return hits[0]?.[0];
}

async function save(url, file) {
  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  fs.writeFileSync(path.join(OUT, file), buf);
  return buf.length;
}

fs.mkdirSync(OUT, { recursive: true });
// --soft (used by `npm run build` on hosts): never fail the deploy if Poly Haven is unreachable
if (process.argv.includes('--soft')) {
  const soft = (e) => { console.warn('Asset download skipped:', e.message, '- using procedural textures'); process.exit(0); };
  process.on('unhandledRejection', soft); process.on('uncaughtException', soft);
  if (fs.existsSync(path.join(OUT, 'manifest.json'))) { console.log('Textures already present, skipping download'); process.exit(0); }
}
const manifest = { res: RES, credits: 'Textures and HDRI from Poly Haven (polyhaven.com), CC0', slots: {} };
const textures = await json('https://api.polyhaven.com/assets?t=textures');
const used = new Set();
for (const [slot, def] of Object.entries(SLOTS)) {
  const id = pick(textures, def, used);
  if (!id) { console.log(`- ${slot}: nothing found, keeping procedural`); continue; }
  used.add(id);
  const files = await json(`https://api.polyhaven.com/files/${id}`);
  const want = { diff: files.Diffuse, nor: files.nor_gl, rough: files.Rough, ao: files.AO };
  const entry = { id, name: textures[id].name, files: {}, size: (textures[id].dimensions?.[0] || 2000) / 1000 };
  for (const [k, v] of Object.entries(want)) {
    const url = v?.[RES]?.jpg?.url || v?.[RES]?.png?.url;
    if (!url) continue;
    const file = `${slot}_${k}${path.extname(url)}`;
    const n = await save(url, file);
    entry.files[k] = file;
    process.stdout.write(`  ${file} ${(n / 1024).toFixed(0)}KB\n`);
  }
  manifest.slots[slot] = entry;
  console.log(`✓ ${slot}: ${entry.name} (${id}), tile ${entry.size}m`);
}
const hdris = await json('https://api.polyhaven.com/assets?t=hdris');
const hid = pick(hdris, HDRI, new Set());
if (hid) {
  const f = await json(`https://api.polyhaven.com/files/${hid}`);
  const url = f.hdri?.[RES === '2k' ? '2k' : '1k']?.hdr?.url;
  if (url) { await save(url, 'sky.hdr'); manifest.hdri = { id: hid, name: hdris[hid].name, file: 'sky.hdr', puresky: hid.includes('puresky') }; console.log(`✓ sky: ${hdris[hid].name}`); }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nDone. Restart the server; the game now uses photo textures from ${path.relative(process.cwd(), OUT)}`);
