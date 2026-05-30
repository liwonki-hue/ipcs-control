import os
from supabase import create_client, Client, ClientOptions

def load_env_manually():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(base_dir, ".env")
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
options = ClientOptions(schema="construction")
supabase: Client = create_client(url, key, options=options)

res = supabase.table("joint_master").select("*").limit(1).execute()
if res.data:
    print("Joint Master Columns:", sorted(res.data[0].keys()))
else:
    print("No data in joint_master")
