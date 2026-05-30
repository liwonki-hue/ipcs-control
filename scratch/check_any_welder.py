import os
import requests

def check_any_welder():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept-Profile": "construction"
    }
    
    print("--- Checking if ANY welder data exists ---")
    # Query for any row where welder is NOT NULL and NOT empty
    endpoint = f"{url}/rest/v1/joint_master?select=id,welder&welder=not.is.null&welder=not.eq.&limit=1"
    try:
        r = requests.get(endpoint, headers=headers)
        if r.status_code == 200:
            data = r.json()
            if data:
                print(f"Found at least one welder: {data[0]}")
            else:
                print("ABSOLUTELY NO welder data found in joint_master table.")
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
    check_any_welder()
