'use strict';

const fs       = require('node:fs');
const path     = require('node:path');
const sharp    = require('sharp');
const pngToIco = require('png-to-ico');

const root   = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const svg    = path.join(assets, 'icon.svg');

if (!fs.existsSync(assets)) fs.mkdirSync(assets, { recursive: true });
if (!fs.existsSync(svg)){
  console.error('Missing assets/icon.svg');
  process.exit(1);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  console.log('Rendering master PNG...');
  const master = await sharp(svg, { density: 512 })
    .resize(512, 512, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
    .png().toBuffer();

  fs.writeFileSync(path.join(assets, 'icon.png'), master);
  fs.writeFileSync(
    path.join(assets, 'tray.png'),
    await sharp(master).resize(32, 32).png().toBuffer()
  );

  console.log('Building ICO...');
  const pngs = await Promise.all(
    SIZES.map(s => sharp(master).resize(s, s).png().toBuffer())
  );
  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(assets, 'icon.ico'), ico);

  console.log('Icons written to assets/');
})().catch(err => { console.error(err); process.exit(1); });