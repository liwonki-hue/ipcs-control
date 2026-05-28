-- ============================================================
-- EP 데이터 집계 RPC 함수 (v2 - TEXT 타입 completed 컬럼 호환)
-- Supabase SQL Editor에서 실행 (liwonki project / construction schema)
-- Python 서버가 joint_master 전체를 메모리에 올리지 않도록
-- DB 레벨에서 집계 후 결과만 반환
-- ============================================================

-- ── 1. EP 시스템별 / 서브에어리어별 집계 ────────────────────────────────
CREATE OR REPLACE FUNCTION construction.get_ep_aggregates()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_sys  JSONB;
  v_area JSONB;
  v_wk   JSONB;
BEGIN
  -- EP 시스템별 집계 (total_di, completed_di) — date_completed 기준
  SELECT jsonb_agg(row_to_json(t)) INTO v_sys
  FROM (
    SELECT
      system,
      ROUND(SUM(di)::NUMERIC, 2) AS total_di,
      ROUND(SUM(CASE WHEN date_completed IS NOT NULL THEN di ELSE 0 END)::NUMERIC, 2) AS completed_di
    FROM construction.joint_master
    WHERE phase = 'EP'
    GROUP BY system
    ORDER BY SUM(di) DESC
  ) t;

  -- EP 서브에어리어별 집계
  SELECT jsonb_agg(row_to_json(t)) INTO v_area
  FROM (
    SELECT
      sub_area,
      ROUND(SUM(di)::NUMERIC, 2) AS total_di,
      ROUND(SUM(CASE WHEN date_completed IS NOT NULL THEN di ELSE 0 END)::NUMERIC, 2) AS completed_di
    FROM construction.joint_master
    WHERE phase = 'EP'
    GROUP BY sub_area
    ORDER BY SUM(di) DESC
  ) t;

  -- EP 주차별 완료 DI (week_schedule과 JOIN)
  SELECT jsonb_agg(row_to_json(t)) INTO v_wk
  FROM (
    SELECT
      ws.week_no,
      ROUND(SUM(j.di)::NUMERIC, 2) AS completed_di
    FROM construction.joint_master j
    JOIN construction.week_schedule ws
      ON j.date_completed BETWEEN ws.week_start_date AND ws.week_end_date
    WHERE j.phase = 'EP'
      AND j.date_completed IS NOT NULL
    GROUP BY ws.week_no
    ORDER BY ws.week_no
  ) t;

  RETURN jsonb_build_object(
    'ep_sys',    COALESCE(v_sys,  '[]'::JSONB),
    'ep_area',   COALESCE(v_area, '[]'::JSONB),
    'ep_weekly', COALESCE(v_wk,  '[]'::JSONB)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION construction.get_ep_aggregates()
  TO anon, authenticated, service_role;


-- ── 2. sync_phase_package_bulk: 엑셀 업로드 일괄 업데이트 ─────────────
--    (create_bulk_update_fn.sql의 함수와 동일 역할이지만 joint_no 정규화 포함)
CREATE OR REPLACE FUNCTION construction.bulk_update_phase_package(updates JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE construction.joint_master AS j
  SET
    phase   = COALESCE(u.phase,   j.phase),
    package = COALESCE(u.package, j.package)
  FROM (
    SELECT
      elem->>'iso'      AS iso_drawing,
      -- joint_no 정규화: '1.0' -> '1', '01' -> '1'
      CASE
        WHEN elem->>'joint_no' ~ '^\d+\.0+$'
          THEN TRIM(LEADING '0' FROM SPLIT_PART(elem->>'joint_no', '.', 1))
        WHEN elem->>'joint_no' ~ '^\d+$'
          THEN LTRIM(elem->>'joint_no', '0')
        ELSE elem->>'joint_no'
      END AS joint_no,
      NULLIF(elem->>'phase',   '') AS phase,
      NULLIF(elem->>'package', '') AS package
    FROM jsonb_array_elements(updates) AS elem
    WHERE elem->>'iso' IS NOT NULL
  ) AS u
  WHERE j.iso_drawing = u.iso_drawing
    AND (
      j.joint_no = u.joint_no
      OR LTRIM(j.joint_no, '0') = u.joint_no
      OR j.joint_no = LPAD(u.joint_no, LENGTH(j.joint_no), '0')
    );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION construction.bulk_update_phase_package(JSONB)
  TO anon, authenticated, service_role;
