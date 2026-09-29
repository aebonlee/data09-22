// 실행: node test/logic.test.mjs   (설치할 것 없음 — vendor/ 의 SheetJS·JSZip 을 그대로 씁니다)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = require('../js/logic.js');
const WBook = require('../js/workbook.js');
const XLSX = require('../vendor/xlsx.full.min.js');
const JSZip = require('../vendor/jszip.min.js');

let passed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function group(name) { queue.push([null, name]); }

// ── 도우미: 셀 격자 만들기 ('A1': 값) ─────────────────────────────
function gridOf(cells) {
  const g = [];
  for (const [ref, v] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const c = m[1].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1, r = Number(m[2]) - 1;
    (g[r] = g[r] || [])[c] = v;
  }
  for (let r = 0; r < g.length; r++) if (!g[r]) g[r] = [];
  return g;
}
const ITEMS = [['용접누락', '없을 것'], ['용접품질[각장]', "도면각장(z), 1.0z ≤ z' ≤ 1.25z"], ['용접품질[언더컷]', 'h ≤ 0.5mm'], ['용접품질[오버랩]', 'α < 90° 이하이면 결함'],
  ['용접품질[크레이터]', 'h ≤ 1mm'], ['용접품질[기공]', '100mm 당 2개이상, Ø2.5mm'], ['용접품질[연장용접]', '도면 준수'], ['일반', '기종명, Serial No., 서명 누락여부']];
function w2Grid(o = {}) {
  const c = { A1: 'Boom 내부용접 검사성적서', A2: '협력사 명', E2: '기종', G2: '품번', I2: '품명 / 옵션정보', A4: '검사일', E4: 'Serial No.', G4: '용접사', I4: '검사원',
    A37: 'No.', C37: '검사항목', E37: '검사기준 (W2)', I37: '검사결과(정량적 기입)' };
  const h = Object.assign({ partner: '협력사X', model: 'MX14', partNo: 'P-1', date: new Date(2026, 8, 21), serial: 'S01', welder: '용접사A', inspector: '검사원A' }, o.header || {});
  if (h.partner != null) c.A3 = h.partner; if (h.model != null) c.E3 = h.model; if (h.partNo != null) c.G3 = h.partNo;
  if (h.date != null) c.A5 = h.date; if (h.serial != null) c.E5 = h.serial; if (h.welder != null) c.G5 = h.welder; if (h.inspector != null) c.I5 = h.inspector;
  [17, 24, 31].forEach(r => ['E', 'I'].forEach(col => { c[col + r] = '기종명, Serial No.,'; c[col + (r + 2)] = '사진 촬영'; }));
  const res = o.results || ITEMS.map(() => 'OK');
  ITEMS.forEach((it, i) => { c['A' + (38 + i)] = i + 1; c['C' + (38 + i)] = it[0]; c['E' + (38 + i)] = it[1]; if (res[i] != null) c['I' + (38 + i)] = res[i]; });
  return gridOf(c);
}
// 위치 A~F 의 가이드(B열/G열)·사진(E열/I열)·각장 숫자 잎(leaf)
function w2Leaves(o = {}) {
  const leaves = [];
  const rows = [15, 22, 29];
  L.POS6.forEach((p, i) => {
    const band = Math.floor(i / 2), right = i % 2, r0 = rows[band];
    const g0 = right ? 6.05 : 1.05, pc = right ? 8.02 : 4.02;
    if (!(o.noGuide || []).includes(p)) leaves.push({ kind: 'pic', target: 'xl/media/g' + p + '.png', c0: g0, c1: g0 + 1.8, r0, r1: r0 + 6, col: g0 + 0.9, row: r0 + 3 });
    (o.sizes && o.sizes[p] || [7]).forEach(z => leaves.push({ kind: 'text', text: String(z), c0: g0 + 0.5, c1: g0 + 0.6, r0: r0 + 2, r1: r0 + 2.5, col: g0 + 0.55, row: r0 + 2.25 }));
    if (!(o.noPhoto || []).includes(p)) leaves.push({ kind: 'pic', target: 'xl/media/p' + p + '.jpeg', c0: pc, c1: pc + 1.3, r0: r0 + 0.5, r1: r0 + 4.5, col: pc + 0.65, row: r0 + 2.5 });
  });
  leaves.push({ kind: 'pic', target: 'xl/media/logo.png', c0: 0, c1: 1, r0: 0, r1: 1, col: 0.5, row: 0.5 });
  leaves.push({ kind: 'pic', target: 'xl/media/boom.png', c0: 0.3, c1: 9, r0: 6.2, r1: 13.8, col: 4.6, row: 10 });
  return leaves;
}
function w2Rep(o = {}) {
  const r = L.analyzeSheet({ fileName: 'a.xlsx', fileHash: o.fileHash || 'h1', sheetName: o.sheet || 'S01', grid: w2Grid(o), leaves: w2Leaves(o) });
  r.positions.forEach(p => p.photos.forEach(ph => { ph.hash = ph.target + '@' + (o.sheet || 'S01'); ph.dhash = null; }));
  return r;
}
const codes = f => f.map(x => x.code);

