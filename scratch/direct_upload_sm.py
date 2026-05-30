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

base_path = r"c:\Users\PCLOVE\Downloads\ipcs-control"
sm_file = os.path.join(base_path, "Support Master_Modified.xlsx")

print(f"Loading {sm_file}...")
df = pd.read_excel(sm_file, dtype=str)

# Map Excel columns to DB columns
# Excel: ['NO. ', 'PHASE', 'UNIT', 'SYSTEM', 'AREA', 'SUB AREA', 'SUPPORT DRAWING', 'REVISION', 'ISO DRAWING', 'LINE NO', 'WELDER', 'WORK DATE']
FIELD_MAP = {
    "PHASE": "phase",
    "UNIT": "unit",
    "SYSTEM": "system",
    "AREA": "area",
    "SUB AREA": "sub_area",
    "SUPPORT DRAWING": "support_drawing",
    "REVISION": "revision",
    "ISO DRAWING": "iso_drawing",
    "LINE NO": "line_no",
    "WELDER": "welder",
    "WORK DATE": "date_completed"
}

records = []
print("Preparing records...")
for _, row in df.iterrows():
    rec = {}
    for excel_col, db_col in FIELD_MAP.items():
        v = row.get(excel_col)
        if v is not None and str(v).strip().lower() not in ["nan", "nat", "none", ""]:
            rec[db_col] = str(v).strip()
    
    # Date handling
    dc = rec.get("date_completed")
    if dc:
        try:
            # Try to parse date
            rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
            rec["completed"] = True
        except:
            rec["date_completed"] = None
            rec["completed"] = False
    else:
        rec["completed"] = False
    
    # Basic validation: must have at least support_drawing or system
    if rec.get("support_drawing") or rec.get("system"):
        records.append(rec)

print(f"Total valid records to insert: {len(records)}")

if not records:
    print("No valid records found. Exiting.")
    exit(0)

# Batch insert
print("Starting bulk insert...")
batch_size = 500
total_inserted = 0
for i in range(0, len(records), batch_size):
    batch = records[i:i+batch_size]
    try:
        supabase.table("support_master").insert(batch).execute()
        total_inserted += len(batch)
        print(f"Inserted {total_inserted}/{len(records)}...")
    except Exception as e:
        print(f"Error at batch {i}: {e}")
        # If it fails, maybe the table doesn't exist?
        if "PGRST204" in str(e) or "PGRST205" in str(e):
            print("Table might be missing. Attempting to create table first...")
            # We don't have SQL execution tool here easily, but we can try to inform.
            raise e

print("Direct upload completed successfully!")
