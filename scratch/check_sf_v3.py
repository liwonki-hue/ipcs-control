import os
from supabase import create_client, Client, ClientOptions

def load_env_manually():
    # Look in the project root (one level up from scratch)
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(base_dir, ".env")
    print(f"Loading env from: {env_path}")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"): continue
                if "=" in line:
                    try:
                        key, val = line.split("=", 1)
                        os.environ[key.strip()] = val.strip()
                    except: continue

load_env_manually()

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")
if not url:
    print("Error: SUPABASE_URL not found in env")
    exit(1)

options = ClientOptions(schema="construction")
supabase: Client = create_client(url, key, options=options)

# Check distinct SF values
res_all_sf = supabase.table("joint_master").select("sf").execute()
distinct_sf = set(r.get("sf") for r in res_all_sf.data if r.get("sf"))
print("Distinct SF values:", distinct_sf)

# Check first few rows with completion
res_comp = supabase.table("joint_master").select("sf,size_inch,date_completed").not_.is_("date_completed", "null").limit(10).execute()
print("\nCompleted Joints Sample:")
for r in res_comp.data:
    print(r)
