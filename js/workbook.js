/*
 * 엑셀 성적서 읽기 — xlsx(=zip)를 풀어 시트별 셀 값과 붙어 있는 그림을 꺼냅니다.
 *   셀 값 : SheetJS (vendor/xlsx.full.min.js)
 *   그림  : JSZip (vendor/jszip.min.js) 으로 xl/drawings/*.xml + 관계 파일 + xl/media/* 를 직접 읽음
 * 파일은 이 브라우저 안에서만 읽고 어디에도 보내지 않습니다.
 * Node 에서도 돌도록(실제 파일 점검 스크립트) 라이브러리를 인자로 받습니다.
 */
(function (root) {
  'use strict';

  function isOle(bytes) { return bytes.length > 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0; }
  function isZip(bytes) { return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B; }

  function XlsError(msg, code) { var e = new Error(msg); e.code = code; return e; }

  // SheetJS 시트 → grid[r][c] (A1 = [0][0])
  function sheetGrid(XLSX, ws) {
    var grid = [];
    if (!ws) return grid;
    Object.keys(ws).forEach(function (k) {
      if (k[0] === '!') return;
      var a = XLSX.utils.decode_cell(k), c = ws[k];
      if (!c || c.v == null) return;
      (grid[a.r] = grid[a.r] || [])[a.c] = c.v;
    });
    for (var r = 0; r < grid.length; r++) if (!grid[r]) grid[r] = [];
    return grid;
  }

  function mimeOf(path) {
    var e = path.split('.').pop().toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', emf: 'image/x-emf', wmf: 'image/x-wmf', tif: 'image/tiff', tiff: 'image/tiff' }[e] || 'application/octet-stream';
  }

  /*
   * read(libs, bytes, fileName) → Promise({ reports, media })
   *   libs  = { JSZip, XLSX, WLogic }
   *   bytes = Uint8Array
   *   reports : WLogic.analyzeSheet 결과 배열(시트마다 하나). 실제 사진마다 hash(파일 지문)·bytes 수를 채웁니다.
   *   media   : { 'xl/media/image3.jpeg': { bytes, mime } } — 화면 표시·모양 지문 계산용(저장하지 않음)
   */
  function read(libs, bytes, fileName) {
    var L = libs.WLogic;
    if (isOle(bytes)) return Promise.reject(XlsError('옛 엑셀 형식(.xls)입니다. 브라우저는 .xls 안의 사진 위치를 읽을 수 없어 .xlsx 로 다시 저장해 올려 주셔야 합니다.', 'XLS'));
    if (!isZip(bytes)) return Promise.reject(XlsError('엑셀(.xlsx) 파일이 아닙니다.', 'NOT_XLSX'));
    var fileHash = L.bytesHash(bytes);
    var wb;
    try { wb = libs.XLSX.read(bytes, { type: 'array', cellDates: true, cellStyles: false, cellHTML: false, bookVBA: false }); }
    catch (e) { return Promise.reject(XlsError('엑셀 내용을 읽지 못했습니다: ' + e.message, 'READ')); }
    return libs.JSZip.loadAsync(bytes).then(function (zip) {
      function text(p) { var f = zip.file(p); return f ? f.async('string') : Promise.resolve(''); }
      return Promise.all([text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels')]).then(function (w) {
        var sheets = L.parseWorkbookSheets(w[0], w[1]);
        var media = {};
        return sheets.reduce(function (pr, sh) {
          return pr.then(function (acc) {
            return text(sh.path).then(function (sx) {
              var geom = L.parseSheetGeometry(sx);
              var rels = L.parseRels('');
              return text(L.relsPathOf(sh.path)).then(function (rx) {
                rels = L.parseRels(rx);
                var dr = geom.drawingRid && rels[geom.drawingRid];
                if (!dr) return [];
                var dPath = L.resolvePath(sh.path, dr.target);
                return Promise.all([text(dPath), text(L.relsPathOf(dPath))]).then(function (d) {
                  return L.parseDrawing(d[0], d[1], geom, dPath);
                });
              }).then(function (leaves) {
                var rep = L.analyzeSheet({ fileName: fileName, fileHash: fileHash, sheetName: sh.name, grid: sheetGrid(libs.XLSX, wb.Sheets[sh.name]), leaves: leaves });
                acc.push(rep);
                return acc;
              });
            });
          });
        }, Promise.resolve([])).then(function (reports) {
          // 쓰인 그림 파일만 꺼내 지문을 붙입니다
          var targets = {};
          reports.forEach(function (rep) {
            if (rep.overview) targets[rep.overview.target] = 1;
            rep.positions.forEach(function (p) { p.guides.concat(p.photos).forEach(function (g) { targets[g.target] = 1; }); });
          });
          return Promise.all(Object.keys(targets).map(function (t) {
            var f = zip.file(t);
            if (!f) return null;
            return f.async('uint8array').then(function (b) { media[t] = { bytes: b, mime: mimeOf(t), hash: L.bytesHash(b) }; });
          })).then(function () {
            reports.forEach(function (rep) {
              if (rep.overview && media[rep.overview.target]) rep.overview.hash = media[rep.overview.target].hash;
              rep.positions.forEach(function (p) {
                p.guides.concat(p.photos).forEach(function (ph) { var m = media[ph.target]; if (m) { ph.hash = m.hash; ph.size = m.bytes.length; } });
              });
            });
            return { reports: reports, media: media, fileHash: fileHash };
          });
        });
      });
    });
  }

  var api = { read: read, sheetGrid: sheetGrid, isOle: isOle, isZip: isZip, mimeOf: mimeOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WBook = api;
})(typeof window !== 'undefined' ? window : this);
