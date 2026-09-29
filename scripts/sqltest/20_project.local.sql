-- ============================================================================
-- 로컬 검증 전용 — data09-22 프로젝트별 검증 (운영 실행 금지, 가드 내장)
--
--  사용자 A·B 두 명과 비로그인(anon)을 번갈아 흉내 내어
--  ① 본인 행만 보이는가 ② 판정 기록은 덧붙이기만 되는가(고치기·지우기 불가)
--  ③ 남의 성적서에 판정을 달 수 없는가 ④ 판정 기록이 달린 성적서는 지울 수 없는가
--  ⑤ CHECK·UNIQUE 가 걸리는가 ⑥ 용접사별 누적 뷰가 화면 계산과 같은가 ⑦ anon 은 아무것도 못 하는가 를 잰다.
-- ============================================================================

do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

create or replace function public._assert_raises(p_sql text, p_state text, p_label text)
returns void language plpgsql set search_path = public as $fn$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then raise notice '  OK   %', p_label; return; end if;
    raise exception 'FAIL  %  (기대 SQLSTATE %, 실제 % — %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL  %  (기대 SQLSTATE % 인데 성공했다)', p_label, p_state;
end;
$fn$;
grant execute on function public._assert_raises(text, text, text) to authenticated, anon;
grant execute on function public._assert(boolean, text) to authenticated, anon;
grant execute on function public._assert_eq(anyelement, anyelement, text) to authenticated, anon;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com')
on conflict (id) do nothing;

do $t$ begin raise notice '[프로젝트] data09-22 — 소유자 격리 · 덧붙이기 전용 기록 · 복합 외래키 · 누적 뷰 · anon 차단'; end $t$;

