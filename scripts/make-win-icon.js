'use strict';
/**
 * Generate the Windows build assets from website/favicon.svg (the single
 * source of truth for the logo):
 *   build/icon.ico             multi-size app icon (exe, shortcuts, taskbar,
 *                              installer, uninstaller, Add/Remove Programs)
 *   build/installerSidebar.bmp 164x314 welcome/finish-page sidebar for the
 *                              NSIS installer
 *
 * Each icon size is rasterized from the vector at its native pixel size (not
 * downscaled from one big bitmap) so the small taskbar/title-bar sizes stay
 * crisp. Run with:  npm run icons:win
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svgSrc = fs.readFileSync(path.join(root, 'website', 'favicon.svg'), 'utf8');
const outDir = path.join(root, 'build');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SIDEBAR = { w: 164, h: 314 };

// Runs in a hidden renderer: draws the SVG onto canvases and hands back PNG
// data URLs plus raw straight-alpha RGBA (base64) for each size.
const RENDER_JS = `(async () => {
  const svgSrc = ${JSON.stringify(svgSrc)};
  const sizes = ${JSON.stringify(ICO_SIZES)};
  const sb = ${JSON.stringify(SIDEBAR)};

  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const loadSvg = (src, px) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    const sized = src.replace('<svg ', '<svg width="' + px + '" height="' + px + '" ');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
  });
  // Thicken the prompt glyph a touch at tiny sizes so it stays legible.
  const strokeFor = (px) => (px <= 24 ? 3.2 : px <= 48 ? 2.8 : 2.4);

  const icons = [];
  for (const px of sizes) {
    const src = svgSrc.replace('stroke-width="2.4"', 'stroke-width="' + strokeFor(px) + '"');
    const img = await loadSvg(src, px);
    const c = document.createElement('canvas');
    c.width = px; c.height = px;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, px, px);
    icons.push({ size: px, png: c.toDataURL('image/png'), rgba: toB64(ctx.getImageData(0, 0, px, px).data) });
  }

  // Installer sidebar: app background, logo, product name.
  const c = document.createElement('canvas');
  c.width = sb.w; c.height = sb.h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, sb.w, sb.h);
  const glow = ctx.createRadialGradient(sb.w / 2, 110, 10, sb.w / 2, 110, 150);
  glow.addColorStop(0, 'rgba(88,166,255,0.22)');
  glow.addColorStop(1, 'rgba(88,166,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, sb.w, sb.h);
  const logo = await loadSvg(svgSrc, 512);
  const lw = 92;
  ctx.drawImage(logo, (sb.w - lw) / 2, 64, lw, lw);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e6edf3';
  ctx.font = '600 22px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('YuviXterm', sb.w / 2, 192);
  ctx.fillStyle = '#8b949e';
  ctx.font = '13px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('SSH client', sb.w / 2, 214);
  ctx.fillStyle = '#21262d';
  ctx.fillRect(sb.w / 2 - 18, 236, 36, 2);
  const sidebar = toB64(ctx.getImageData(0, 0, sb.w, sb.h).data);

  return { icons, sidebar };
})()`;

// ---- ICO writer: PNG entry for 256px, classic 32-bit BGRA DIB entries below.
function dibEntry(size, rgba) {
  const xorSize = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const maskSize = maskStride * size;
  const buf = Buffer.alloc(40 + xorSize + maskSize);
  buf.writeUInt32LE(40, 0);            // biSize
  buf.writeInt32LE(size, 4);           // biWidth
  buf.writeInt32LE(size * 2, 8);       // biHeight (XOR + AND)
  buf.writeUInt16LE(1, 12);            // biPlanes
  buf.writeUInt16LE(32, 14);           // biBitCount
  buf.writeUInt32LE(0, 16);            // BI_RGB
  buf.writeUInt32LE(xorSize + maskSize, 20);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    const dstRow = 40 + y * size * 4;
    const maskRow = 40 + xorSize + y * maskStride;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4, d = dstRow + x * 4;
      buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s]; buf[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) buf[maskRow + (x >> 3)] |= 0x80 >> (x & 7); // transparent
    }
  }
  return buf;
}

function writeIco(file, icons) {
  const images = icons.map(({ size, png, rgba }) => ({
    size,
    data: size >= 256 ? Buffer.from(png.split(',')[1], 'base64') : dibEntry(size, Buffer.from(rgba, 'base64')),
  }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header[e + 2] = 0;
    header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...images.map((i) => i.data)]));
}

// ---- 24-bit bottom-up BMP (what NSIS/MUI2 expects for sidebar bitmaps).
function writeBmp(file, w, h, rgba) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(stride * h, 34);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = 54 + y * stride;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4, d = dst + x * 3;
      buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s];
    }
  }
  fs.writeFileSync(file, buf);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  try {
    await win.loadURL('about:blank');
    const { icons, sidebar } = await win.webContents.executeJavaScript(RENDER_JS);
    fs.mkdirSync(outDir, { recursive: true });
    writeIco(path.join(outDir, 'icon.ico'), icons);
    writeBmp(path.join(outDir, 'installerSidebar.bmp'), SIDEBAR.w, SIDEBAR.h, Buffer.from(sidebar, 'base64'));
    // Per-size previews for eyeballing (not used by the build).
    const previewDir = path.join(root, 'dist', 'icon-preview');
    fs.mkdirSync(previewDir, { recursive: true });
    for (const { size, png } of icons) fs.writeFileSync(path.join(previewDir, `${size}.png`), Buffer.from(png.split(',')[1], 'base64'));
    console.log('ICONS_OK sizes=' + icons.map((i) => i.size).join(',') + ' -> build/icon.ico, build/installerSidebar.bmp');
    process.exitCode = 0;
  } catch (e) {
    console.log('ICONS_ERR ' + (e && e.stack || e));
    process.exitCode = 1;
  }
  app.quit();
});
