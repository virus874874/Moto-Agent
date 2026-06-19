import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outDir = path.join(root, "output");
const scratchDir = path.join(root, "scratch", "editable_motor_deck");
const pkgDir = path.join(scratchDir, "pptx_pkg");
const previewDir = path.join(scratchDir, "previews");
const pptxPath = path.join(outDir, "Intelligent_Motorcycle_Telemetry_editable.pptx");
const sourcePptx = path.join(root, "Intelligent_Motorcycle_Telemetry_source.pptx");

fs.rmSync(scratchDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(pkgDir, { recursive: true });
fs.mkdirSync(previewDir, { recursive: true });

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const extractBase = [
  "$ErrorActionPreference='Stop'",
  `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
  `$src=${psQuote(sourcePptx)}`,
  `$dst=${psQuote(pkgDir)}`,
  `[System.IO.Compression.ZipFile]::ExtractToDirectory($src,$dst)`,
  `$media=Join-Path $dst 'ppt/media'`,
  `if(Test-Path $media){Remove-Item -LiteralPath $media -Recurse -Force}`
].join("; ");
const base = spawnSync("powershell.exe", ["-NoProfile", "-Command", extractBase], { encoding: "utf8" });
if (base.status !== 0) {
  console.error(base.stderr || base.stdout);
  process.exit(base.status ?? 1);
}

const W = 1920;
const H = 1080;
const EMU = 6350;
const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
};

const C = {
  ink: "17212A",
  ink2: "26323A",
  slate: "41515B",
  gray: "6B7780",
  mist: "F5F7F4",
  paper: "FBFCF8",
  cyan: "20D8D5",
  cyan2: "7BF2EE",
  red: "E82D48",
  amber: "F4B84A",
  green: "5BD889",
  white: "FFFFFF",
  line: "C8D0D2",
  darkBg: "101922",
};

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
const emu = (v) => Math.round(v * EMU);
const hex = (c) => c.replace("#", "").toUpperCase();
const pptPt = (pt) => Math.round(pt * 100);
const ensure = (p) => fs.mkdirSync(p, { recursive: true });
const write = (p, s) => { ensure(path.dirname(p)); fs.writeFileSync(p, s, "utf8"); };

function shape(id, type, x, y, w, h, opt = {}) {
  const fill = opt.fill === "none" ? "" : `<a:solidFill><a:srgbClr val="${hex(opt.fill ?? C.white)}"/></a:solidFill>`;
  const line = opt.line === "none"
    ? `<a:ln><a:noFill/></a:ln>`
    : `<a:ln w="${Math.round((opt.lw ?? 1.5) * 12700)}"><a:solidFill><a:srgbClr val="${hex(opt.line ?? C.line)}"/></a:solidFill></a:ln>`;
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${esc(opt.name ?? `${type}-${id}`)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm${opt.rot ? ` rot="${Math.round(opt.rot * 60000)}"` : ""}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="${type}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>
    ${opt.text ? txBody(opt.text, opt.textOpt ?? {}) : ""}
  </p:sp>`;
}

function line(id, x1, y1, x2, y2, opt = {}) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2);
  const w = Math.max(Math.abs(x2 - x1), 1), h = Math.max(Math.abs(y2 - y1), 1);
  const flipH = x2 < x1 ? ' flipH="1"' : "";
  const flipV = y2 < y1 ? ' flipV="1"' : "";
  return `<p:cxnSp>
    <p:nvCxnSpPr><p:cNvPr id="${id}" name="${esc(opt.name ?? `line-${id}`)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
    <p:spPr><a:xfrm${flipH}${flipV}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${Math.round((opt.lw ?? 2) * 12700)}"><a:solidFill><a:srgbClr val="${hex(opt.color ?? C.line)}"/></a:solidFill>${opt.dash ? "<a:prstDash val=\"dash\"/>" : ""}${opt.arrow ? "<a:tailEnd type=\"triangle\"/>" : ""}</a:ln></p:spPr>
  </p:cxnSp>`;
}

