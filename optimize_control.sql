-- 1. 메타데이터 검색 최적화
CREATE OR REPLACE FUNCTION construction.get_distinct_meta_v2()
RETURNS json AS $$
DECLARE
    result json;
BEGIN
    SELECT json_build_object(
        'units', (SELECT array_to_json(array_agg(DISTINCT unit)) FROM construction.joint_master WHERE unit IS NOT NULL AND unit <> ''),
        'systems', (SELECT array_to_json(array_agg(DISTINCT system)) FROM construction.joint_master WHERE system IS NOT NULL AND system <> ''),
        'areas', (SELECT array_to_json(array_agg(DISTINCT area)) FROM construction.joint_master WHERE area IS NOT NULL AND area <> ''),
        'sub_areas', (SELECT array_to_json(array_agg(DISTINCT sub_area)) FROM construction.joint_master WHERE sub_area IS NOT NULL AND sub_area <> '')
    ) INTO result;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- 2. ISO Drawing 요약 집계 (서버사이드)
CREATE OR REPLACE FUNCTION construction.get_iso_summary_v2(
    f_system text DEFAULT NULL,
    f_unit text DEFAULT NULL,
    f_area text DEFAULT NULL,
    f_subarea text DEFAULT NULL
)
RETURNS TABLE (
    unit text,
    area text,
    sub_area text,
    system text,
    line_no text,
    iso_drawing text,
    total_fab_di numeric,
    total_erect_di numeric,
    remain_fab_di numeric,
    remain_erect_di numeric
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        j.unit,
        j.area,
        j.sub_area,
        j.system,
        j.line_no,
        j.iso_drawing,
        COALESCE(SUM(CASE WHEN (sf = 'S' OR sf ILIKE '%FAB%') THEN size_inch ELSE 0 END), 0) as total_fab_di,
        COALESCE(SUM(CASE WHEN (sf = 'F' OR sf ILIKE '%ERE%' OR sf ILIKE '%FIELD%') THEN size_inch ELSE 0 END), 0) as total_erect_di,
        COALESCE(SUM(CASE WHEN (sf = 'S' OR sf ILIKE '%FAB%') AND NOT (date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])) THEN size_inch ELSE 0 END), 0) as remain_fab_di,
        COALESCE(SUM(CASE WHEN (sf = 'F' OR sf ILIKE '%ERE%' OR sf ILIKE '%FIELD%') AND NOT (date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])) THEN size_inch ELSE 0 END), 0) as remain_erect_di
    FROM construction.joint_master j
    WHERE (f_system IS NULL OR f_system = '' OR j.system = f_system)
      AND (f_unit IS NULL OR f_unit = '' OR j.unit = f_unit)
      AND (f_area IS NULL OR f_area = '' OR j.area = f_area)
      AND (f_subarea IS NULL OR f_subarea = '' OR j.sub_area = f_subarea)
      AND j.iso_drawing IS NOT NULL
    GROUP BY j.unit, j.area, j.sub_area, j.system, j.line_no, j.iso_drawing;
END;
$$ LANGUAGE plpgsql;

-- 3. 대시보드 데이터 통합 집계 (Support, TestPackage, EP 포함)
CREATE OR REPLACE FUNCTION construction.get_dashboard_aggregates_control_v2()
RETURNS json AS $$
DECLARE
    units_data json;
    areas_data json;
    systems_data json;
    act_data json;
    ep_act_data json;
    kpi_data json;
    ep_kpi_data json;
    actual_plan_agg json;
