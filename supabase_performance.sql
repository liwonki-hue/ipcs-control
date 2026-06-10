-- 성능 개선용 Supabase RPC 함수 2개
-- Supabase SQL 에디터에서 실행 후 app.py 재시작 필요

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

-- 2. Joint Master 패키지 필터용 — 시스템별 distinct 패키지 목록 단일 쿼리
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
