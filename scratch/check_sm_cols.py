import os
import io
from supabase import create_client, ClientOptions

def load_env_manually():
    base_dir = os.path.dirname(os.path.abspath(__file__))
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
sb = create_client(url, key, options=options)

try:
    res = sb.table("support_master").select("*").limit(1).execute()
    if res.data:
        print("Columns:", sorted(res.data[0].keys()))
    else:
        # If no data, try to get columns via another way or just print No Data
        print("No data found in support_master")
except Exception as e:
    print("Error:", e)