group('XML · 관계 · 경로');
test('XML 파서 — 중첩·속성·엔티티·자체 닫힘', () => {
  const t = L.parseXml('<a x="1&amp;2"><b:c y=\'q\'/><d>가&lt;나</d></a>');
  const a = t.children[0];
  assert.equal(a.attrs.x, '1&2');
  assert.equal(a.children[0].name, 'b:c');
  assert.equal(a.children[1].text, '가<나');
});
test('관계 파일 읽기와 상대 경로 풀기', () => {
  const r = L.parseRels('<Relationships><Relationship Id="rId1" Type="t/image" Target="../media/image3.jpeg"/></Relationships>');
  assert.equal(r.rId1.target, '../media/image3.jpeg');
  assert.equal(L.resolvePath('xl/drawings/drawing1.xml', '../media/image3.jpeg'), 'xl/media/image3.jpeg');
  assert.equal(L.resolvePath('xl/workbook.xml', 'worksheets/sheet2.xml'), 'xl/worksheets/sheet2.xml');
  assert.equal(L.resolvePath('xl/workbook.xml', '/xl/worksheets/sheet2.xml'), 'xl/worksheets/sheet2.xml');
  assert.equal(L.relsPathOf('xl/worksheets/sheet1.xml'), 'xl/worksheets/_rels/sheet1.xml.rels');
});

group('그림 좌표 — 앵커·그룹 변환·열 너비');
const GEOM_XML = '<worksheet><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="3" width="10" customWidth="1"/></cols><drawing r:id="rId1"/></worksheet>';
test('열 너비(글자 수) → 칸, 행 높이(pt) → 칸', () => {
  const g = L.parseSheetGeometry(GEOM_XML);
  assert.equal(g.drawingRid, 'rId1');
  const colEmu = 70 * 9525; // width 10, MDW 7 → floor((2560+18)/256×7) = 70px
  const p = L.emuToCell(g, colEmu * 1.5, 15 * 12700 * 2.25);
  assert.ok(Math.abs(p.col - 1.5) < 1e-9 && Math.abs(p.row - 2.25) < 1e-9, JSON.stringify(p));
});
test('twoCellAnchor 그림 + 그룹 안(자식 좌표계가 다른) 그림·글상자의 위치를 시트 칸으로 환산', () => {
  const g = L.parseSheetGeometry(GEOM_XML);
  const W = 70 * 9525, H = 15 * 12700;
  const xml = '<xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:r="r">' +
    '<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
    '<xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></xdr:spPr></xdr:pic></xdr:twoCellAnchor>' +
    // 그룹: 앵커 = 열 0~2, 행 10~14. 자식 좌표계 1000..3000 x 500..1300 → 오른쪽 아래 1/4 에 그림, 왼쪽 위 글상자 「7」
    '<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
    '<xdr:grpSp><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="1000" y="500"/><a:chExt cx="2000" cy="800"/></a:xfrm></xdr:grpSpPr>' +
    '<xdr:pic><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="2000" y="900"/><a:ext cx="1000" cy="400"/></a:xfrm></xdr:spPr></xdr:pic>' +
    '<xdr:sp><xdr:spPr><a:xfrm><a:off x="1000" y="500"/><a:ext cx="200" cy="80"/></a:xfrm></xdr:spPr><xdr:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></xdr:txBody></xdr:sp>' +
    '</xdr:grpSp></xdr:twoCellAnchor></xdr:wsDr>';
  const rels = '<Relationships><Relationship Id="rId1" Target="../media/image1.png"/><Relationship Id="rId2" Target="../media/image2.jpeg"/></Relationships>';
  const lv = L.parseDrawing(xml, rels, g, 'xl/drawings/drawing1.xml');
  assert.equal(lv.length, 3);
  assert.equal(lv[0].target, 'xl/media/image1.png');
  assert.deepEqual([lv[0].c0, lv[0].r0, lv[0].c1, lv[0].r1].map(x => Math.round(x * 100) / 100), [1, 2, 2, 4]);
  // 그룹 안 그림: 자식 좌표 2000~3000 → 50%~100% → 열 1~2, 900~1300 → 50%~100% → 행 12~14
  assert.equal(lv[1].target, 'xl/media/image2.jpeg');
  assert.deepEqual([lv[1].c0, lv[1].r0, lv[1].c1, lv[1].r1].map(x => Math.round(x * 100) / 100), [1, 12, 2, 14]);
  assert.equal(lv[2].kind, 'text'); assert.equal(lv[2].text, '7');
  assert.ok(Math.abs(lv[2].c0) < 1e-6 && Math.abs(lv[2].r0 - 10) < 1e-6);
  void W; void H;
});
test('열 너비 환산 폭(MDW) 맞추기 — 앵커 오프셋이 열 너비를 넘지 않는 가장 작은 값', () => {
  const g = L.parseSheetGeometry(GEOM_XML);
  // 70px(MDW 7) 열에 오프셋 76px → MDW 8(80px)이어야 들어갑니다
  const d = L.fitMdw(g, '<xdr:col>1</xdr:col><xdr:colOff>' + 76 * 9525 + '</xdr:colOff>');
  assert.equal(d, 8);
});

