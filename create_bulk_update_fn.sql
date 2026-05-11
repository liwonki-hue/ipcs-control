-- UPDATE: Replace the function with a faster single-statement version
-- Run this in Supabase SQL Editor (liwonki project)
CREATE OR REPLACE FUNCTION construction.bulk_update_phase_package(updates JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
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
      elem->>'joint_no' AS joint_no,
      elem->>'phase'    AS phase,
      elem->>'package'  AS package
    FROM jsonb_array_elements(updates) AS elem
  ) AS u
  WHERE j.iso_drawing = u.iso_drawing
    AND j.joint_no    = u.joint_no;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION construction.bulk_update_phase_package(JSONB) TO anon, authenticated, service_role;
