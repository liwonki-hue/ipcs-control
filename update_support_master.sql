-- Run this in your Supabase SQL Editor to update the support_master table schema
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS phase text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS support_drawing text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS revision text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS line_no text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS welder text;

-- ensure existing columns exist
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS system text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS sub_area text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS iso_drawing text;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS date_completed date;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS completed boolean DEFAULT false;
ALTER TABLE construction.support_master ADD COLUMN IF NOT EXISTS remark text;
