-- ============================================================================
-- data09-22 — 용접누락 방지 검출
-- Supabase(PostgreSQL) 스키마 + RLS
--
--  무엇인가 : 지금 브라우저 localStorage 에 두는 성적서 분석 결과 · 위치별 판정 기록을 DB 로 옮길 때 쓸
--             표 구조입니다. 앱 연결은 다음 단계입니다(폐쇄망 요구가 확정된 뒤 — 기획서 10장).
--  실행 위치 : 수강생 본인(또는 회사 내부) Supabase 프로젝트의 SQL Editor
--  재실행    : 안전합니다 (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS 선행)
--
--  본인 프로젝트에 올리는 것을 전제로 하므로 표 이름에 접두사를 붙이지 않았습니다.
--  주소·키는 이 파일 어디에도 없습니다.
--
--  표 목록                                   ← 지금 앱의 저장 위치(localStorage 'data09-22.db')
--    weld_reports        성적서(시트 하나 = 한 행)  ← .reports
--    weld_judgement_log  위치별 판정 기록           ← .judgements  (덧붙이기만 — 고치기·지우기 없음)
--    welder_stats (뷰)   용접사별 누적              ← 화면 「용접사별 누적」과 같은 계산
--
--  설계 메모
--    · 사진 원본은 DB 에도 두지 않습니다. positions(jsonb)에는 위치별 사진 수·도면 각장·사진 지문(파일 지문, 모양 지문)만.
--    · 판정은 기록입니다. 판정을 바꾸면 새 행을 넣고, 같은 (성적서, 위치)의 가장 최근 행이 현재 판정입니다.
--      사후 조작을 막으려고 UPDATE/DELETE 정책도 권한도 두지 않습니다.
--    · 판정 기록이 달린 성적서는 지울 수 없습니다(on delete restrict) — 지우면 기록이 사라지기 때문입니다.
--    · 판정 기록은 자기 성적서에만 달 수 있습니다((report_id, owner_id) 복합 외래키).
--
--  보안
--    모든 표 RLS 켬. 행은 만든 사람(owner_id = auth.uid())만 봅니다. 비로그인(anon)은 표·뷰 권한 자체를 걷었습니다.
--    뷰는 security_invoker 로 만들어 부르는 사람의 RLS 가 그대로 걸립니다(PostgreSQL 15 이상, Supabase 는 15 이상).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

create table if not exists public.weld_reports (
  id               bigint generated always as identity primary key,
  owner_id         uuid not null default auth.uid(),
  file_name        text not null check (length(btrim(file_name)) > 0),
  file_hash        text not null check (length(file_hash) > 0),        -- 파일 지문(같은 파일 다시 올림 판별)
  sheet_name       text not null,
  layout           text not null check (layout in ('W2', 'P2')),       -- W2 = 위치 A~F 성적서, P2 = 위치 번호 보고서
  part             text check (part is null or part in ('Boom', 'Arm')),
  partner          text,                                               -- 협력사(P2 양식은 칸이 없어 사람이 적음)
  model            text,
  part_no          text,
  part_name        text,
  inspect_date     date,                                               -- 날짜로 읽힌 경우만
  inspect_date_raw text,                                               -- 칸에 적힌 글자 그대로(「월 일」 등)
  date_status      text not null check (date_status in ('ok', 'blank', 'placeholder', 'invalid', 'absent')),
  serial_no        text,
  welder           text,                                               -- 여럿이면 쉼표·「/」로 구분
  inspector        text,
  results          jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  positions        jsonb not null default '[]'::jsonb check (jsonb_typeof(positions) = 'array'),
  findings         jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array'),
  created_at       timestamptz not null default now(),
  constraint weld_reports_date_ok check ((date_status = 'ok') = (inspect_date is not null)),
  -- ⚠ upsert 시 onConflict: 'owner_id,file_hash,sheet_name'
  constraint weld_reports_file_sheet_key unique (owner_id, file_hash, sheet_name),
  constraint weld_reports_id_owner_key unique (id, owner_id)             -- 판정 기록의 복합 외래키 대상
);
create index if not exists weld_reports_owner_partner_idx on public.weld_reports (owner_id, partner, model);