group('날짜 · 양식 · 머리칸 · 결과표');
test('검사일: 날짜·일련번호·글자 날짜는 ok, 「월     일」은 양식 글자, 빈칸, 날짜 아님', () => {
  assert.equal(L.readDate(new Date(2026, 8, 14)).iso, '2026-09-14');
  assert.equal(L.readDate(46279).iso, '2026-09-14');
  assert.equal(L.readDate('2026.9.14').iso, '2026-09-14');
  assert.equal(L.readDate('월     일').status, 'placeholder');
  assert.equal(L.readDate('  ').status, 'blank');
  assert.equal(L.readDate('2026-02-30').status, 'invalid');
  assert.equal(L.readDate('다음주').status, 'invalid');
});
test('양식 판별: 내부용접 검사성적서 = W2, 공정 검사 보고서 = P2, 그 밖 = 모름(멈추지 않고 알림)', () => {
  assert.equal(L.detectLayout(gridOf({ A1: 'Arm 내부용접 검사성적서' })).id, 'W2');
  assert.equal(L.detectLayout(gridOf({ A1: '제 관 / 용 접(내부) 공  정  검  사  보  고  서(2/1)\n(WELD INSPECTION REPORT)' })).id, 'P2');
  const r = L.analyzeSheet({ fileName: 'x.xlsx', fileHash: 'h', sheetName: 'Sheet1', grid: gridOf({ A1: '월간 생산 계획' }), leaves: [] });
  assert.equal(r.layout, null);
  assert.match(r.error, /알 수 없는 양식/);
  assert.deepEqual(codes(L.checkReport(r)), ['LAYOUT']);
  const r2 = L.analyzeSheet({ fileName: 'x.xlsx', fileHash: 'h', sheetName: 'S', grid: gridOf({ A1: 'Boom 내부용접 검사성적서' }), leaves: [] });
  assert.match(r2.error, /결과표/);
});
test('머리칸: 이름표 바로 아래 칸 (형식2의 띄어쓴 이름표 「LOT NO」·「작업자」·「검사자」 포함)', () => {
  const h = L.readHeader(w2Grid());
  assert.equal(h.partner, '협력사X'); assert.equal(h.serial, 'S01'); assert.equal(h.welder, '용접사A'); assert.equal(h.dateIso, '2026-09-21');
  const p = L.readHeader(gridOf({ A2: '                          기종', C2: '                           품번', E2: '작업자', A3: 'LX20', E3: '용접사D', A4: '날짜', C4: '                        LOT NO', E4: '                         검사자', C5: 'L01' }));
  assert.equal(p.model, 'LX20'); assert.equal(p.welder, '용접사D'); assert.equal(p.serial, 'L01');
  assert.equal(p.inspector, ''); assert.equal(p.partner, null); assert.equal(p.dateStatus, 'blank');
});
test('결과표: 8항목, 「정량적 기입」 표시, 형식2의 「확 인」 열', () => {
  const r = L.readResults(w2Grid({ results: ['OK', '7'] }));
  assert.equal(r.items.length, 8); assert.equal(r.quantitative, true);
  assert.equal(r.items[1].item, '용접품질[각장]'); assert.equal(r.items[1].value, '7'); assert.equal(r.items[2].value, '');
  const p = L.readResults(gridOf({ A42: '검      사      항      목', F42: '확 인', A43: '1. 내부용접 누락 여부', F43: 'OK', A44: '2. 언더컷', F44: 'NG' }));
  assert.equal(p.items.length, 2); assert.equal(p.quantitative, false); assert.equal(p.items[0].item, '내부용접 누락 여부');
});

