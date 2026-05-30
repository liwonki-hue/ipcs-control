import os
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

# We can't easily run arbitrary SQL via the client without an RPC, 
# but we can check columns again. 
# I'll try to just check the columns and if they are missing, I'll tell the user.

options = ClientOptions(schema="construction")
sb = create_client(url, key, options=options)

try:
    # Try to select all from support_master and see what columns we get
    res = sb.table("support_master").select("*").limit(0).execute()
    # If it works, we can't really see columns if there's no data unless we use a trick
    # Let's try to insert a dummy row and see if it fails
    dummy = {"system": "TEST_COL_CHECK"}
    res = sb.table("support_master").insert(dummy).execute()
    if res.data:
        print("Columns found:", sorted(res.data[0].keys()))
        # Clean up
        sb.table("support_master").delete().eq("system", "TEST_COL_CHECK").execute()
    else:
        print("No data returned from insert")
except Exception as e:
    print("Error during column check:", e)
