import os
from supabase import create_client
from supabase.lib.client_options import ClientOptions

def check_db():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    # Set schema to construction
    opts = ClientOptions(schema="construction")
    sb = create_client(url, key, options=opts)
    
    print("--- Construction Schema Check ---")
    try:
        res = sb.table("joint_master").select("id", "unit", "system", "size_inch").limit(5).execute()
        print(f"Sample Rows (construction): {res.data}")
        
        count_res = sb.table("joint_master").select("id", count="exact").limit(1).execute()
        print(f"Total Rows (construction): {count_res.count}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    with open(".env", "r") as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                os.environ[k] = v
    check_db()
