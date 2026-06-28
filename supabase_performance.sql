-- 성능 개선용 Supabase RPC 함수 + 스키마 마이그레이션
-- Supabase SQL 에디터에서 실행 후 app.py 재시작 필요

-- ★ support_master 스키마 변경 (최초 1회 실행)
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE construction.support_master DROP COLUMN IF EXISTS welder;

-- ★ support_master 전체 삭제 RPC (RLS 우회용 — SECURITY DEFINER, TRUNCATE 사용)
CREATE OR REPLACE FUNCTION construction.clear_support_master()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = construction
AS $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt FROM support_master;
  TRUNCATE support_master RESTART IDENTITY;
  RETURN cnt;
END;
$$;

-- 1. Test Master readiness 계산용 — joint_master 47페이지 페이지네이션 → 단일 쿼리
CREATE OR REPLACE FUNCTION construction.get_pkg_readiness_stats_v1()
RETURNS TABLE(package TEXT, total BIGINT, completed BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        package,
        COUNT(*)             AS total,
        COUNT(date_completed) AS completed
    FROM construction.joint_master
    WHERE package IS NOT NULL AND package <> ''
    GROUP BY package
    ORDER BY package;
$$;

-- 2. Test Master readiness v2 — piping(joint_master) + support(support_master) 통합 진행률
CREATE OR REPLACE FUNCTION construction.get_pkg_readiness_stats_v2()
RETURNS TABLE(
    package          TEXT,
    piping_total     BIGINT,
    piping_completed BIGINT,
    support_total    BIGINT,
    support_installed BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        j.package,
        COUNT(j.id)               AS piping_total,
        COUNT(j.date_completed)   AS piping_completed,
        COALESCE(s.sup_total,     0) AS support_total,
        COALESCE(s.sup_installed, 0) AS support_installed
    FROM construction.joint_master j
    LEFT JOIN (
        SELECT
            package,
            COUNT(*)              AS sup_total,
            COUNT(date_completed) AS sup_installed
        FROM construction.support_master
        WHERE package IS NOT NULL AND package <> ''
        GROUP BY package
    ) s ON s.package = j.package
    WHERE j.package IS NOT NULL AND j.package <> ''
    GROUP BY j.package, s.sup_total, s.sup_installed
    ORDER BY j.package;
$$;

-- 3. Joint Master 패키지 필터용 — 시스템별 distinct 패키지 목록 단일 쿼리
CREATE OR REPLACE FUNCTION construction.get_distinct_packages_v1()
RETURNS TABLE(system TEXT, package TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT DISTINCT system, package
    FROM construction.joint_master
    WHERE package IS NOT NULL AND package <> ''
    ORDER BY system, package;
$$;


-- 4. support_master 시스템별 집계 — 22페이지 페이지네이션 → 단일 쿼리
CREATE OR REPLACE FUNCTION construction.get_support_breakdown_v1()
RETURNS TABLE(system TEXT, total BIGINT, completed BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        COALESCE(system, '') AS system,
        COUNT(*)              AS total,
        COUNT(date_completed) AS completed
    FROM construction.support_master
    GROUP BY system;
$$;

-- 5. test_package_master 시스템별 집계 — 페이지네이션 → 단일 쿼리
CREATE OR REPLACE FUNCTION construction.get_test_breakdown_v1()
RETURNS TABLE(system TEXT, total BIGINT, completed BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT
        COALESCE(system, '') AS system,
        COUNT(*)              AS total,
        COUNT(CASE WHEN completed THEN 1 END) AS completed
    FROM construction.test_package_master
    GROUP BY system;
$$;

-- 6. Joint Master 드롭다운 distinct 값 — 21회 개별 RPC 호출 → 단일 RPC 호출
CREATE OR REPLACE FUNCTION construction.get_jm_filter_values()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT json_build_object(
        'mat',       (SELECT json_agg(v ORDER BY v) FROM (SELECT DISTINCT mat AS v       FROM construction.joint_master WHERE mat       IS NOT NULL AND mat       <> '') t),
        'size_inch', (SELECT json_agg(v ORDER BY v) FROM (SELECT DISTINCT size_inch AS v FROM construction.joint_master WHERE size_inch IS NOT NULL) t),
        'pwht',      (SELECT json_agg(v ORDER BY v) FROM (SELECT DISTINCT pwht AS v      FROM construction.joint_master WHERE pwht      IS NOT NULL AND pwht      <> '') t)
    );
$$;
