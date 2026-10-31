// build-icons.mjs — 由 assets/icon.svg 生成应用图标：assets/icon.png（512）和 assets/icon.ico（16～256 多尺寸）。
// 用法：npm run icons（在 Electron 离屏窗口里渲染 SVG，不需要另装图像库）。
// 只输出结论；失败时输出原文并以非 0 退出。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const PNG = path.join(ROOT, 'assets', 'icon.png');
const ICO = path.join(ROOT, 'assets', 'icon.ico');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();

async function renderPng(win, size) {
  const svg = fs.readFileSync(SVG, 'utf8');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// ICO 容器：6 字节头 + 每张 16 字节目录项 + PNG 数据（Vista 起支持内嵌 PNG）
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('about:blank');
    fs.writeFileSync(PNG, await renderPng(win, 512));
    const images = [];
    for (const size of ICO_SIZES) images.push({ size, data: await renderPng(win, size) });
    fs.writeFileSync(ICO, buildIco(images));
    console.log(`图标已生成：icon.png（512）、icon.ico（${ICO_SIZES.join('/')}）`);
    app.exit(0);
  } catch (e) {
    console.error('图标生成失败：', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
