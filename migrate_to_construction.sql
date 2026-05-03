-- Create the new schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS construction;

-- Move tables from public to construction
ALTER TABLE IF EXISTS public.bom_temp SET SCHEMA construction;
ALTER TABLE IF EXISTS public.dwg_iso SET SCHEMA construction;
ALTER TABLE IF EXISTS public.dwg_latest SET SCHEMA construction;
ALTER TABLE IF EXISTS public.dwg_speciality SET SCHEMA construction;
ALTER TABLE IF EXISTS public.dwg_support SET SCHEMA construction;
ALTER TABLE IF EXISTS public.dwg_valve SET SCHEMA construction;
ALTER TABLE IF EXISTS public.joint_master SET SCHEMA construction;
ALTER TABLE IF EXISTS public.plan_master SET SCHEMA construction;
ALTER TABLE IF EXISTS public.week_plan_items SET SCHEMA construction;
ALTER TABLE IF EXISTS public.week_schedule SET SCHEMA construction;

-- Note: You may also need to update or move views and RPC functions to the construction schema.
-- Example for a view:
-- ALTER VIEW public.v_iso_summary SET SCHEMA construction;
-- For functions, you will need to recreate them in the construction schema or update their search_path:
-- ALTER FUNCTION public.get_dashboard_summary_v17 SET SCHEMA construction;
