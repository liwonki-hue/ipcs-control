import os
from supabase import create_client
from supabase.lib.client_options import ClientOptions

def check_welder_data():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    opts = ClientOptions(schema="construction")
    sb = create_client(url, key, options=opts)
    
    print("--- Welder Data Check ---")
    try:
        # Check rows where date_completed IS NOT NULL
        res = sb.table("joint_master").select("id", "welder", "date_completed").not_.is_("date_completed", "null").limit(10).execute()
        print(f"Completed joints samples: {res.data}")
        
        # Count rows with welder and date_completed
        count_res = sb.table("joint_master").select("id", count="exact").not_.is_("date_completed", "null").not_.is_("welder", "null").execute()
        print(f"Total joints with date_completed and welder: {count_res.count}")
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    with open(".env", "r") as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                os.environ[k] = v
    check_welder_data()
