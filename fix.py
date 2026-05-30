with open('static/js/dashboard.js', 'r', encoding='utf-8') as f:
    text = f.read()

old = 'metaData = await apiFetch("/api/meta?t=" + Date.now());'
new = '''let ts = new Date().getTime();
        let res = await fetch("/api/meta?t=" + ts, { cache: "no-store" });
        if (res.status === 202) {
            setTimeout(loadMeta, 3000);
            return;
        }
        if (!res.ok) throw new Error("API error: " + res.status);
        metaData = await res.json();'''

if old in text:
    text = text.replace(old, new)
    with open('static/js/dashboard.js', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Replaced!")
else:
    print("Not found!")
