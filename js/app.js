/*
 * 화면 — 해시 주소로 나눕니다.
 *   #/upload    성적서 올리기   엑셀(여러 개) → 시트마다 머리칸·결과표·위치별 사진 읽기
 *   #/check     자동 점검       규칙으로 찾은 문제(검사일·빈칸·사진 누락·OK만 기입·각장·같은 사진)
 *   #/review    사진 판정       위치별 가이드 ↔ 실제 사진, 사람이 양호 / 누락 의심 / 판독 불가 확정
 *   #/welders   용접사별 누적   판정한 위치 수 · 누락 의심 수 · 비율, 협력사·기종 거르기, CSV
 *   #/labels    라벨 사진       2단계용 정상/누락 라벨 사진 폴더의 이름 점검 · 위치별 개수 · 라벨 표 CSV
 *   #/settings  설정·데이터     폐쇄망 모드(기본 꺼짐, 2026-09-30), AI 키, 백업·복원, 저장 방식
 */
(function () {
  'use strict';
  var L = window.WLogic, S = window.WStore, B = window.WBook, Sample = window.WSample;
  var db = S.loadDb();
  if (!db.thumbs) db.thumbs = {};
  var main = document.getElementById('main');
  db._sample = db.reports.some(function (r) { return /^예시_/.test(r.fileName); });
  // 이번 창에서 올린 파일의 그림(원본). 저장하지 않습니다 — 새로 고치면 사라집니다.
  var media = {};            // fileHash → { target → { url, mime, bytes } }
  var ui = { level: 'all', reviewId: '', partner: '', model: '', busy: false };

  // ── 도우미 ────────────────────────────────────────────────
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); continue; }
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  // 폐쇄망 모드: 2026-09-30 제출자 답(「폐쇄망으로 안 해도 될 듯」)으로 기본 꺼짐. 설정에서 켜면 켬.
  function offline() { return db.settings.offline_mode === true; }
  function save() {
    gcThumbs();
    db._sample = db.reports.some(function (r) { return /^예시_/.test(r.fileName); });
    var ok = S.saveDb(db);
    var msg = ok ? '' : S.isFull()
      ? '브라우저 저장 공간이 가득 찼습니다. 「설정·데이터」에서 미리보기 저장을 끄거나 백업 후 오래된 성적서를 지워 주세요. 지금 내용은 이 창을 닫으면 사라집니다.'
      : '이 브라우저에서는 저장소를 쓸 수 없어, 창을 닫으면 내용이 사라집니다. 「설정·데이터」에서 백업 파일을 받아 두세요.';
    var b = document.getElementById('storeBanner'); b.textContent = msg; b.hidden = !msg;
    document.getElementById('sampleBanner').hidden = !db._sample;
    updateNetBadge();
  }
  function gcThumbs() { // 어느 성적서도 쓰지 않는 미리보기는 지웁니다
    var used = {};
    db.reports.forEach(function (r) {
      if (r.overview && r.overview.hash) used[r.overview.hash] = 1;
      r.positions.forEach(function (p) { p.guides.concat(p.photos).forEach(function (g) { if (g.hash) used[g.hash] = 1; }); });
    });
    Object.keys(db.thumbs).forEach(function (k) { if (!used[k]) delete db.thumbs[k]; });
  }
  function updateNetBadge() {
    var b = document.getElementById('netBadge');
    b.className = 'net-badge' + (offline() ? '' : ' ai-on');
    b.textContent = offline()
      ? '폐쇄망 모드 · 이 화면은 어떤 데이터도 외부로 보내지 않습니다. 성적서·사진은 이 PC 브라우저 안에서만 읽습니다.'
      : '성적서·사진은 이 PC 브라우저 안에서만 읽습니다 · 폐쇄망 모드 꺼짐(기본) — 「AI 제안 받기(내 키)」를 누를 때만 그 위치 사진이 OpenAI 로 갑니다.';
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
  var toastTimer;
  function toast(msg, isError) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3600);
  }
  function dialog(title, content, buttons, wide) {
    var dlg = document.getElementById('dialog');
    dlg.className = 'dialog' + (wide ? ' dialog-wide' : '');
    document.getElementById('dialogTitle').textContent = title;
    var box = document.getElementById('dialogContent'); box.textContent = ''; append(box, content);
    var acts = document.getElementById('dialogActions'); acts.textContent = '';
    (buttons || [{ label: '닫기' }]).forEach(function (b) {
      acts.appendChild(h('button', { class: 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : ''), type: 'button',
        onclick: function () { var keep = b.onClick ? b.onClick() === false : false; if (!keep) closeDialog(); } }, b.label));
    });
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }
  function closeDialog() { var d = document.getElementById('dialog'); if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); } }
  function confirmBox(title, msg, okLabel, onOk) { dialog(title, h('p', null, msg), [{ label: '취소' }, { label: okLabel, primary: true, danger: true, onClick: onOk }]); }
  function download(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function stamp() { var d = new Date(); return d.toISOString().slice(0, 10).replace(/-/g, '') + '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2); }
  function field(label, control, cls) { return h('label', { class: 'field' + (cls ? ' ' + cls : '') }, h('span', null, label), control); }
  function lvBadge(level) { return h('span', { class: 'lv lv-' + level }, L.LEVEL[level]); }
  function vBadge(v) { return v ? h('span', { class: 'vd vd-' + v }, L.VERDICT[v]) : h('span', { class: 'vd vd-none' }, '미판정'); }
  function repTitle(r) { return (r.header && r.header.serial ? r.header.serial : '(Serial 없음)') + ' · ' + r.sheetName; }
  function findRep(id) { return db.reports.filter(function (r) { return r.id === id; })[0] || null; }
  function findings() { return L.allFindings(db.reports); }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { toast('복사했습니다.'); }, function () { toast('복사하지 못했습니다. 글을 직접 선택해 복사해 주세요.', true); });
    toast('이 브라우저는 자동 복사를 막습니다. 글을 직접 선택해 복사해 주세요.', true);
  }

  // ── 그림: 화면 표시 주소 · 미리보기 · 모양 지문 ──────────────────
  function imgUrl(rep, g) {
    var m = media[rep.fileHash] && media[rep.fileHash][g.target];
    if (m) return m.url;
    return g.hash && db.thumbs[g.hash] ? db.thumbs[g.hash] : '';
  }
  function hasOriginal(rep) { return !!media[rep.fileHash]; }
  function loadImage(url) {
    return new Promise(function (res) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { res(null); }; im.src = url; });
  }
  // 한 그림 → { dhash, thumb }. 브라우저가 못 여는 형식(EMF 등)은 null
  function fingerprint(url, wantThumb) {
    return loadImage(url).then(function (im) {
      if (!im || !im.naturalWidth) return null;
      var c = document.createElement('canvas'); c.width = 136; c.height = 128;
      var x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(im, 0, 0, 136, 128);
      var gray = L.rgbaToGray(x.getImageData(0, 0, 136, 128).data, 136, 128);
      var out = { dhash: L.dhash(gray, 136, 128, 16), w: im.naturalWidth, h: im.naturalHeight };
      if (wantThumb) {
        var k = 96 / Math.max(im.naturalWidth, im.naturalHeight);
        var t = document.createElement('canvas'); t.width = Math.max(1, Math.round(im.naturalWidth * k)); t.height = Math.max(1, Math.round(im.naturalHeight * k));
        var tx = t.getContext('2d'); tx.fillStyle = '#fff'; tx.fillRect(0, 0, t.width, t.height); tx.drawImage(im, 0, 0, t.width, t.height);
        out.thumb = t.toDataURL('image/jpeg', 0.6);
      }
      return out;
    });
  }
  // AI 로 보낼 때: 긴 변 1024px JPEG
  function dataUrlOf(url) {
    return loadImage(url).then(function (im) {
      if (!im) return null;
      var k = Math.min(1, 1024 / Math.max(im.naturalWidth, im.naturalHeight));
      var c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    });
  }

  // ── 파일 올리기 ────────────────────────────────────────────
  function readBytes(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = function () { rej(new Error('파일을 읽지 못했습니다.')); };
      r.readAsArrayBuffer(file);
    });
  }
  // bytes → 분석 → 지문·미리보기 → 저장. 반환: { reports, error }
  function ingest(bytes, name) {
    if (/\.xls$/i.test(name) && B.isOle(bytes)) return Promise.resolve({ name: name, error: 'XLS' });
    return B.read({ JSZip: window.JSZip, XLSX: window.XLSX, WLogic: L }, bytes, name).then(function (out) {
      var mm = media[out.fileHash] = media[out.fileHash] || {};
      Object.keys(out.media).forEach(function (t) {
        var m = out.media[t];
        if (!mm[t]) mm[t] = { url: URL.createObjectURL(new Blob([m.bytes], { type: m.mime })), mime: m.mime, hash: m.hash, bytes: m.bytes };
      });
      var cache = {};
      var jobs = [];
      out.reports.forEach(function (rep) {
        var gs = [];
        if (rep.overview) gs.push(rep.overview);
        rep.positions.forEach(function (p) { gs = gs.concat(p.guides, p.photos); });
        gs.forEach(function (g) {
          var m = mm[g.target]; if (!m) return;
          if (!cache[g.target]) cache[g.target] = fingerprint(m.url, db.settings.keep_thumbs !== false);
          jobs.push(cache[g.target].then(function (fp) {
            if (!fp) return;
            if (rep.positions.some(function (p) { return p.photos.indexOf(g) >= 0; })) g.dhash = fp.dhash;
            if (fp.thumb && g.hash) db.thumbs[g.hash] = fp.thumb;
          }));
        });
      });
      return Promise.all(jobs).then(function () {
        L.upsertReports(db, out.reports);
        return { name: name, reports: out.reports };
      });
    }, function (e) { return { name: name, error: e.code || 'READ', message: e.message }; });
  }
  function ingestFiles(list) {
    if (ui.busy) return;
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    ui.busy = true; setBusy('성적서를 읽는 중입니다… (사진이 큰 파일은 몇 초 걸립니다)');
    var results = [];
    files.reduce(function (p, f) {
      return p.then(function () { return readBytes(f).then(function (b) { return ingest(b, f.name); }, function (e) { return { name: f.name, error: 'READ', message: e.message }; }); })
        .then(function (r) { results.push(r); });
    }, Promise.resolve()).then(function () {
      save(); ui.busy = false; setBusy('');
      ui.lastResults = results;
      go('#/upload'); render();
    });
  }
  function setBusy(msg) { var b = document.getElementById('busy'); if (b) { b.textContent = msg; b.hidden = !msg; } }
  function loadSamples() {
    if (!Sample) return;
    ui.busy = true; setBusy('예시 성적서를 읽는 중입니다…');
    var results = [];
    Sample.files.reduce(function (p, n) {
      return p.then(function () {
        var bin = atob(Sample.b64[n]), u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return ingest(u, n).then(function (r) { results.push(r); });
      });
    }, Promise.resolve()).then(function () {
      Sample.judgements.forEach(function (j) {
        var rep = db.reports.filter(function (r) { return r.fileName === j[0] && r.sheetName === j[1]; })[0];
        var done = rep && L.latestJudgements(db.judgements)[rep.id + '|' + j[2]];
        if (rep && !done) L.addJudgement(db, { reportId: rep.id, pos: j[2], verdict: j[3], by: '예시 판정', memo: '예시 데이터' });
      });
      save(); ui.busy = false; setBusy('');
      ui.lastResults = results;
      toast('예시 성적서 3개(시트 7장)를 불러왔습니다.');
      render();
    });
  }

  // ── 공통 조각 ───────────────────────────────────────────────
  function posStrip(rep) {
    return h('div', { class: 'pos-strip', 'aria-label': '위치별 실제 사진 수' }, rep.positions.filter(function (p) { return p.expected || p.photos.length; }).map(function (p) {
      var miss = p.expected && !p.photos.length;
      return h('span', { class: 'pos-chip' + (miss ? ' miss' : ''), title: '위치 ' + p.pos + ' — 실제 사진 ' + p.photos.length + '장' + (p.guides.length ? ', 가이드 ' + p.guides.length : '') },
        h('b', null, p.pos), ' ', miss ? '없음' : p.photos.length + '장');
    }));
  }
  function headerLine(rep) {
    var hd = rep.header || {};
    var part = function (k, label) { var v = k === 'partner' ? L.effectivePartner(rep) : hd[k]; return h('span', null, h('span', { class: 'k' }, label), ' ', v ? v : h('em', { class: 'blank' }, hd[k] === null ? '양식에 칸 없음' : '비어 있음')); };
    return h('div', { class: 'kv-line' },
      part('partner', '협력사'), part('model', '기종'), part('serial', 'Serial'), part('welder', '용접사'), part('inspector', '검사원'),
      h('span', null, h('span', { class: 'k' }, '검사일'), ' ', hd.dateIso ? hd.dateIso : h('em', { class: 'blank' }, hd.dateStatus === 'placeholder' ? '「' + hd.dateRaw.replace(/\s+/g, ' ') + '」(양식 글자)' : '비어 있음')));
  }
  function levelCounts(f) { var c = L.countLevels(f); return h('span', { class: 'counts' }, c.error ? h('span', { class: 'lv lv-error' }, '오류 ' + c.error) : null, c.warn ? h('span', { class: 'lv lv-warn' }, '확인 ' + c.warn) : null, !c.error && !c.warn ? h('span', { class: 'lv lv-ok' }, '문제 없음') : null); }

  // ── #/upload 성적서 올리기 ─────────────────────────────────────
  function pageUpload() {
    var input = h('input', { type: 'file', accept: '.xlsx,.xlsm,.xls', multiple: true, 'aria-label': '성적서 엑셀 고르기' });
    input.addEventListener('change', function () { var f = input.files; ingestFiles(f); input.value = ''; });
    var drop = h('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': '성적서 엑셀 끌어다 놓기 또는 고르기' },
      h('b', null, '내부용접 검사성적서 엑셀을 여기로 끌어다 놓아 주세요'),
      h('span', { class: 'note' }, '여러 파일을 한 번에 올릴 수 있습니다. 파일은 이 브라우저 안에서만 읽습니다.'),
      h('span', { class: 'btn btn-primary file-btn' }, '파일 고르기', input));
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); ingestFiles(e.dataTransfer.files); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '성적서 올리기'),
      h('button', { class: 'btn', type: 'button', onclick: loadSamples }, '예시 성적서 불러오기')));
    main.appendChild(h('div', { class: 'card' }, drop, h('p', { id: 'busy', class: 'busy', role: 'status', hidden: true })));

    if (ui.lastResults && ui.lastResults.length) {
      var box = h('div', { class: 'card' }, h('h2', null, '방금 읽은 파일'));
      var F = findings();
      ui.lastResults.forEach(function (r) {
        if (r.error === 'XLS') { box.appendChild(h('div', { class: 'alert warn' }, h('b', null, r.name), ' — 옛 엑셀 형식(.xls)이라 사진 위치를 읽을 수 없습니다. 아래 「.xls 파일은 .xlsx 로 저장해 주세요」 순서대로 저장해 다시 올려 주세요.')); return; }
        if (r.error) { box.appendChild(h('div', { class: 'alert warn' }, h('b', null, r.name), ' — ', r.message || '읽지 못했습니다.')); return; }
        box.appendChild(h('h3', { class: 'file-name' }, r.name, h('span', { class: 'note' }, ' 시트 ' + r.reports.length + '장')));
        box.appendChild(reportTable(r.reports, F));
      });
      box.appendChild(h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-primary', href: '#/check' }, '자동 점검 보기'), h('a', { class: 'btn', href: '#/review' }, '사진 판정하기')));
      main.appendChild(box);
    } else if (db.reports.length) {
      main.appendChild(h('div', { class: 'card' }, h('h2', null, '저장된 성적서 ' + db.reports.length + '장'), reportTable(db.reports, findings())));
    }

    main.appendChild(h('div', { class: 'card', id: 'xlsGuide' }, h('h2', null, '.xls 파일은 .xlsx 로 저장해 주세요'),
      h('p', null, '옛 엑셀 형식(.xls)은 안이 하나의 이진 파일이라, 브라우저에서는 사진이 어느 칸에 붙어 있는지 읽을 수 없습니다. 엑셀에서 한 번만 다시 저장하면 됩니다.'),
      h('ol', { class: 'steps' },
        h('li', null, '엑셀에서 .xls 파일을 엽니다.'),
        h('li', null, '「파일 → 다른 이름으로 저장」을 누릅니다.'),
        h('li', null, '「파일 형식」을 「Excel 통합 문서 (*.xlsx)」로 바꾸고 저장합니다. 「호환성 검사」 창이 뜨면 「계속」을 누릅니다.'),
        h('li', null, '새로 생긴 .xlsx 파일을 이 화면에 올립니다.')),
      h('p', { class: 'note' }, '한셀·리브레오피스도 「다른 이름으로 저장 → .xlsx」로 같습니다. 협력사가 처음부터 .xlsx 로 내 주시면 이 단계가 필요 없습니다(기획서 10장 질문 2).')));

    main.appendChild(h('details', { class: 'card how' }, h('summary', null, '이 도구가 성적서를 읽는 방법'),
      h('ul', null,
        h('li', null, h('b', null, '양식 판별 — '), '첫 줄 제목으로 정합니다. 「Boom/Arm 내부용접 검사성적서」 = 위치 A~F 양식, 「제관/용접(내부) 공정 검사 보고서」 = 위치 번호(1·2) 양식. 그 밖의 시트는 「알 수 없는 양식」으로 알려 드리고 건너뜁니다.'),
        h('li', null, h('b', null, '머리칸 — '), '「협력사 명·기종·품번·검사일·Serial No.·용접사·검사원」(형식2는 「날짜·LOT NO·작업자·검사자」) 이름표 바로 아래 칸을 값으로 읽습니다.'),
        h('li', null, h('b', null, '결과표 — '), '「검사항목」 머리칸 아래 줄을 항목으로, 「검사결과」(또는 「확인」) 열을 결과로 읽습니다.'),
        h('li', null, h('b', null, '사진 위치(A~F) — '), '엑셀 그림은 칸에 붙어 있습니다. 양식에 「기종명, Serial No., 각장검사 기록 후 사진 촬영」이라고 적힌 칸의 행이 세 줄(A·B / C·D / E·F)의 기준이고, 그 칸의 열(E·I열)이 실제 사진 자리입니다. 왼쪽 반은 A·C·E, 오른쪽 반은 B·D·F 입니다.'),
        h('li', null, h('b', null, '가이드와 실제 사진 구분 — '), '실제 파일을 보면 가이드는 B~D·G~H 열에 붙은 선 그림(PNG)이고 그 위에 빨간 각장 숫자 글상자가 겹쳐 있습니다. 실제 사진은 E·I 열에 붙은 사진(JPEG) 한 장입니다. 그래서 「그림 왼쪽 끝이 E·I 열에 있으면 실제 사진, 그 밖이면 가이드」로 나누고, 가이드 위 숫자 글상자는 그 위치의 도면 각장으로 읽습니다.'),
        h('li', null, h('b', null, '형식2(위치 번호) — '), '도면 아래에 놓인 숫자 글상자(1·2)가 위치 번호표입니다. 번호표 아래 사진은 왼쪽에서 가장 가까운 번호의 위치로 들어갑니다. 이 양식에는 가이드 그림이 없습니다.'))));
  }
  function reportTable(reps, F) {
    var tb = h('tbody');
    reps.forEach(function (rep) {
      var tr = h('tr');
      tr.appendChild(h('td', null, h('b', null, rep.sheetName), h('span', { class: 'sub' }, rep.layout ? rep.layoutName + (rep.part ? ' · ' + rep.part : '') : '')));
      if (!rep.layout) { tr.appendChild(h('td', { colspan: '3' }, h('span', { class: 'lv lv-warn' }, '건너뜀'), ' ', rep.error)); tb.appendChild(tr); return; }
      var partnerCell = h('td', null, headerLine(rep));
      if (rep.header.partner === null) {
        var inp = h('input', { type: 'text', class: 'mini', value: (rep.edit && rep.edit.partner) || '', placeholder: '협력사 이름', 'aria-label': rep.sheetName + ' 협력사 이름' });
        inp.addEventListener('change', function () { rep.edit = rep.edit || {}; rep.edit.partner = inp.value.trim(); save(); toast('협력사 이름을 적었습니다.'); });
        partnerCell.appendChild(h('div', { class: 'mini-row' }, h('span', { class: 'note' }, '이 양식엔 협력사 칸이 없습니다 → '), inp));
      }
      tr.appendChild(partnerCell);
      tr.appendChild(h('td', null, posStrip(rep)));
      tr.appendChild(h('td', null, levelCounts(F[rep.id]), h('div', null, h('a', { href: '#/review?id=' + encodeURIComponent(rep.id) }, '사진 판정'))));
      tb.appendChild(tr);
    });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'list' }, h('thead', null, h('tr', null, h('th', null, '시트'), h('th', null, '머리칸'), h('th', null, '위치별 실제 사진'), h('th', null, '점검'))), tb));
  }

  // ── #/check 자동 점검 ───────────────────────────────────────
  function pageCheck() {
    var F = findings();
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '자동 점검'),
      db.reports.length ? h('button', { class: 'btn', type: 'button', onclick: function () { download('용접성적서_자동점검_' + stamp() + '.csv', new Blob([L.findingsCsv(db.reports, F)], { type: 'text/csv;charset=utf-8' })); } }, '점검 결과 CSV') : null));
    if (!db.reports.length) { main.appendChild(emptyCard()); return; }
    var reps = db.reports.filter(function (r) { return r.layout; });
    var withErr = reps.filter(function (r) { return L.countLevels(F[r.id]).error; }).length;
    var withWarn = reps.filter(function (r) { var c = L.countLevels(F[r.id]); return !c.error && c.warn; }).length;
    var missPos = 0; reps.forEach(function (r) { (F[r.id] || []).forEach(function (f) { if (f.code === 'NO_PHOTO') missPos++; }); });
    main.appendChild(h('div', { class: 'tiles' },
      tile(reps.length, '읽은 성적서(시트)', ''), tile(withErr, '오류 있는 성적서', 'bad'), tile(withWarn, '확인 필요만 있는 성적서', 'mid'), tile(missPos, '실제 사진 없는 위치', 'bad')));
    main.appendChild(h('p', { class: 'note' }, '규칙으로만 찾습니다(AI 없음). 오류 = 성적서를 돌려보내 고쳐야 할 것, 확인 필요 = 사람이 한 번 보면 되는 것. 같은 사진 찾기는 지금까지 올린 모든 성적서를 서로 비교합니다.'));
    var filt = h('div', { class: 'btn-row filter', role: 'group', 'aria-label': '수준 거르기' });
    [['all', '전체'], ['error', '오류 있는 것'], ['warn', '확인 필요 있는 것']].forEach(function (x) {
      filt.appendChild(h('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': ui.level === x[0] ? 'true' : 'false', onclick: function () { ui.level = x[0]; render(); } }, x[1]));
    });
    main.appendChild(filt);
    var list = h('div', { class: 'rep-list' });
    db.reports.forEach(function (rep) {
      var f = F[rep.id] || [], c = L.countLevels(f);
      if (ui.level === 'error' && !c.error) return;
      if (ui.level === 'warn' && !c.warn) return;
      var card = h('article', { class: 'rep-card' + (c.error ? ' has-error' : c.warn ? ' has-warn' : '') },
        h('div', { class: 'rep-head' }, h('h2', null, repTitle(rep)), levelCounts(f)),
        h('p', { class: 'note file-line' }, rep.fileName + (rep.layout ? ' · ' + rep.layoutName : '')),
        rep.layout ? headerLine(rep) : null,
        rep.layout ? posStrip(rep) : null,
        f.length ? h('ul', { class: 'finds' }, f.map(function (x) { return h('li', null, lvBadge(x.level), ' ', x.text); })) : h('p', { class: 'ok-line' }, '규칙으로 찾은 문제가 없습니다. 사진은 「사진 판정」에서 사람이 확인해 주세요.'),
        h('div', { class: 'btn-row' },
          rep.layout ? h('a', { class: 'btn btn-small', href: '#/review?id=' + encodeURIComponent(rep.id) }, '사진 판정') : null,
          h('button', { class: 'btn btn-small btn-danger', type: 'button', onclick: function () {
            confirmBox('성적서 지우기', '「' + repTitle(rep) + '」을 목록에서 지웁니다. 판정 기록은 기록으로 남지만 누적표에서는 빠집니다.', '지우기', function () {
              db.reports = db.reports.filter(function (x) { return x.id !== rep.id; }); save(); render();
            });
          } }, '지우기')));
      list.appendChild(card);
    });
    main.appendChild(list);
  }
  function tile(n, label, cls) { return h('div', { class: 'tile ' + (cls || '') }, h('b', null, String(n)), h('span', null, label)); }
  function emptyCard() {
    return h('div', { class: 'card' }, h('p', null, '아직 올린 성적서가 없습니다.'), h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-primary', href: '#/upload' }, '성적서 올리기'), h('button', { class: 'btn', type: 'button', onclick: function () { loadSamples(); } }, '예시 성적서 불러오기')));
  }

  // ── #/review 사진 판정 ──────────────────────────────────────
  function pageReview(params) {
    var reps = db.reports.filter(function (r) { return r.layout; });
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '사진 판정')));
    if (!reps.length) { main.appendChild(emptyCard()); return; }
    var id = params.id || ui.reviewId;
    var rep = findRep(id) && findRep(id).layout ? findRep(id) : reps[0];
    ui.reviewId = rep.id;
    var latest = L.latestJudgements(db.judgements);
    var sel = h('select', { 'aria-label': '판정할 성적서' });
    reps.forEach(function (r) {
      var n = r.positions.filter(function (p) { return p.expected || p.photos.length; }), done = n.filter(function (p) { return latest[r.id + '|' + p.pos]; }).length;
      sel.appendChild(h('option', { value: r.id, selected: r.id === rep.id }, repTitle(r) + ' — ' + r.fileName + ' (판정 ' + done + '/' + n.length + ')'));
    });
    sel.addEventListener('change', function () { go('#/review?id=' + encodeURIComponent(sel.value)); });
    var F = findings()[rep.id] || [];
    main.appendChild(h('div', { class: 'card' }, field('성적서', sel), headerLine(rep),
      F.length ? h('ul', { class: 'finds compact' }, F.map(function (x) { return h('li', null, lvBadge(x.level), ' ', x.text); })) : null,
      hasOriginal(rep) ? null : h('p', { class: 'alert info' }, '사진 원본은 저장하지 않습니다. 지금은 작은 미리보기만 보입니다. 크게 보려면 이 성적서 파일(' + rep.fileName + ')을 「성적서 올리기」에서 다시 올려 주세요.')));
    main.appendChild(h('p', { class: 'note' }, '위치마다 가이드(용접해야 할 곳)와 실제 사진을 나란히 보고 판정해 주세요. 사진을 누르면 크게 봅니다. 판정은 기록으로 쌓이고, 마지막 판정이 현재 판정입니다.' + (offline() ? ' AI 도우미는 폐쇄망 모드에서 숨겨집니다.' : '')));
    if (rep.overview && imgUrl(rep, rep.overview)) main.appendChild(h('details', { class: 'card overview' }, h('summary', null, '위치 안내도 보기'), h('img', { src: imgUrl(rep, rep.overview), alt: '위치 안내도' })));
    var grid = h('div', { class: 'pos-grid' });
    rep.positions.filter(function (p) { return p.expected || p.photos.length; }).forEach(function (p) { grid.appendChild(posCard(rep, p, latest[rep.id + '|' + p.pos])); });
    main.appendChild(grid);
  }
  function thumbImg(rep, g, alt, cls) {
    var u = imgUrl(rep, g);
    if (!u) return h('div', { class: 'no-img ' + (cls || '') }, '미리보기 없음');
    var img = h('img', { src: u, alt: alt, loading: 'lazy' });
    return h('button', { type: 'button', class: 'img-btn ' + (cls || ''), 'aria-label': alt + ' 크게 보기', onclick: function () { zoom(rep, g, alt); } }, img);
  }
  function posCard(rep, p, cur) {
    var hist = db.judgements.filter(function (j) { return j.reportId === rep.id && j.pos === p.pos; });
    var memo = h('input', { type: 'text', class: 'memo', placeholder: '메모(선택) — 예: 아래 모서리 비드 없음', 'aria-label': '위치 ' + p.pos + ' 메모', value: cur ? cur.memo : '' });
    var sugBox = h('div', { class: 'ai-sug', hidden: true });
    var card = h('section', { class: 'pos-card' + (cur ? ' judged-' + cur.verdict : '') + (p.expected && !p.photos.length ? ' missing' : ''), 'aria-label': '위치 ' + p.pos },
      h('div', { class: 'pos-head' }, h('h2', null, '위치 ' + p.pos), vBadge(cur && cur.verdict), p.sizes.length ? h('span', { class: 'note' }, '도면 각장 ' + p.sizes.join(' · ') + 'mm') : null),
      h('div', { class: 'pair' },
        h('figure', null, p.guides.length ? p.guides.map(function (g, i) { return thumbImg(rep, g, '위치 ' + p.pos + ' 가이드' + (p.guides.length > 1 ? ' ' + (i + 1) : ''), 'guide'); }) : h('div', { class: 'no-img guide' }, '가이드 없음(이 양식)'), h('figcaption', null, '가이드')),
        h('figure', null, p.photos.length ? p.photos.map(function (g, i) { return thumbImg(rep, g, '위치 ' + p.pos + ' 실제 사진' + (p.photos.length > 1 ? ' ' + (i + 1) : ''), 'photo'); }) : h('div', { class: 'no-img photo miss' }, '실제 사진 없음'), h('figcaption', null, '실제 사진' + (p.photos.length > 1 ? ' ' + p.photos.length + '장' : '')))),
      h('div', { class: 'verdict-row', role: 'group', 'aria-label': '위치 ' + p.pos + ' 판정' },
        ['good', 'suspect', 'unreadable'].map(function (v) {
          return h('button', { type: 'button', class: 'btn btn-small vbtn vbtn-' + v, 'aria-pressed': cur && cur.verdict === v ? 'true' : 'false', onclick: function () {
            var sug = card._sug;
            L.addJudgement(db, { reportId: rep.id, pos: p.pos, verdict: v, memo: memo.value, ai: sug && sug.verdict ? { verdict: sug.verdict, reason: sug.reason, confidence: sug.confidence } : null });
            save(); toast('위치 ' + p.pos + ' — ' + L.VERDICT[v] + '(으)로 판정했습니다.'); render();
          } }, L.VERDICT[v]);
        })),
      peerBox(rep, p),
      memo,
      hist.length > 1 ? h('p', { class: 'note' }, '판정 기록 ' + hist.length + '건 · 마지막 ' + hist[hist.length - 1].at.slice(0, 16).replace('T', ' ')) : null,
      sugBox);
    if (!offline()) card.appendChild(aiTools(rep, p, card, sugBox));
    return card;
  }
  // 같은 위치 다른 제품 사진 — 2026-09-30 확인된 불량(Serial 끝 60, 위치 B·E)은 규칙으로는 다른 Serial 과
  // 똑같이 보였고, 같은 위치 사진을 나란히 놓아야 윗면 이음매의 비드 차이가 보였습니다.
  function peerBox(rep, p) {
    if (!p.photos.length) return null;
    var peers = L.peerPhotos(db.reports, rep, p.pos);
    if (!peers.length) return null;
    return h('details', { class: 'peer-box' },
      h('summary', null, '같은 위치 다른 제품 사진과 비교 (' + peers.length + '장)'),
      h('p', { class: 'note' }, '같은 기종·부품의 다른 Serial 에서 같은 위치 사진입니다. 이음매마다 비드(볼록한 용접 줄)가 같은 자리에 있는지 견주어 보세요.'),
      h('div', { class: 'peer-grid' }, peers.map(function (x) {
        var t = L.str(x.rep.header && x.rep.header.serial) || x.rep.sheetName;
        return h('figure', null, thumbImg(x.rep, x.photo, t + ' · 위치 ' + p.pos, 'photo'), h('figcaption', null, t));
      })));
  }
  // AI 도우미 — 폐쇄망 모드가 꺼져 있을 때만. 제안만 보여 주고 확정은 사람이 판정 단추로.
  function aiTools(rep, p, card, sugBox) {
    var ta = h('textarea', { rows: 3, placeholder: 'ChatGPT 등의 답(JSON)을 붙여 넣어 주세요', 'aria-label': '위치 ' + p.pos + ' AI 답 붙여넣기' });
    function show(s) {
      card._sug = s;
      sugBox.hidden = false; sugBox.textContent = '';
      if (!s) { append(sugBox, h('p', { class: 'alert warn' }, '답에서 판정(양호 / 누락 의심 / 판독 불가)을 찾지 못했습니다.')); return; }
      append(sugBox, h('p', null, h('b', null, 'AI 제안: '), vBadge(s.verdict), s.confidence != null ? ' 신뢰도 ' + Math.round(s.confidence * 100) + '%' : '', s.reason ? ' — ' + s.reason : ''),
        h('p', { class: 'note' }, '제안일 뿐입니다. 사진을 직접 보고 위 판정 단추를 눌러 확정해 주세요.'));
      Array.prototype.forEach.call(card.querySelectorAll('.vbtn'), function (b) { b.classList.toggle('suggested', b.classList.contains('vbtn-' + s.verdict)); });
    }
    var key = S.getKey();
    var imgs = p.guides.concat(p.photos);
    return h('details', { class: 'ai-tools' }, h('summary', null, 'AI 도우미 (제안만, 확정은 사람)'),
      h('ol', { class: 'steps' },
        h('li', null, h('button', { type: 'button', class: 'btn btn-small', onclick: function () { copyText(L.buildPrompt(rep, p.pos)); } }, '요청문 복사'), ' 후 ChatGPT 등에 붙여 넣습니다.'),
        h('li', null, h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
          if (!hasOriginal(rep)) { toast('사진 원본이 없습니다. 성적서 파일을 다시 올려 주세요.', true); return; }
          imgs.forEach(function (g, i) { var m = media[rep.fileHash][g.target]; if (m) download(safe(repTitle(rep)) + '_' + p.pos + '_' + (i < p.guides.length ? '가이드' : '사진' + (i - p.guides.length + 1)) + '.' + (g.target.split('.').pop()), new Blob([m.bytes], { type: m.mime })); });
        } }, '사진 내려받기'), ' 한 가이드·사진을 함께 첨부합니다.'),
        h('li', null, '받은 답을 붙여 넣고 「답 읽기」를 누릅니다.')),
      ta, h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { show(L.parseAiAnswer(ta.value)); } }, '답 읽기'),
        key ? h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: function (e) {
          if (!hasOriginal(rep)) { toast('사진 원본이 없습니다. 성적서 파일을 다시 올려 주세요.', true); return; }
          var btn = e.currentTarget; btn.disabled = true; btn.textContent = '요청 중…';
          Promise.all(imgs.map(function (g) { var m = media[rep.fileHash][g.target]; return m ? dataUrlOf(m.url) : null; })).then(function (urls) {
            return window.WAI.judgePhotos({ offline: db.settings.offline_mode, key: S.getKey(), model: db.settings.ai_model, prompt: L.buildPrompt(rep, p.pos), images: urls.filter(Boolean) });
          }).then(function (ans) { ta.value = ans; show(L.parseAiAnswer(ans)); }, function (err) { toast('AI 요청 실패: ' + err.message, true); })
            .then(function () { btn.disabled = false; btn.textContent = 'AI 제안 받기(내 키)'; });
        } }, 'AI 제안 받기(내 키)') : h('span', { class: 'note' }, '「설정·데이터」에 내 OpenAI 키를 넣으면 자동으로 받을 수 있습니다.')));
  }
  function safe(s) { return String(s || '').replace(/[\\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
  function zoom(rep, g, alt) {
    var u = imgUrl(rep, g);
    var P = rep.positions.filter(function (p) { return p.guides.indexOf(g) >= 0 || p.photos.indexOf(g) >= 0; })[0];
    var scale = 1;
    var img = h('img', { src: u, alt: alt });
    var label = h('span', { class: 'zoom-label' }, '100%');
    function apply() { img.style.width = (scale * 100) + '%'; label.textContent = Math.round(scale * 100) + '%'; }
    var side = P && P.guides.length && P.guides.indexOf(g) < 0 ? h('div', { class: 'zoom-guide' }, h('p', { class: 'note' }, '가이드' + (P.sizes.length ? ' · 도면 각장 ' + P.sizes.join(' · ') + 'mm' : '')), P.guides.map(function (x) { return h('img', { src: imgUrl(rep, x), alt: '위치 ' + P.pos + ' 가이드' }); })) : null;
    dialog(alt, [
      h('div', { class: 'btn-row photo-tools' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { scale = Math.max(1, scale / 1.5); apply(); } }, '축소'), label,
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { scale = Math.min(6, scale * 1.5); apply(); } }, '확대'),
        hasOriginal(rep) ? null : h('span', { class: 'note' }, '미리보기(작은 그림)입니다.')),
      h('div', { class: 'zoom-wrap' + (side ? ' with-guide' : '') }, side, h('div', { class: 'photo-scroll' }, img))
    ], null, true);
    apply();
  }

  // ── #/welders 용접사별 누적 ───────────────────────────────────
  function pageWelders() {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '용접사별 누적')));
    if (!db.reports.length) { main.appendChild(emptyCard()); return; }
    var reps = db.reports.filter(function (r) { return r.layout; });
    var partners = uniqSorted(reps.map(L.effectivePartner)), models = uniqSorted(reps.map(function (r) { return L.str(r.header.model); }));
    var ps = h('select', { 'aria-label': '협력사' }, h('option', { value: '' }, '전체 협력사'), partners.map(function (x) { return h('option', { value: x, selected: ui.partner === x }, x); }));
    var ms = h('select', { 'aria-label': '기종' }, h('option', { value: '' }, '전체 기종'), models.map(function (x) { return h('option', { value: x, selected: ui.model === x }, x); }));
    ps.addEventListener('change', function () { ui.partner = ps.value; render(); });
    ms.addEventListener('change', function () { ui.model = ms.value; render(); });
    var rows = L.welderStats(db.reports, db.judgements, { partner: ui.partner, model: ui.model });
    main.appendChild(h('div', { class: 'card' }, h('div', { class: 'form-grid' }, field('협력사', ps), field('기종', ms),
      h('div', { class: 'field' }, h('span', null, '내보내기'), h('button', { class: 'btn', type: 'button', onclick: function () { download('용접사별_누적_' + stamp() + '.csv', new Blob([L.welderCsv(rows)], { type: 'text/csv;charset=utf-8' })); } }, 'CSV 내려받기')))));
    main.appendChild(h('p', { class: 'note' }, '사람이 확정한 판정만 셉니다(AI 제안은 세지 않음). 비율 = 누락 의심 위치 ÷ 판정한 위치. 한 성적서에 용접사가 여럿(쉼표·「/」로 구분)이면 각자에게 셉니다. 판정하지 않은 성적서는 「성적서 수」에만 들어갑니다.'));
    var tb = h('tbody');
    rows.forEach(function (r) {
      tb.appendChild(h('tr', { class: r.suspect ? 'row-bad' : '' },
        h('td', null, h('b', null, r.welder)), h('td', null, r.partner || '-'), h('td', null, r.models.join(', ') || '-'),
        h('td', { class: 'num' }, r.reports), h('td', { class: 'num' }, r.judged), h('td', { class: 'num' }, r.good), h('td', { class: 'num' }, r.suspect), h('td', { class: 'num' }, r.unreadable),
        h('td', { class: 'num' }, h('b', null, L.pct(r.rate))), h('td', { class: 'num' }, r.suspectReports)));
    });
    main.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, '용접사'), h('th', null, '협력사'), h('th', null, '기종'), h('th', null, '성적서'), h('th', null, '판정한 위치'), h('th', null, '양호'), h('th', null, '누락 의심'), h('th', null, '판독 불가'), h('th', null, '누락 의심 비율'), h('th', null, '누락 의심 성적서'))), tb)));
    if (!rows.length) main.appendChild(h('p', { class: 'note' }, '조건에 맞는 성적서가 없습니다.'));
    main.appendChild(h('p', { class: 'note' }, '용접사 실명으로 누적해도 된다고 제출자가 확인했습니다(2026-09-30). 누적 결과는 이 PC 브라우저와 내려받은 CSV 에만 남습니다.'));
  }
  function uniqSorted(a) { return a.filter(function (x, i) { return x && a.indexOf(x) === i; }).sort(); }

  // ── #/labels 라벨 사진 (2단계 준비) ──────────────────────────────
  // 사진은 읽지 않고 파일 이름·폴더 이름만 봅니다. 어디에도 저장·전송하지 않습니다.
  function pageLabels() {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '라벨 사진 받기')));
    main.appendChild(h('div', { class: 'card', id: 'labelGuide' }, h('h2', null, '보내 주실 폴더 모양'),
      h('p', null, '2단계(AI 판독 파일럿)의 정답표가 될 사진입니다. 폴더 이름이 라벨이고, 파일 이름에 기종·Serial·위치를 적어 주세요.'),
      h('pre', { class: 'tree' }, '라벨사진_20261001_김무연/\n  정상/   VDK14W_SJ25D58_B.jpg\n          VDK14W_SJ25D58_E.jpg\n  누락/   VDK14W_SJ25D60_B.jpg\n          VDK14W_SJ25D60_E_1_윗면비드없음.jpg\n  경계/   VDK14W_SJ25D57_E_어두움.jpg'),
      h('ul', null,
        h('li', null, h('b', null, '폴더 = 라벨: '), '「정상」 · 「누락」 · 「경계」(사람도 판단이 어려운 사진 — 어두움·그을음·초점) 세 가지만 써 주세요. 하위 폴더가 더 있어도 됩니다.'),
        h('li', null, h('b', null, '파일 이름 = 기종_Serial_위치'), ' — 위치는 A~F(성적서) 또는 1·2(공정 검사 보고서). 같은 위치에 여러 장이면 뒤에 _1, _2. 그 뒤에 _메모(예: 윗면비드없음)를 붙여도 됩니다.'),
        h('li', null, h('b', null, '한 장 = 한 위치: '), '성적서에서 꺼낸 사진이든 새로 찍은 사진이든, 한 파일에 한 위치만 담아 주세요.'),
        h('li', null, h('b', null, '먼저 B·E: '), '사고가 난 위치입니다. Serial 끝 60 의 B·E 는 「누락」에 넣어 주시고, 같은 기종 다른 Serial 의 B·E 정상 사진도 함께 주시면 비교 기준이 됩니다.')),
      h('p', { class: 'note' }, '자세한 안내: docs/라벨사진_보내는_방법.md. 받은 사진은 공개 저장소에 올리지 않습니다.')));
    var input = h('input', { type: 'file', multiple: true, webkitdirectory: true, 'aria-label': '라벨 사진 폴더 고르기' });
    var out = h('div');
    input.addEventListener('change', function () {
      var paths = Array.prototype.map.call(input.files, function (f) { return f.webkitRelativePath || f.name; });
      input.value = '';
      showLabels(out, paths);
    });
    main.appendChild(h('div', { class: 'card' }, h('h2', null, '폴더 점검'),
      h('p', { class: 'note' }, '받은 폴더(또는 보내기 전 폴더)를 골라 주세요. 사진 내용은 읽지 않고 이름만 봅니다. 저장하지 않으며 밖으로 보내지 않습니다.'),
      h('div', { class: 'btn-row' }, h('span', { class: 'btn btn-primary file-btn' }, '폴더 고르기', input))));
    main.appendChild(out);
    if (ui.labelPaths) showLabels(out, ui.labelPaths);
  }
  function showLabels(out, paths) {
    ui.labelPaths = paths;
    var s = L.labelSummary(paths);
    out.textContent = '';
    append(out, h('div', { class: 'tiles' }, tile(s.totals.good, '정상'), tile(s.totals.suspect, '누락', s.totals.suspect ? 'bad' : ''), tile(s.totals.unclear, '경계'), tile(s.bad.length, '이름 확인 필요', s.bad.length ? 'mid' : '')));
    var poss = Object.keys(s.table).sort();
    if (poss.length) append(out, h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, '위치'), h('th', null, '정상'), h('th', null, '누락'), h('th', null, '경계'))),
      h('tbody', null, poss.map(function (p) { var r = s.table[p]; return h('tr', null, h('td', null, h('b', null, p)), h('td', { class: 'num' }, r.good), h('td', { class: 'num' }, r.suspect), h('td', { class: 'num' }, r.unclear)); })))));
    if (s.serials.length) append(out, h('p', { class: 'note' }, '기종·Serial ' + s.serials.length + '개: ' + s.serials.join(', ')));
    if (s.conflicts.length) append(out, h('div', { class: 'alert warn' }, '같은 Serial·위치에 라벨이 엇갈린 사진이 있습니다(한 자리에 여러 장이면 한 장씩 라벨이 다를 수는 있습니다): ',
      s.conflicts.map(function (c) { return c.model + ' ' + c.serial + ' 위치 ' + c.pos + '(' + c.labels.join('·') + ')'; }).join(', ')));
    if (s.bad.length) append(out, h('div', { class: 'card' }, h('h2', null, '이름을 확인해 주세요'), h('ul', { class: 'finds' }, s.bad.map(function (x) { return h('li', null, h('b', null, x.path), ' — ', x.problems.join(' · ')); }))));
    if (s.ok.length) append(out, h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: function () { download('라벨표_' + stamp() + '.csv', new Blob([L.labelCsv(s)], { type: 'text/csv;charset=utf-8' })); } }, '라벨 표 CSV 내려받기')));
    if (!paths.length) append(out, h('p', { class: 'note' }, '고른 폴더에 파일이 없습니다.'));
  }

  // ── #/settings 설정·데이터 ───────────────────────────────────
  function pageSettings() {
    main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '설정·데이터')));
    var offChk = h('input', { type: 'checkbox', checked: offline() });
    offChk.addEventListener('change', function () { db.settings.offline_mode = offChk.checked; db.settings.offline_user_set = true; save(); toast(offChk.checked ? '폐쇄망 모드를 켰습니다. AI 도우미가 숨겨집니다.' : '폐쇄망 모드를 껐습니다. 사진 판정 화면에 AI 도우미가 나타납니다.'); render(); });
    var card = h('div', { class: 'card', id: 'offlineCard' }, h('h2', null, '폐쇄망 모드 · 외부 전송'),
      h('label', { class: 'check-line' }, offChk, h('span', null, h('b', null, '폐쇄망 모드 (기본 꺼짐)'), h('br'), '인터넷 없는 사내 PC 나 사진을 회사 밖으로 보내면 안 되는 경우에 켜 주세요. 켜 두면 이 화면은 어떤 데이터도 밖으로 보내지 않고, AI 도우미(요청문 복사·내 키로 자동 제안)를 숨깁니다. 2026-09-30 제출자 답(「폐쇄망으로 안 해도 될 듯」)으로 기본값을 꺼짐으로 바꿨습니다.')));
    if (!offline()) {
      var key = h('input', { type: 'password', value: S.getKey(), placeholder: 'sk-…', autocomplete: 'off', 'aria-label': 'OpenAI API 키' });
      var model = h('input', { type: 'text', value: db.settings.ai_model || 'gpt-4o-mini', 'aria-label': '모델' });
      append(card, h('div', { class: 'alert info' }, '폐쇄망 모드가 꺼져 있습니다. 성적서·사진은 여전히 이 브라우저 안에서만 읽습니다. 밖으로 나가는 것은 「AI 제안 받기(내 키)」를 누른 그 위치의 가이드·사진과 요청문뿐이고(OpenAI), 누르지 않으면 아무것도 보내지 않습니다.'),
        h('div', { class: 'form-grid' }, field('내 OpenAI API 키 (이 브라우저에만 저장, 백업에 안 들어감)', key, 'span-2'), field('모델', model)),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { S.setKey(key.value.trim()); db.settings.ai_model = model.value.trim() || 'gpt-4o-mini'; save(); toast('저장했습니다.'); } }, '키 저장'),
          h('button', { type: 'button', class: 'btn', onclick: function () { S.setKey(''); key.value = ''; toast('키를 지웠습니다.'); } }, '키 지우기')));
    }
    main.appendChild(card);

    var thumbChk = h('input', { type: 'checkbox', checked: db.settings.keep_thumbs !== false });
    thumbChk.addEventListener('change', function () { db.settings.keep_thumbs = thumbChk.checked; if (!thumbChk.checked) db.thumbs = {}; save(); render(); });
    var kb = Math.round(S.bytes() / 1024);
    main.appendChild(h('div', { class: 'card', id: 'storagePolicy' }, h('h2', null, '무엇을 저장하나요'),
      h('ul', null,
        h('li', null, h('b', null, '사진 원본은 저장하지 않습니다. '), '올린 그 창에서만 화면에 띄우고, 창을 닫거나 새로 고치면 사라집니다.'),
        h('li', null, h('b', null, '저장하는 것: '), '성적서마다 머리칸·결과표·위치별 사진 수, 사진 지문(파일 지문과 모양 지문 — 같은 사진 찾기용), 사람의 판정 기록, 설정.'),
        h('li', null, h('b', null, '미리보기: '), '가이드·사진마다 긴 변 96px 짜리 작은 그림(한 장 약 2~4KB)을 남겨, 다시 열었을 때 어느 사진이었는지 알아볼 수 있게 합니다. 끌 수 있습니다.'),
        h('li', null, '저장 위치는 이 PC 브라우저(localStorage)뿐입니다. 서버·클라우드로 가지 않습니다.')),
      h('label', { class: 'check-line' }, thumbChk, h('span', null, '미리보기 저장 (끄면 다시 열었을 때 사진 자리가 비어 보입니다)')),
      h('p', { class: 'note' }, '지금 저장 크기 약 ' + kb + 'KB (브라우저 한도는 보통 5MB 안팎) · 성적서 ' + db.reports.length + '장 · 판정 기록 ' + db.judgements.length + '건')));

    var restore = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '백업 파일 고르기' });
    restore.addEventListener('change', function () {
      var f = restore.files[0]; restore.value = ''; if (!f) return;
      f.text().then(function (t) { var nd = L.parseBackup(t); nd.thumbs = JSON.parse(t).thumbs || {}; db = nd; save(); toast('복원했습니다.'); render(); }).catch(function (e) { toast(e.message, true); });
    });
    main.appendChild(h('div', { class: 'card' }, h('h2', null, '백업·복원'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { var b = L.makeBackup(db); b.thumbs = db.thumbs; download('용접누락검출_백업_' + stamp() + '.json', new Blob([JSON.stringify(b)], { type: 'application/json' })); } }, '백업 파일 저장'),
        h('span', { class: 'btn file-btn' }, '백업 파일로 복원', restore),
        h('button', { type: 'button', class: 'btn', onclick: loadSamples }, '예시 성적서 불러오기'),
        h('button', { type: 'button', class: 'btn btn-danger', onclick: function () { confirmBox('모두 지우기', '성적서·판정 기록·미리보기를 이 브라우저에서 모두 지웁니다. 되돌릴 수 없습니다.', '모두 지우기', function () { var s = db.settings; db = L.emptyDb(); db.settings = s; db.thumbs = {}; media = {}; ui.lastResults = null; save(); render(); }); } }, '모두 지우기')),
      h('p', { class: 'note' }, '백업 파일에는 API 키가 들어가지 않습니다.')));

    main.appendChild(h('div', { class: 'card', id: 'offlineGuide' }, h('h2', null, '폐쇄망 사용법 (사내망·인터넷 없는 PC)'),
      h('ol', { class: 'steps' },
        h('li', null, '인터넷이 되는 PC 에서 이 저장소를 「Code → Download ZIP」으로 받습니다.'),
        h('li', null, 'ZIP 을 사내 PC 로 옮겨 풀고, 폴더의 index.html 을 크롬·엣지로 엽니다(더블클릭).'),
        h('li', null, '「설정·데이터」에서 폐쇄망 모드를 켭니다(기본은 꺼짐). 화면 위 띠에 「폐쇄망 모드 · 이 화면은 어떤 데이터도 외부로 보내지 않습니다」가 보이면 그대로 씁니다.'),
        h('li', null, '결과는 그 PC 브라우저 저장소와 내려받은 CSV·백업 파일에만 남습니다.')),
      h('p', { class: 'note' }, '확인 방법: 개발자 도구(F12) → 네트워크 탭을 연 채로 써 보시면 외부 요청이 없습니다. 코드에서 밖으로 요청하는 곳은 폐쇄망 모드를 껐을 때의 「AI 제안 받기」(js/ai.js) 한 곳뿐이고, index.html 의 보안 정책(Content-Security-Policy)이 그 밖의 주소로 연결하는 것을 막습니다. test/logic.test.mjs 의 「폐쇄망」 검사가 이를 확인합니다.')));
  }

  // ── 라우팅 ────────────────────────────────────────────────
  var ROUTES = [['upload', '성적서 올리기', pageUpload], ['check', '자동 점검', pageCheck], ['review', '사진 판정', pageReview], ['welders', '용접사별 누적', pageWelders], ['labels', '라벨 사진', pageLabels], ['settings', '설정·데이터', pageSettings]];
  function render() {
    var m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(location.hash || '');
    var name = m ? m[1] : 'upload', params = {};
    if (m && m[2]) m[2].split('&').forEach(function (kv) { var p = kv.split('='); params[p[0]] = decodeURIComponent(p[1] || ''); });
    var route = ROUTES.filter(function (r) { return r[0] === name; })[0] || ROUTES[0];
    var nav = document.getElementById('nav'); nav.textContent = '';
    ROUTES.forEach(function (r) { nav.appendChild(h('a', { href: '#/' + r[0], 'aria-current': r[0] === route[0] ? 'page' : null }, r[1])); });
    main.textContent = '';
    route[2](params);
    document.title = route[1] + ' · 용접누락 방지 검출';
    updateNetBadge();
    document.getElementById('sampleBanner').hidden = !db._sample;
  }
  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });
  if (!S.available()) { var sb = document.getElementById('storeBanner'); sb.textContent = '이 브라우저에서는 저장소를 쓸 수 없어, 창을 닫으면 내용이 사라집니다.'; sb.hidden = false; }
  render();
})();
