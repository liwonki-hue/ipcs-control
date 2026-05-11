-- Run this in Supabase SQL Editor to allow data upload via the API/Anon key
ALTER TABLE construction.support_master DISABLE ROW LEVEL SECURITY;
GRANT ALL ON construction.support_master TO anon;
GRANT ALL ON construction.support_master TO authenticated;
GRANT ALL ON construction.support_master TO service_role;
