import os
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")
supabase = create_client(url, key)

sql = """
ALTER TABLE construction.joint_master 
ADD COLUMN IF NOT EXISTS pt_date date,
ADD COLUMN IF NOT EXISTS pt_result text,
ADD COLUMN IF NOT EXISTS mt_date date,
ADD COLUMN IF NOT EXISTS mt_result text,
ADD COLUMN IF NOT EXISTS rt_date date,
ADD COLUMN IF NOT EXISTS rt_result text,
ADD COLUMN IF NOT EXISTS pwht_date date,
ADD COLUMN IF NOT EXISTS pwht_result text;
"""

try:
    # We use rpc or just execute via a temporary function if needed, 
    # but since I don't have a generic execute SQL rpc, I'll try to use the API to check if columns exist or use a known migration pattern.
    # Actually, the best way here is to use a direct SQL execution if possible.
    # If not, I'll assume the user can run this or I'll try to use the app's existing patterns.
    print("Please run the following SQL in Supabase SQL Editor:")
    print(sql)
except Exception as e:
    print(f"Error: {e}")