-- ----------------------------------------------------------------------------
-- 1. 사용자 A 가 성적서 3장을 올리고 위치별로 판정한다
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $t$
declare r1 bigint; r2 bigint; r3 bigint;
begin
  insert into public.weld_reports (file_name, file_hash, sheet_name, layout, part, partner, model, date_status, inspect_date_raw, serial_no, welder, inspector, positions)
  values ('예시.xlsx', 'fh1', 'S01', 'W2', 'Boom', '협력사X', 'MX14', 'placeholder', '월     일', 'S01', '용접사A', '검사원A', '[{"pos":"A","photos":[{"hash":"p1"}]}]')
  returning id into r1;
  insert into public.weld_reports (file_name, file_hash, sheet_name, layout, partner, model, date_status, inspect_date, serial_no, welder)
  values ('예시.xlsx', 'fh1', 'S02', 'W2', '협력사X', 'MX14', 'ok', '2026-09-21', 'S02', '용접사A, 용접사B') returning id into r2;
  insert into public.weld_reports (file_name, file_hash, sheet_name, layout, partner, model, date_status, inspect_date, serial_no, welder)
  values ('형식2.xlsx', 'fh2', '내부용접-01', 'P2', '협력사Y', 'LX20', 'ok', '2026-09-25', 'L01', '용접사B') returning id into r3;

  perform public._assert_eq((select owner_id from public.weld_reports where id = r1),
    '11111111-1111-1111-1111-111111111111'::uuid, 'owner_id 기본값이 auth.uid() 로 채워진다');

  -- S01: A 양호, B 누락 의심, C 양호, D 판독 불가 → 용접사A 4위치 중 1
  insert into public.weld_judgement_log (report_id, position, verdict) values (r1, 'A', 'good'), (r1, 'B', 'suspect'), (r1, 'C', 'good'), (r1, 'D', 'unreadable');
  -- S02: A 누락 의심 → 다시 보고 양호로(새 행), E 누락 의심 → 용접사A·B 각각 2위치 중 1
  insert into public.weld_judgement_log (report_id, position, verdict, ai_verdict, ai_confidence) values (r2, 'A', 'suspect', 'suspect', 0.7);
  insert into public.weld_judgement_log (report_id, position, verdict, memo) values (r2, 'A', 'good', '재확인 — 비드 있음');
  insert into public.weld_judgement_log (report_id, position, verdict) values (r2, 'E', 'suspect');
  -- 형식2: 위치 번호
  insert into public.weld_judgement_log (report_id, position, verdict) values (r3, '1', 'good');

  perform public._assert_eq((select count(*) from public.weld_judgement_log), 8::bigint, '판정 기록 8행(고친 판정도 새 행으로 남음)');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 2. 누적 뷰 — 가장 최근 판정만, 용접사 여럿이면 각자, 비율
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $t$
declare s record;
begin
  select * into s from public.welder_stats where welder = '용접사A';
  perform public._assert_eq(s.reports, 2::bigint, '용접사A — 성적서 2장');
  perform public._assert_eq(s.judged_positions, 6, '용접사A — 판정한 위치 6 (S01 4 + S02 2, S02-A 는 최근 판정 하나만)');
  perform public._assert_eq(s.suspect, 2, '용접사A — 누락 의심 2 (S01-B, S02-E; S02-A 는 양호로 고침)');
  perform public._assert_eq(s.suspect_rate, 0.3333::numeric, '용접사A — 비율 0.3333');
  perform public._assert_eq(s.suspect_reports, 2::bigint, '용접사A — 누락 의심 성적서 2');
  select * into s from public.welder_stats where welder = '용접사B' and partner = '협력사X';
  perform public._assert_eq(s.judged_positions, 2, '용접사B(협력사X) — 쉼표로 나눈 두 번째 용접사도 따로 셈');
  perform public._assert_eq(s.suspect_rate, 0.5000::numeric, '용접사B(협력사X) — 비율 0.5');
  select * into s from public.welder_stats where welder = '용접사B' and partner = '협력사Y';
  perform public._assert_eq(s.suspect_rate, 0::numeric, '용접사B(협력사Y) — 협력사별로 나뉨, 누락 의심 0');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 3. 기록은 덧붙이기만 · 성적서 삭제 제한 · 제약
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $t$
declare r1 bigint;
begin
  select id into r1 from public.weld_reports where sheet_name = 'S01';
  perform public._assert_raises($s$update public.weld_judgement_log set verdict = 'good' where position = 'B'$s$, '42501', '본인도 판정 기록을 고칠 수 없다(UPDATE 권한 없음)');
  perform public._assert_raises($s$delete from public.weld_judgement_log$s$, '42501', '본인도 판정 기록을 지울 수 없다(DELETE 권한 없음)');
  perform public._assert_raises($s$update public.weld_reports set welder = '바꿈'$s$, '42501', '성적서는 고치지 않고 지우고 다시 올린다(UPDATE 권한 없음)');
  perform public._assert_raises(format('delete from public.weld_reports where id = %s', r1), '23503', '판정 기록이 달린 성적서는 지울 수 없다(on delete restrict)');
  perform public._assert_raises(format($s$insert into public.weld_judgement_log (report_id, position, verdict) values (%s, 'A', '양호')$s$, r1), '23514', '판정 값은 good·suspect·unreadable 만');
  perform public._assert_raises(format($s$insert into public.weld_judgement_log (report_id, position, verdict) values (%s, 'G', 'good')$s$, r1), '23514', '위치는 A~F 또는 번호만');
  perform public._assert_raises(format($s$insert into public.weld_judgement_log (report_id, position, verdict, ai_confidence) values (%s, 'A', 'good', 1.5)$s$, r1), '23514', 'AI 신뢰도는 0~1');
  perform public._assert_raises($s$insert into public.weld_reports (file_name, file_hash, sheet_name, layout, date_status) values ('예시.xlsx', 'fh1', 'S01', 'W2', 'blank')$s$, '23505', '같은 파일·시트는 한 번만(UNIQUE)');
  perform public._assert_raises($s$insert into public.weld_reports (file_name, file_hash, sheet_name, layout, date_status) values ('x.xlsx', 'fh9', 'S', 'X9', 'blank')$s$, '23514', '양식은 W2·P2 만');
  perform public._assert_raises($s$insert into public.weld_reports (file_name, file_hash, sheet_name, layout, date_status) values ('x.xlsx', 'fh9', 'S', 'W2', 'ok')$s$, '23514', '검사일 상태 ok 면 날짜가 있어야 함');
  -- 판정이 없는 성적서는 지울 수 있다
  insert into public.weld_reports (file_name, file_hash, sheet_name, layout, date_status) values ('잘못.xlsx', 'fh8', 'S', 'W2', 'blank');
  delete from public.weld_reports where file_hash = 'fh8';
  perform public._assert_eq((select count(*) from public.weld_reports where file_hash = 'fh8'), 0::bigint, '판정 없는 성적서는 지울 수 있다');
