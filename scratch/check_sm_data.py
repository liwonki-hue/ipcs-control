import requests
try:
    res = requests.get("http://127.0.0.1:5001/api/support-master?limit=5").json()
    print(f"Support Master rows: {len(res.get('data', []))}")
    if res.get('data'):
        print("First row:", res['data'][0])
except Exception as e:
    print("Error:", e)
