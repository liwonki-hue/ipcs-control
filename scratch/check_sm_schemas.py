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
# Try public schema
options = ClientOptions(schema="public")
supabase: Client = create_client(url, key, options=options)

try:
    res = supabase.table("support_master").select("*", count="exact").limit(0).execute()
    print(f"Public Support Master Row Count: {res.count}")
except Exception as e:
    print(f"Error checking public: {e}")

# Check construction again just in case
options2 = ClientOptions(schema="construction")
supabase2: Client = create_client(url, key, options=options2)
try:
    res2 = supabase2.table("support_master").select("*", count="exact").limit(0).execute()
    print(f"Construction Support Master Row Count: {res2.count}")
except Exception as e:
    print(f"Error checking construction: {e}")
