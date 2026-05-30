-- ================================================================
-- 대시보드 성능 최적화: Cache Table + pg_cron + 병렬 Fallback
-- Supabase SQL Editor에서 순서대로 실행
-- ================================================================

-- ── STEP 1. joint_master 인덱스 (get_weekly_actuals JOIN 최적화) ──
CREATE INDEX IF NOT EXISTS idx_jm_date_completed
    ON construction.joint_master(date_completed);

CREATE INDEX IF NOT EXISTS idx_jm_phase
    ON construction.joint_master(phase);

-- ── STEP 2. 대시보드 캐시 테이블 ──
CREATE TABLE IF NOT EXISTS construction.dashboard_cache (
    cache_key TEXT PRIMARY KEY,
    data      JSONB NOT NULL,
    built_at  TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT ON construction.dashboard_cache TO anon, authenticated, service_role;

-- ── STEP 3. 캐시 갱신 함수 ──
-- 기존 RPC들을 DB 내부에서 직접 호출 → 네트워크 왕복 없음
CREATE OR REPLACE FUNCTION construction.refresh_dashboard_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'construction', 'public'
AS $$
DECLARE
    v17_data JSON;
    v2_data  JSON;
    ep_data  JSONB;
    wa_data  JSONB;
    combined JSONB;
BEGIN
    SELECT construction.get_dashboard_summary_v17()           INTO v17_data;
    SELECT construction.get_dashboard_aggregates_control_v2() INTO v2_data;
    SELECT construction.get_ep_aggregates()                   INTO ep_data;
    SELECT construction.get_weekly_actuals()                  INTO wa_data;

    combined := jsonb_build_object(
        'v17',      to_jsonb(v17_data),
        'v2',       to_jsonb(v2_data),
        'ep',       ep_data,
        'wa',       wa_data,
        'built_at', NOW()
    );

    INSERT INTO construction.dashboard_cache (cache_key, data, built_at)
    VALUES ('main', combined, NOW())
    ON CONFLICT (cache_key) DO UPDATE
        SET data = EXCLUDED.data, built_at = NOW();

    RAISE NOTICE 'Dashboard cache refreshed at %', NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION construction.refresh_dashboard_cache()
    TO anon, authenticated, service_role;

-- ── STEP 4. pg_cron 등록 (5분마다 자동 갱신) ──
-- 기존 job 있으면 삭제 (없어도 에러 안 남)
DO $$
BEGIN
    PERFORM cron.unschedule('bop-dashboard-refresh');
EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

SELECT cron.schedule(
    'bop-dashboard-refresh',
    '*/5 * * * *',
    'SELECT construction.refresh_dashboard_cache()'
);

-- ── STEP 5. 첫 캐시 즉시 빌드 (수십 초 소요) ──
SELECT construction.refresh_dashboard_cache();

-- 확인
SELECT cache_key, built_at, octet_length(data::text)/1024 AS kb
FROM construction.dashboard_cache;
