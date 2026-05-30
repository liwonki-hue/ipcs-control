import codecs
with codecs.open('static/js/dashboard.js', 'r', 'utf-8') as f:
    content = f.read()

old = '        metaData = await apiFetch(" /api/meta?t=\ + Date.now());'
new = ''' let ts = new Date().getTime();
 let res = await fetch(\/api/meta?t=\ + ts, { cache: \no-store\ });
 if (res.status === 202) {
 console.log(\[BOP] Meta building retrying in 3s...\);
 setTimeout(loadMeta, 3000);
 return;
 }
 if (!res.ok) throw new Error(\API error: \ + res.status);
 metaData = await res.json();'''

content = content.replace(old, new)
with codecs.open('static/js/dashboard.js', 'w', 'utf-8') as f:
 f.write(content)
print('Done!')
