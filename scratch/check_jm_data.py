import requests
try:
    res = requests.get("http://127.0.0.1:5001/api/joints?limit=5").json()
    print(f"Joint Master rows count: {res.get('count', 0)}")
    print(f"Joint Master data len: {len(res.get('data', []))}")
    if res.get('data'):
        print("First row:", res['data'][0])
except Exception as e:
    print("Error:", e)
