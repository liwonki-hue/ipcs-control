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