BEGIN
    -- Systems aggregation with Support/Test Package counts
    SELECT json_agg(t) INTO systems_data FROM (
        SELECT 
            j.system,
            SUM(j.size_inch) as total_di, 
            SUM(CASE WHEN j.date_completed IS NOT NULL OR j.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN j.size_inch ELSE 0 END) as completed_di,
            COUNT(*) as total_joints,
            SUM(CASE WHEN j.date_completed IS NOT NULL OR j.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END) as completed_joints,
            (SELECT COUNT(*) FROM construction.support_master s WHERE s.system = j.system) as support_total,
            (SELECT COUNT(*) FROM construction.support_master s WHERE s.system = j.system AND (s.date_completed IS NOT NULL OR s.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))) as support_comp,
            (SELECT COUNT(*) FROM construction.test_package_master t WHERE t.system = j.system) as testpkg_total,
            (SELECT COUNT(*) FROM construction.test_package_master t WHERE t.system = j.system AND (t.date_completed IS NOT NULL OR t.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))) as testpkg_comp
        FROM construction.joint_master j
        WHERE j.system IS NOT NULL AND j.system <> ''
        GROUP BY j.system
    ) t;

    -- Unit aggregation
    SELECT json_agg(t) INTO units_data FROM (
        SELECT unit, SUM(size_inch) as total_di, 
               SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN size_inch ELSE 0 END) as completed_di,
               COUNT(*) as total_joints,
               SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END) as completed_joints
        FROM construction.joint_master
        WHERE unit IS NOT NULL AND unit <> ''
        GROUP BY unit
    ) t;

    -- Area aggregation
    SELECT json_agg(t) INTO areas_data FROM (
        SELECT 
            j.area,
            SUM(j.size_inch) as total_di, 
            SUM(CASE WHEN j.date_completed IS NOT NULL OR j.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN j.size_inch ELSE 0 END) as completed_di,
            COUNT(*) as total_joints,
            SUM(CASE WHEN j.date_completed IS NOT NULL OR j.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END) as completed_joints,
            (SELECT COUNT(*) FROM construction.support_master s WHERE s.sub_area = j.area) as support_total,
            (SELECT COUNT(*) FROM construction.support_master s WHERE s.sub_area = j.area AND (s.date_completed IS NOT NULL OR s.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))) as support_comp,
            (SELECT COUNT(*) FROM construction.test_package_master t WHERE t.sub_area = j.area) as testpkg_total,
            (SELECT COUNT(*) FROM construction.test_package_master t WHERE t.sub_area = j.area AND (t.date_completed IS NOT NULL OR t.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))) as testpkg_comp
        FROM construction.joint_master j
        WHERE j.area IS NOT NULL AND j.area <> ''
        GROUP BY j.area
    ) t;

    -- KPI data
    SELECT json_build_object(
        'total_di', SUM(size_inch),
        'completed_di', SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN size_inch ELSE 0 END),
        'total_joints', COUNT(*),
        'completed_joints', SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END),
        'fab_total_di', SUM(CASE WHEN sf = 'S' OR sf ILIKE '%FAB%' THEN size_inch ELSE 0 END),
        'fab_completed_di', SUM(CASE WHEN (sf = 'S' OR sf ILIKE '%FAB%') AND (date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])) THEN size_inch ELSE 0 END),
        'erect_total_di', SUM(CASE WHEN sf = 'F' OR sf ILIKE '%ERE%' OR sf ILIKE '%FIELD%' THEN size_inch ELSE 0 END),
        'erect_completed_di', SUM(CASE WHEN (sf = 'F' OR sf ILIKE '%ERE%' OR sf ILIKE '%FIELD%') AND (date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])) THEN size_inch ELSE 0 END),
        'support_total', (SELECT COUNT(*) FROM construction.support_master),
        'support_comp', (SELECT COUNT(*) FROM construction.support_master WHERE date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])),
        'testpkg_total', (SELECT COUNT(*) FROM construction.test_package_master),
        'testpkg_comp', (SELECT COUNT(*) FROM construction.test_package_master WHERE date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))
    ) INTO kpi_data FROM construction.joint_master;

    -- EP KPI data
    SELECT json_build_object(
        'total_di', SUM(size_inch),
        'completed_di', SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN size_inch ELSE 0 END),
        'total_joints', COUNT(*),
        'completed_joints', SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END),
        'fab_total_di', SUM(CASE WHEN sf = 'S' OR sf ILIKE '%FAB%' THEN size_inch ELSE 0 END),
        'fab_completed_di', SUM(CASE WHEN (sf = 'S' OR sf ILIKE '%FAB%') AND (date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])) THEN size_inch ELSE 0 END),
        'erect_total_di', SUM(CASE WHEN sf = 'F' OR sf ILIKE '%ERE%' OR sf ILIKE '%FIELD%' THEN size_inch ELSE 0 END),
        'erect_completed_di', SUM(CASE WHEN (sf = 'F' OR sf ILIKE '%ERE%' OR sf ILIKE '%FIELD%') AND (date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y'])) THEN size_inch ELSE 0 END)
    ) INTO ep_kpi_data FROM construction.joint_master WHERE phase = 'EP';

    -- Weekly actuals
    SELECT json_agg(t) INTO act_data FROM (
        SELECT 
            w.week_no, 
            w.week_start_date,
            w.week_end_date,
            SUM(j.size_inch) as completed_di,
            SUM(CASE WHEN j.sf = 'S' OR j.sf ILIKE '%FAB%' THEN j.size_inch ELSE 0 END) as fab_di,
            SUM(CASE WHEN j.sf = 'F' OR j.sf ILIKE '%ERE%' OR j.sf ILIKE '%FIELD%' THEN j.size_inch ELSE 0 END) as erect_di
        FROM construction.joint_master j
        JOIN construction.week_schedule w ON j.date_completed::date >= w.week_start_date::date 
                                         AND j.date_completed::date <= w.week_end_date::date
        WHERE j.date_completed IS NOT NULL
        GROUP BY w.week_no, w.week_start_date, w.week_end_date
    ) t;

    -- EP Weekly actuals
    SELECT json_agg(t) INTO ep_act_data FROM (
        SELECT 
            w.week_no, 
            SUM(j.size_inch) as completed_di,
            SUM(CASE WHEN j.sf = 'S' OR j.sf ILIKE '%FAB%' THEN j.size_inch ELSE 0 END) as fab_di,
            SUM(CASE WHEN j.sf = 'F' OR j.sf ILIKE '%ERE%' OR j.sf ILIKE '%FIELD%' THEN j.size_inch ELSE 0 END) as erect_di
        FROM construction.joint_master j
        JOIN construction.week_schedule w ON j.date_completed::date >= w.week_start_date::date 
                                         AND j.date_completed::date <= w.week_end_date::date
        WHERE j.date_completed IS NOT NULL AND j.phase = 'EP'
        GROUP BY w.week_no
    ) t;

    -- Plan aggregation from week_plan_items
    SELECT json_object_agg(week_no, json_build_object('f', total_f, 'e', total_e)) INTO actual_plan_agg FROM (
        SELECT week_no, SUM(plan_fab_di) as total_f, SUM(plan_erect_di) as total_e
        FROM construction.week_plan_items
        GROUP BY week_no
    ) t;

    RETURN json_build_object(
        'unit', units_data,
        'area', areas_data,
        'sys', systems_data,
        'act', act_data,
        'ep_act', ep_act_data,
        'kpi', kpi_data,
        'ep_kpi', ep_kpi_data,
        'actual_plan_agg', actual_plan_agg
    );
END;
$$ LANGUAGE plpgsql;

-- 4. 용접사 실적 요약 (Welder Summary) v4
-- 공동 용접(IWP-001/ IWP-002) 처리: 참여 용접사 수만큼 DI/Joint를 균등 분할
CREATE OR REPLACE FUNCTION construction.get_welder_stats_v4(
    f_date_from text DEFAULT NULL,
    f_date_to text DEFAULT NULL,
    f_system text DEFAULT NULL,
    f_welder text DEFAULT NULL
)
RETURNS json AS $$
DECLARE
    stats_data      json;
    ranking_data    json;
    weekly_data     json;
    monthly_data    json;
    last_week_data  json;
    last_month_data json;
BEGIN
    /*
     * 핵심 로직: CROSS JOIN LATERAL + unnest 로 공동 용접 분리
     *   welder = 'IWP-001/ IWP-002'  →  IWP-001 / IWP-002 각각
     *   ind_di    = size_inch / 참여 인원수  (DI 50% 균등 분할)
     *   ind_joint = 1.0       / 참여 인원수  (Joint 50% 균등 분할)
     *
     * 반환 구조:
     *   stats      : active_welders, total_joints, total_di, avg_di
     *   ranking    : welder, joints, total_di, working_days, avg_di_per_day
     *   weekly     : week_no, week_label, total_di, joints, active_welders, avg_di_per_welder
     *   monthly    : month, total_di, joints, active_welders, avg_di_per_welder
     *   last_week  : welder, joints, total_di, working_days, avg_di_per_day, week_label
     *   last_month : welder, joints, total_di, working_days, avg_di_per_day, month
     */

    -- ── 공통 LATERAL 서브쿼리 정의 (매크로처럼 반복 사용) ─────────────────────

    -- 1. 전체 통계
    SELECT json_build_object(
        'active_welders', COUNT(DISTINCT ws.ind_welder),
        'total_joints',   COUNT(DISTINCT jm.id),
        'total_di',       ROUND(SUM(ws.ind_di)::numeric, 2),
        'avg_di',         CASE WHEN COUNT(DISTINCT ws.ind_welder) > 0
                               THEN ROUND((SUM(ws.ind_di) / COUNT(DISTINCT ws.ind_welder))::numeric, 2)
                               ELSE 0 END
    ) INTO stats_data
    FROM construction.joint_master jm
    CROSS JOIN LATERAL (
        SELECT TRIM(w_raw) AS ind_welder,
               COALESCE(jm.size_inch, 0) / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_di,
               1.0 / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_joint
        FROM unnest(string_to_array(jm.welder, '/')) AS w_raw
    ) ws
    WHERE jm.date_completed IS NOT NULL
      AND (f_date_from IS NULL OR f_date_from = '' OR jm.date_completed >= f_date_from::date)
      AND (f_date_to   IS NULL OR f_date_to   = '' OR jm.date_completed <= f_date_to::date)
      AND (f_system    IS NULL OR f_system    = '' OR jm.system = f_system)
      AND (f_welder    IS NULL OR f_welder    = '' OR ws.ind_welder = f_welder)
      AND jm.welder IS NOT NULL AND jm.welder <> '';

    -- 2. 용접사 랭킹 Top 50
    --    working_days = 실제 작업 일수(일별 unique date)
    --    avg_di_per_day = 해당 용접사 분할 DI / working_days
    SELECT json_agg(t) INTO ranking_data FROM (
        SELECT
            ws.ind_welder                                                                 AS welder,
            ROUND(SUM(ws.ind_joint)::numeric, 1)                                          AS joints,
            ROUND(SUM(ws.ind_di)::numeric, 2)                                             AS total_di,
            COUNT(DISTINCT jm.date_completed)                                              AS working_days,
            CASE WHEN COUNT(DISTINCT jm.date_completed) > 0
                 THEN ROUND((SUM(ws.ind_di) / COUNT(DISTINCT jm.date_completed))::numeric, 2)
                 ELSE 0 END                                                               AS avg_di_per_day
        FROM construction.joint_master jm
        CROSS JOIN LATERAL (
            SELECT TRIM(w_raw) AS ind_welder,
                   COALESCE(jm.size_inch, 0) / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_di,
                   1.0 / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_joint
            FROM unnest(string_to_array(jm.welder, '/')) AS w_raw
        ) ws
        WHERE jm.date_completed IS NOT NULL
          AND (f_date_from IS NULL OR f_date_from = '' OR jm.date_completed >= f_date_from::date)
          AND (f_date_to   IS NULL OR f_date_to   = '' OR jm.date_completed <= f_date_to::date)
          AND (f_system    IS NULL OR f_system    = '' OR jm.system = f_system)
          AND (f_welder    IS NULL OR f_welder    = '' OR ws.ind_welder = f_welder)
          AND jm.welder IS NOT NULL AND jm.welder <> ''
        GROUP BY ws.ind_welder
        ORDER BY total_di DESC
        LIMIT 50
    ) t;

    -- 3. 주간 생산성
    --    avg_di_per_welder = 해당 주 각 용접사의 (DI / working_days) 평균
    --    ① 내부: 주 × 용접사별 집계 → welder_avg_di_day 계산
    --    ② 외부: 주별로 AVG(welder_avg_di_day)
    SELECT json_agg(t ORDER BY t.week_no) INTO weekly_data FROM (
        SELECT
            ww.week_no                                                                     AS week_no,
            'W' || ww.week_no                                                              AS week_label,
            ROUND(SUM(ww.welder_di)::numeric, 2)                                           AS total_di,
            ROUND(SUM(ww.welder_joints)::numeric, 1)                                       AS joints,
            COUNT(*)                                                                        AS active_welders,
            ROUND(AVG(ww.welder_avg_di_day)::numeric, 2)                                   AS avg_di_per_welder
        FROM (
            SELECT
                sch.week_no,
                ws.ind_welder,
                SUM(ws.ind_di)                                                             AS welder_di,
                SUM(ws.ind_joint)                                                          AS welder_joints,
                CASE WHEN COUNT(DISTINCT jm.date_completed) > 0
                     THEN SUM(ws.ind_di) / COUNT(DISTINCT jm.date_completed)
                     ELSE 0 END                                                            AS welder_avg_di_day
            FROM construction.joint_master jm
            JOIN construction.week_schedule sch
                ON jm.date_completed::date >= sch.week_start_date::date
                AND jm.date_completed::date <= sch.week_end_date::date
            CROSS JOIN LATERAL (
                SELECT TRIM(w_raw) AS ind_welder,
                       COALESCE(jm.size_inch, 0) / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_di,
                       1.0 / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_joint
                FROM unnest(string_to_array(jm.welder, '/')) AS w_raw
            ) ws
            WHERE jm.date_completed IS NOT NULL
              AND (f_date_from IS NULL OR f_date_from = '' OR jm.date_completed >= f_date_from::date)
              AND (f_date_to   IS NULL OR f_date_to   = '' OR jm.date_completed <= f_date_to::date)
              AND (f_system    IS NULL OR f_system    = '' OR jm.system = f_system)
              AND (f_welder    IS NULL OR f_welder    = '' OR ws.ind_welder = f_welder)
              AND jm.welder IS NOT NULL AND jm.welder <> ''
            GROUP BY sch.week_no, ws.ind_welder
        ) ww
        GROUP BY ww.week_no
    ) t;

    -- 4. 월간 생산성
    --    avg_di_per_welder = 해당 월 각 용접사의 (DI / working_days) 평균
    SELECT json_agg(t ORDER BY t.month) INTO monthly_data FROM (
        SELECT
            wm.month                                                                       AS month,
            ROUND(SUM(wm.welder_di)::numeric, 2)                                           AS total_di,
            ROUND(SUM(wm.welder_joints)::numeric, 1)                                       AS joints,
            COUNT(*)                                                                        AS active_welders,
            ROUND(AVG(wm.welder_avg_di_day)::numeric, 2)                                   AS avg_di_per_welder
        FROM (
            SELECT
                TO_CHAR(jm.date_completed, 'YYYY-MM')                                     AS month,
                ws.ind_welder,
                SUM(ws.ind_di)                                                             AS welder_di,
                SUM(ws.ind_joint)                                                          AS welder_joints,
                CASE WHEN COUNT(DISTINCT jm.date_completed) > 0
                     THEN SUM(ws.ind_di) / COUNT(DISTINCT jm.date_completed)
                     ELSE 0 END                                                            AS welder_avg_di_day
            FROM construction.joint_master jm
            CROSS JOIN LATERAL (
                SELECT TRIM(w_raw) AS ind_welder,
                       COALESCE(jm.size_inch, 0) / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_di,
                       1.0 / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_joint
                FROM unnest(string_to_array(jm.welder, '/')) AS w_raw
            ) ws
            WHERE jm.date_completed IS NOT NULL
              AND (f_date_from IS NULL OR f_date_from = '' OR jm.date_completed >= f_date_from::date)
              AND (f_date_to   IS NULL OR f_date_to   = '' OR jm.date_completed <= f_date_to::date)
              AND (f_system    IS NULL OR f_system    = '' OR jm.system = f_system)
              AND (f_welder    IS NULL OR f_welder    = '' OR ws.ind_welder = f_welder)
              AND jm.welder IS NOT NULL AND jm.welder <> ''
            GROUP BY TO_CHAR(jm.date_completed, 'YYYY-MM'), ws.ind_welder
        ) wm
        GROUP BY wm.month
    ) t;

    -- 5. 마지막 활성 주의 용접사 목록 (last active week welders)
    --    week_schedule 기준 가장 최근 week_no 에 작업한 용접사
    SELECT json_agg(t) INTO last_week_data FROM (
        SELECT
            ws.ind_welder                                                                 AS welder,
            ROUND(SUM(ws.ind_joint)::numeric, 1)                                          AS joints,
            ROUND(SUM(ws.ind_di)::numeric, 2)                                             AS total_di,
            COUNT(DISTINCT jm.date_completed)                                              AS working_days,
            CASE WHEN COUNT(DISTINCT jm.date_completed) > 0
                 THEN ROUND((SUM(ws.ind_di) / COUNT(DISTINCT jm.date_completed))::numeric, 2)
                 ELSE 0 END                                                               AS avg_di_per_day,
            'W' || sch.week_no                                                             AS week_label
        FROM construction.joint_master jm
        JOIN construction.week_schedule sch
            ON jm.date_completed::date >= sch.week_start_date::date
            AND jm.date_completed::date <= sch.week_end_date::date
        CROSS JOIN LATERAL (
            SELECT TRIM(w_raw) AS ind_welder,
                   COALESCE(jm.size_inch, 0) / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_di,
                   1.0 / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_joint
            FROM unnest(string_to_array(jm.welder, '/')) AS w_raw
        ) ws
        WHERE jm.date_completed IS NOT NULL
          AND jm.welder IS NOT NULL AND jm.welder <> ''
          AND (f_system IS NULL OR f_system = '' OR jm.system = f_system)
          AND (f_welder IS NULL OR f_welder = '' OR ws.ind_welder = f_welder)
          AND sch.week_no = (
              SELECT MAX(s2.week_no)
              FROM construction.joint_master jm2
              JOIN construction.week_schedule s2
                  ON jm2.date_completed::date >= s2.week_start_date::date
                  AND jm2.date_completed::date <= s2.week_end_date::date
              WHERE jm2.date_completed IS NOT NULL
                AND jm2.welder IS NOT NULL AND jm2.welder <> ''
                AND (f_system IS NULL OR f_system = '' OR jm2.system = f_system)
          )
        GROUP BY ws.ind_welder, sch.week_no
        ORDER BY total_di DESC
    ) t;

    -- 6. 마지막 활성 달의 용접사 목록 (last active month welders)
    SELECT json_agg(t) INTO last_month_data FROM (
        SELECT
            ws.ind_welder                                                                 AS welder,
            ROUND(SUM(ws.ind_joint)::numeric, 1)                                          AS joints,
            ROUND(SUM(ws.ind_di)::numeric, 2)                                             AS total_di,
            COUNT(DISTINCT jm.date_completed)                                              AS working_days,
            CASE WHEN COUNT(DISTINCT jm.date_completed) > 0
                 THEN ROUND((SUM(ws.ind_di) / COUNT(DISTINCT jm.date_completed))::numeric, 2)
                 ELSE 0 END                                                               AS avg_di_per_day,
            TO_CHAR(jm.date_completed, 'YYYY-MM')                                         AS month
        FROM construction.joint_master jm
        CROSS JOIN LATERAL (
            SELECT TRIM(w_raw) AS ind_welder,
                   COALESCE(jm.size_inch, 0) / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_di,
                   1.0 / GREATEST(array_length(string_to_array(jm.welder, '/'), 1), 1)::numeric AS ind_joint
            FROM unnest(string_to_array(jm.welder, '/')) AS w_raw
        ) ws
        WHERE jm.date_completed IS NOT NULL
          AND jm.welder IS NOT NULL AND jm.welder <> ''
          AND (f_system IS NULL OR f_system = '' OR jm.system = f_system)
          AND (f_welder IS NULL OR f_welder = '' OR ws.ind_welder = f_welder)
          AND TO_CHAR(jm.date_completed, 'YYYY-MM') = (
              SELECT TO_CHAR(MAX(jm3.date_completed), 'YYYY-MM')
              FROM construction.joint_master jm3
              WHERE jm3.date_completed IS NOT NULL
                AND jm3.welder IS NOT NULL AND jm3.welder <> ''
                AND (f_system IS NULL OR f_system = '' OR jm3.system = f_system)
          )
        GROUP BY ws.ind_welder, TO_CHAR(jm.date_completed, 'YYYY-MM')
        ORDER BY total_di DESC
    ) t;

    RETURN json_build_object(
        'stats',      stats_data,
        'ranking',    COALESCE(ranking_data,    '[]'::json),
        'weekly',     COALESCE(weekly_data,     '[]'::json),
        'monthly',    COALESCE(monthly_data,    '[]'::json),
        'last_week',  COALESCE(last_week_data,  '[]'::json),
        'last_month', COALESCE(last_month_data, '[]'::json)
    );
END;
$$ LANGUAGE plpgsql;