end $t$;
commit;

-- B 가 A 의 성적서 id 를 알아냈다고 가정하기 위해 관리자 권한으로 적어 둡니다
do $t$ begin perform set_config('test.a_report', (select id::text from public.weld_reports where sheet_name = 'S01'), false); end $t$;

-- ----------------------------------------------------------------------------
-- 4. 사용자 B — A 의 행을 보지도, 대신 쓰지도, A 성적서에 판정을 달지도 못한다
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
do $t$
declare r1 bigint; n bigint;
begin
  perform public._assert_eq((select count(*) from public.weld_reports) + (select count(*) from public.weld_judgement_log) + (select count(*) from public.welder_stats),
    0::bigint, 'B 에게는 A 의 성적서·판정·누적이 보이지 않는다');
  delete from public.weld_reports;
  get diagnostics n = row_count;
  perform public._assert_eq(n, 0::bigint, 'B 의 DELETE 는 A 의 성적서에 닿지 않는다');
  perform public._assert_raises($s$insert into public.weld_reports (owner_id, file_name, file_hash, sheet_name, layout, date_status) values ('11111111-1111-1111-1111-111111111111', 'x', 'h', 's', 'W2', 'blank')$s$,
    '42501', 'B 는 owner_id 를 A 로 적어 대신 쓸 수 없다');
  -- B 가 A 의 성적서 id 를 알아냈다고 가정한다(행은 안 보이므로 여기서는 권한 우회로 알아 둔 값)
  r1 := current_setting('test.a_report', true)::bigint;
  perform public._assert_raises(format($s$insert into public.weld_judgement_log (report_id, position, verdict) values (%s, 'A', 'suspect')$s$, r1),
    '23503', 'B 는 자기 owner_id 로라도 A 의 성적서에 판정을 달 수 없다(복합 외래키)');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 5. 비로그인(anon) — 표·뷰 모두 권한 없음
-- ----------------------------------------------------------------------------
begin;
set local role anon;
do $t$
begin
  perform public._assert_raises('select * from public.weld_reports', '42501', 'anon 은 성적서를 읽을 수 없다');
  perform public._assert_raises('select * from public.weld_judgement_log', '42501', 'anon 은 판정 기록을 읽을 수 없다');
  perform public._assert_raises('select * from public.welder_stats', '42501', 'anon 은 누적 뷰를 읽을 수 없다');
  perform public._assert_raises($s$insert into public.weld_judgement_log (report_id, position, verdict) values (1, 'A', 'good')$s$, '42501', 'anon 은 판정을 넣을 수 없다');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 6. 뷰가 security_invoker 인가(아니면 뷰 소유자 권한으로 RLS 를 건너뜀)
-- ----------------------------------------------------------------------------
do $t$
begin
  perform public._assert(
    (select coalesce(reloptions::text, '') like '%security_invoker=true%' from pg_class where oid = 'public.welder_stats'::regclass),
    'welder_stats 는 security_invoker 뷰다');
end $t$;

drop function public._assert_raises(text, text, text);
