-- support_master 테이블에 package 컬럼 추가
ALTER TABLE construction.support_master
  ADD COLUMN IF NOT EXISTS package TEXT;
