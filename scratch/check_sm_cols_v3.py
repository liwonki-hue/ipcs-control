import os
from supabase import create_client, ClientOptions

def load_env_manually():
    # Fix: search in parent directory if not found
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if not os.path.exists(env_path):
        env_path = os.path.join(os.path.dirname(base_dir), ".env")
        
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
    else:
        print("Env file not found at", env_path)

load_env_manually()
url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")

if not url or not key:
    print("URL or KEY missing. URL:", url)
    exit(1)

options = ClientOptions(schema="construction")
sb = create_client(url, key, options=options)

try:
    dummy = {"system": "TEST_COL_CHECK"}
    res = sb.table("support_master").insert(dummy).execute()
    if res.data:
        print("Columns found:", sorted(res.data[0].keys()))
        sb.table("support_master").delete().eq("system", "TEST_COL_CHECK").execute()
    else:
        print("No data returned from insert")
except Exception as e:
    print("Error during column check:", e)
