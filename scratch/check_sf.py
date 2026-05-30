import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
# Assuming the default schema is 'construction' as seen in app.py
from supabase.lib.client_options import ClientOptions
options = ClientOptions(schema="construction")
supabase: Client = create_client(url, key, options=options)

res = supabase.table("joint_master").select("sf").limit(20).execute()
print("SF values (first 20):", [r.get("sf") for r in res.data])

# Also check distinct values
res_dist = supabase.rpc("get_distinct_meta_v2", {}).execute()
# Wait, get_distinct_meta_v2 doesn't have SF.
# Let's just do a distinct query if possible.
# Supabase select distinct is tricky, but we can try:
res_all_sf = supabase.table("joint_master").select("sf").execute()
distinct_sf = set(r.get("sf") for r in res_all_sf.data if r.get("sf"))
print("Distinct SF values:", distinct_sf)