group('사진 위치 배정');
test('W2: 세 줄(A·B/C·D/E·F) × 좌우, E·I 열 = 실제 사진, 그 밖 = 가이드, 가이드 위 숫자 = 도면 각장, 안내도·로고 제외', () => {
  const r = w2Rep({ sizes: { A: [5, 5], C: [7, 6, 6, 7] } });
  assert.equal(r.layout, 'W2'); assert.equal(r.part, 'Boom');
  assert.deepEqual(r.positions.map(p => p.pos), L.POS6);
  assert.deepEqual(r.positions.map(p => [p.guides.length, p.photos.length]), L.POS6.map(() => [1, 1]));
  assert.equal(r.positions[0].photos[0].target, 'xl/media/pA.jpeg');
  assert.equal(r.positions[5].photos[0].target, 'xl/media/pF.jpeg');
  assert.deepEqual(r.positions[0].sizes, [5, 5]);
  assert.deepEqual(r.positions[2].sizes, [6, 6, 7, 7]);
  assert.equal(r.overview.target, 'xl/media/boom.png');
});
test('W2: 가이드가 있는 위치만 「사진 있어야 함」(Arm 처럼 A~E 만 있는 양식)', () => {
  const r = w2Rep({ noGuide: ['F'], noPhoto: ['F'] });
  assert.deepEqual(r.positions.map(p => p.expected), [true, true, true, true, true, false]);
});
test('P2: 도면 아래 번호표(1·2) 기준으로 사진 배정 — 도면 위에 겹친 번호는 무시', () => {
  const grid = gridOf({ A1: '제관/용접(내부) 공정 검사 보고서', A2: '기종', A3: 'LX20', A42: '검 사 항 목', F42: '확 인', A43: '1. 내부용접 누락 여부', F43: 'OK' });
  const leaves = [
    { kind: 'pic', target: 'xl/media/draw.png', c0: 0.3, c1: 5.6, r0: 10, r1: 17.4, col: 3, row: 13.7 },
    { kind: 'text', text: '2', c0: 2, c1: 2.2, r0: 12.3, r1: 13.2, col: 2.1, row: 12.7 },
    { kind: 'text', text: '1', c0: 0.2, c1: 0.4, r0: 20.4, r1: 21.3, col: 0.3, row: 20.8 },
    { kind: 'text', text: '2', c0: 4.1, c1: 4.3, r0: 20.4, r1: 21.3, col: 4.2, row: 20.8 },
    { kind: 'pic', target: 'xl/media/a.jpeg', c0: 0.2, c1: 1.8, r0: 23, r1: 29, col: 1, row: 26 },
    { kind: 'pic', target: 'xl/media/b.jpeg', c0: 2.2, c1: 3.8, r0: 23, r1: 29, col: 3, row: 26 },
    { kind: 'pic', target: 'xl/media/c.jpeg', c0: 4.2, c1: 5.8, r0: 23, r1: 29, col: 5, row: 26 }
  ];
  const r = L.analyzeSheet({ fileName: 'p.xlsx', fileHash: 'h', sheetName: '내부용접-01', grid, leaves });
  assert.equal(r.layout, 'P2');
  assert.deepEqual(r.positions.map(p => [p.pos, p.photos.length]), [['1', 2], ['2', 1]]);
  assert.equal(r.overview.target, 'xl/media/draw.png');
});

