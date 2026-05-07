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
        SELECT w.week_no, SUM(j.size_inch) as completed_di
        FROM construction.joint_master j
        JOIN construction.week_schedule w ON j.date_completed::date >= w.week_start_date::date 
                                         AND j.date_completed::date <= w.week_end_date::date
        WHERE j.date_completed IS NOT NULL
        GROUP BY w.week_no
    ) t;

    -- EP Weekly actuals
    SELECT json_agg(t) INTO ep_act_data FROM (
        SELECT w.week_no, SUM(j.size_inch) as completed_di
        FROM construction.joint_master j
        JOIN construction.week_schedule w ON j.date_completed::date >= w.week_start_date::date 
                                         AND j.date_completed::date <= w.week_end_date::date
        WHERE j.date_completed IS NOT NULL AND j.phase = 'EP'
        GROUP BY w.week_no
    ) t;

    RETURN json_build_object(
        'unit', units_data,
        'area', areas_data,
        'sys', systems_data,
        'act', act_data,
        'ep_act', ep_act_data,
        'kpi', kpi_data,
        'ep_kpi', ep_kpi_data
    );
END;
$$ LANGUAGE plpgsql;

-- 4. 용접사 실적 요약 (Welder Summary) 최적화
CREATE OR REPLACE FUNCTION construction.get_welder_summary_v2(
    f_date_from text DEFAULT NULL,
    f_date_to text DEFAULT NULL,
    f_system text DEFAULT NULL,
    f_welder text DEFAULT NULL
)
RETURNS TABLE (
    welder text,
    total_di numeric,
    joint_count bigint
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        j.welder,
        SUM(COALESCE(j.size_inch, 0)) as total_di,
        COUNT(*) as joint_count
    FROM construction.joint_master j
    WHERE j.date_completed IS NOT NULL
      AND (f_date_from IS NULL OR f_date_from = '' OR j.date_completed >= f_date_from::date)
      AND (f_date_to IS NULL OR f_date_to = '' OR j.date_completed <= f_date_to::date)
      AND (f_system IS NULL OR f_system = '' OR j.system = f_system)
      AND (f_welder IS NULL OR f_welder = '' OR j.welder = f_welder)
      AND j.welder IS NOT NULL AND j.welder <> ''
    GROUP BY j.welder;
END;
$$ LANGUAGE plpgsql;
