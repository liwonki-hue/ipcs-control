with open('app.py', 'r', encoding='utf-8') as f:
    text = f.read()

old = 'options = ClientOptions(schema="construction")'
new = 'options = ClientOptions(schema="construction", postgrest_client_timeout=30)'

if old in text:
    text = text.replace(old, new)
    with open('app.py', 'w', encoding='utf-8') as f:
        f.write(text)
    print('Done timeout patch!')
else:
    print('Not found')
