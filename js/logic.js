/*
 * 용접누락 방지 검출 — 순수 로직 모듈 (화면·저장소·파일 읽기와 무관)
 * 브라우저에서는 window.WLogic, Node(테스트)에서는 module.exports 로 씁니다.
 * ES module 이 아닌 이유: index.html 을 로컬 파일(file://)로 열었을 때
 * 브라우저가 module 스크립트를 막기 때문입니다.
 *
 * 흐름
 *   엑셀(xlsx = zip) ─ js/workbook.js 가 풀어서 ─▶ 시트마다 { grid(셀 값 2차원), 그림 목록 }
 *   ─▶ analyzeSheet()  : 양식 판별 · 머리칸 · 결과표 · 그림을 위치(A~F / 1·2)에 배정
 *   ─▶ checkReport()   : 규칙 점검(AI 없음) — 검사일·빈칸·사진 누락·「OK」만 기입·각장 범위·기록된 불량
 *   ─▶ checkReuse()    : 같은 사진 재사용(파일 지문 + 모양 지문 dHash)
 *   ─▶ 사람이 위치별로 양호 / 누락 의심 / 판독 불가 판정 ─▶ welderStats() 용접사별 누적
 *
 * 그림 위치 계산: 엑셀 그림은 셀에 「붙어(anchor)」 있습니다. drawing XML 의 from/to(열·행 + 오프셋)와
 * 그룹 안 좌표 변환을 따라가 그림마다 중심점의 (열, 행)을 소수로 구하고, 양식별 규칙으로 위치를 정합니다.
 */
