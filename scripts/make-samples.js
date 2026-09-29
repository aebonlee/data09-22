#!/usr/bin/env node
/*
 * 예시 성적서 만들기 — 실제 양식과 같은 배치의 「가상」 엑셀을 만듭니다.
 *   node scripts/make-samples.js
 *
 * - 실제 협력사 파일은 실명(용접사·검사원)·업체명·로고가 있어 이 저장소에 넣지 않습니다.
 *   대신 같은 칸 배치·같은 그림 앵커 방식으로 가명(협력사X·용접사A) 파일을 만듭니다.
 * - 용접 사진은 코드로 그린 그림(PNG)입니다. 상자 안쪽 모서리를 따라 비드(물결 무늬 띠)를 그리고,
 *   「누락」 그림은 한쪽 모서리에 비드 없이 이음매 선만 남깁니다.
 * - 일부러 넣은 문제: 검사일 「월 일」 그대로, 위치 F 사진 없음, 다른 Serial 사진 재사용(같은 파일·밝기만 바꾼 것),
 *   누락 사진, 각장 기준 밖 값, 빈 Arm 시트, 검사자 빈칸.
 *
 * 산출: samples/*.xlsx, js/sample-data.js(화면의 「예시 불러오기」용 base64 — file:// 에서는 파일을 읽어 올 수 없어서)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const JSZip = require(path.join(ROOT, 'vendor/jszip.min.js'));
const L = require(path.join(ROOT, 'js/logic.js'));

// ── 작은 래스터 그리기 + PNG 인코더 ─────────────────────────────
function canvas(w, h, bg) { const px = new Uint8Array(w * h * 3); for (let i = 0; i < w * h; i++) px.set(bg, i * 3); return { w, h, px }; }
function put(c, x, y, col) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= c.w || y >= c.h) return; c.px.set(col, (y * c.w + x) * 3); }
function rect(c, x0, y0, x1, y1, col) { for (let y = Math.max(0, y0 | 0); y < Math.min(c.h, y1); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(c.w, x1); x++) put(c, x, y, col); }
function line(c, x0, y0, x1, y1, col, t) {
  t = t || 1;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; rect(c, x - t / 2, y - t / 2, x + t / 2 + 0.5, y + t / 2 + 0.5, col); }
}
function shade(col, k) { return col.map(v => Math.max(0, Math.min(255, Math.round(v * k)))); }
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) { raw[y * (c.w * 3 + 1)] = 0; Buffer.from(c.px.buffer, y * c.w * 3, c.w * 3).copy(raw, y * (c.w * 3 + 1) + 1); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(c.w, 0); ih.writeUInt32BE(c.h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gray(c) { const g = new Float64Array(c.w * c.h); for (let i = 0; i < c.w * c.h; i++) g[i] = 0.299 * c.px[i * 3] + 0.587 * c.px[i * 3 + 1] + 0.114 * c.px[i * 3 + 2]; return g; }

// 상자 안쪽을 들여다본 용접 사진(가상). missing = 비드가 빠진 모서리 목록('top'·'bottom'·'left'·'right')
function weldPhoto(seed, missing, bright) {
  const r = rng(seed), W = 160, H = 120;
  const steel = [110 + r() * 30 | 0, 100 + r() * 25 | 0, 92 + r() * 20 | 0];
  const c = canvas(W, H, shade(steel, 0.55));
  // 바깥 벽(원근) — 밝기 방향을 사진마다 다르게
  const ix0 = 30 + r() * 30, iy0 = 22 + r() * 22, ix1 = W - 30 - r() * 30, iy1 = H - 20 - r() * 22;
  const lightX = r() < 0.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = 0.45 + 0.35 * (lightX ? x / W : y / H);
    put(c, x, y, shade(steel, k));
  }
  // 안쪽 벽(뒤판)
  for (let y = iy0 | 0; y < iy1; y++) for (let x = ix0 | 0; x < ix1; x++) {
    const k = 0.85 + 0.35 * Math.sin((x - ix0) / (ix1 - ix0) * Math.PI) * (0.6 + 0.4 * r());
    put(c, x, y, shade(steel, k));
  }
  // 그을음·연마 자국(사진마다 다른 얼룩) — 서로 다른 사진의 모양 지문이 충분히 멀어지게 합니다
  for (let i = 0; i < 9; i++) {
    const bx = r() * W, by = r() * H, bw = 8 + r() * 26, bh = 6 + r() * 20, k = 0.55 + r() * 0.9;
    for (let y = by | 0; y < by + bh; y++) for (let x = bx | 0; x < bx + bw; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (y * W + x) * 3; for (let q = 0; q < 3; q++) c.px[o + q] = Math.max(0, Math.min(255, Math.round(c.px[o + q] * k)));
    }
  }
  line(c, 0, 0, ix0, iy0, shade(steel, 0.3), 2); line(c, W, 0, ix1, iy0, shade(steel, 0.3), 2);
  line(c, 0, H, ix0, iy1, shade(steel, 0.3), 2); line(c, W, H, ix1, iy1, shade(steel, 0.3), 2);
  // 분필 표시(가상 Serial) — 위치·획을 사진마다 다르게
  const chalk = [235, 235, 228];
  const cx = ix0 + (ix1 - ix0) * (0.2 + r() * 0.4), cy = iy0 + (iy1 - iy0) * (0.25 + r() * 0.3);
  for (let i = 0; i < 5; i++) { const x = cx + i * 7, y = cy + (r() - 0.5) * 4; line(c, x, y, x + 4 + r() * 3, y + 8 + r() * 4, chalk, 1); line(c, x + 1, y + 4, x + 6, y + 2, chalk, 1); }
  // 모서리 용접
  const edges = { top: [ix0, iy0, ix1, iy0], bottom: [ix0, iy1, ix1, iy1], left: [ix0, iy0, ix0, iy1], right: [ix1, iy0, ix1, iy1] };
  Object.keys(edges).forEach(k => {
    const [x0, y0, x1, y1] = edges[k];
    if (missing.indexOf(k) >= 0) { line(c, x0, y0, x1, y1, [28, 26, 24], 1); return; } // 비드 없음 — 이음매 선만
    line(c, x0, y0, x1, y1, [196, 190, 176], 6);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 4;
    for (let i = 0; i < n; i++) { // 물결 무늬
      const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (y0 === y1) line(c, x, y - 3, x + 2, y + 3, [120, 112, 100], 1); else line(c, x - 3, y, x + 3, y + 2, [120, 112, 100], 1);
    }
  });
  if (bright) for (let i = 0; i < c.px.length; i++) c.px[i] = Math.min(255, Math.round(c.px[i] * bright));
  return c;
}
// 촬영 가이드(도해) — 선 그림 + 빨간 용접선
function guideDrawing(kind) {
  const W = 120, H = 96, c = canvas(W, H, [244, 246, 250]);
  const ink = [70, 80, 96], red = [220, 30, 30];
  if (kind === 'pipe') { rect(c, 30, 26, 90, 70, [214, 220, 230]); line(c, 30, 26, 30, 70, ink, 2); line(c, 90, 26, 90, 70, ink, 2); line(c, 34, 26, 34, 70, red, 2); line(c, 86, 26, 86, 70, red, 2); }
  else { rect(c, 22, 18, 98, 78, [214, 220, 230]); line(c, 22, 18, 98, 18, ink, 2); line(c, 22, 78, 98, 78, ink, 2); line(c, 22, 18, 22, 78, ink, 2); line(c, 98, 18, 98, 78, ink, 2);
    line(c, 26, 22, 94, 22, red, 2); line(c, 26, 74, 94, 74, red, 2); if (kind !== 'two') { line(c, 26, 22, 26, 74, red, 2); line(c, 94, 22, 94, 74, red, 2); } }
  line(c, 0, 0, 22, 18, ink, 1); line(c, W, 0, 98, 18, ink, 1); line(c, 0, H, 22, 78, ink, 1); line(c, W, H, 98, 78, ink, 1);
  return c;
}
// 붐 위치 안내도(가상)
function boomDrawing(labels) {
  const W = 480, H = 110, c = canvas(W, H, [255, 255, 255]);
  const ink = [60, 70, 86];
  line(c, 20, 80, 200, 30, ink, 3); line(c, 200, 30, 460, 70, ink, 3); line(c, 20, 95, 200, 48, ink, 2); line(c, 200, 48, 460, 88, ink, 2);
  [[20, 88], [200, 40], [460, 79]].forEach(([x, y]) => { for (let a = 0; a < 64; a++) put(c, x + 9 * Math.cos(a / 10), y + 9 * Math.sin(a / 10), ink); });
  (labels || []).forEach(([x, y]) => { rect(c, x - 7, y - 7, x + 8, y + 8, [30, 110, 60]); });
  return c;
}

// ── xlsx 쓰기 ───────────────────────────────────────────────
const MDW = 7, EMU_PX = 9525, EMU_PT = 12700;
function colPx(w) { return Math.floor(((256 * w + Math.floor(128 / MDW)) / 256) * MDW); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function colName(c) { return L.colName(c); }
function excelSerial(iso) { return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5); }

function sheetXml(sh) {
  const rows = {};
  Object.keys(sh.cells).forEach(ref => { const m = /^([A-Z]+)(\d+)$/.exec(ref); (rows[m[2]] = rows[m[2]] || []).push([m[1], sh.cells[ref]]); });
  const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const colIdx = s => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  const body = rowNums.map(r => '<row r="' + r + '">' + rows[r].sort((a, b) => colIdx(a[0]) - colIdx(b[0])).map(([c, v]) => {
    const ref = c + r;
    if (v && v.date) return '<c r="' + ref + '" s="1"><v>' + excelSerial(v.date) + '</v></c>';
    if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }).join('') + '</row>').join('');
  const cols = sh.cols.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetFormatPr defaultRowHeight="' + sh.rowPt + '" customHeight="1"/><cols>' + cols + '</cols><sheetData>' + body + '</sheetData>' +
    (sh.draw.length ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
}
// 셀 위치(열·행 소수) → 앵커 마커. 열 너비는 이 파일의 <cols> 로 환산
function marker(sh, col, row) {
  const c = Math.floor(col), r = Math.floor(row);
  const cw = colPx(sh.cols[c] != null ? sh.cols[c] : 8.43) * EMU_PX, rh = sh.rowPt * EMU_PT;
  return { c, r, co: Math.round((col - c) * cw), ro: Math.round((row - r) * rh) };
}
function mk(tag, m) { return '<xdr:' + tag + '><xdr:col>' + m.c + '</xdr:col><xdr:colOff>' + m.co + '</xdr:colOff><xdr:row>' + m.r + '</xdr:row><xdr:rowOff>' + m.ro + '</xdr:rowOff></xdr:' + tag + '>'; }
function xfrm(x, y, w, h, ch) { return '<a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/>' + (ch ? '<a:chOff x="' + ch[0] + '" y="' + ch[1] + '"/><a:chExt cx="' + ch[2] + '" cy="' + ch[3] + '"/>' : '') + '</a:xfrm>'; }
let SHAPE_ID = 2;
function picXml(rid, x, y, w, h, name) {
  return '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + (SHAPE_ID++) + '" name="' + esc(name || '그림') + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr>' + xfrm(x, y, w, h) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>';
}
function spXml(text, x, y, w, h, red) {
  return '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="' + (SHAPE_ID++) + '" name="글상자"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr>' + xfrm(x, y, w, h) +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' + (red ? '<a:ln><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>' : '') + '</xdr:spPr>' +
    '<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR"' + (red ? '><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>' : '/>') + '<a:t>' + esc(text) + '</a:t></a:r></a:p></xdr:txBody></xdr:sp>';
}
// 한 시트의 그림 배치를 drawing XML 로
function drawingXml(sh, ridOf) {
  const parts = sh.draw.map(d => {
    const a = marker(sh, d.c0, d.r0), b = marker(sh, d.c1, d.r1);
    const W = 1000000, H = Math.round(W * (d.r1 - d.r0) / Math.max(0.01, d.c1 - d.c0)); // 맨 위 xfrm 은 아무 값 — 읽는 쪽이 앵커에 맞춤
    let inner;
    if (d.group) {
      // 그룹: 자식 좌표계(chOff/chExt)를 일부러 다르게 잡아 좌표 변환을 거치게 합니다(실제 파일과 같은 구조)
      const CH = [5000000, 7000000, 2000000, Math.round(2000000 * H / W)];
      const kidsXml = d.group.map(k => {
        const x = CH[0] + Math.round(k.x * CH[2]), y = CH[1] + Math.round(k.y * CH[3]), w = Math.round(k.w * CH[2]), h = Math.round(k.h * CH[3]);
        return k.pic ? picXml(ridOf(k.pic), x, y, w, h, '가이드') : spXml(k.text, x, y, w, h, k.red);
      }).join('');
      inner = '<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="' + (SHAPE_ID++) + '" name="그룹"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr>' + xfrm(0, 0, W, H, CH) + '</xdr:grpSpPr>' + kidsXml + '</xdr:grpSp>';
    } else if (d.pic) inner = picXml(ridOf(d.pic), 0, 0, W, H, d.name);
    else inner = spXml(d.text, 0, 0, W, H, d.red);
    return '<xdr:twoCellAnchor editAs="oneCell">' + mk('from', a) + mk('to', b) + inner + '<xdr:clientData/></xdr:twoCellAnchor>';
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + parts.join('') + '</xdr:wsDr>';
}
async function writeXlsx(file, sheets, images) {
  const z = new JSZip();
  const names = Object.keys(images);
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' + (s.draw.length ? '<Override PartName="/xl/drawings/drawing' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '')).join('') + '</Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  z.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>');
  names.forEach(n => z.file('xl/media/' + n, images[n]));
  sheets.forEach((s, i) => {
    z.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s));
    if (!s.draw.length) return;
    z.file('xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing' + (i + 1) + '.xml"/></Relationships>');
    const used = [];
    const ridOf = img => { let k = used.indexOf(img); if (k < 0) { used.push(img); k = used.length - 1; } return 'rId' + (k + 1); };
    const dx = drawingXml(s, ridOf);
    z.file('xl/drawings/drawing' + (i + 1) + '.xml', dx);
    z.file('xl/drawings/_rels/drawing' + (i + 1) + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      used.map((img, k) => '<Relationship Id="rId' + (k + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + img + '"/>').join('') + '</Relationships>');
  });
  // 날짜를 고정해 다시 만들어도 같은 바이트가 나오게 합니다(예시 파일 지문 고정)
  const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, date: new Date(Date.UTC(2026, 8, 29)) });
  fs.writeFileSync(file, buf);
  return buf;
}

// ── 양식 W2 (내부용접 검사성적서, 위치 A~F) ─────────────────────────
const W2_COLS = [1.44, 3.78, 13.78, 1.44, 16.78, 1.44, 16.78, 1.44, 16.78, 1.44];
// 위치별 칸: 줄(0·1·2) = 15·22·29행부터(0부터 셈 14·21·28), 가이드 B~D열 / G~H열, 실제 사진 E열 / I열
const W2_ROW = [14.2, 21.2, 28.2];
const LEG = { A: [5, 5], B: [7, 7, 7, 7], C: [7, 6, 6, 7], D: [7, 6, 6, 7], E: [7, 7, 7, 7], F: [5, 5, 5] };
const GUIDE_KIND = { A: 'two', B: 'box', C: 'pipe', D: 'pipe', E: 'box', F: 'box' };
const ITEMS = [
  ['용접누락', '없을 것'], ['용접품질[각장]', "도면각장(z), 1.0z ≤ z' ≤ 1.25z"], ['용접품질[언더컷]', 'h ≤ 0.5mm (단독으로 고립된 짧은 것 허용)'],
  ['용접품질[오버랩]', 'α < 90° 이하이면 결함'], ['용접품질[크레이터]', 'h ≤ 1mm'], ['용접품질[기공]', '필렛용접, 100mm 당 2개이상, Ø2.5mm 넘으면 안됨'],
  ['용접품질[연장용접]', '도면 준수'], ['일반', '기종명, Serial No., 내부용접사진, 서명 누락여부']
];
function w2Sheet(o) {
  const cells = {
    A1: (o.part || 'Boom') + ' 내부용접 검사성적서',
    A2: '협력사 명', E2: '기종', G2: '품번', I2: '품명 / 옵션정보',
    A4: '검사일', E4: 'Serial No.', G4: '용접사', I4: '검사원',
    A6: '사진촬영 방향',
    A37: 'No.', C37: '검사항목', E37: '검사기준 (W2)', I37: '검사결과(정량적 기입)'
  };
  const h = o.header || {};
  if (h.partner) cells.A3 = h.partner; if (h.model) cells.E3 = h.model; if (h.partNo) cells.G3 = h.partNo; if (h.partName) cells.I3 = h.partName;
  if (h.date) cells.A5 = h.date; if (h.serial) cells.E5 = h.serial; if (h.welder) cells.G5 = h.welder; if (h.inspector) cells.I5 = h.inspector;
  [17, 24, 31].forEach(r => ['E', 'I'].forEach(c => { cells[c + r] = '기종명, Serial No.,'; cells[c + (r + 1)] = '각장검사 기록 후'; cells[c + (r + 2)] = '사진 촬영'; }));
  ITEMS.forEach((it, i) => { const r = 38 + i; cells['A' + r] = i + 1; cells['C' + r] = it[0]; cells['E' + r] = it[1]; if (o.results && o.results[i] != null) cells['I' + r] = o.results[i]; });
  const draw = [];
  draw.push({ pic: 'boom.png', c0: 0.3, r0: 6.2, c1: 9.2, r1: 13.8, name: '위치 안내도' });
  L.POS6.forEach((p, i) => draw.push({ text: p, c0: [2.2, 3.1, 4.1, 6.1, 6.4, 8.3][i], r0: 9 + (i % 3), c1: [2.4, 3.3, 4.3, 6.3, 6.6, 8.5][i], r1: 10 + (i % 3) }));
  const positions = o.positions || L.POS6;
  const guideDraw = [];
  L.POS6.forEach((p, i) => {
    if (positions.indexOf(p) < 0) return;
    const band = Math.floor(i / 2), right = i % 2;
    const gc0 = right ? 6.05 : 1.05, gc1 = right ? 7.9 : 3.9, r0 = W2_ROW[band], r1 = r0 + 6.4;
    guideDraw.push({ p, c0: gc0, c1: gc1, r0, r1 });
    const pc = right ? 8 : 4;
    const photo = o.photos && o.photos[p];
    if (photo) draw.push({ pic: photo, c0: pc + 0.02, r0: r0 + 0.8, c1: pc + 0.98, r1: r0 + 5.2, name: '사진' });
  });
  if (o.groupGuides) {
    // 여섯 가이드를 그룹 하나로(실제 파일 한 곳이 이렇게 돼 있습니다)
    const c0 = Math.min(...guideDraw.map(g => g.c0)), c1 = Math.max(...guideDraw.map(g => g.c1)), r0 = Math.min(...guideDraw.map(g => g.r0)), r1 = Math.max(...guideDraw.map(g => g.r1));
    // 그룹 안 비율 좌표는 열 너비를 고려해 EMU 로 계산
    const colX = c => { let x = 0; for (let k = 0; k < Math.floor(c); k++) x += colPx(W2_COLS[k]); return x + (c - Math.floor(c)) * colPx(W2_COLS[Math.floor(c)]); };
    const X0 = colX(c0), X1 = colX(c1);
    const kids = [];
    guideDraw.forEach(g => {
      const fx = (colX(g.c0) - X0) / (X1 - X0), fw = (colX(g.c1) - colX(g.c0)) / (X1 - X0), fy = (g.r0 - r0) / (r1 - r0), fh = (g.r1 - g.r0) / (r1 - r0);
      kids.push({ pic: 'guide_' + GUIDE_KIND[g.p] + '.png', x: fx, y: fy, w: fw, h: fh });
      kids.push({ text: g.p, x: fx, y: fy, w: fw * 0.12, h: fh * 0.12 });
      LEG[g.p].forEach((z, k) => kids.push({ text: String(z), red: true, x: fx + fw * (0.2 + 0.18 * k), y: fy + fh * 0.45, w: fw * 0.1, h: fh * 0.1 }));
    });
    draw.push({ group: kids, c0, r0, c1, r1 });
  } else {
    guideDraw.forEach(g => {
      draw.push({ group: [{ pic: 'guide_' + GUIDE_KIND[g.p] + '.png', x: 0, y: 0, w: 1, h: 1 }, { text: g.p, x: 0, y: 0, w: 0.12, h: 0.12 }], c0: g.c0, r0: g.r0, c1: g.c1, r1: g.r1 });
      LEG[g.p].forEach((z, k) => { const x = g.c0 + (g.c1 - g.c0) * (0.12 + 0.2 * k); draw.push({ text: String(z), red: true, c0: x, r0: g.r0 + 2.5, c1: x + 0.12, r1: g.r0 + 3.3 }); });
    });
  }
  return { name: o.name, cols: W2_COLS, rowPt: 16.5, cells, draw };
}
// ── 양식 P2 (공정 검사 보고서, 위치 번호) ─────────────────────────
function p2Sheet(o) {
  const h = o.header;
  const cells = {
    A1: '제관 / 용접(내부) 공정 검사 보고서(2/1)\n(WELD INSPECTION REPORT)',
    A2: '기종', C2: '품번', E2: '작업자', A4: '날짜', C4: 'LOT NO', E4: '검사자',
    A7: '검사내용(Detail Description)', A9: '1. 내부 용접',
    A42: '검      사      항      목', F42: '확 인',
    A43: '1. 내부용접 누락 여부', A44: '2. 언더컷, 기공, 오버랩, 용접누락 여부', A45: '3. 단품 발청제거 유무', A46: '4. ROOT GAP(3~8mm) 확인 여부.'
  };
  if (h.model) cells.A3 = h.model; if (h.partNo) cells.C3 = h.partNo; if (h.welder) cells.E3 = h.welder;
  if (h.date) cells.A5 = h.date; if (h.serial) cells.C5 = h.serial; if (h.inspector) cells.E5 = h.inspector;
  o.results.forEach((v, i) => { cells['F' + (43 + i)] = v; });
  const draw = [
    { pic: 'boom.png', c0: 0.3, r0: 10.1, c1: 5.6, r1: 17.4, name: '도면' },
    { text: '2', c0: 2.05, r0: 12.3, c1: 2.25, r1: 13.2 }, { text: '1', c0: 4.8, r0: 12.3, c1: 5.0, r1: 13.2 }, // 도면 위 번호
    { text: '1', c0: 0.2, r0: 20.4, c1: 0.4, r1: 21.3 }, { text: '2', c0: 4.1, r0: 20.4, c1: 4.3, r1: 21.3 } // 위치 번호표
  ];
  o.photos.forEach(ph => draw.push(Object.assign({ name: '사진' }, ph)));
  return { name: o.name, cols: [13.55, 13.55, 13.55, 13.55, 13.55, 13.55, 2.44], rowPt: 13.5, cells, draw };
}

(async () => {
  const OUT = path.join(ROOT, 'samples');
  fs.mkdirSync(OUT, { recursive: true });
  const images = {};
  const shots = {}; // 이름 → 회색 배열(모양 지문 검사용)
  function addPhoto(name, c) { images[name] = png(c); shots[name] = L.dhash(gray(c), c.w, c.h, 16); }
  images['boom.png'] = png(boomDrawing([[60, 70], [150, 44], [215, 36], [300, 50], [345, 57], [440, 74]]));
  ['two', 'box', 'pipe'].forEach(k => { images['guide_' + k + '.png'] = png(guideDrawing(k)); });

  // 파일 1 — 협력사X, 기종 MX14, Serial S01~S04
  let seed = 1000;
  const photos = {};
  ['S01', 'S02', 'S03', 'S04'].forEach(s => {
    photos[s] = {};
    L.POS6.forEach(p => {
      const name = s + '_' + p + '.png';
      const missing = s === 'S03' && p === 'E' ? ['bottom', 'right'] : [];
      addPhoto(name, weldPhoto(seed += 37, missing));
      photos[s][p] = name;
    });
  });
  // S04: 위치 B = S02 의 B 사진 파일 그대로, 위치 D = S03 의 D 를 밝기만 올린 것, 위치 F = 사진 없음
  delete images['S04_B.png']; photos.S04.B = 'S02_B.png';
  const s03d = weldPhoto(1000 + 37 * (2 * 6 + 4), [], 1.12); // S03_D 와 같은 장면(같은 씨앗)
  addPhoto('S04_D.png', s03d);
  delete images['S04_F.png']; delete photos.S04.F;
  const ok8 = ['OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK'];
  const f1 = [
    w2Sheet({ name: 'MX14 S01', header: { partner: '협력사X', model: 'MX14', partNo: 'P-1401', partName: 'BOOM ASSY', date: '월     일', serial: 'S01', welder: '용접사A', inspector: '검사원A' }, results: ok8, photos: photos.S01 }),
    w2Sheet({ name: 'MX14 S02', header: { partner: '협력사X', model: 'MX14', partNo: 'P-1401', partName: 'BOOM ASSY', date: { date: '2026-09-21' }, serial: 'S02', welder: '용접사A', inspector: '검사원A' },
      results: ['OK', 'A 5.5, B 7.4, C 7.2, D 7.1, E 7.3, F 5.6', '0.2', '110°', '0.3', '0개', 'OK', 'OK'], photos: photos.S02 }),
    w2Sheet({ name: 'MX14 S03', header: { partner: '협력사X', model: 'MX14', partNo: 'P-1401', partName: 'BOOM ASSY', date: { date: '2026-09-22' }, serial: 'S03', welder: '용접사B', inspector: '검사원A' }, results: ok8, photos: photos.S03 }),
    w2Sheet({ name: 'MX14 S04', header: { partner: '협력사X', model: 'MX14', partNo: 'P-1401', partName: 'BOOM ASSY', date: { date: '2026-09-23' }, serial: 'S04', welder: '용접사B', inspector: '검사원A' },
      results: ['OK', 'A 5.3, B 7.5, C 7.4, D 7.0, E 7.6, F 5.4', '0.1', '105°', '0.2', '0개', 'OK', 'OK'], photos: photos.S04 })
  ];
  // 파일 2 — 협력사Y, TX30 Boom(가이드 그룹 하나 · 각장 기준 밖) + 빈 Arm
  const tx = {};
  L.POS6.forEach(p => { const n = 'T01_' + p + '.png'; addPhoto(n, weldPhoto(seed += 53, [])); tx[p] = n; });
  const f2 = [
    w2Sheet({ name: 'Boom', part: 'Boom', header: { partner: '협력사Y', model: 'TX30', partNo: 'P-3001', partName: 'BOOM 6.2M', date: { date: '2026-09-24' }, serial: 'T01', welder: '용접사C', inspector: '검사원B' },
      results: ['OK', 'A 5.2, B 9.4', 'OK', 'OK', 'OK', 'OK', '50', 'OK'], photos: tx, groupGuides: true }),
    w2Sheet({ name: 'Arm', part: 'Arm', header: {}, results: [], photos: {}, positions: ['A', 'B', 'C', 'D', 'E'] })
  ];
  // 파일 3 — 형식2(위치 번호 1·2), 검사자 빈칸, 협력사 칸 없음
  ['L01_1a', 'L01_1b', 'L01_2a'].forEach(n => addPhoto(n + '.png', weldPhoto(seed += 71, [])));
  const f3 = [p2Sheet({
    name: '내부용접-01', header: { model: 'LX20', partNo: 'P-2001', welder: '용접사D', date: { date: '2026-09-25' }, serial: 'L01', inspector: '' },
    results: ['OK', 'OK', 'OK', 'OK'],
    photos: [{ pic: 'L01_1a.png', c0: 0.2, r0: 23.3, c1: 1.8, r1: 29.5 }, { pic: 'L01_1b.png', c0: 2.2, r0: 23.3, c1: 3.8, r1: 29.5 }, { pic: 'L01_2a.png', c0: 4.2, r0: 23.3, c1: 5.8, r1: 29.5 }]
  })];

  const pick = (names) => { const o = {}; names.forEach(n => { if (images[n]) o[n] = images[n]; }); return o; };
  const common = ['boom.png', 'guide_two.png', 'guide_box.png', 'guide_pipe.png'];
  const files = [
    ['예시_성적서_MX14_S01-S04.xlsx', f1, pick(common.concat(Object.keys(images).filter(n => /^S0/.test(n))))],
    ['예시_성적서_TX30_붐암.xlsx', f2, pick(common.concat(Object.keys(images).filter(n => /^T01/.test(n))))],
    ['예시_보고서_형식2_LX20.xlsx', f3, pick(['boom.png'].concat(Object.keys(images).filter(n => /^L01/.test(n))))]
  ];
  const b64 = {};
  for (const [name, sheets, imgs] of files) {
    const buf = await writeXlsx(path.join(OUT, name), sheets, imgs);
    b64[name] = buf.toString('base64');
    console.log(name, (buf.length / 1024).toFixed(1) + ' KB');
  }
  // 모양 지문 확인: 서로 다른 사진은 기준(24/256)보다 멀고, 밝기만 바꾼 S04_D 는 S03_D 와 가까워야 합니다
  const names = Object.keys(shots).filter(n => n !== 'S04_D.png');
  let minDiff = 999;
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) minDiff = Math.min(minDiff, L.hamming(shots[names[i]], shots[names[j]]));
  const near = L.hamming(shots['S03_D.png'], shots['S04_D.png']);
  console.log('서로 다른 사진 사이 최소 거리', minDiff, '/ S03_D↔S04_D', near);
  if (!(minDiff > L.SIMILAR_BITS) || !(near <= L.SIMILAR_BITS)) { console.error('예시 사진 모양 지문이 기준과 맞지 않습니다.'); process.exit(1); }

  const js = '/* 자동 생성: node scripts/make-samples.js — 손으로 고치지 마세요.\n * 예시 성적서 3개(가상 협력사·가명·그린 사진)를 base64 로 담았습니다. 파일로 연 화면(file://)에서도 「예시 불러오기」가 되게 하려는 것입니다. */\n' +
    '(function (root) {\n  root.WSample = {\n    files: ' + JSON.stringify(Object.keys(b64)) + ',\n    b64: {\n' +
    Object.keys(b64).map(n => '      ' + JSON.stringify(n) + ': ' + JSON.stringify(b64[n])).join(',\n') + '\n    },\n' +
    '    // 누적 화면을 보여 주기 위한 예시 판정(사람이 한 것처럼) — [파일, 시트, 위치, 판정]\n' +
    '    judgements: ' + JSON.stringify([
      ['예시_성적서_MX14_S01-S04.xlsx', 'MX14 S02', 'A', 'good'], ['예시_성적서_MX14_S01-S04.xlsx', 'MX14 S02', 'B', 'good'], ['예시_성적서_MX14_S01-S04.xlsx', 'MX14 S02', 'E', 'good'],
      ['예시_성적서_MX14_S01-S04.xlsx', 'MX14 S03', 'A', 'good'], ['예시_성적서_MX14_S01-S04.xlsx', 'MX14 S03', 'B', 'good'], ['예시_성적서_MX14_S01-S04.xlsx', 'MX14 S03', 'E', 'suspect'],
      ['예시_성적서_TX30_붐암.xlsx', 'Boom', 'B', 'good'], ['예시_성적서_TX30_붐암.xlsx', 'Boom', 'E', 'unreadable']
    ]) + '\n  };\n})(typeof window !== \'undefined\' ? window : this);\n';
  fs.writeFileSync(path.join(ROOT, 'js/sample-data.js'), js);
  console.log('js/sample-data.js', (js.length / 1024).toFixed(1) + ' KB');
})();
