import pandas as pd
import os

base_path = r"c:\Users\PCLOVE\Downloads\ipcs-control"
jm_file = os.path.join(base_path, "BOP Piping Joint Master.xlsx")
sm_file = os.path.join(base_path, "Support Master.xlsx")

print("--- Joint Master ---")
try:
    jm_df = pd.read_excel(jm_file, nrows=5)
    print("Columns:", jm_df.columns.tolist())
    print(jm_df.head(2))
except Exception as e:
    print("Error JM:", e)

print("\n--- Support Master ---")
try:
    sm_df = pd.read_excel(sm_file, nrows=5)
    print("Columns:", sm_df.columns.tolist())
    print(sm_df.head(2))
except Exception as e:
    print("Error SM:", e)
