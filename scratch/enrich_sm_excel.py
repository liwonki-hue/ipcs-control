import os
import pandas as pd
from supabase import create_client, Client, ClientOptions

def load_env_manually():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
options = ClientOptions(schema="construction")
supabase: Client = create_client(url, key, options=options)

print("Fetching metadata from Joint Master table...")
# Fetch metadata. Since we need it for all ISOs, we'll fetch in chunks or just select needed cols.
# To be safe and efficient, we fetch everything we need.
all_jm = []
limit = 5000
offset = 0
while True:
    res = supabase.table("joint_master").select("iso_drawing,unit,area,sub_area").range(offset, offset + limit - 1).execute()
    if not res.data: break
    all_jm.extend(res.data)
    offset += limit
    print(f"Loaded {len(all_jm)} JM rows...")

# Build mapping
# If multiple sub_areas, use the first one encountered (assuming order by ID or similar)
# Since we fetched in order, we just keep the first one for each ISO.
jm_map = {}
for r in all_jm:
    iso = str(r.get("iso_drawing") or "").strip()
    if not iso or iso in jm_map: continue
    jm_map[iso] = {
        "UNIT": r.get("unit"),
        "AREA": r.get("area"),
        "SUB AREA": r.get("sub_area")
    }

print(f"Mapping built for {len(jm_map)} unique ISOs.")

# Load Support Master Excel
base_path = r"c:\Users\PCLOVE\Downloads\ipcs-control"
sm_file = os.path.join(base_path, "Support Master.xlsx")
output_file = os.path.join(base_path, "Support Master_Modified.xlsx")

print(f"Loading {sm_file}...")
df = pd.read_excel(sm_file)

# Normalize column names to match what we saw in check_excel_cols
# Columns: ['NO. ', 'PHASE', 'UNIT', 'SYSTEM', 'AREA', 'SUB AREA', 'SUPPORT DRAWING', 'REVISION', 'ISO DRAWING', 'LINE NO', 'WELDER', 'WORK DATE']

def enrich(row):
    iso = str(row.get("ISO DRAWING") or "").strip()
    if iso in jm_map:
        m = jm_map[iso]
        # Only fill if empty
        if pd.isna(row.get("UNIT")):     row["UNIT"] = m["UNIT"]
        if pd.isna(row.get("AREA")):     row["AREA"] = m["AREA"]
        if pd.isna(row.get("SUB AREA")): row["SUB AREA"] = m["SUB AREA"]
    return row

print("Updating rows...")
df = df.apply(enrich, axis=1)

print(f"Saving to {output_file}...")
df.to_excel(output_file, index=False)
print("Done!")
