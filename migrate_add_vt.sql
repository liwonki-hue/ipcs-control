-- Add VT inspection columns to joint_master
-- Run in Supabase SQL Editor (liwonki project)
ALTER TABLE construction.joint_master
  ADD COLUMN IF NOT EXISTS vt_date   DATE,
  ADD COLUMN IF NOT EXISTS vt_result TEXT;  -- 'PASS' or 'FAIL'