group('규칙 점검');
test('정상 성적서는 오류 없음(정량 기입 항목을 수치로 적은 경우)', () => {
  const r = w2Rep({ sizes: { A: [5], B: [7], C: [7], D: [7], E: [7], F: [5] }, results: ['OK', 'A 5.5, B 7.2', '0.2', '110°', '0.3', '0개', 'OK', 'OK'] });
  const f = L.checkReport(r);
  assert.deepEqual(f.filter(x => x.level === 'error'), []);
  assert.equal(f.summary.withPhoto, 6);
});
test('검사일 양식 글자 · 빈칸 → 오류', () => {
  assert.ok(codes(L.checkReport(w2Rep({ header: { date: '월     일' } }))).includes('DATE_PLACEHOLDER'));
  assert.ok(codes(L.checkReport(w2Rep({ header: { date: '' } }))).includes('DATE_BLANK'));
});
test('Serial · 용접사 · 검사원 빈칸 → 오류 각각', () => {
  const f = L.checkReport(w2Rep({ header: { serial: '', welder: '', inspector: '' } }));
  assert.equal(f.filter(x => x.code === 'MISSING_FIELD').length, 3);
});
test('실제 사진이 없는 위치 → 위치별 오류', () => {
  const f = L.checkReport(w2Rep({ noPhoto: ['F', 'B'] }));
  assert.deepEqual(f.filter(x => x.code === 'NO_PHOTO').map(x => x.pos), ['B', 'F']);
  assert.equal(f.summary.withPhoto, 4);
});
test('「정량적 기입」인데 수치 기준 항목이 OK 만 → 확인 필요 한 건(항목 묶음)', () => {
  const f = L.checkReport(w2Rep());
  const x = f.filter(y => y.code === 'OK_ONLY');
  assert.equal(x.length, 1); assert.equal(x[0].level, 'warn');
  assert.match(x[0].text, /각장 · 언더컷 · 오버랩 · 크레이터 · 기공/);
});
test('각장: 위치별 값이 기준 밖이면 오류, 한 값이 일부 도면 각장에만 맞으면 확인 필요', () => {
  const sizes = { A: [5, 5], B: [7, 7], C: [7, 6], D: [6], E: [7], F: [5] };
  const bad = L.checkReport(w2Rep({ sizes, results: ['OK', 'A 5.2, B 9.4'] }));
  const out = bad.filter(x => x.code === 'LEG_OUT');
  assert.equal(out.length, 1); assert.match(out[0].text, /위치 B 각장 9\.4.*7~8\.75/);
  const one = L.checkReport(w2Rep({ sizes, results: ['OK', '7'] }));
  assert.ok(codes(one).includes('LEG_PARTIAL'));
  assert.match(one.filter(x => x.code === 'LEG_PARTIAL')[0].text, /도면 각장 5/);
  const allBad = L.checkReport(w2Rep({ sizes, results: ['OK', '12'] }));
  assert.ok(codes(allBad).includes('LEG_OUT'));
  const ok = L.checkReport(w2Rep({ sizes: { A: [7], B: [7], C: [7], D: [7], E: [7], F: [7] }, results: ['OK', '7.5'] }));
  assert.ok(!codes(ok).some(c => /^LEG/.test(c)));
});
test('각장 기준 글 · 값 읽기', () => {
  assert.deepEqual(L.parseLegCriterion("도면각장(z), 1.0z ≤ z' ≤ 1.25z"), { lo: 1, hi: 1.25 });
  assert.deepEqual(L.parseLegValues('A 5.2, B:7.5, C=6'), { byPos: { A: [5.2], B: [7.5], C: [6] }, all: [] });
  assert.deepEqual(L.parseLegValues('7'), { byPos: {}, all: [7] });
});
test('성적서에 용접누락 이상이 기록돼 있으면 사진과 관계없이 오류(강제 확인)', () => {
  const f = L.checkReport(w2Rep({ results: ['누락', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK'] }));
  assert.ok(codes(f).includes('RECORDED_OMISSION'));
  const g = L.checkReport(w2Rep({ results: ['OK', 'OK', 'NG', 'OK', 'OK', 'OK', 'OK', 'OK'] }));
  assert.ok(codes(g).includes('RECORDED_NG'));
});
test('결과 빈 항목 → 오류, 머리칸·결과·사진 모두 빈 시트 → 「빈 성적서」 한 건만', () => {
  assert.ok(codes(L.checkReport(w2Rep({ results: ['OK', 'OK'] }))).includes('RESULT_BLANK'));
  const empty = L.analyzeSheet({ fileName: 'a.xlsx', fileHash: 'h', sheetName: 'Arm', grid: w2Grid({ header: { partner: null, model: null, partNo: null, date: null, serial: null, welder: null, inspector: null }, results: [] }), leaves: w2Leaves({ noPhoto: L.POS6 }) });
  assert.deepEqual(codes(L.checkReport(empty)), ['EMPTY_SHEET']);
});
test('협력사 칸이 없는 양식은 참고 안내, 사람이 적으면 사라짐', () => {
  const r = w2Rep(); r.header.partner = null;
  assert.ok(codes(L.checkReport(r)).includes('NO_PARTNER_FIELD'));
  r.edit = { partner: '협력사Z' };
  assert.ok(!codes(L.checkReport(r)).includes('NO_PARTNER_FIELD'));
  assert.equal(L.effectivePartner(r), '협력사Z');
});

group('같은 사진 재사용 — 파일 지문 · 모양 지문(dHash)');
function img(w, h, f) { const g = new Float64Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y); return g; }
test('dHash: 밝기만 바꾸거나 크기를 바꿔도 거의 같고, 다른 장면이면 멀다', () => {
  const scene = (x, y) => 100 + 80 * Math.sin(x / 9) * Math.cos(y / 13) + (x > 60 && y > 40 ? 50 : 0);
  const a = L.dhash(img(160, 120, scene), 160, 120, 16);
  const b = L.dhash(img(160, 120, (x, y) => Math.min(255, scene(x, y) * 1.15)), 160, 120, 16);
  const c = L.dhash(img(80, 60, (x, y) => scene(x * 2, y * 2)), 80, 60, 16);
  const d = L.dhash(img(160, 120, (x, y) => 120 + 90 * Math.cos(x / 5 + y / 7)), 160, 120, 16);
  assert.equal(a.length, 64);
  assert.ok(L.hamming(a, b) <= 4, 'bright ' + L.hamming(a, b));
  assert.ok(L.hamming(a, c) <= 12, 'resize ' + L.hamming(a, c));
  assert.ok(L.hamming(a, d) > L.SIMILAR_BITS, 'different ' + L.hamming(a, d));
});
test('파일 지문: 같은 바이트는 같고, 한 바이트만 달라도 다름', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5]), b = new Uint8Array([1, 2, 3, 4, 6]);
  assert.equal(L.bytesHash(a), L.bytesHash(new Uint8Array([1, 2, 3, 4, 5])));
  assert.notEqual(L.bytesHash(a), L.bytesHash(b));
});
test('다른 Serial 의 같은 사진 → 양쪽에 오류, 비슷한 사진 → 확인 필요, 먼 사진 → 없음', () => {
  const r1 = w2Rep({ sheet: 'S01', fileHash: 'f' }), r2 = w2Rep({ sheet: 'S02', fileHash: 'f' });
  r2.positions[1].photos[0].hash = r1.positions[1].photos[0].hash;             // B 재사용
  r1.positions[3].photos[0].dhash = 'f'.repeat(64);
  r2.positions[3].photos[0].dhash = 'f'.repeat(60) + '0000';                    // D: 16비트 차이
  r1.positions[4].photos[0].dhash = 'a'.repeat(64); r2.positions[4].photos[0].dhash = '5'.repeat(64); // E: 256비트 차이
  const out = L.checkReuse([r1, r2]);
  assert.deepEqual(out[r1.id].map(x => [x.code, x.pos]).sort(), [['REUSED_PHOTO', 'B'], ['SIMILAR_PHOTO', 'D']]);
  assert.deepEqual(out[r2.id].map(x => [x.code, x.pos]).sort(), [['REUSED_PHOTO', 'B'], ['SIMILAR_PHOTO', 'D']]);
  assert.match(out[r2.id].find(x => x.code === 'REUSED_PHOTO').text, /S01 · 위치 B/);
  const strict = L.checkReuse([r1, r2], { similarBits: 8 });
  assert.deepEqual(strict[r1.id].map(x => x.code), ['REUSED_PHOTO']);
});
test('같은 성적서 안 다른 위치에 같은 사진 → 오류', () => {
  const r = w2Rep();
  r.positions[5].photos[0].hash = r.positions[0].photos[0].hash;
  assert.equal(L.checkReuse([r])[r.id].filter(x => x.code === 'REUSED_PHOTO').length, 2);
});

