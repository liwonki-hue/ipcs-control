import os
import pandas as pd
import io
from supabase import create_client, ClientOptions

def load_env_manually():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if not os.path.exists(env_path):
        env_path = os.path.join(os.path.dirname(base_dir), ".env")
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
sb = create_client(url, key, options=options)

file_path = r"c:\Users\PCLOVE\Downloads\ipcs-control\Support Master.xlsx"

try:
    print(f"Reading {file_path}...")
    df = pd.read_excel(file_path, dtype=str)
    # Normalize columns: remove trailing spaces, lower case, replace space with underscore
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    
    # Mapping for Support Master Excel columns to DB columns
    FIELD_MAP = {
        "phase": "phase",
        "unit": "unit",
        "system": "system",
        "area": "area",
        "sub_area": "sub_area",
        "support_drawing": "support_drawing",
        "revision": "revision",
        "iso_drawubg": "iso_drawing",
        "iso_drawing": "iso_drawing", 
        "line_no": "line_no",
        "welder": "welder",
        "actual_date": "date_completed"
    }
    
    records, skipped = [], 0
    for _, row in df.iterrows():
        rec = {}
        for excel_col, db_col in FIELD_MAP.items():
            v = row.get(excel_col)
            if v is None or (isinstance(v, float) and pd.isna(v)): 
                v = None
            else: 
                v = str(v).strip() or None
            if v: rec[db_col] = v
        
        # Date processing
        dc = rec.get("date_completed")
        if dc:
            try:
                rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
                rec["completed"]      = True
            except:
                rec["date_completed"] = None
                rec["completed"]      = False
        else:
            rec["completed"] = False
            
        # Basic validation
        if not rec.get("system") and not rec.get("support_drawing"):
            skipped += 1; continue
            
        records.append(rec)
        
    print(f"Parsed {len(records)} records (skipped {skipped})")
    
    if not records:
        print("No records to upload.")
    else:
        # Clear existing data if needed? No, user didn't ask to clear.
        # But usually a master upload replaces or appends.
        # I'll just append for now, or if it's too much, I'll batch it.
        inserted = 0
        batch_size = 500
        for i in range(0, len(records), batch_size):
            batch = records[i:i+batch_size]
            sb.table("support_master").insert(batch).execute()
            inserted += len(batch)
            print(f"Uploaded {inserted}/{len(records)}...")
        
        print(f"Successfully uploaded {inserted} rows.")

except Exception as e:
    print(f"Error during upload: {e}")
