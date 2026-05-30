import os
from supabase import create_client

def apply_sql_fix():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    sb = create_client(url, key)
    
    sql = """
CREATE OR REPLACE FUNCTION construction.get_dashboard_aggregates_control_v2()
RETURNS json AS $$
DECLARE
    units_data json;
    areas_data json;
    systems_data json;
    subarea_agg json;
    act_data json;
    ep_act_data json;
    kpi_data json;
    ep_kpi_data json;
BEGIN
    -- [1] Systems
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
        ORDER BY j.system
    ) t;

    -- [2] Units
    SELECT json_agg(t) INTO units_data FROM (
        SELECT unit, SUM(size_inch) as total_di, 
               SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN size_inch ELSE 0 END) as completed_di,
               COUNT(*) as total_joints,
               SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END) as completed_joints
        FROM construction.joint_master
        WHERE unit IS NOT NULL AND unit <> ''
        GROUP BY unit
        ORDER BY unit
    ) t;

    -- [3] Areas
    SELECT json_agg(t) INTO areas_data FROM (
        SELECT area, SUM(size_inch) as total_di, 
               SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN size_inch ELSE 0 END) as completed_di,
               COUNT(*) as total_joints,
               SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END) as completed_joints
        FROM construction.joint_master
        WHERE area IS NOT NULL AND area <> ''
        GROUP BY area
        ORDER BY area
    ) t;

    -- [4] Sub Areas (FIXED GROUP BY)
    SELECT json_agg(t) INTO subarea_agg FROM (
        SELECT 
            j.sub_area,
            SUM(j.size_inch) as total_di, 
            SUM(CASE WHEN j.date_completed IS NOT NULL OR j.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN j.size_inch ELSE 0 END) as completed_di,
            (SELECT COUNT(*) FROM construction.support_master s WHERE s.sub_area = j.sub_area) as support_total,
            (SELECT COUNT(*) FROM construction.support_master s WHERE s.sub_area = j.sub_area AND (s.date_completed IS NOT NULL OR s.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))) as support_comp,
            (SELECT COUNT(*) FROM construction.test_package_master t WHERE t.sub_area = j.sub_area) as testpkg_total,
            (SELECT COUNT(*) FROM construction.test_package_master t WHERE t.sub_area = j.sub_area AND (t.date_completed IS NOT NULL OR t.completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']))) as testpkg_comp
        FROM construction.joint_master j
        WHERE j.sub_area IS NOT NULL AND j.sub_area <> ''
        GROUP BY j.sub_area
        ORDER BY j.sub_area
    ) t;

    -- [5] Overall KPI
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

    -- [6] EP KPI
    SELECT json_build_object(
        'total_di', SUM(size_inch),
        'completed_di', SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN size_inch ELSE 0 END),
        'total_joints', COUNT(*),
        'completed_joints', SUM(CASE WHEN date_completed IS NOT NULL OR completed::text ILIKE ANY (ARRAY['O', 'TRUE', 'Y']) THEN 1 ELSE 0 END)
    ) INTO ep_kpi_data FROM construction.joint_master WHERE phase = 'EP';

    -- [7] Weekly
    SELECT json_agg(t) INTO act_data FROM (
        SELECT w.week_no, SUM(j.size_inch) as completed_di
        FROM construction.joint_master j
        JOIN construction.week_schedule w ON j.date_completed::date >= w.week_start_date::date 
                                         AND j.date_completed::date <= w.week_end_date::date
        WHERE j.date_completed IS NOT NULL
        GROUP BY w.week_no
        ORDER BY w.week_no
    ) t;

    -- [8] EP Weekly
    SELECT json_agg(t) INTO ep_act_data FROM (
        SELECT w.week_no, SUM(j.size_inch) as completed_di
        FROM construction.joint_master j
        JOIN construction.week_schedule w ON j.date_completed::date >= w.week_start_date::date 
                                         AND j.date_completed::date <= w.week_end_date::date
        WHERE j.date_completed IS NOT NULL AND j.phase = 'EP'
        GROUP BY w.week_no
        ORDER BY w.week_no
    ) t;

    RETURN json_build_object(
        'units', units_data,
        'areas', areas_data,
        'systems', systems_data,
        'subareas', subarea_agg,
        'act_weekly', act_data,
        'ep_weekly', ep_act_data,
        'kpi', kpi_data,
        'ep_kpi', ep_kpi_data
    );
END;
$$ LANGUAGE plpgsql;
    """
    try:
        # We can't run arbitrary SQL via the supabase-py table() interface.
        # But we can try to run it via the SQL editor if we had it.
        # Since we don't have direct SQL execution in the SDK,
        # I'll ask the user to run it or use a postgres library.
        print("SQL Fix generated. Please run this in your Supabase SQL Editor.")
        print(sql)
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    apply_sql_fix()