group('판정 · 용접사별 누적 · CSV');
test('판정은 덧붙이기만, 마지막 기록이 현재 판정', () => {
  const db = L.emptyDb();
  L.addJudgement(db, { reportId: 'r1', pos: 'A', verdict: 'good' });
  L.addJudgement(db, { reportId: 'r1', pos: 'A', verdict: 'suspect', memo: '아래 모서리' });
  assert.equal(db.judgements.length, 2);
  assert.equal(L.latestJudgements(db.judgements)['r1|A'].verdict, 'suspect');
  assert.throws(() => L.addJudgement(db, { reportId: 'r1', pos: 'A', verdict: 'maybe' }), /양호/);
});
test('용접사별: 판정한 위치·누락 의심·비율, 용접사 여럿이면 각자, 협력사·기종 거르기', () => {
  const a = w2Rep({ sheet: 'S01', header: { welder: '용접사A' } });
  const b = w2Rep({ sheet: 'S02', header: { welder: '용접사A, 용접사B', model: 'TX30', partner: '협력사Y' } });
  const js = [];
  const add = (r, p, v) => js.push({ reportId: r.id, pos: p, verdict: v });
  add(a, 'A', 'good'); add(a, 'B', 'suspect'); add(a, 'C', 'good'); add(a, 'D', 'unreadable');
  add(b, 'A', 'suspect'); add(b, 'A', 'good'); // 고쳐서 양호
  add(b, 'E', 'suspect');
  const s = L.welderStats([a, b], js);
  const A = s.find(x => x.welder === '용접사A' && x.partner === '협력사X');
  assert.deepEqual([A.reports, A.judged, A.good, A.suspect, A.unreadable, A.suspectReports], [1, 4, 2, 1, 1, 1]);
  assert.equal(A.rate, 0.25);
  const BY = s.find(x => x.welder === '용접사B');
  assert.deepEqual([BY.partner, BY.judged, BY.suspect, BY.rate], ['협력사Y', 2, 1, 0.5]);
  assert.equal(s[0].rate, 0.5); // 비율 높은 순
  assert.deepEqual(L.welderStats([a, b], js, { partner: '협력사Y' }).map(x => x.welder).sort(), ['용접사A', '용접사B']);
  assert.deepEqual(L.welderStats([a, b], js, { model: 'MX14' }).map(x => x.welder), ['용접사A']);
  const csv = L.welderCsv(s);
  assert.ok(csv.startsWith('﻿용접사,협력사'));
  assert.match(csv, /용접사B,협력사Y,TX30,1,1,2,1,1,0,50%,1/);
});
test('점검 결과 CSV 에 수준·위치·내용', () => {
  const r = w2Rep({ header: { date: '월 일' }, noPhoto: ['F'] });
  const csv = L.findingsCsv([r], L.allFindings([r]));
  assert.match(csv, /오류,F,위치 F — 실제 사진이 없습니다/);
  assert.match(csv, /오류,,검사일이 양식 글자/);
});

