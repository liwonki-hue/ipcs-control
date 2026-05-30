with open('app.py', 'r', encoding='utf-8') as f:
    text = f.read()

old = '''        # Populate _meta_cache using the data we already fetched
        m_units = sorted(list(set(u.get("unit") for u in (data.get("units") or []) if u.get("unit"))))
        m_sys   = sorted(list(set(s.get("system") for s in (data.get("systems") or []) if s.get("system"))))
        m_area  = sorted(list(set(a.get("area") for a in (data.get("areas") or []) if a.get("area"))))
        m_sub   = sorted(list(set(a.get("subarea") or a.get("area") for a in (data.get("subareas") or []) if (a.get("subarea") or a.get("area")))))'''

new = '''        # Populate _meta_cache safely
        try:
            m_units = sorted(list(set(u.get("unit") for u in (data.get("units") or []) if isinstance(u, dict) and u.get("unit"))))
            m_sys   = sorted(list(set(s.get("system") for s in (data.get("systems") or []) if isinstance(s, dict) and s.get("system"))))
            m_area  = sorted(list(set(a.get("area") for a in (data.get("areas") or []) if isinstance(a, dict) and a.get("area"))))
            m_sub   = sorted(list(set(a.get("subarea") or a.get("area") for a in (data.get("subareas") or []) if isinstance(a, dict) and (a.get("subarea") or a.get("area")))))
        except Exception as me:
            print(f"[cache] Meta extraction error: {me}")
            m_units, m_sys, m_area, m_sub = [], [], [], []'''

if old in text:
    text = text.replace(old, new)
    with open('app.py', 'w', encoding='utf-8') as f:
        f.write(text)
    print('Done app.py patches!')
else:
    print('String not found!')
