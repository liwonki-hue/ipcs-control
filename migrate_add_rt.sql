-- Add new columns for RT 2nd round and finding
ALTER TABLE construction.joint_master 
ADD COLUMN IF NOT EXISTS rt_finding text,
ADD COLUMN IF NOT EXISTS rt_2_date date,
ADD COLUMN IF NOT EXISTS rt_2_result text;