group('AI 도우미(반자동) — 요청문 · 답 읽기');
test('요청문에 위치·도면 각장·첨부 순서·JSON 형식', () => {
  const r = w2Rep({ sizes: { B: [7, 7] } });
  const p = L.buildPrompt(r, 'B');
  assert.match(p, /위치: B \(도면 각장: 7, 7mm\)/);
  assert.match(p, /첫째 = 촬영 가이드/);
  assert.match(p, /"판정": "양호 \| 누락 의심 \| 판독 불가"/);
  assert.match(p, /해줘/);
});
test('답 읽기: JSON · 코드블록 · 줄 글 · 신뢰도 백분율, 판정 없으면 null', () => {
  assert.deepEqual(L.parseAiAnswer('```json\n{"판정": "누락 의심", "사유": "아래 모서리 비드 없음", "신뢰도": 0.8}\n```'), { verdict: 'suspect', reason: '아래 모서리 비드 없음', confidence: 0.8 });
  assert.equal(L.parseAiAnswer('판정: 판독 불가\n사유: 어두움\n신뢰도: 60').confidence, 0.6);
  assert.equal(L.parseAiAnswer('판정: 판독 불가').verdict, 'unreadable');
  assert.equal(L.parseAiAnswer('{"verdict":"good"}').verdict, 'good');
  assert.equal(L.parseAiAnswer('잘 모르겠습니다'), null);
});

group('백업');
test('백업에 API 키가 들어가지 않고, 다른 도구 파일은 거부', () => {
  const db = L.emptyDb(); db.settings.api_key = 'sk-secret';
  const b = JSON.stringify(L.makeBackup(db));
  assert.ok(!b.includes('sk-secret'));
  assert.throws(() => L.parseBackup('{"app":"data09-08"}'), /백업 파일이 아닙니다/);
  assert.equal(L.parseBackup(b).settings.offline_mode, true);
});

