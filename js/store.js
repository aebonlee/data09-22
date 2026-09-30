/*
 * 브라우저 저장소 — localStorage 를 쓰되, 막혀 있거나 가득 차면 메모리로만 동작합니다.
 *
 * 저장하는 것: 성적서 분석 결과(머리칸·결과표·위치별 사진 수·사진 지문), 사람의 판정 기록, 설정.
 * 저장하지 않는 것: 사진 원본. 사진은 올린 그 창에서만 화면에 띄우고, 저장소에는 지문(hash·dHash)과
 *   작은 미리보기(긴 변 96px JPEG, 한 장 약 2~4KB — 설정에서 끌 수 있음)만 남깁니다.
 * API 키는 따로(KEY_AI) 두고 백업 파일에 넣지 않습니다.
 */
(function (root) {
  'use strict';
  var KEY_DB = 'data09-22.db';
  var KEY_AI = 'data09-22.openai_key';
  var memory = {};
  var ok = true, full = false;
  function get(k) {
    try { return root.localStorage.getItem(k); } catch (e) { ok = false; return memory[k] == null ? null : memory[k]; }
  }
  function set(k, v) {
    try { root.localStorage.setItem(k, v); full = false; return true; }
    catch (e) { memory[k] = v; if (e && /quota/i.test(e.name + e.message)) full = true; else ok = false; return false; }
  }
  function del(k) { try { root.localStorage.removeItem(k); } catch (e) { ok = false; } delete memory[k]; }
  function loadDb() {
    var L = root.WLogic;
    var db = L.emptyDb();
    var raw = get(KEY_DB);
    if (!raw) return db;
    try {
      var p = JSON.parse(raw);
      if (Array.isArray(p.reports)) db.reports = p.reports;
      if (Array.isArray(p.judgements)) db.judgements = p.judgements;
      db.settings = L.mergeSettings(p.settings); // 폐쇄망 모드 기본값 바뀜(2026-09-30) 반영
      if (p.thumbs && typeof p.thumbs === 'object') db.thumbs = p.thumbs;
      if (p._sample) db._sample = true;
    } catch (e) { /* 깨진 값은 무시하고 빈 DB */ }
    return db;
  }
  root.WStore = {
    loadDb: loadDb,
    saveDb: function (db) { return set(KEY_DB, JSON.stringify(db)); },
    clearDb: function () { del(KEY_DB); },
    getKey: function () { return get(KEY_AI) || ''; },
    setKey: function (k) { if (k) set(KEY_AI, k); else del(KEY_AI); },
    available: function () { get(KEY_DB); return ok; },
    isFull: function () { return full; },
    bytes: function () { var r = get(KEY_DB); return r ? r.length * 2 : 0; }
  };
})(window);
