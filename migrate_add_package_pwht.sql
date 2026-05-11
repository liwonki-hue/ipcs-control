-- ============================================================
-- Migration: Add PACKAGE, PWHT, and NDE columns to joint_master
-- Supabase project: liwonki (ognhvfvlboqblueuldlm)
-- Run in SQL Editor of the liwonki project
-- ============================================================

-- Safety check: create schema if missing
CREATE SCHEMA IF NOT EXISTS construction;

ALTER TABLE construction.joint_master
  ADD COLUMN IF NOT EXISTS package      TEXT,
  ADD COLUMN IF NOT EXISTS pwht         TEXT,          -- 'Y' or 'N'
  ADD COLUMN IF NOT EXISTS pt_date      DATE,
  ADD COLUMN IF NOT EXISTS pt_result    TEXT,          -- 'PASS' or 'FAIL'
  ADD COLUMN IF NOT EXISTS mt_date      DATE,
  ADD COLUMN IF NOT EXISTS mt_result    TEXT,
  ADD COLUMN IF NOT EXISTS rt_date      DATE,
  ADD COLUMN IF NOT EXISTS rt_result    TEXT,
  ADD COLUMN IF NOT EXISTS pwht_date    DATE,
  ADD COLUMN IF NOT EXISTS pwht_result  TEXT;          -- 'PASS' or 'FAIL'

-- Indexes for common filters
CREATE INDEX IF NOT EXISTS idx_jm_package ON construction.joint_master (package);
CREATE INDEX IF NOT EXISTS idx_jm_pwht    ON construction.joint_master (pwht);