create table if not exists public.weld_judgement_log (
  id             bigint generated always as identity primary key,
  owner_id       uuid not null default auth.uid(),
  report_id      bigint not null,
  position       text not null check (position ~ '^([A-F]|[0-9]{1,2})$'),
  verdict        text not null check (verdict in ('good', 'suspect', 'unreadable')),   -- 양호 / 누락 의심 / 판독 불가
  memo           text,
  judged_by      text,
  ai_verdict     text check (ai_verdict is null or ai_verdict in ('good', 'suspect', 'unreadable')),  -- 그때 본 AI 제안(참고)
  ai_reason      text,
  ai_confidence  numeric check (ai_confidence is null or ai_confidence between 0 and 1),
  created_at     timestamptz not null default now(),
  constraint weld_judgement_log_report_fk foreign key (report_id, owner_id)
    references public.weld_reports (id, owner_id) on delete restrict
);
create index if not exists weld_judgement_log_report_idx on public.weld_judgement_log (report_id, position, created_at desc, id desc);

-- ----------------------------------------------------------------------------
-- 2. 용접사별 누적 뷰 — 화면 계산(js/logic.js welderStats)과 같은 규칙
--    · (성적서, 위치)마다 가장 최근 판정 하나만 셉니다
--    · 용접사 칸을 쉼표·「/」·「·」·「;」로 나눠 각자에게 셉니다
--    · 비율 = 누락 의심 위치 ÷ 판정한 위치
-- ----------------------------------------------------------------------------

create or replace view public.welder_stats with (security_invoker = true) as
with latest as (
  select distinct on (j.report_id, j.position) j.report_id, j.position, j.verdict
    from public.weld_judgement_log j
   order by j.report_id, j.position, j.created_at desc, j.id desc
),
per_report as (
  select r.id as report_id, r.owner_id, coalesce(nullif(btrim(r.partner), ''), '') as partner, coalesce(r.model, '') as model,
         btrim(w) as welder
    from public.weld_reports r
    cross join lateral regexp_split_to_table(coalesce(nullif(btrim(r.welder), ''), '(용접사 미기재)'), '[,/·;]+') as w
   where btrim(w) <> ''
),
counted as (
  select p.owner_id, p.welder, p.partner, p.model, p.report_id,
         count(l.position)                                  as judged,
         count(*) filter (where l.verdict = 'good')         as good,
         count(*) filter (where l.verdict = 'suspect')      as suspect,
         count(*) filter (where l.verdict = 'unreadable')   as unreadable
    from per_report p left join latest l on l.report_id = p.report_id
   group by p.owner_id, p.welder, p.partner, p.model, p.report_id
)
select owner_id, welder, partner, model,
       count(*)                                 as reports,
       count(*) filter (where judged > 0)       as judged_reports,
       sum(judged)::int                         as judged_positions,
       sum(good)::int                           as good,
       sum(suspect)::int                        as suspect,
       sum(unreadable)::int                     as unreadable,
       round(sum(suspect)::numeric / nullif(sum(judged), 0), 4) as suspect_rate,
       count(*) filter (where suspect > 0)      as suspect_reports
  from counted
 group by owner_id, welder, partner, model;

-- ----------------------------------------------------------------------------
-- 3. RLS — 본인 행만. 판정 기록은 읽기·넣기만.
-- ----------------------------------------------------------------------------

alter table public.weld_reports       enable row level security;
alter table public.weld_judgement_log enable row level security;

drop policy if exists weld_reports_select on public.weld_reports;
drop policy if exists weld_reports_insert on public.weld_reports;
drop policy if exists weld_reports_delete on public.weld_reports;
create policy weld_reports_select on public.weld_reports for select to authenticated using (owner_id = auth.uid());
create policy weld_reports_insert on public.weld_reports for insert to authenticated with check (owner_id = auth.uid());
-- 고치기 대신 지우고 다시 올립니다(판정 기록이 달린 성적서는 외래키가 막음)
create policy weld_reports_delete on public.weld_reports for delete to authenticated using (owner_id = auth.uid());

drop policy if exists weld_judgement_log_select on public.weld_judgement_log;
drop policy if exists weld_judgement_log_insert on public.weld_judgement_log;
create policy weld_judgement_log_select on public.weld_judgement_log for select to authenticated using (owner_id = auth.uid());
create policy weld_judgement_log_insert on public.weld_judgement_log for insert to authenticated with check (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 4. 표·뷰 권한 — Supabase 는 새 표마다 anon·authenticated 에 전 권한을 붙이므로 걷고 필요한 것만 줍니다.
-- ----------------------------------------------------------------------------

revoke all on public.weld_reports, public.weld_judgement_log, public.welder_stats from public, anon, authenticated;
grant select, insert, delete on public.weld_reports to authenticated;
grant select, insert on public.weld_judgement_log to authenticated;          -- UPDATE·DELETE 권한 없음(덧붙이기만)
grant select on public.welder_stats to authenticated;

-- 이 스키마에는 함수가 없습니다(트리거·RPC 없음).

-- ----------------------------------------------------------------------------
-- 끝.
-- ----------------------------------------------------------------------------
