-- Step 3: Support Master Phase/Package 동기화
-- joint_master의 ISO Drawing 기준으로 phase/package 없는 행 채움

UPDATE construction.support_master AS s
SET
  phase   = COALESCE(s.phase,   jm.phase),
  package = COALESCE(s.package, jm.package)
FROM (
  SELECT DISTINCT ON (iso_drawing)
    iso_drawing, phase, package
  FROM construction.joint_master
  WHERE iso_drawing IS NOT NULL
    AND (phase IS NOT NULL OR package IS NOT NULL)
  ORDER BY iso_drawing, id
) AS jm
WHERE s.iso_drawing = jm.iso_drawing
  AND (s.phase IS NULL OR s.package IS NULL);