(function (root) {
  'use strict';

  var EMU_PX = 9525;     // 1px = 9525 EMU (96dpi)
  var EMU_PT = 12700;    // 1pt = 12700 EMU
  // 엑셀 열 너비는 「글자 수」로 적혀 있어 기본 글꼴의 숫자 폭(MDW, px)을 곱해야 길이가 됩니다.
  // 영문 기본 글꼴은 7px, 돋움·맑은 고딕 11pt 는 8px 안팎이라 파일마다 fitMdw() 로 맞춥니다.
  var POS6 = ['A', 'B', 'C', 'D', 'E', 'F'];
  var SIMILAR_BITS = 24; // 256비트 dHash 에서 이 값 이하면 「비슷한 사진」(실측 근거는 개발일지)

  var VERDICT = { good: '양호', suspect: '누락 의심', unreadable: '판독 불가' };
  var LEVEL = { error: '오류', warn: '확인 필요', info: '참고' };

  function str(v) { return v == null ? '' : String(v).trim(); }
  // 공백·구두점을 걷고 소문자로 — 「협력사 명」·「협력사명」, 「LOT NO」·「lotno」를 같게 봅니다
  function norm(v) { return str(v).toLowerCase().replace(/[\s_\-·:()（）]+/g, ''); }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

  // ── 최소 XML 파서 (브라우저·Node 공통, 의존성 없음) ──────────────
  function decodeEnt(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, function (m, e) {
      var k = e.toLowerCase();
      if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'amp') return '&';
      if (k === 'quot') return '"'; if (k === 'apos') return "'";
      return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    });
  }
  function parseAttrs(s) {
    var o = {}, re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(s))) o[m[1]] = decodeEnt(m[3] != null ? m[3] : m[4]);
    return o;
  }
  function parseXml(xml) {
    var rootNode = { name: '#root', attrs: {}, children: [], text: '' };
    var stack = [rootNode];
    var re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g, m;
    while ((m = re.exec(xml))) {
      var top = stack[stack.length - 1];
      if (m[1] != null) { top.text += m[1]; continue; }
      if (m[3]) {
        if (m[2] === '/') { if (stack.length > 1) stack.pop(); continue; }
        var node = { name: m[3], attrs: parseAttrs(m[4]), children: [], text: '' };
        top.children.push(node);
        if (!m[5]) stack.push(node);
        continue;
      }
      if (m[6] != null) top.text += decodeEnt(m[6]);
    }
    return rootNode;
  }
  function local(name) { var i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); }
  function kid(node, ln) { if (!node) return null; for (var i = 0; i < node.children.length; i++) if (local(node.children[i].name) === ln) return node.children[i]; return null; }
  function kids(node, ln) { return node ? node.children.filter(function (c) { return local(c.name) === ln; }) : []; }
  function find(node, ln) { // 깊이 우선 첫 번째
    if (!node) return null;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (local(c.name) === ln) return c;
      var f = find(c, ln); if (f) return f;
    }
    return null;
  }
  function allText(node) { // a:t 글자 모으기
    var out = [];
    (function walk(n) { n.children.forEach(function (c) { if (local(c.name) === 't') out.push(c.text); else walk(c); }); })(node);
    return out.join('');
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  // ── 관계 파일 · 경로 ──────────────────────────────────────────
  function parseRels(xml) {
    var o = {};
    if (!xml) return o;
    kids(parseXml(xml).children[0] || { children: [] }, 'Relationship').forEach(function (r) { o[r.attrs.Id] = { target: r.attrs.Target, type: r.attrs.Type || '', mode: r.attrs.TargetMode || '' }; });
    return o;
  }
  // base 파일 기준 상대 경로 풀기: ('xl/worksheets/sheet1.xml', '../drawings/drawing1.xml') → 'xl/drawings/drawing1.xml'
  function resolvePath(base, target) {
    if (!target) return '';
    if (target[0] === '/') return target.slice(1);
    var parts = base.split('/'); parts.pop();
    target.split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); });
    return parts.join('/');
  }
  function relsPathOf(path) { var i = path.lastIndexOf('/'); return path.slice(0, i) + '/_rels/' + path.slice(i + 1) + '.rels'; }
  // workbook.xml → 시트 순서대로 [{ name, path }]
  function parseWorkbookSheets(wbXml, wbRelsXml) {
    var rels = parseRels(wbRelsXml);
    var sheets = find(parseXml(wbXml), 'sheets');
    return kids(sheets, 'sheet').map(function (s) {
      var rid = s.attrs['r:id'] || s.attrs.id || '';
      var r = rels[rid];
      return { name: s.attrs.name, path: r ? resolvePath('xl/workbook.xml', r.target) : '' };
    });
  }

  // ── 시트 치수(열 너비·행 높이) → 그림 좌표 환산 ─────────────────────
  function colPx(width, mdw) { return Math.floor(((256 * width + Math.floor(128 / mdw)) / 256) * mdw); }
  function parseSheetGeometry(sheetXml) {
    var g = { colW: {}, rowPt: {}, defColW: 8.43, defRowPt: 15, drawingRid: '', mdw: 7 };
    var fmt = /<sheetFormatPr\b([^>]*)>/.exec(sheetXml);
    if (fmt) {
      var a = parseAttrs(fmt[1]);
      if (a.defaultRowHeight) g.defRowPt = num(a.defaultRowHeight, 15);
      if (a.defaultColWidth) g.defColW = num(a.defaultColWidth, 8.43);
      else if (a.baseColWidth) g.defColW = num(a.baseColWidth, 8) + 0.71;
    }
    var re = /<col\b([^>]*)\/?>/g, m;
    while ((m = re.exec(sheetXml))) {
      var c = parseAttrs(m[1]);
      if (c.width == null) continue;
      var w = c.hidden === '1' || c.hidden === 'true' ? 0 : num(c.width, 8.43);
      for (var i = num(c.min, 1); i <= num(c.max, 1) && i <= 256; i++) g.colW[i - 1] = w;
    }
    re = /<row\b([^>]*)>/g;
    while ((m = re.exec(sheetXml))) {
      var r = parseAttrs(m[1]);
      if (r.r == null) continue;
      if (r.hidden === '1') g.rowPt[num(r.r, 1) - 1] = 0;
      else if (r.ht != null) g.rowPt[num(r.r, 1) - 1] = num(r.ht, g.defRowPt);
    }
    var d = /<drawing\b[^>]*r:id="([^"]+)"/.exec(sheetXml);
    if (d) g.drawingRid = d[1];
    return g;
  }
  function colEmu(g, c) { var w = g.colW[c] != null ? g.colW[c] : g.defColW; return w ? colPx(w, g.mdw) * EMU_PX : 0; }
  // 그림 앵커의 열 안 오프셋(colOff)은 그 열 너비보다 작아야 합니다. 이를 만족하는 가장 작은 MDW 를 고릅니다.
  function fitMdw(g, drawingXml) {
    var re = /<(?:xdr:)?col>(\d+)<\/(?:xdr:)?col>\s*<(?:xdr:)?colOff>(\d+)</g, m, pairs = [];
    while ((m = re.exec(drawingXml || ''))) pairs.push([Number(m[1]), Number(m[2])]);
    for (var d = 7; d <= 12; d++) {
      g.mdw = d;
      if (pairs.every(function (p) { var w = colEmu(g, p[0]); return !w || p[1] <= w + EMU_PX; })) return d;
    }
    g.mdw = 8;
    return 8;
  }
  function rowEmu(g, r) { return (g.rowPt[r] != null ? g.rowPt[r] : g.defRowPt) * EMU_PT; }
  function colStart(g, c) { var x = 0; for (var i = 0; i < c; i++) x += colEmu(g, i); return x; }
  function rowStart(g, r) { var y = 0; for (var i = 0; i < r; i++) y += rowEmu(g, i); return y; }
  // 절대 EMU → 소수 (열, 행). 2.5 = C열 가운데(0부터 셈)
  function emuToCell(g, x, y) {
    var c = 0, acc = 0;
    while (c < 300) { var w = colEmu(g, c); if (acc + w > x || w === 0 && acc >= x) break; acc += w; c++; }
    var col = c + (colEmu(g, c) ? (x - acc) / colEmu(g, c) : 0);
    var r = 0; acc = 0;
    while (r < 2000) { var h = rowEmu(g, r); if (acc + h > y || h === 0 && acc >= y) break; acc += h; r++; }
    var row = r + (rowEmu(g, r) ? (y - acc) / rowEmu(g, r) : 0);
    return { col: col, row: row };
  }

  // ── drawing XML → 그림·글상자 목록 ─────────────────────────────
  // 반환: [{ kind: 'pic'|'text', target(그림 경로), text, col, row(중심), c0, r0, c1, r1, anchor(번호) }]
  function markerEmu(g, mk) {
    return { x: colStart(g, num(allLeaf(mk, 'col'), 0)) + num(allLeaf(mk, 'colOff'), 0),
             y: rowStart(g, num(allLeaf(mk, 'row'), 0)) + num(allLeaf(mk, 'rowOff'), 0) };
  }
  function allLeaf(node, ln) { var k = kid(node, ln); return k ? k.text.trim() : ''; }
  function xfrmOf(el) {
    var pr = kid(el, 'spPr') || kid(el, 'grpSpPr');
    var x = pr && kid(pr, 'xfrm');
    if (!x) return null;
    var off = kid(x, 'off'), ext = kid(x, 'ext'), cho = kid(x, 'chOff'), che = kid(x, 'chExt');
    if (!off || !ext) return null;
    return {
      x: num(off.attrs.x, 0), y: num(off.attrs.y, 0), w: num(ext.attrs.cx, 0), h: num(ext.attrs.cy, 0),
      cx: cho ? num(cho.attrs.x, 0) : null, cy: cho ? num(cho.attrs.y, 0) : null,
      cw: che ? num(che.attrs.cx, 0) : null, ch: che ? num(che.attrs.cy, 0) : null
    };
  }
  function parseDrawing(drawingXml, drawingRelsXml, geom, drawingPath) {
    var rels = parseRels(drawingRelsXml);
    var out = [];
    fitMdw(geom, drawingXml);
    var tree = parseXml(drawingXml);
    var wsDr = tree.children.filter(function (c) { return local(c.name) === 'wsDr'; })[0] || tree;
    var anchorNo = 0;
    wsDr.children.forEach(function (an) {
      var ln = local(an.name);
      if (ln !== 'twoCellAnchor' && ln !== 'oneCellAnchor' && ln !== 'absoluteAnchor') return;
      anchorNo++;
      var a0, a1;
      if (ln === 'absoluteAnchor') {
        var pos = kid(an, 'pos'), ext0 = kid(an, 'ext');
        a0 = { x: num(pos && pos.attrs.x, 0), y: num(pos && pos.attrs.y, 0) };
        a1 = { x: a0.x + num(ext0 && ext0.attrs.cx, 0), y: a0.y + num(ext0 && ext0.attrs.cy, 0) };
      } else {
        a0 = markerEmu(geom, kid(an, 'from'));
        if (ln === 'twoCellAnchor') a1 = markerEmu(geom, kid(an, 'to'));
        else { var e1 = kid(an, 'ext'); a1 = { x: a0.x + num(e1 && e1.attrs.cx, 0), y: a0.y + num(e1 && e1.attrs.cy, 0) }; }
      }
      var el = an.children.filter(function (c) { return ['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'].indexOf(local(c.name)) >= 0; })[0];
      if (!el) return;
      // 맨 위 요소의 xfrm(off/ext)을 앵커 사각형에 맞추는 변환. 그룹 안 좌표도 이 변환을 거쳐 시트 좌표가 됩니다.
      var xf = xfrmOf(el);
      var T = (xf && xf.w > 0 && xf.h > 0)
        ? function (p) { return { x: a0.x + (p.x - xf.x) * (a1.x - a0.x) / xf.w, y: a0.y + (p.y - xf.y) * (a1.y - a0.y) / xf.h }; }
        : null;
      walk(el, T, true);
      function emit(node, rect) {
        var t = local(node.name);
        var c0 = emuToCell(geom, Math.min(rect.x0, rect.x1), Math.min(rect.y0, rect.y1));
        var c1 = emuToCell(geom, Math.max(rect.x0, rect.x1), Math.max(rect.y0, rect.y1));
        var base = { c0: c0.col, r0: c0.row, c1: c1.col, r1: c1.row, col: (c0.col + c1.col) / 2, row: (c0.row + c1.row) / 2, anchor: anchorNo };
        if (t === 'pic') {
          var blip = find(node, 'blip');
          var rid = blip && (blip.attrs['r:embed'] || blip.attrs.embed);
          var rel = rid && rels[rid];
          if (!rel || rel.mode === 'External') return;
          base.kind = 'pic'; base.target = resolvePath(drawingPath || 'xl/drawings/drawing1.xml', rel.target);
          out.push(base);
        } else if (t === 'sp') {
          var tx = allText(node).trim();
          if (!tx) return;
          base.kind = 'text'; base.text = tx;
          out.push(base);
        }
      }
      function walk(node, Tp, isTop) {
        var t = local(node.name);
        var x = xfrmOf(node);
        if (t === 'grpSp') {
          var Tc;
          if (x && x.cw && x.ch && Tp) {
            Tc = function (p) { return Tp({ x: x.x + (p.x - x.cx) * x.w / x.cw, y: x.y + (p.y - x.cy) * x.h / x.ch }); };
          } else {
            // 좌표 정보가 없으면 그룹 전체를 앵커 사각형 하나로 봅니다
            Tc = null;
          }
          node.children.forEach(function (c) {
            if (['sp', 'pic', 'grpSp'].indexOf(local(c.name)) < 0) return;
            if (Tc) walk(c, Tc, false);
            else emit2(c);
          });
          return;
        }
        if (isTop || !x || !Tp) { emit(node, { x0: a0.x, y0: a0.y, x1: a1.x, y1: a1.y }); return; }
        var p0 = Tp({ x: x.x, y: x.y }), p1 = Tp({ x: x.x + x.w, y: x.y + x.h });
        emit(node, { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
      }
      function emit2(node) { // 그룹 좌표를 못 쓸 때 — 안쪽 그림·글상자 모두 앵커 사각형으로
        if (local(node.name) === 'grpSp') node.children.forEach(emit2);
        else if (['sp', 'pic'].indexOf(local(node.name)) >= 0) emit(node, { x0: a0.x, y0: a0.y, x1: a1.x, y1: a1.y });
      }
    });
    return out;
  }

  // ── 셀 격자 도우미 ─────────────────────────────────────────────
  // grid[r][c] = 셀 값(글자·숫자·Date). 행·열은 0부터 (A1 = grid[0][0])
  function cell(grid, r, c) { return grid[r] && grid[r][c] != null ? grid[r][c] : ''; }
  function findCells(grid, pred, maxRow) {
    var out = [];
    for (var r = 0; r < grid.length && (maxRow == null || r < maxRow); r++) {
      var row = grid[r] || [];
      for (var c = 0; c < row.length; c++) if (row[c] !== '' && row[c] != null && pred(norm(row[c]), row[c])) out.push({ r: r, c: c, v: row[c] });
    }
    return out;
  }
  function colName(c) { var s = ''; c++; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }

  // ── 날짜 ─────────────────────────────────────────────────────
  function pad2(n) { return String(n).padStart(2, '0'); }
  function validYmd(y, m, d) {
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  // 검사일 칸 판정: ok(날짜) / blank(빈칸) / placeholder(양식 글자 「월 일」 그대로) / invalid(날짜 아님)
  function readDate(v) {
    if (v instanceof Date && !isNaN(v)) {
      // SheetJS 는 날짜를 그 PC 시간대의 자정으로 줍니다. 12시간을 더해 날짜가 밀리지 않게 합니다.
      var t = new Date(v.getTime() + 12 * 3600e3);
      return { status: 'ok', iso: t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate()), raw: '' };
    }
    if (typeof v === 'number' && isFinite(v)) {
      if (v > 20000 && v < 80000) { // 엑셀 날짜 일련번호
        var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
        return { status: 'ok', iso: d.toISOString().slice(0, 10), raw: String(v) };
      }
      return { status: 'invalid', iso: null, raw: String(v) };
    }
    var s = str(v);
    if (!s) return { status: 'blank', iso: null, raw: '' };
    var m = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s);
    if (m && validYmd(+m[1], +m[2], +m[3])) return { status: 'ok', iso: m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]), raw: s };
    if (!/\d/.test(s) && /월|일|년|날짜|yyyy|mm|dd/i.test(s)) return { status: 'placeholder', iso: null, raw: s };
    return { status: 'invalid', iso: null, raw: s };
  }

  // ── 양식 판별 ────────────────────────────────────────────────
  // W2 : 「Boom/Arm 내부용접 검사성적서」 — 위치 A~F, 가이드 그림 + 실제 사진, 결과표 8항목(검사기준 W2)
  // P2 : 「제관/용접(내부) 공정 검사 보고서」 — 위치 번호(1·2…), 가이드 없음, 확인 4항목
  var LAYOUTS = {
    W2: { id: 'W2', name: '내부용접 검사성적서 (위치 A~F)', hasPartner: true },
    P2: { id: 'P2', name: '제관/용접(내부) 공정 검사 보고서 (위치 번호)', hasPartner: false }
  };
  function detectLayout(grid) {
    var top = [];
    for (var r = 0; r < Math.min(3, grid.length); r++) (grid[r] || []).forEach(function (v) { if (v !== '' && v != null) top.push(norm(v)); });
    var t = top.join('|');
    if (t.indexOf('내부용접검사성적서') >= 0) return LAYOUTS.W2;
    if (t.indexOf('공정검사보고서') >= 0 || t.indexOf('weldinspectionreport') >= 0) return LAYOUTS.P2;
    return null;
  }

  // ── 머리칸: 이름표 칸 바로 아래 칸이 값 ─────────────────────────
  var HEADER_LABELS = {
    partner: ['협력사명', '협력사', '업체명'],
    model: ['기종'],
    partNo: ['품번'],
    partName: ['품명/옵션정보', '품명', '품명옵션정보'],
    date: ['검사일', '검사일자', '날짜', '일자'],
    serial: ['serialno.', 'serialno', 'serial', 'lotno', 'lotno.', 'lot', '시리얼번호'],
    welder: ['용접사', '용접자', '작업자'],
    inspector: ['검사원', '검사자']
  };
  var HEADER_NAME = { partner: '협력사', model: '기종', partNo: '품번', partName: '품명', date: '검사일', serial: 'Serial No.', welder: '용접사', inspector: '검사원' };
  function readHeader(grid) {
    var h = {}, where = {};
    Object.keys(HEADER_LABELS).forEach(function (k) {
      var hit = findCells(grid, function (n) { return HEADER_LABELS[k].indexOf(n) >= 0; }, 8)[0];
      if (!hit) { h[k] = null; return; } // null = 양식에 칸이 없음, '' = 칸은 있는데 비었음
      where[k] = colName(hit.c) + (hit.r + 2);
      var v = cell(grid, hit.r + 1, hit.c);
      h[k] = k === 'date' ? v : str(v);
    });
    var d = readDate(h.date);
    h.dateStatus = h.date === null ? 'absent' : d.status;
    h.dateIso = d.iso;
    h.dateRaw = h.date === null ? '' : (d.raw || (d.iso || ''));
    delete h.date;
    h._cells = where;
    return h;
  }

  // ── 결과표 ──────────────────────────────────────────────────
  function readResults(grid) {
    var head = findCells(grid, function (n) { return n.indexOf('검사항목') >= 0; })[0];
    if (!head) return null;
    var row = grid[head.r] || [];
    var col = { item: head.c, crit: -1, res: -1, no: -1 };
    for (var c = 0; c < row.length; c++) {
      var n = norm(row[c]);
      if (!n) continue;
      if (n.indexOf('검사기준') >= 0) col.crit = c;
      else if (n.indexOf('검사결과') >= 0 || n === '확인' || n.indexOf('판정') >= 0 || n.indexOf('결과') >= 0) col.res = c;
      else if (n === 'no.' || n === 'no' || n === '번호') col.no = c;
    }
    if (col.res < 0) return null;
    var items = [];
    for (var r = head.r + 1; r < grid.length && items.length < 40; r++) {
      var it = str(cell(grid, r, col.item));
      var noV = col.no >= 0 ? str(cell(grid, r, col.no)) : '';
      if (!it && !noV) break;
      items.push({
        no: noV || String(items.length + 1),
        item: it.replace(/^\d+\s*\.\s*/, ''),
        criterion: col.crit >= 0 ? str(cell(grid, r, col.crit)) : '',
        value: str(cell(grid, r, col.res) instanceof Date ? '' : cell(grid, r, col.res)),
        cell: colName(col.res) + (r + 1)
      });
    }
    var resHead = str(row[col.res]);
    return { headerRow: head.r, resultHeader: resHead, quantitative: /정량/.test(resHead), items: items };
  }

  // ── 그림을 위치에 배정 ────────────────────────────────────────
  function isSizeText(t) { return /^\d{1,2}(\.\d)?$/.test(t); }
  function assignW2(grid, leaves, resultsRow) {
    // 성적서의 위치 칸마다 「기종명, Serial No., / 각장검사 기록 후 / 사진 촬영」 안내 글이 실제 사진 칸(E·I 열)에 적혀 있습니다.
    // 그 글이 있는 행 = 세 줄(A·B / C·D / E·F)의 기준, 그 열 = 실제 사진 열. 못 찾으면 양식 기본값(17·24·31행, E·I열)을 씁니다.
    var R = resultsRow;
    var marks = findCells(grid, function (n) { return n.indexOf('기종명') === 0; }).filter(function (x) { return x.r > 5 && x.r < R; });
    var bandRows = uniq(marks.map(function (x) { return x.r; })).sort(function (a, b) { return a - b; });
    var photoCols = uniq(marks.map(function (x) { return x.c; })).sort(function (a, b) { return a - b; });
    if (bandRows.length !== 3) bandRows = [16, 23, 30];
    if (photoCols.length !== 2) photoCols = [4, 8];
    // 줄 경계 = 안내 글 행보다 1.5행 위(가이드 그림·사진은 안내 글 1~2행 위에서 시작)
    var bandTop = bandRows.map(function (r) { return r - 1.5; });
    var pos = {};
    POS6.forEach(function (p) { pos[p] = { pos: p, guides: [], photos: [], sizes: [], labels: [] }; });
    var overview = null, others = [], unplaced = [];
    leaves.forEach(function (lf) {
      if (lf.row < bandTop[0] || lf.row >= R) {
        if (lf.kind === 'pic') {
          var w = lf.c1 - lf.c0;
          if (lf.row < R && lf.row > 5 && w >= 5 && (!overview || w > overview.c1 - overview.c0)) overview = lf;
          else others.push(lf);
        }
        return;
      }
      // 열은 그림 왼쪽 끝이 걸린 칸으로 봅니다. 사진은 E·I 열 칸에 「붙여」 두고 오른쪽으로 넘치게 둔 경우가 많아
      // 중심점으로 보면 옆 칸으로 밀립니다(열 너비 환산 오차 포함).
      var c0 = Math.floor(lf.c0 + 1e-6);
      var k = bandTop[2] <= lf.row ? 2 : bandTop[1] <= lf.row ? 1 : 0;
      var side = c0 < photoCols[0] + 1 ? 0 : 1;
      var p = pos[POS6[k * 2 + side]];
      var inPhotoCol = c0 === photoCols[0] || c0 === photoCols[1];
      if (lf.kind === 'pic') (inPhotoCol ? p.photos : p.guides).push(lf);
      else if (isSizeText(lf.text) && !inPhotoCol) p.sizes.push(Number(lf.text));
      else if (/^[A-F]$/.test(lf.text)) p.labels.push(lf.text);
    });
    var list = POS6.map(function (p) { return pos[p]; });
    var anyGuide = list.some(function (p) { return p.guides.length; });
    list.forEach(function (p) {
      p.expected = anyGuide ? p.guides.length > 0 : true;
      p.photos.sort(byPlace); p.guides.sort(byPlace);
    });
    return { positions: list, overview: overview, others: others, unplaced: unplaced, rule: { bandRows: bandRows, photoCols: photoCols } };
  }
  function byPlace(a, b) { return a.row - b.row || a.col - b.col; }
  function assignP2(grid, leaves, resultsRow) {
    var pics = leaves.filter(function (l) { return l.kind === 'pic' && l.row < resultsRow; });
    var overview = pics.slice().sort(function (a, b) { return (b.c1 - b.c0) * (b.r1 - b.r0) - (a.c1 - a.c0) * (a.r1 - a.r0); })[0] || null;
    var bottom = overview ? overview.r1 : 0;
    // 도면 아래에 놓인 숫자 글상자 = 위치 번호표(도면 위에 겹친 번호는 도면 안내용)
    var labels = leaves.filter(function (l) { return l.kind === 'text' && /^\d{1,2}$/.test(l.text) && l.r0 >= bottom - 0.01 && l.row < resultsRow; })
      .sort(function (a, b) { return a.col - b.col; });
    var seen = {}, list = [];
    labels.forEach(function (l) { if (!seen[l.text]) { seen[l.text] = { pos: l.text, col: l.c0, row: l.row, guides: [], photos: [], sizes: [], labels: [l.text], expected: true }; list.push(seen[l.text]); } });
    var unplaced = [];
    pics.forEach(function (p) {
      if (p === overview) return;
      if (!list.length) { unplaced.push(p); return; }
      var best = null;
      list.forEach(function (L) { if (L.col <= p.col + 0.25 && p.row > L.row && (!best || L.col > best.col)) best = L; });
      (best ? best.photos : unplaced).push(p);
    });
    list.sort(function (a, b) { return Number(a.pos) - Number(b.pos); });
    list.forEach(function (p) { p.photos.sort(byPlace); delete p.col; delete p.row; });
    return { positions: list, overview: overview, others: [], unplaced: unplaced, rule: { labels: list.map(function (p) { return p.pos; }) } };
  }

  // ── 시트 하나 분석 ────────────────────────────────────────────
  // input: { fileName, fileHash, sheetName, grid, leaves }
  // 반환: 성적서(report). 그림은 target(엑셀 안 파일 경로)만 두고, 지문·미리보기는 읽는 쪽이 채웁니다.
  function analyzeSheet(input) {
    var rep = {
      id: 'r-' + shortHash(str(input.fileHash) + '|' + str(input.sheetName)),
      fileName: str(input.fileName), fileHash: str(input.fileHash), sheetName: str(input.sheetName),
      layout: null, layoutName: '', part: '', header: null, results: null, positions: [], overview: null, unplaced: 0,
      error: ''
    };
    var grid = input.grid || [];
    var lay = detectLayout(grid);
    if (!lay) {
      rep.error = '알 수 없는 양식입니다. 첫 줄 제목에 「내부용접 검사성적서」 또는 「공정 검사 보고서」가 있는 시트만 읽습니다.';
      return rep;
    }
    var res = readResults(grid);
    if (!res) {
      rep.error = '「' + lay.name + '」 양식으로 보이지만 결과표(「검사항목」·「검사결과」 또는 「확인」 머리칸)를 찾지 못했습니다.';
      return rep;
    }
    rep.layout = lay.id; rep.layoutName = lay.name;
    var title = norm(cell(grid, 0, 0));
    rep.part = title.indexOf('arm') === 0 ? 'Arm' : title.indexOf('boom') === 0 ? 'Boom' : '';
    rep.header = readHeader(grid);
    rep.results = res;
    var asg = lay.id === 'W2' ? assignW2(grid, input.leaves || [], res.headerRow) : assignP2(grid, input.leaves || [], res.headerRow);
    rep.rule = asg.rule;
    rep.positions = asg.positions.map(function (p) {
      return {
        pos: p.pos, expected: p.expected,
        sizes: p.sizes.slice().sort(function (a, b) { return a - b; }),
        guides: p.guides.map(function (g) { return { target: g.target }; }),
        photos: p.photos.map(function (g) { return { target: g.target, cell: colName(Math.floor(g.c0)) + (Math.floor(g.r0) + 1) }; })
      };
    });
    rep.overview = asg.overview ? { target: asg.overview.target } : null;
    rep.unplaced = asg.unplaced.length;
    return rep;
  }

  // ── 지문 ───────────────────────────────────────────────────
  // 파일 지문: 바이트 전체의 53비트 해시(cyrb53) + 길이. 같은 파일을 찾는 용도라 암호 강도는 필요 없습니다.
  function bytesHash(bytes) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < bytes.length; i++) {
      var ch = bytes[i];
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + '-' + bytes.length.toString(36);
  }
  function shortHash(s) {
    var b = []; for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
    return bytesHash(b).slice(0, 12);
  }
  // 모양 지문 dHash: 회색 이미지를 (n+1)×n 칸으로 평균 낸 뒤 가로 이웃끼리 밝기를 비교한 n×n 비트.
  // 다시 저장·크기 변경·밝기 조정에는 거의 변하지 않고, 다른 사진이면 크게 달라집니다.
  function dhash(gray, w, h, n) {
    n = n || 16;
    var W = n + 1, cells = new Float64Array(W * n), cnt = new Float64Array(W * n);
    for (var y = 0; y < h; y++) {
      var by = Math.min(n - 1, Math.floor(y * n / h));
      for (var x = 0; x < w; x++) {
        var bx = Math.min(W - 1, Math.floor(x * W / w));
        cells[by * W + bx] += gray[y * w + x]; cnt[by * W + bx]++;
      }
    }
    var hex = '', nib = 0, bits = 0;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      var a = cells[r * W + c] / (cnt[r * W + c] || 1), b = cells[r * W + c + 1] / (cnt[r * W + c + 1] || 1);
      nib = (nib << 1) | (b > a ? 1 : 0); bits++;
      if (bits === 4) { hex += nib.toString(16); nib = 0; bits = 0; }
    }
    return hex;
  }
  function rgbaToGray(rgba, w, h) {
    var g = new Float64Array(w * h);
    for (var i = 0; i < w * h; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    return g;
  }
  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    var d = 0;
    for (var i = 0; i < a.length; i++) { var x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
    return d;
  }

  // ── 각장 기준·값 ────────────────────────────────────────────
  // 「도면각장(z), 1.0z ≤ z' ≤ 1.25z」 → { lo: 1, hi: 1.25 }
  function parseLegCriterion(s) {
    var m = /([\d.]+)\s*z\s*[≤<=]+\s*z['’]?\s*[≤<=]+\s*([\d.]+)\s*z/i.exec(str(s));
    return m ? { lo: Number(m[1]), hi: Number(m[2]) } : null;
  }
  // 「7」 → { all: [7] }, 「A 5.2, B:7.5」 → { byPos: { A: [5.2], B: [7.5] } }
  function parseLegValues(s) {
    s = str(s);
    var byPos = {}, any = false, m, re = /(?:^|[^A-Za-z])([A-F])\s*[:=]?\s*(\d+(?:\.\d+)?)/g;
    while ((m = re.exec(s))) { (byPos[m[1]] = byPos[m[1]] || []).push(Number(m[2])); any = true; }
    if (any) return { byPos: byPos, all: [] };
    return { byPos: {}, all: (s.match(/\d+(?:\.\d+)?/g) || []).map(Number) };
  }
  function fmtN(n) { return String(Math.round(n * 100) / 100); }

  // ── 규칙 점검 (AI 없음) ─────────────────────────────────────────
  var OK_WORDS = ['ok', '양호', '합격', '이상없음', '적합', 'o', '○', '√', 'v', 'pass', 'good'];
  var NG_RE = /^(ng|nok|nog|불량|불합격|부적합|x|×|fail)$|누락|미완료|미용접|불량/i;
  function effectivePartner(rep) { return str(rep.header && rep.header.partner) || str(rep.edit && rep.edit.partner); }
  function isEmptySheet(rep) {
    var h = rep.header || {};
    var headBlank = ['partner', 'model', 'partNo', 'serial', 'welder', 'inspector'].every(function (k) { return !str(h[k]); }) && h.dateStatus !== 'ok';
    var resBlank = !rep.results || rep.results.items.every(function (it) { return !str(it.value); });
    var noPhoto = rep.positions.every(function (p) { return !p.photos.length; });
    return headBlank && resBlank && noPhoto;
  }
  function checkReport(rep) {
    var f = [];
    function add(level, code, text, pos) { f.push({ level: level, code: code, text: text, pos: pos || '' }); }
    if (!rep.layout) { add('error', 'LAYOUT', rep.error || '알 수 없는 양식입니다.'); return f; }
    if (isEmptySheet(rep)) {
      add('error', 'EMPTY_SHEET', '빈 성적서입니다 — 머리칸·결과·실제 사진이 모두 비어 있습니다' +
        (rep.positions.some(function (p) { return p.guides.length; }) ? '(가이드 그림만 있음)' : '') + '. 작성하지 않은 시트인지 확인해 주세요.');
      return f;
    }
    var h = rep.header;
    // 검사일
    if (h.dateStatus === 'placeholder') add('error', 'DATE_PLACEHOLDER', '검사일이 양식 글자 「' + h.dateRaw.replace(/\s+/g, ' ') + '」 그대로입니다 — 날짜를 적지 않았습니다.');
    else if (h.dateStatus === 'blank') add('error', 'DATE_BLANK', '검사일이 비어 있습니다.');
    else if (h.dateStatus === 'invalid') add('warn', 'DATE_INVALID', '검사일 「' + h.dateRaw + '」을 날짜로 읽지 못했습니다.');
    // 필수 칸
    [['serial', 'Serial No.'], ['welder', '용접사'], ['inspector', '검사원']].forEach(function (k) {
      if (h[k[0]] === null) add('warn', 'NO_FIELD', '이 양식에서 「' + k[1] + '」 칸을 찾지 못했습니다.');
      else if (!str(h[k[0]])) add('error', 'MISSING_FIELD', k[1] + ' 칸이 비어 있습니다.');
    });
    if (h.partner === null) {
      if (!effectivePartner(rep)) add('info', 'NO_PARTNER_FIELD', '이 양식에는 협력사 칸이 없습니다. 목록에서 협력사 이름을 적어 주시면 용접사별 누적에 쓰입니다.');
    } else if (!str(h.partner)) add('warn', 'MISSING_PARTNER', '협력사 명 칸이 비어 있습니다.');
    if (h.model !== null && !str(h.model)) add('warn', 'MISSING_MODEL', '기종 칸이 비어 있습니다.');
    // 사진
    var exp = rep.positions.filter(function (p) { return p.expected; });
    exp.forEach(function (p) {
      if (!p.photos.length) add('error', 'NO_PHOTO', '위치 ' + p.pos + ' — 실제 사진이 없습니다' + (p.guides.length ? '(가이드 그림만 있음)' : '') + '.', p.pos);
    });
    var have = exp.filter(function (p) { return p.photos.length; }).length;
    if (!exp.length) add('error', 'NO_POSITION', '사진 위치를 찾지 못했습니다(위치 표시 A~F 또는 번호가 없음).');
    if (rep.unplaced) add('info', 'UNPLACED', '위치를 정하지 못한 그림이 ' + rep.unplaced + '장 있습니다.');
    // 결과표
    var items = rep.results.items;
    var blanks = items.filter(function (it) { return !str(it.value); });
    if (blanks.length) add('error', 'RESULT_BLANK', '검사결과가 빈 항목: ' + blanks.map(function (it) { return it.item; }).join(' · '));
    items.forEach(function (it) {
      var v = norm(it.value);
      if (v && NG_RE.test(v) && OK_WORDS.indexOf(v) < 0) {
        if (/누락/.test(it.item)) add('error', 'RECORDED_OMISSION', '성적서에 「' + it.item + '」 결과가 「' + it.value + '」로 기록돼 있습니다 — 사진 판정과 관계없이 조립 투입 전 확인 대상입니다.');
        else add('error', 'RECORDED_NG', '「' + it.item + '」 결과가 「' + it.value + '」로 기록돼 있습니다.');
      }
    });
    if (rep.results.quantitative) {
      var okOnly = items.filter(function (it) { return /\d|≤|<|≥|>/.test(it.criterion) && OK_WORDS.indexOf(norm(it.value)) >= 0; });
      if (okOnly.length) add('warn', 'OK_ONLY', '「' + rep.results.resultHeader + '」인데 수치 기준 항목 ' + okOnly.length + '개가 「OK」만 적혀 있습니다: ' + okOnly.map(function (it) { return it.item.replace(/^용접품질\[|\]$/g, ''); }).join(' · '));
    }
    // 각장
    var legItem = items.filter(function (it) { return /각장/.test(it.item); })[0];
    var crit = legItem && parseLegCriterion(legItem.criterion);
    if (legItem && crit && str(legItem.value) && OK_WORDS.indexOf(norm(legItem.value)) < 0) {
      var vals = parseLegValues(legItem.value);
      var sizesAll = uniq([].concat.apply([], rep.positions.map(function (p) { return p.sizes; }))).sort(function (a, b) { return a - b; });
      var judge = function (v, sizes, where) {
        sizes = uniq(sizes);
        if (!sizes.length) return;
        var bad = sizes.filter(function (z) { return v < crit.lo * z - 1e-9 || v > crit.hi * z + 1e-9; });
        if (!bad.length) return;
        var ranges = bad.map(function (z) { return 'z=' + fmtN(z) + ' → ' + fmtN(crit.lo * z) + '~' + fmtN(crit.hi * z); }).join(', ');
        if (bad.length === sizes.length) add('error', 'LEG_OUT', where + '각장 ' + fmtN(v) + ' 이(가) 도면 각장 기준 밖입니다 (' + ranges + ').', '');
        else add('warn', 'LEG_PARTIAL', where + '각장 ' + fmtN(v) + ' 은(는) 도면 각장 ' + bad.map(fmtN).join('·') + ' 인 용접선 기준(' + ranges + ')에 맞지 않습니다. 위치별 값(예: 「A 5.5, B 7.2」)을 적어 주세요.', '');
      };
      Object.keys(vals.byPos).forEach(function (p) {
        var P = rep.positions.filter(function (x) { return x.pos === p; })[0];
        vals.byPos[p].forEach(function (v) { judge(v, P ? P.sizes : [], '위치 ' + p + ' '); });
      });
      vals.all.forEach(function (v) { judge(v, sizesAll, ''); });
      if (!sizesAll.length) add('info', 'LEG_NO_SIZE', '가이드 그림에서 도면 각장 숫자를 찾지 못해 각장 값(' + legItem.value + ')을 기준과 비교하지 않았습니다.');
    }
    f.summary = { expected: exp.length, withPhoto: have };
    return f;
  }

  // 같은 사진 재사용: 서로 다른 (성적서, 위치) 사이에서 파일 지문이 같으면 오류, 모양 지문이 가까우면 확인 필요
  function photoLabel(rep, pos) { return (rep.header && rep.header.serial ? rep.header.serial : rep.sheetName) + ' · 위치 ' + pos; }
  function checkReuse(reports, opts) {
    var lim = opts && opts.similarBits != null ? opts.similarBits : SIMILAR_BITS;
    var list = [];
    reports.forEach(function (rep) {
      if (!rep.layout) return;
      rep.positions.forEach(function (p) {
        p.photos.forEach(function (ph, i) { if (ph.hash) list.push({ rep: rep, pos: p.pos, i: i, hash: ph.hash, dh: ph.dhash }); });
      });
    });
    var out = {};
    function put(rep, x) { (out[rep.id] = out[rep.id] || []).push(x); }
    for (var a = 0; a < list.length; a++) for (var b = a + 1; b < list.length; b++) {
      var A = list[a], B = list[b];
      if (A.rep.id === B.rep.id && A.pos === B.pos && A.i === B.i) continue;
      var same = A.hash === B.hash;
      var d = same ? 0 : hamming(A.dh, B.dh);
      if (!same && !(d <= lim)) continue;
      var lv = same ? 'error' : 'warn', code = same ? 'REUSED_PHOTO' : 'SIMILAR_PHOTO';
      var what = same ? '똑같은 사진 파일' : '거의 같은 사진(모양 지문 차이 ' + d + '/256)';
      put(A.rep, { level: lv, code: code, pos: A.pos, text: '위치 ' + A.pos + ' 사진이 [' + photoLabel(B.rep, B.pos) + '] 사진과 ' + what + '입니다 — 다른 제품·위치 사진을 다시 쓴 것인지 확인해 주세요.', other: B.rep.id + '|' + B.pos });
      put(B.rep, { level: lv, code: code, pos: B.pos, text: '위치 ' + B.pos + ' 사진이 [' + photoLabel(A.rep, A.pos) + '] 사진과 ' + what + '입니다 — 다른 제품·위치 사진을 다시 쓴 것인지 확인해 주세요.', other: A.rep.id + '|' + A.pos });
    }
    return out;
  }
  var LV_ORDER = { error: 0, warn: 1, info: 2 };
  function allFindings(reports, opts) {
    var reuse = checkReuse(reports, opts), out = {};
    reports.forEach(function (rep) {
      var f = checkReport(rep).concat(reuse[rep.id] || []);
      f.sort(function (a, b) { return LV_ORDER[a.level] - LV_ORDER[b.level]; });
      out[rep.id] = f;
    });
    return out;
  }
  function countLevels(f) { var c = { error: 0, warn: 0, info: 0 }; (f || []).forEach(function (x) { c[x.level]++; }); return c; }

  // ── 판정 (사람이 확정) ───────────────────────────────────────
  // judgements 는 덧붙이기만 합니다. 같은 (성적서, 위치)의 마지막 기록이 현재 판정입니다.
  function latestJudgements(judgements) {
    var m = {};
    (judgements || []).forEach(function (j) { m[j.reportId + '|' + j.pos] = j; });
    Object.keys(m).forEach(function (k) { if (!m[k].verdict) delete m[k]; }); // verdict 빈 기록 = 판정 취소
    return m;
  }
  function welderNames(s) { return str(s).split(/[,\/·;\n]+|\s{2,}/).map(str).filter(Boolean); }
  // 용접사별 누적: 판정한 위치 수 · 누락 의심 수 · 비율. 한 성적서에 용접사가 여럿이면 각자에게 셉니다.
  function welderStats(reports, judgements, filter) {
    filter = filter || {};
    var latest = latestJudgements(judgements), rows = {};
    reports.forEach(function (rep) {
      if (!rep.layout || isEmptySheet(rep)) return; // 작성하지 않은 시트는 세지 않습니다
      var partner = effectivePartner(rep), model = str(rep.header.model);
      if (filter.partner && partner !== filter.partner) return;
      if (filter.model && model !== filter.model) return;
      var names = welderNames(rep.header.welder);
      if (!names.length) names = ['(용접사 미기재)'];
      var js = rep.positions.map(function (p) { return latest[rep.id + '|' + p.pos]; }).filter(Boolean);
      names.forEach(function (n) {
        var key = n + '\u0000' + partner;
        var r = rows[key] = rows[key] || { welder: n, partner: partner, models: [], reports: 0, judgedReports: 0, judged: 0, good: 0, suspect: 0, unreadable: 0, suspectReports: 0 };
        if (model && r.models.indexOf(model) < 0) r.models.push(model);
        r.reports++;
        if (js.length) r.judgedReports++;
        var sus = 0;
        js.forEach(function (j) { r.judged++; r[j.verdict]++; if (j.verdict === 'suspect') sus++; });
        if (sus) r.suspectReports++;
      });
    });
    return Object.keys(rows).map(function (k) {
      var r = rows[k];
      r.rate = r.judged ? r.suspect / r.judged : null;
      return r;
    }).sort(function (a, b) { return (b.rate || 0) - (a.rate || 0) || b.judged - a.judged || a.welder.localeCompare(b.welder); });
  }
  function pct(x) { return x == null ? '-' : (Math.round(x * 1000) / 10) + '%'; }

  // ── AI 도우미 (반자동) ───────────────────────────────────────
  function buildPrompt(rep, pos) {
    var P = rep.positions.filter(function (p) { return p.pos === pos; })[0] || { sizes: [], guides: [], photos: [] };
    var h = rep.header || {};
    return [
      '너는 용접 품질 검사 보조자야. 첨부한 사진으로 「용접누락」만 판단해줘.',
      '',
      '- 성적서: ' + (rep.layoutName || '') + (rep.part ? ' / ' + rep.part : '') + ' / 기종 ' + (h.model || '-') + ' / Serial ' + (h.serial || '-'),
      '- 위치: ' + pos + (P.sizes.length ? ' (도면 각장: ' + P.sizes.join(', ') + 'mm)' : ''),
      '- 첨부: ' + (P.guides.length ? '첫째 = 촬영 가이드 그림(빨간 선·숫자가 용접해야 할 곳), 그다음 = 실제 사진 ' + P.photos.length + '장' : '실제 사진 ' + P.photos.length + '장'),
      '',
      '판단 기준',
      '1. 가이드에 표시된 용접선마다 실제 사진에 용접 비드(물결 무늬로 볼록하게 쌓인 금속)가 보이는지 본다.',
      '2. 이음매가 가는 선·틈으로만 보이고 비드가 없으면 「누락 의심」.',
      '3. 어둡거나 초점이 흐리거나 해당 부위가 사진에 없어 확신할 수 없으면 억지로 정하지 말고 「판독 불가」.',
      '4. 모든 용접선에 비드가 보이면 「양호」.',
      '',
      '답은 아래 JSON 한 개만 보내줘.',
      '{"판정": "양호 | 누락 의심 | 판독 불가", "사유": "어느 용접선이 어떻게 보이는지 한두 문장", "신뢰도": 0.0~1.0}'
    ].join('\n');
  }
  function verdictOf(s) {
    var n = norm(s);
    if (!n) return '';
    if (/판독불가|불가|unreadable|unclear/.test(n)) return 'unreadable';
    if (/누락|의심|미용접|missing|suspect|omission/.test(n)) return 'suspect';
    if (/양호|정상|good|ok/.test(n)) return 'good';
    return '';
  }
  function parseAiAnswer(text) {
    var t = str(text);
    if (!t) return null;
    var m = /\{[\s\S]*\}/.exec(t), o = null;
    if (m) { try { o = JSON.parse(m[0]); } catch (e) { o = null; } }
    var v, reason = '', conf = null;
    if (o) {
      v = verdictOf(o['판정'] || o.verdict || o.result);
      reason = str(o['사유'] || o.reason || '');
      conf = o['신뢰도'] != null ? Number(o['신뢰도']) : o.confidence != null ? Number(o.confidence) : null;
    } else {
      var line = /판정\s*[:：]\s*([^\n]+)/.exec(t);
      v = verdictOf(line ? line[1] : t.split('\n')[0]);
      var rs = /사유\s*[:：]\s*([^\n]+)/.exec(t); reason = rs ? str(rs[1]) : '';
      var cf = /신뢰도\s*[:：]\s*([\d.]+)/.exec(t); conf = cf ? Number(cf[1]) : null;
    }
    if (!v) return null;
    if (conf != null && !(conf >= 0 && conf <= 1)) conf = conf > 1 && conf <= 100 ? conf / 100 : null;
    return { verdict: v, reason: reason, confidence: conf };
  }

  // ── CSV ────────────────────────────────────────────────────
  function csvCell(v) { var s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(rows) { return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }
  function welderCsv(stats) {
    return toCsv([['용접사', '협력사', '기종', '성적서 수', '판정한 성적서', '판정한 위치', '양호', '누락 의심', '판독 불가', '누락 의심 비율(위치 기준)', '누락 의심 성적서']]
      .concat(stats.map(function (r) { return [r.welder, r.partner, r.models.join(' / '), r.reports, r.judgedReports, r.judged, r.good, r.suspect, r.unreadable, pct(r.rate), r.suspectReports]; })));
  }
  function findingsCsv(reports, findings) {
    var rows = [['파일', '시트', 'Serial No.', '협력사', '용접사', '수준', '위치', '내용']];
    reports.forEach(function (rep) {
      (findings[rep.id] || []).forEach(function (f) {
        rows.push([rep.fileName, rep.sheetName, rep.header ? rep.header.serial : '', effectivePartner(rep), rep.header ? rep.header.welder : '', LEVEL[f.level], f.pos, f.text]);
      });
    });
    return toCsv(rows);
  }

  // ── 저장 구조 ───────────────────────────────────────────────
  function emptyDb() {
    return { app: 'data09-22', v: 1, reports: [], judgements: [], settings: { offline_mode: true, ai_model: 'gpt-4o-mini', keep_thumbs: true } };
  }
  // 같은 성적서(파일 지문+시트)를 다시 올리면 새 분석으로 바꾸되, 사람이 적은 협력사 보정은 남깁니다.
  function upsertReports(db, reps) {
    reps.forEach(function (r) {
      var i = db.reports.findIndex(function (x) { return x.id === r.id; });
      if (i >= 0) { if (db.reports[i].edit) r.edit = db.reports[i].edit; db.reports[i] = r; }
      else db.reports.push(r);
    });
    return db;
  }
  function addJudgement(db, j) {
    if (j.verdict && !VERDICT[j.verdict]) throw new Error('판정은 양호 / 누락 의심 / 판독 불가 중 하나입니다.');
    db.judgements.push({ reportId: j.reportId, pos: j.pos, verdict: j.verdict || '', memo: str(j.memo), by: str(j.by), at: j.at || new Date().toISOString(), ai: j.ai || null });
    return db;
  }
  function makeBackup(db) {
    var s = JSON.parse(JSON.stringify(db.settings || {})); delete s.api_key;
    return { app: 'data09-22', v: 1, savedAt: new Date().toISOString(), reports: db.reports, judgements: db.judgements, settings: s };
  }
  function parseBackup(text) {
    var p = JSON.parse(text);
    if (!p || p.app !== 'data09-22' || !Array.isArray(p.reports) || !Array.isArray(p.judgements)) throw new Error('이 도구의 백업 파일이 아닙니다.');
    var db = emptyDb();
    db.reports = p.reports.filter(function (r) { return r && r.id; });
    db.judgements = p.judgements.filter(function (j) { return j && j.reportId && j.pos; });
    if (p.settings) db.settings = Object.assign(db.settings, p.settings);
    delete db.settings.api_key;
    return db;
  }

  var api = {
    POS6: POS6, VERDICT: VERDICT, LEVEL: LEVEL, LAYOUTS: LAYOUTS, SIMILAR_BITS: SIMILAR_BITS, HEADER_NAME: HEADER_NAME,
    str: str, norm: norm, colName: colName,
    parseXml: parseXml, parseRels: parseRels, resolvePath: resolvePath, relsPathOf: relsPathOf,
    parseWorkbookSheets: parseWorkbookSheets, parseSheetGeometry: parseSheetGeometry, fitMdw: fitMdw, emuToCell: emuToCell, parseDrawing: parseDrawing,
    readDate: readDate, detectLayout: detectLayout, readHeader: readHeader, readResults: readResults, analyzeSheet: analyzeSheet,
    bytesHash: bytesHash, dhash: dhash, rgbaToGray: rgbaToGray, hamming: hamming,
    parseLegCriterion: parseLegCriterion, parseLegValues: parseLegValues,
    checkReport: checkReport, checkReuse: checkReuse, allFindings: allFindings, countLevels: countLevels, effectivePartner: effectivePartner,
    latestJudgements: latestJudgements, welderNames: welderNames, welderStats: welderStats, pct: pct,
    buildPrompt: buildPrompt, parseAiAnswer: parseAiAnswer, verdictOf: verdictOf,
    toCsv: toCsv, welderCsv: welderCsv, findingsCsv: findingsCsv,
    emptyDb: emptyDb, upsertReports: upsertReports, addJudgement: addJudgement, makeBackup: makeBackup, parseBackup: parseBackup
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WLogic = api;
})(typeof window !== 'undefined' ? window : this);
