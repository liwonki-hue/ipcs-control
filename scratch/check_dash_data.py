import requests

url = "http://127.0.0.1:5001/api/dashboard"
try:
    res = requests.get(url).json()
    if "building" in res:
        print("Dashboard is still building...")
    else:
        for key in ["kpi", "weekly", "systems", "units", "areas", "subareas"]:
            val = res.get(key)
            if isinstance(val, list):
                print(f"{key}: {len(val)} items")
            elif isinstance(val, dict):
                print(f"{key}: dict with {len(val)} keys")
            else:
                print(f"{key}: {val}")
        
        # Check first few weekly items
        weekly = res.get("weekly", [])
        if weekly:
            print("\nFirst 3 weekly items:")
            for w in weekly[:3]:
                print(w)
except Exception as e:
    print("Error:", e)
