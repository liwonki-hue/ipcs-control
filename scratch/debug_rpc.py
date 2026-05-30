import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key)

res = supabase.rpc("get_dashboard_summary_v17", {}).execute()
data = res.data
if isinstance(data, list) and data:
    data = data[0]

print("Keys in v17:", data.keys() if isinstance(data, dict) else "Not a dict")
if "act" in data:
    print("First item in act:", data["act"][0] if data["act"] else "Empty")

res2 = supabase.rpc("get_dashboard_aggregates_control_v2", {}).execute()
data2 = res2.data
if isinstance(data2, list) and data2:
    data2 = data2[0]

print("\nKeys in v2:", data2.keys() if isinstance(data2, dict) else "Not a dict")
if "act" in data2:
    print("First item in act (v2):", data2["act"][0] if data2["act"] else "Empty")
