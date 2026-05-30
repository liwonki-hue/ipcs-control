with open('static/js/dashboard.js', 'r', encoding='utf-8') as f:
    text = f.read()

old1 = '            _dashData = await res.json();\n            return _dashData;'
new1 = '            if (!res.ok) throw new Error("HTTP " + res.status);\n            _dashData = await res.json();\n            return _dashData;'
text = text.replace(old1, new1)

old2 = '''    } else {
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }'''
new2 = '''    } else {
        if (msg) {
            el.querySelectorAll("div")[1].textContent = "ERROR";
            el.querySelectorAll("div")[1].style.color = "#ef4444";
            el.querySelectorAll("div")[2].textContent = msg;
        } else {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        }
    }'''
text = text.replace(old2, new2)

with open('static/js/dashboard.js', 'w', encoding='utf-8') as f:
    f.write(text)
print('Done frontend patches!')