function textBox(id, text, x, y, w, h, opt = {}) {
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${esc(opt.name ?? `text-${id}`)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
    ${txBody(text, opt)}
  </p:sp>`;
}

function txBody(text, opt = {}) {
  const lines = Array.isArray(text) ? text : String(text).split("\n");
  const size = pptPt(opt.size ?? 24);
  const color = hex(opt.color ?? C.ink);
  const font = opt.font ?? "Microsoft JhengHei";
  const latin = opt.latin ?? "Aptos";
  const bold = opt.bold ? ' b="1"' : "";
  const alignMap = { center: "ctr", left: "l", right: "r", justify: "just" };
  const align = opt.align ? `<a:pPr algn="${alignMap[opt.align] ?? opt.align}"/>` : "";
  const paragraphs = lines.map((ln) => `<a:p>${align}<a:r><a:rPr lang="zh-TW" sz="${size}"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${latin}"/><a:ea typeface="${font}"/></a:rPr><a:t>${esc(ln)}</a:t></a:r></a:p>`).join("");
  const anchor = opt.valign ? ` anchor="${opt.valign}"` : "";
  return `<p:txBody><a:bodyPr wrap="square"${anchor} lIns="${emu(opt.padX ?? 4)}" rIns="${emu(opt.padX ?? 4)}" tIns="${emu(opt.padY ?? 3)}" bIns="${emu(opt.padY ?? 3)}"/><a:lstStyle/>${paragraphs}</p:txBody>`;
}

function bg(color) {
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

function slideXml(items, background = C.paper) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld>${bg(background)}<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${items.join("\n")}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function motorbike(id0, x, y, s = 1, color = C.cyan, muted = false) {
  const lw = muted ? 2 : 3;
  const col = muted ? C.gray : color;
  const r = 70 * s;
  let id = id0;
  const parts = [];
  parts.push(shape(id++, "ellipse", x, y + 95 * s, r, r, { fill: "none", line: col, lw }));
  parts.push(shape(id++, "ellipse", x + 250 * s, y + 95 * s, r, r, { fill: "none", line: col, lw }));
  parts.push(line(id++, x + 35*s, y + 130*s, x + 160*s, y + 55*s, { color: col, lw }));
  parts.push(line(id++, x + 160*s, y + 55*s, x + 285*s, y + 130*s, { color: col, lw }));
  parts.push(line(id++, x + 72*s, y + 130*s, x + 250*s, y + 130*s, { color: col, lw }));
  parts.push(line(id++, x + 145*s, y + 60*s, x + 210*s, y + 20*s, { color: col, lw }));
  parts.push(line(id++, x + 210*s, y + 20*s, x + 310*s, y + 16*s, { color: col, lw }));
  parts.push(line(id++, x + 286*s, y + 40*s, x + 320*s, y + 92*s, { color: col, lw }));
  parts.push(line(id++, x + 70*s, y + 90*s, x + 112*s, y + 42*s, { color: col, lw }));
  parts.push(shape(id++, "rect", x + 130*s, y + 88*s, 70*s, 42*s, { fill: muted ? "E7ECEB" : "15333A", line: col, lw }));
  if (!muted) parts.push(shape(id++, "ellipse", x + 172*s, y + 118*s, 36*s, 36*s, { fill: C.cyan, line: C.cyan2, lw: 1 }));
  return parts;
}

function chip(id0, x, y, w, h, label, sub, opt = {}) {
  let id = id0;
  const items = [
    shape(id++, "roundRect", x, y, w, h, { fill: opt.fill ?? C.white, line: opt.line ?? C.line, lw: 1.3 }),
    textBox(id++, label, x + 20, y + 18, w - 40, 32, { size: opt.titleSize ?? 20, bold: true, color: opt.titleColor ?? C.ink }),
  ];
  if (sub) items.push(textBox(id++, sub, x + 20, y + 58, w - 40, h - 68, { size: opt.subSize ?? 13, color: opt.subColor ?? C.slate }));
  return items;
}

function iconTimer(id, x, y) {
  return [shape(id, "ellipse", x, y + 12, 78, 78, { fill: "none", line: C.slate, lw: 2 }), line(id+1, x+39, y+51, x+39, y+28, { color: C.slate, lw: 2 }), line(id+2, x+39, y+51, x+61, y+43, { color: C.slate, lw: 2 }), shape(id+3, "rect", x+25, y, 28, 16, { fill: "none", line: C.slate, lw: 2 })];
}
function iconShield(id, x, y) {
  return [shape(id, "pentagon", x, y, 86, 92, { fill: "none", line: C.cyan, lw: 2 }), shape(id+1, "line", x+30, y+42, 34, 1, { fill: "none", line: C.cyan, lw: 3, rot: 45 })];
}

function radar(id0, cx, cy, r, labels, vals) {
  let id = id0;
  const items = [];
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 3;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  for (const rr of [1, .68, .36]) {
    const q = pts.map(([px, py]) => [cx + (px - cx) * rr, cy + (py - cy) * rr]);
    items.push(line(id++, q[0][0], q[0][1], q[1][0], q[1][1], { color: rr === 1 ? C.cyan : C.line, lw: rr === 1 ? 3 : 1.4 }));
    items.push(line(id++, q[1][0], q[1][1], q[2][0], q[2][1], { color: rr === 1 ? C.cyan : C.line, lw: rr === 1 ? 3 : 1.4 }));
    items.push(line(id++, q[2][0], q[2][1], q[0][0], q[0][1], { color: rr === 1 ? C.cyan : C.line, lw: rr === 1 ? 3 : 1.4 }));
  }
  for (const [px, py] of pts) items.push(line(id++, cx, cy, px, py, { color: C.line, lw: 1 }));
  const poly = vals.map((v, i) => [cx + (pts[i][0] - cx) * v, cy + (pts[i][1] - cy) * v]);
  items.push(line(id++, poly[0][0], poly[0][1], poly[1][0], poly[1][1], { color: C.red, lw: 3 }));
  items.push(line(id++, poly[1][0], poly[1][1], poly[2][0], poly[2][1], { color: C.red, lw: 3 }));
  items.push(line(id++, poly[2][0], poly[2][1], poly[0][0], poly[0][1], { color: C.red, lw: 3 }));
  items.push(textBox(id++, labels[0], cx - 80, cy - r - 68, 160, 38, { size: 21, bold: true, align: "center" }));
  items.push(textBox(id++, labels[1], cx - r - 170, cy + r * .56, 190, 38, { size: 21, bold: true, align: "center" }));
  items.push(textBox(id++, labels[2], cx + r - 20, cy + r * .56, 190, 38, { size: 21, bold: true, align: "center" }));
  return items;
}

const slides = [];

slides.push(slideXml([
  shape(2, "rect", 0, 0, W, H, { fill: C.darkBg, line: "none" }),
  ...motorbike(10, 690, 205, 1.35, C.cyan, false),
  shape(40, "ellipse", 878, 515, 145, 145, { fill: C.cyan, line: C.cyan2, lw: 2 }),
  textBox(50, "基於 ESP32 之智慧機車動態監測與安全預警系統", 110, 795, 1180, 58, { size: 34, bold: true, color: C.white }),
  textBox(51, "Explainable Low-Cost Motorcycle Telemetry", 112, 865, 820, 40, { size: 22, color: "B8C4C8" }),
  textBox(52, "專案研發團隊", 112, 928, 340, 32, { size: 16, color: "8EA0A7" }),
], C.darkBg));

slides.push(slideXml([
  textBox(2, "為什麼需要一套低成本、可解釋的機車動態監測？", 120, 88, 1060, 52, { size: 31, bold: true }),
  ...chip(10, 220, 235, 350, 190, "高昂成本", "傳統感測器 ECU 動態監測系統價格高且生態封閉，入門門檻與維護負擔高。"),
  ...chip(20, 785, 235, 350, 190, "雙載體驗", "現有系統較少針對「雙載情境」的動態補償與風險感知，容易忽略重量分布變化。"),
  shape(30, "ellipse", 725, 545, 230, 230, { fill: "FFF5F6", line: C.red, lw: 3 }),
  textBox(31, "動態風險", 770, 608, 140, 34, { size: 24, bold: true, color: C.red, align: "center" }),
  textBox(32, "騎士與乘客臨場姿態、坡度與雨天路況，會改變車輛平衡與制動距離。", 660, 786, 360, 70, { size: 17, color: C.slate, align: "center" }),
  line(40, 570, 330, 725, 600, { color: C.line, dash: true }),
  line(41, 1135, 330, 955, 600, { color: C.line, dash: true }),
], C.paper));

slides.push(slideXml([
  textBox(2, "系統定位", 105, 80, 420, 42, { size: 27, bold: true }),
  textBox(3, "建立不依賴高階 ECU 的低成本、高擴充性機車動態監測系統。", 105, 130, 450, 58, { size: 17, color: C.slate }),
  textBox(4, "核心價值", 1470, 80, 280, 42, { size: 27, bold: true }),
  textBox(5, "結合 AI 工程的模型提示，具備可解釋性與即時安全回饋。", 1470, 130, 350, 58, { size: 17, color: C.slate }),
  textBox(10, "[ 輕量化感測 ]", 205, 410, 410, 72, { size: 40, bold: true, color: C.ink, align: "center" }),
  textBox(11, "+", 640, 418, 80, 60, { size: 48, bold: true, color: C.ink, align: "center" }),
  textBox(12, "[ 可解釋性 AI ]", 745, 410, 430, 72, { size: 40, bold: true, color: C.ink, align: "center" }),
  textBox(13, "=", 1195, 418, 80, 60, { size: 48, bold: true, color: C.ink, align: "center" }),
  textBox(14, "[ 直覺式安全預警 ]", 1290, 410, 520, 72, { size: 40, bold: true, color: C.ink, align: "center" }),
  ...motorbike(30, 810, 620, .85, C.cyan, false),
  line(60, 520, 560, 740, 645, { color: C.cyan, lw: 3 }),
  line(61, 1400, 560, 1190, 645, { color: C.cyan, lw: 3 }),
], C.paper));

slides.push(slideXml([
  textBox(2, "系統架構：以 ESP32 為核心的模組化感測網路", 95, 70, 1160, 56, { size: 32, bold: true }),
  shape(10, "rect", 755, 362, 405, 260, { fill: "26323A", line: C.cyan, lw: 3 }),
  textBox(11, "核心運算\nESP32-WROVER Dev Board", 790, 420, 335, 90, { size: 25, bold: true, color: C.white, align: "center" }),
  shape(12, "rect", 835, 535, 245, 28, { fill: C.cyan, line: "none" }),
  ...chip(20, 125, 215, 430, 120, "動態感知", "GY-521 MPU6050 擷取加速度與角速度，分析傾角與振動。"),
  ...chip(30, 1290, 215, 430, 120, "速度與距離", "Bluetooth OBD2 ELM327 / HC-SR04 取得車速、距離與環境資訊。"),
  ...chip(40, 130, 770, 430, 120, "中央視覺", "0.96 吋 SSD1306 OLED 顯示即時狀態與警示。"),
  ...chip(50, 1290, 770, 430, 120, "電源安全", "MP1584EN 降壓穩壓模組，支援 12V 車電到 5V / 3.3V。"),
  line(70, 555, 275, 755, 440, { color: C.cyan, lw: 3 }),
  line(71, 1290, 275, 1160, 440, { color: C.cyan, lw: 3 }),
  line(72, 560, 830, 755, 545, { color: C.cyan, lw: 3 }),
  line(73, 1290, 830, 1160, 545, { color: C.cyan, lw: 3 }),
], "F0F4F3"));

slides.push(slideXml([
  textBox(2, "風險分級以可視化方式即時回饋", 120, 76, 760, 50, { size: 32, bold: true }),
  shape(10, "ellipse", 492, 118, 936, 936, { fill: "FCE2E5", line: "F5A6B0", lw: 2 }),
  shape(11, "ellipse", 610, 236, 700, 700, { fill: "FFF0B9", line: "F3D36D", lw: 2 }),
  shape(12, "ellipse", 730, 356, 460, 460, { fill: "DFF6E7", line: "84DCA4", lw: 2 }),
  shape(13, "ellipse", 858, 484, 204, 204, { fill: C.white, line: C.slate, lw: 3 }),
  textBox(14, "OLED\n85 km/h", 890, 545, 140, 62, { size: 24, bold: true, align: "center" }),
  textBox(20, "中央視覺（轉速錶）", 250, 484, 270, 34, { size: 23, bold: true }),
  textBox(21, "即時顯示速度、傾角與風險等級。", 190, 525, 350, 54, { size: 17, color: C.slate }),
  textBox(22, "周邊視覺（直覺警示）", 1390, 484, 330, 34, { size: 23, bold: true }),
  textBox(23, "以綠、黃、紅分區提示安全狀態。", 1390, 525, 350, 54, { size: 17, color: C.slate }),
  textBox(24, "臨界狀態（強制介入）", 820, 928, 330, 34, { size: 23, bold: true, align: "center" }),
  textBox(25, "低速高傾角 / 高振動時啟動 Level 2 安全警示。", 720, 970, 520, 44, { size: 17, color: C.slate, align: "center" }),
], C.paper));

slides.push(slideXml([
  textBox(2, "資料處理：從原始訊號到穩定特徵", 105, 82, 760, 52, { size: 32, bold: true }),
  textBox(10, "原始 IMU 與 OBD2 數據", 160, 255, 400, 34, { size: 25, bold: true, align: "center" }),
  ...Array.from({ length: 20 }, (_, i) => line(20+i, 140 + i*19, 430 + Math.sin(i)*60, 160 + i*19, 410 + Math.cos(i*1.7)*82, { color: C.slate, lw: 2 })),
  line(50, 610, 465, 760, 465, { color: C.slate, lw: 2.5, arrow: true }),
  shape(60, "roundRect", 820, 335, 315, 260, { fill: "E8FAFA", line: C.cyan, lw: 3 }),
  shape(61, "rect", 925, 420, 105, 95, { fill: "2B3A42", line: C.cyan, lw: 2 }),
  textBox(62, "數據前處理與融合", 782, 255, 390, 34, { size: 25, bold: true, align: "center" }),
  line(70, 1185, 405, 1325, 405, { color: C.slate, lw: 2.5, arrow: true }),
  line(71, 1185, 525, 1325, 525, { color: C.slate, lw: 2.5, arrow: true }),
  textBox(80, "零延遲抖動動態特徵", 1350, 255, 450, 34, { size: 25, bold: true, align: "center" }),
  ...Array.from({ length: 16 }, (_, i) => line(90+i, 1370 + i*23, 405 + Math.sin(i*.9)*70, 1393 + i*23, 405 + Math.sin((i+1)*.9)*70, { color: C.cyan, lw: 3 })),
  ...Array.from({ length: 16 }, (_, i) => line(110+i, 1370 + i*23, 545 + Math.sin(i*.9)*70, 1393 + i*23, 545 + Math.sin((i+1)*.9)*70, { color: C.cyan, lw: 3 })),
  textBox(130, "• IMU 互補濾波：結合 GPS 車速與 IMU 數據，消除單點跳動\n• 時間窗同步：將 OBD2 車速與 IMU 空間軌跡對齊，穩定判斷滑移特徵", 785, 660, 760, 92, { size: 18, color: C.slate }),
], "F4F6F7"));

slides.push(slideXml([
  textBox(2, "AI Agent 1: Payload Adaptation（單雙載自適應）", 420, 75, 1080, 52, { size: 32, bold: true, align: "center" }),
  textBox(3, "透過傾斜率與分析結果推論乘車動態，系統自動判斷單載狀態及早期雙載變異。", 405, 130, 1110, 42, { size: 18, color: C.slate, align: "center" }),
  ...motorbike(10, 245, 440, 1.05, C.gray, true),
  shape(40, "ellipse", 390, 312, 70, 70, { fill: "CFD5D5", line: C.gray, lw: 2 }),
  line(41, 425, 382, 450, 460, { color: C.gray, lw: 7 }),
  line(42, 450, 455, 500, 520, { color: C.gray, lw: 7 }),
  line(43, 450, 455, 392, 520, { color: C.gray, lw: 7 }),
  textBox(50, "單載狀態 (Single Rider)", 285, 785, 360, 34, { size: 23, bold: true, align: "center" }),
  textBox(51, "標準騎乘姿勢與負載，維持常規預警門檻。", 285, 827, 360, 56, { size: 17, color: C.slate, align: "center" }),
  line(60, 960, 252, 960, 880, { color: C.line, lw: 2 }),
  ...motorbike(70, 1120, 440, 1.05, C.gray, true),
  shape(100, "ellipse", 1265, 312, 70, 70, { fill: "CFD5D5", line: C.gray, lw: 2 }),
  line(101, 1300, 382, 1325, 460, { color: C.gray, lw: 7 }),
  shape(102, "ellipse", 1405, 328, 70, 70, { fill: "CFD5D5", line: C.gray, lw: 2 }),
  line(103, 1440, 398, 1465, 478, { color: C.gray, lw: 7 }),
  textBox(110, "雙載狀態 (Dual Rider / Pillion)", 1110, 785, 520, 34, { size: 23, bold: true, align: "center" }),
  textBox(111, "辨識下沉與重心偏移，自動收緊過彎傾角與煞車預警門檻。", 1120, 827, 500, 56, { size: 17, color: C.slate, align: "center" }),
], C.paper));

slides.push(slideXml([
  ...radar(10, 665, 575, 325, ["傾角容忍度", "動態線韌度", "預警保守性"], [.54, .42, .62]),
  textBox(60, "AI Agent 2:\nRider Profiling & 情境切換", 1025, 185, 650, 98, { size: 34, bold: true }),
  line(61, 1025, 330, 1025, 825, { color: C.line, lw: 2 }),
  textBox(70, "Rider Profile Modeling", 1070, 350, 560, 34, { size: 25, bold: true }),
  textBox(71, "長期學習不同騎士的騎乘風格，建立專屬個人的動態風險基準模型。", 1070, 392, 600, 70, { size: 18, color: C.slate }),
  textBox(72, "Sport Mode（運動模式）", 1070, 520, 560, 34, { size: 25, bold: true }),
  textBox(73, "針對傾角容忍度，提供更激進的動態分析與極限警示。", 1070, 562, 600, 70, { size: 18, color: C.slate }),
  textBox(74, "Rain Mode（雨天模式）", 1070, 690, 560, 34, { size: 25, bold: true }),
  textBox(75, "面對低抓地力條件，主動提高預警保守性，以避免嚴格的安全門檻被忽略。", 1070, 732, 640, 84, { size: 18, color: C.slate }),
], C.paper));

slides.push(slideXml([
  ...chip(10, 275, 120, 300, 62, "傾角 > 35度", "", { titleSize: 18 }),
  ...chip(20, 720, 120, 300, 62, "載重狀態：雙載", "", { titleSize: 18 }),
  ...chip(30, 1165, 120, 300, 62, "環境：Rain Mode", "", { titleSize: 18 }),
  line(50, 425, 182, 875, 322, { color: C.line, lw: 2, arrow: true }),
  line(51, 870, 182, 915, 322, { color: C.line, lw: 2, arrow: true }),
  line(52, 1315, 182, 955, 322, { color: C.line, lw: 2, arrow: true }),
  shape(60, "hexagon", 805, 320, 300, 245, { fill: "F2F6F7", line: C.line, lw: 3 }),
  textBox(61, "推論\n(Reasoning)", 845, 392, 220, 74, { size: 24, bold: true, align: "center" }),
  textBox(62, "AI 模型結合五軸濾波數據，判定當前抓地力極低且高傾角。", 1130, 376, 520, 72, { size: 19, color: C.slate }),
  line(70, 955, 565, 955, 765, { color: C.red, lw: 12, arrow: true }),
  shape(71, "roundRect", 875, 770, 160, 74, { fill: C.red, line: C.red, lw: 2 }),
  textBox(72, "LED!", 895, 783, 120, 44, { size: 32, bold: true, color: C.white, align: "center" }),
  textBox(80, "具備可解釋性的風險估測架構", 190, 850, 520, 42, { size: 28, bold: true }),
  textBox(81, "每一次警示皆具備可解釋性，讓騎士真正理解危險來源並建立對系統的信任。", 190, 900, 620, 58, { size: 18, color: C.slate }),
  textBox(82, "輸出 (Output)\n觸發 Crimson Red 連續閃爍 + 蜂鳴器 Level 2 介入", 1110, 780, 560, 80, { size: 20, color: C.slate }),
], "F4F6F7"));

slides.push(slideXml([
  textBox(2, "預期成果 (Expected Outcomes)", 80, 70, 620, 45, { size: 28, bold: true }),
  line(10, 960, 198, 960, 905, { color: C.line, lw: 2 }),
  line(11, 125, 555, 1795, 555, { color: C.line, lw: 2 }),
  ...iconTimer(20, 170, 252),
  textBox(30, "精準零延遲", 305, 265, 450, 34, { size: 26, bold: true }),
  textBox(31, "實現 OBD2 與 IMU 數據的毫秒級同步，提升動態監測準確度與即時性。", 305, 310, 520, 78, { size: 18, color: C.slate }),
  shape(40, "rect", 1110, 252, 88, 88, { fill: "none", line: C.slate, lw: 2 }),
  textBox(41, "NT$", 1122, 282, 64, 30, { size: 24, bold: true, align: "center" }),
  textBox(42, "極致成本控制", 1240, 265, 450, 34, { size: 26, bold: true }),
  textBox(43, "將整套系統硬體成本壓到 NT$1,500 以內，打破商用車機專屬的價格壁壘。", 1240, 310, 520, 78, { size: 18, color: C.slate }),
  ...iconShield(50, 170, 670),
  textBox(60, "直覺安全防護", 305, 680, 450, 34, { size: 26, bold: true }),
  textBox(61, "透過高辨識視覺化警示，有效降低過彎與轉向危險操作。", 305, 725, 520, 78, { size: 18, color: C.slate }),
  shape(70, "arc", 1110, 680, 98, 74, { fill: "none", line: C.slate, lw: 2 }),
  textBox(71, "雙載舒適革命", 1240, 680, 450, 34, { size: 26, bold: true }),
  textBox(72, "透過 Payload Adaptation 提前預警，減少雙載時的突發性晃動與乘車不適。", 1240, 725, 520, 78, { size: 18, color: C.slate }),
], C.paper));

slides.push(slideXml([
  textBox(2, "未來延伸：從動態監測走向視覺智慧", 115, 75, 860, 52, { size: 32, bold: true }),
  shape(10, "hexagon", 185, 315, 330, 285, { fill: "F3F6F5", line: C.slate, lw: 2 }),
  textBox(11, "當前階段\n車體自我感知\n(Sensory Dynamics)", 172, 630, 360, 78, { size: 22, bold: true, align: "center" }),
  shape(12, "rect", 288, 398, 126, 95, { fill: C.white, line: C.slate, lw: 2 }),
  textBox(13, "IMU", 314, 428, 78, 34, { size: 25, bold: true, align: "center" }),
  line(20, 525, 457, 780, 457, { color: C.cyan, lw: 10, arrow: true }),
  shape(30, "diamond", 805, 365, 230, 185, { fill: "E6FBFA", line: C.cyan, lw: 3 }),
  textBox(31, "未來展望 (Future Work): Vision Extension", 700, 740, 700, 36, { size: 24, bold: true, align: "center" }),
  textBox(32, "預計導入 ESP32 Camera 模組，將防撞偵測向外擴展：前方路面分析、坑洞 / 標線突變、雨天積水環境之機器視覺即時辨識。", 640, 790, 805, 92, { size: 18, color: C.slate, align: "center" }),
  line(40, 1035, 457, 1280, 457, { color: C.cyan, lw: 10, arrow: true }),
  shape(50, "hexagon", 1330, 305, 360, 315, { fill: "F3F6F5", line: C.slate, lw: 2 }),
  shape(51, "ellipse", 1420, 360, 180, 180, { fill: "DDE5E6", line: C.slate, lw: 3 }),
  shape(52, "ellipse", 1470, 410, 80, 80, { fill: "26323A", line: C.cyan, lw: 2 }),
  textBox(53, "次世代升級\n外部環境預測\n(Visual Intelligence)", 1320, 630, 380, 78, { size: 22, bold: true, align: "center" }),
], C.paper));

slides.push(slideXml([
  shape(2, "rect", 0, 0, W, H, { fill: C.darkBg, line: "none" }),
  shape(3, "rect", 0, 720, W, 70, { fill: "143740", line: "none" }),
  ...motorbike(10, 1035, 285, .95, C.cyan, false),
  textBox(40, "基於 ESP32 之智慧機車動態監測與安全預警系統", 620, 705, 700, 32, { size: 16, color: "A8BDC2", align: "center" }),
  textBox(41, "「讓每一次騎乘，都有一位懂你的隱形副駕。」", 340, 765, 1240, 72, { size: 40, bold: true, color: C.white, align: "center" }),
  textBox(42, "開放問答與技術交流", 800, 880, 320, 34, { size: 19, color: "95AAB0", align: "center" }),
], C.darkBg));

for (let i = 0; i < slides.length; i++) {
  write(path.join(pkgDir, "ppt", "slides", `slide${i + 1}.xml`), slides[i]);
  write(path.join(pkgDir, "ppt", "slides", "_rels", `slide${i + 1}.xml.rels`), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
}

function svgText(t) {
  return esc(t).split("\n").map((line, i) => `<tspan x="0" dy="${i === 0 ? 0 : 1.25}em">${line}</tspan>`).join("");
}
function previewSlide(i, title) {
  const isDark = i === 0 || i === 11;
  const bg = isDark ? `#${C.darkBg}` : i === 3 || i === 5 || i === 8 ? "#F4F6F7" : "#FBFCF8";
  const titleColor = isDark ? "#FFFFFF" : `#${C.ink}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${bg}"/>
    <text x="90" y="115" font-family="Microsoft JhengHei, Arial" font-size="38" font-weight="700" fill="${titleColor}">${svgText(title)}</text>
    <text x="90" y="1015" font-family="Arial" font-size="20" fill="${isDark ? "#7FAAB0" : "#8A969B"}">Editable PPTX reconstruction • slide ${i + 1}/12</text>
    <rect x="84" y="165" width="1752" height="780" rx="18" fill="${isDark ? "#12242B" : "#FFFFFF"}" stroke="#${isDark ? C.cyan : C.line}" stroke-width="3"/>
    <text x="145" y="265" font-family="Microsoft JhengHei, Arial" font-size="32" fill="${titleColor}">本頁已重建為原生文字、線條與形狀，可在 PowerPoint 中逐項編輯。</text>
    <text x="145" y="330" font-family="Microsoft JhengHei, Arial" font-size="27" fill="${isDark ? "#B8C4C8" : "#41515B"}">實際簡報包含對應的圖示、流程線、雷達圖、架構節點與中英標題。</text>
    <circle cx="1550" cy="560" r="130" fill="#${C.cyan}" opacity=".16"/><circle cx="1550" cy="560" r="64" fill="#${C.cyan}" opacity=".65"/>
  </svg>`;
}

const previewTitles = [
  "基於 ESP32 之智慧機車動態監測與安全預警系統",
  "低成本、雙載與動態風險",
  "輕量化感測 + 可解釋性 AI",
  "ESP32 模組化系統架構",
  "風險分級視覺回饋",
  "資料前處理與特徵融合",
  "Payload Adaptation 單雙載自適應",
  "Rider Profiling & 情境切換",
  "可解釋性推論到 LED 預警",
  "預期成果",
  "Future Work: Vision Extension",
  "Q&A"
];
for (let i = 0; i < previewTitles.length; i++) {
  const svg = previewSlide(i, previewTitles[i]);
  fs.writeFileSync(path.join(previewDir, `slide${String(i + 1).padStart(2, "0")}.svg`), svg);
}

const previewPy = path.join(scratchDir, "make_preview_pngs.py");
write(previewPy, String.raw`
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1920, 1080
preview_dir = r"${previewDir}"
titles = ${JSON.stringify(previewTitles, null, 2)}
font_path = r"C:\Windows\Fonts\msjh.ttc"
font_bold = r"C:\Windows\Fonts\msjhbd.ttc"

def font(size, bold=False):
    path = font_bold if bold and os.path.exists(font_bold) else font_path
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

for i, title in enumerate(titles, 1):
    dark = i in (1, 12)
    bg = "#101922" if dark else ("#F4F6F7" if i in (4, 6, 9) else "#FBFCF8")
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    title_color = "#FFFFFF" if dark else "#17212A"
    muted = "#B8C4C8" if dark else "#41515B"
    line = "#20D8D5" if dark else "#C8D0D2"
    d.text((90, 75), title, fill=title_color, font=font(38, True))
    d.rounded_rectangle((84, 165, 1836, 945), radius=18, fill="#12242B" if dark else "#FFFFFF", outline=line, width=3)
    d.text((145, 245), "本頁已重建為原生文字、線條與形狀，可在 PowerPoint 中逐項編輯。", fill=title_color, font=font(32, True))
    d.text((145, 310), "實際簡報包含對應的圖示、流程線、雷達圖、架構節點與中英標題。", fill=muted, font=font(27))
    d.ellipse((1420, 430, 1680, 690), outline="#20D8D5", width=5)
    d.ellipse((1486, 496, 1614, 624), fill="#20D8D5")
    d.text((90, 1015), f"Editable PPTX reconstruction • slide {i}/12", fill="#7FAAB0" if dark else "#8A969B", font=font(20))
    img.save(os.path.join(preview_dir, f"slide{i:02d}.png"))
`);
const py = spawnSync("C:\\Users\\user\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe", [previewPy], { encoding: "utf8" });
if (py.status !== 0) {
  console.error(py.stderr || py.stdout);
  process.exit(py.status ?? 1);
}

fs.rmSync(pptxPath, { force: true });
const ps = [
  "$ErrorActionPreference='Stop'",
  `Add-Type -AssemblyName System.IO.Compression`,
  `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
  `$src=${psQuote(pkgDir)}`,
  `$dst=${psQuote(pptxPath)}`,
  `if(Test-Path $dst){Remove-Item -LiteralPath $dst -Force}`,
  `$zip=[System.IO.Compression.ZipFile]::Open($dst,[System.IO.Compression.ZipArchiveMode]::Create)`,
  `try{Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object { $rel=$_.FullName.Substring($src.Length+1).Replace('\\','/'); [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$_.FullName,$rel) | Out-Null }} finally { $zip.Dispose() }`
].join("; ");
const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

console.log(JSON.stringify({ pptxPath, previewDir, slides: slides.length }, null, 2));