group('예시 엑셀 파일 전체 읽기 (SheetJS + JSZip, 브라우저와 같은 코드)');
function pngGray(buf) { // 이 저장소 생성기가 만든 PNG(8비트 RGB, 필터 0)만 풉니다
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const parts = []; let o = 8;
  while (o < buf.length) { const n = buf.readUInt32BE(o), t = buf.toString('ascii', o + 4, o + 8); if (t === 'IDAT') parts.push(buf.subarray(o + 8, o + 8 + n)); o += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(parts)), g = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; g[y * w + x] = 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]; }
  return { g, w, h };
}
async function readSample(name) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'samples', name)));
  const out = await WBook.read({ JSZip, XLSX, WLogic: L }, bytes, name);
  out.reports.forEach(r => r.positions.forEach(p => p.photos.forEach(ph => { const m = out.media[ph.target]; const d = pngGray(Buffer.from(m.bytes)); ph.dhash = L.dhash(d.g, d.w, d.h, 16); })));
  return out;
}
test('MX14 4장: 머리칸·위치별 사진 수·각장 숫자·검사일 양식 글자·S04 위치 F 사진 없음', async () => {
  const { reports } = await readSample('예시_성적서_MX14_S01-S04.xlsx');
  assert.deepEqual(reports.map(r => r.header.serial), ['S01', 'S02', 'S03', 'S04']);
  assert.deepEqual(reports.map(r => r.positions.map(p => p.photos.length).join('')), ['111111', '111111', '111111', '111110']);
  assert.deepEqual(reports[0].positions.map(p => p.sizes.join('/')), ['5/5', '7/7/7/7', '6/6/7/7', '6/6/7/7', '7/7/7/7', '5/5/5']);
  assert.equal(reports[0].header.dateStatus, 'placeholder');
  assert.equal(reports[1].header.dateIso, '2026-09-21');
});
test('예시 3파일 전체 점검: 재사용(같은 파일)·비슷한 사진·빈 Arm·각장 기준 밖·검사원 빈칸', async () => {
  const all = [];
  for (const n of ['예시_성적서_MX14_S01-S04.xlsx', '예시_성적서_TX30_붐암.xlsx', '예시_보고서_형식2_LX20.xlsx']) all.push(...(await readSample(n)).reports);
  assert.equal(all.length, 7);
  const F = L.allFindings(all);
  const by = s => all.find(r => r.sheetName === s);
  const has = (s, code, pos) => (F[by(s).id] || []).some(f => f.code === code && (pos == null || f.pos === pos));
  assert.ok(has('MX14 S01', 'DATE_PLACEHOLDER'));
  assert.ok(has('MX14 S04', 'NO_PHOTO', 'F'));
  assert.ok(has('MX14 S04', 'REUSED_PHOTO', 'B') && has('MX14 S02', 'REUSED_PHOTO', 'B'));
  assert.ok(has('MX14 S04', 'SIMILAR_PHOTO', 'D') && has('MX14 S03', 'SIMILAR_PHOTO', 'D'));
  assert.ok(has('Boom', 'LEG_OUT'));
  assert.deepEqual(F[by('Arm').id].map(f => f.code), ['EMPTY_SHEET']);
  assert.ok(has('내부용접-01', 'MISSING_FIELD'));
  assert.deepEqual(by('내부용접-01').positions.map(p => [p.pos, p.photos.length]), [['1', 2], ['2', 1]]);
  // 그 밖의 사진끼리는 재사용·비슷함으로 잡히지 않아야 합니다(거짓 경보 없음)
  const reuse = Object.values(F).flat().filter(f => /PHOTO$/.test(f.code) && f.code !== 'NO_PHOTO');
  assert.equal(reuse.length, 4);
});
test('.xls(옛 형식)·엑셀 아닌 파일은 멈추지 않고 이유를 알려 줌', async () => {
  const ole = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]);
  await assert.rejects(WBook.read({ JSZip, XLSX, WLogic: L }, ole, 'a.xls'), e => e.code === 'XLS' && /\.xlsx 로 다시 저장/.test(e.message));
  await assert.rejects(WBook.read({ JSZip, XLSX, WLogic: L }, new Uint8Array([1, 2, 3, 4, 5]), 'a.txt'), e => e.code === 'NOT_XLSX');
});

group('폐쇄망 — 외부로 나가는 요청 코드 검사');
{
  const files = ['index.html', 'css/style.css', 'vendor/xlsx.full.min.js', 'vendor/jszip.min.js'].concat(fs.readdirSync(path.join(ROOT, 'js')).map(f => 'js/' + f));
  const NET = /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource|sendBeacon|importScripts\s*\(|<script[^>]+src=["']?https?:|<link[^>]+href=["']?https?:|@import|url\(\s*["']?https?:|\.src\s*=\s*["']https?:/g;
  const hits = [];
  files.forEach(f => { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); let m; NET.lastIndex = 0; while ((m = NET.exec(t))) hits.push(f + ': ' + m[0]); });
  test('네트워크 요청 코드는 js/ai.js 의 fetch 한 곳뿐(AI 도우미, 폐쇄망 모드에서 막힘)', () => assert.deepEqual(hits, ['js/ai.js: fetch(']));
  test('ai.js 는 폐쇄망 모드가 꺼져 있을 때만 요청(가드 문구 존재)', () => {
    assert.ok(/if\s*\(\s*opts\.offline\s*!==\s*false\s*\)/.test(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8')));
  });
  test('index.html 보안 정책이 api.openai.com 밖으로의 연결을 막음', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /connect-src https:\/\/api\.openai\.com;/);
  });
  test('기본 설정은 폐쇄망 모드 켬', () => assert.equal(L.emptyDb().settings.offline_mode, true));
}

// ── 실행 ────────────────────────────────────────────────────
for (const [name, fn] of queue) {
  if (name === null) { console.log(fn); continue; }
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); process.exitCode = 1; }
}
console.log(process.exitCode ? '\n실패 있음' : '\n전부 통과 ' + passed + '건');
