import os
import sys

# Add parent directory to path to import app
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import get_sb

def fix_dates():
    sb = get_sb()
    # Find bad dates
    res = sb.table("joint_master").select("id, iso_drawing, joint_no, date_completed").lt("date_completed", "2020-01-01").execute()
    bad_rows = res.data or []
    print(f"Found {len(bad_rows)} rows with bad dates:")
    for row in bad_rows:
        print(row)
        
        # Assume it's a typo for 2026
        bad_date = row['date_completed']
        if bad_date:
            # Replace year with 2026
            new_date = "2026" + bad_date[4:]
            print(f"Fixing ID {row['id']} from {bad_date} to {new_date}")
            sb.table("joint_master").update({"date_completed": new_date}).eq("id", row['id']).execute()

if __name__ == '__main__':
    fix_dates()
