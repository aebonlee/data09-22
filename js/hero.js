/*
 * 표지 그림 움직임 — 용접 불꽃·아크 깜빡임, AI 시선 스캔·검출 상자·값, 눈동자 따라보기.
 *   · SVG 원래 모습이 「마지막 장면」입니다(스크립트가 없거나 움직임 줄이기 설정이면 그대로 보임).
 *   · requestAnimationFrame 하나로 돌리고, 탭이 숨었거나 표지가 화면에 없으면 멈춥니다.
 *   · 속성 값만 바꾸므로 레이아웃이 밀리지 않습니다. 외부 요청 없음.
 */
(function () {
  'use strict';
  var svg = document.getElementById('heroArt');
  if (!svg || !window.requestAnimationFrame) return;
  var NS = 'http://www.w3.org/2000/svg';
  function $(id) { return document.getElementById(id); }
  var glow = $('heroGlow'), core = $('heroCore'), visor = $('heroVisor');
  var sparksG = $('heroSparks'), sparksStatic = $('heroSparksStatic');
  var scan = $('heroScan'), scanLine = $('heroScanLine'), scanTick = $('heroScanTick');
  var eyes = $('heroEyes'), lens = $('heroLens'), led = $('heroLed'), hudDot = $('heroHudDot');
  var boxBead = $('heroBoxBead'), boxMiss = $('heroBoxMiss'), boxAngle = $('heroBoxAngle');
  var valBead = $('heroValBead'), valAngle = $('heroValAngle');
  var rows = [$('heroRow1'), $('heroRow2'), $('heroRow3'), $('heroRow4')];

  var TIP = { x: 522, y: 377 };          // 토치 끝(아크)
  var HELMET = { x: 400, y: 214 };       // 용접사 얼굴 쪽
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // 불꽃: 줄 요소를 미리 만들어 두고 다시 씁니다
  var POOL = 44, sparks = [];
  for (var i = 0; i < POOL; i++) {
    var ln = document.createElementNS(NS, 'line');
    ln.setAttribute('stroke-width', '2');
    ln.setAttribute('opacity', '0');
    sparksG.appendChild(ln);
    sparks.push({ el: ln, life: 0, age: 0, x: 0, y: 0, vx: 0, vy: 0 });
  }
  var COLORS = ['#fff6d6', '#ffe1a0', '#ffc36b', '#ffa94d', '#ff8a1f', '#e8651a'];
  function spawn(s) {
    s.x = TIP.x + (Math.random() - .5) * 4; s.y = TIP.y - 2;
    var a = -Math.PI / 2 + (Math.random() - .35) * 2.1;   // 위쪽 부채꼴(오른쪽으로 조금 치우침)
    var sp = 120 + Math.random() * 230;
    s.vx = Math.cos(a) * sp; s.vy = Math.sin(a) * sp;
    s.age = 0; s.life = .35 + Math.random() * .6; s.bounced = false;
  }
  function stepSpark(s, dt) {
    s.age += dt;
    if (s.age >= s.life) { s.life = 0; s.el.setAttribute('opacity', '0'); return; }
    s.vy += 620 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
    // 아래판 윗면·작업대 윗면에서 한 번 튐
    var floorY = (s.x > 420 && s.x < 712) ? 384 : (s.x > 330 && s.x < 790 ? 398 : 560);
    if (s.y > floorY && s.vy > 0) { if (s.bounced) { s.life = 0; s.el.setAttribute('opacity', '0'); return; } s.y = floorY; s.vy *= -.32; s.vx *= .55; s.bounced = true; }
    var k = s.age / s.life, tail = .028;
    s.el.setAttribute('x1', s.x.toFixed(1)); s.el.setAttribute('y1', s.y.toFixed(1));
    s.el.setAttribute('x2', (s.x - s.vx * tail).toFixed(1)); s.el.setAttribute('y2', (s.y - s.vy * tail).toFixed(1));
    s.el.setAttribute('stroke', COLORS[Math.min(COLORS.length - 1, Math.floor(k * COLORS.length))]);
    s.el.setAttribute('opacity', (1 - k * k).toFixed(2));
  }

  // 깜빡임: 부드러운 잡음(사인 몇 개) + 가끔 튀는 값
  function flicker(t) {
    var n = .55 * Math.sin(t * 31) + .3 * Math.sin(t * 57 + 1.3) + .15 * Math.sin(t * 113 + .7);
    if (Math.random() < .04) n += (Math.random() - .5) * 1.4;
    return Math.max(-1, Math.min(1, n));
  }

  function ease(x) { return x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x); }
  function fadeIn(t, start, dur) { return ease((t - start) / dur); }
  var CYCLE = 7.2, SCAN_T = 2.8, X0 = 700, X1 = 450;
  function setOp(el, v) { el.setAttribute('opacity', v.toFixed(3)); }

  function scene(t, dt) {
    // 아크·빛
    var f = flicker(t);
    setOp(glow, .72 + .2 * f);
    core.setAttribute('r', (15 + 3.5 * f).toFixed(1));
    setOp(visor, .55 + .3 * f);
    // 불꽃 뿜기(초당 약 70개, 깜빡임이 셀 때 더)
    var want = dt * (55 + 45 * Math.max(0, f));
    for (var i = 0; i < sparks.length && want > 0; i++) {
      if (sparks[i].life === 0 && Math.random() < want) { spawn(sparks[i]); want -= 1; }
    }
    for (var j = 0; j < sparks.length; j++) if (sparks[j].life) stepSpark(sparks[j], dt);

    // AI 스캔 주기
    var c = t % CYCLE;
    var sx = X0 + (X1 - X0) * ease(c / SCAN_T);
    var scanOn = c < SCAN_T ? Math.min(1, c / .25, (SCAN_T - c) / .3 + .0001) : 0;
    setOp(scan, Math.max(0, scanOn));
    scanLine.setAttribute('x2', sx.toFixed(1));
    scanTick.setAttribute('x', (sx - 12).toFixed(1));
    var tBead = SCAN_T * .42, tAngle = SCAN_T * .66, tMiss = SCAN_T * .9, tEnd = SCAN_T + .3;
    var out = c > CYCLE - .9 ? 1 - ease((c - (CYCLE - .9)) / .7) : 1;
    var aB = fadeIn(c, tBead, .35) * out, aA = fadeIn(c, tAngle, .35) * out, aM = fadeIn(c, tMiss, .35) * out;
    setOp(boxBead, aB); setOp(boxAngle, aA); setOp(boxMiss, aM);
    valBead.textContent = (7.8 * ease((c - tBead) / .8)).toFixed(1);
    valAngle.textContent = String(Math.round(45 * ease((c - tAngle) / .6)));
    setOp(rows[0], aB); setOp(rows[1], fadeIn(c, tAngle, .35) * out); setOp(rows[2], aM); setOp(rows[3], fadeIn(c, tEnd, .4) * out);

    // 시선: 스캔 중에는 스캔 점, 쉬는 동안 아크와 용접사 얼굴을 번갈아
    var target;
    if (c < SCAN_T) target = { x: sx, y: 386 };
    else target = (Math.floor((c - SCAN_T) / 1.6) % 2 === 0) ? TIP : HELMET;
    lookAt(target, dt);
    // 눈 깜박임(약 4초마다), 상태 불빛
    var blink = (t % 4.3) < .12 ? .15 : 1;
    eyes.setAttribute('transform', 'translate(' + gaze.x.toFixed(2) + ',' + gaze.y.toFixed(2) + ') ' + 'translate(0,' + (122 * (1 - blink)).toFixed(1) + ') scale(1,' + blink + ')');
    lens.setAttribute('cx', (616 + gaze.x * .9).toFixed(2)); lens.setAttribute('cy', (172 + gaze.y * .9).toFixed(2));
    var pulse = .55 + .45 * Math.sin(t * 4.2);
    setOp(led, pulse); setOp(hudDot, c < SCAN_T ? .5 + .5 * Math.sin(t * 16) : 1);
  }
  var gaze = { x: -3, y: 3 };
  function lookAt(p, dt) {
    var dx = p.x - 650, dy = p.y - 124, d = Math.sqrt(dx * dx + dy * dy) || 1;
    var gx = dx / d * 4.5, gy = dy / d * 4.5;
    var k = Math.min(1, dt * 6);
    gaze.x += (gx - gaze.x) * k; gaze.y += (gy - gaze.y) * k;
  }

  // 정지 장면(움직임 줄이기): 마크업 그대로 — 모든 표시가 보이고 스캔 선은 숨김
  function staticFrame() {
    sparks.forEach(function (s) { s.life = 0; s.el.setAttribute('opacity', '0'); });
    sparksStatic.removeAttribute('display');
    [boxBead, boxMiss, boxAngle].concat(rows).forEach(function (el) { el.setAttribute('opacity', '1'); });
    setOp(scan, 0); setOp(glow, .85); core.setAttribute('r', '16'); setOp(visor, .75); setOp(led, 1); setOp(hudDot, 1);
    valBead.textContent = '7.8'; valAngle.textContent = '45';
    eyes.removeAttribute('transform'); lens.setAttribute('cx', '614'); lens.setAttribute('cy', '175');
  }

  var raf = 0, last = 0, clock = 0, visible = true;
  function frame(now) {
    raf = 0;
    var dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
    last = now; clock += dt;
    scene(clock, dt);
    svg.setAttribute('data-frame', String((+svg.getAttribute('data-frame') || 0) + 1));
    schedule();
  }
  function running() { return !reduce.matches && !document.hidden && visible; }
  function schedule() { if (!raf && running()) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
  function update() {
    if (reduce.matches) { stop(); staticFrame(); svg.setAttribute('data-motion', 'static'); return; }
    svg.setAttribute('data-motion', 'on');
    sparksStatic.setAttribute('display', 'none');
    if (running()) schedule(); else stop();
  }
  document.addEventListener('visibilitychange', update);
  if (reduce.addEventListener) reduce.addEventListener('change', update); else if (reduce.addListener) reduce.addListener(update);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { visible = es[es.length - 1].isIntersecting; update(); }).observe(svg);
  }
  update();
})();
