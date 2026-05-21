-- FO Deleted.xlsx에 따른 설계 삭제 ISO Drawing 처리
-- Supabase SQL Editor에서 실행 (liwonki project / construction schema)

-- ── 1. 삭제 전 현황 확인 ─────────────────────────────────────────────────
SELECT
  iso_drawing,
  COUNT(*) AS joint_count,
  ROUND(SUM(di)::NUMERIC, 2) AS total_di,
  SUM(CASE WHEN LOWER(completed::TEXT) IN ('true','t','1','yes') THEN 1 ELSE 0 END) AS completed_count
FROM construction.joint_master
WHERE iso_drawing IN (
  'CCP-W-B046-PI-140-FO-017-3',
  'CCP-W-B046-PI-140-FO-018-1',
  'CCP-W-B046-PI-140-FO-021-1',
  'CCP-W-B046-PI-140-FO-024-1',
  'CCP-W-B046-PI-140-FO-025-3',
  'CCP-W-B046-PI-140-FO-026-1',
  'CCP-W-B046-PI-140-FO-074-1',
  'CCP-W-B046-PI-140-FO-404-1',
  'CCP-W-B046-PI-140-FO-407-1'
)
GROUP BY iso_drawing
ORDER BY iso_drawing;

-- ── 2. joint_master 삭제 ─────────────────────────────────────────────────
DELETE FROM construction.joint_master
WHERE iso_drawing IN (
  'CCP-W-B046-PI-140-FO-017-3',
  'CCP-W-B046-PI-140-FO-018-1',
  'CCP-W-B046-PI-140-FO-021-1',
  'CCP-W-B046-PI-140-FO-024-1',
  'CCP-W-B046-PI-140-FO-025-3',
  'CCP-W-B046-PI-140-FO-026-1',
  'CCP-W-B046-PI-140-FO-074-1',
  'CCP-W-B046-PI-140-FO-404-1',
  'CCP-W-B046-PI-140-FO-407-1'
);
-- 결과: 102개 rows deleted

-- ── 3. support_master 삭제 ───────────────────────────────────────────────
DELETE FROM construction.support_master
WHERE iso_drawing IN (
  'CCP-W-B046-PI-140-FO-017-3',
  'CCP-W-B046-PI-140-FO-018-1',
  'CCP-W-B046-PI-140-FO-021-1',
  'CCP-W-B046-PI-140-FO-024-1',
  'CCP-W-B046-PI-140-FO-025-3',
  'CCP-W-B046-PI-140-FO-026-1',
  'CCP-W-B046-PI-140-FO-074-1',
  'CCP-W-B046-PI-140-FO-404-1',
  'CCP-W-B046-PI-140-FO-407-1'
);
-- 결과: 2개 rows deleted

-- ── 4. 삭제 후 검증 ─────────────────────────────────────────────────────
SELECT COUNT(*) AS remaining_joints
FROM construction.joint_master
WHERE iso_drawing IN (
  'CCP-W-B046-PI-140-FO-017-3',
  'CCP-W-B046-PI-140-FO-018-1',
  'CCP-W-B046-PI-140-FO-021-1',
  'CCP-W-B046-PI-140-FO-024-1',
  'CCP-W-B046-PI-140-FO-025-3',
  'CCP-W-B046-PI-140-FO-026-1',
  'CCP-W-B046-PI-140-FO-074-1',
  'CCP-W-B046-PI-140-FO-404-1',
  'CCP-W-B046-PI-140-FO-407-1'
);
-- 0이면 삭제 완료
