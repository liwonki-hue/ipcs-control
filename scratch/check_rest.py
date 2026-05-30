import os
import requests

def check_raw_data():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    
    # Set headers with schema preference
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Range": "0-9",
        "Accept-Profile": "construction"
    }
    
    print("--- Construction Table Check (Direct REST with Profile) ---")
    endpoint = f"{url}/rest/v1/joint_master?select=id,welder,date_completed&date_completed=not.is.null"
    try:
        r = requests.get(endpoint, headers=headers)
        if r.status_code == 200:
            data = r.json()
            print(f"Completed joints found: {len(data)}")
            if data:
                print(f"Sample data: {data}")
                welders = [d.get('welder') for d in data if d.get('welder')]
                print(f"Joints with welder name in this sample: {len(welders)}")
        else:
            print(f"Error: {r.status_code} {r.text}")
    except Exception as e:
        print(f"Request failed: {e}")

if __name__ == "__main__":
    with open(".env", "r") as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                os.environ[k] = v
    check_raw_data()
