import json, socket, http.client, urllib.parse

# Connect to Chrome CDP via HTTP
conn = http.client.HTTPConnection('localhost', 9222)
conn.request('GET', '/json/list')
resp = conn.getresponse()
tabs = json.loads(resp.read())
conn.close()

tab = next((t for t in tabs if 'coinglass' in t.get('url','') and t.get('type') == 'page'), None)
if not tab:
    print('No coinglass tab')
    exit(1)

print('Tab:', tab['url'][:70])

# Connect via WebSocket
import websocket, threading, time

result = {'done': False, 'value': None}

def on_message(ws, msg):
    m = json.loads(msg)
    if m.get('id') == 1:
        result['value'] = m.get('result', {}).get('result', {}).get('value')
        result['done'] = True
        ws.close()

def on_open(ws):
    # Click period dropdown then collect option texts
    expr = """
(async function() {
    // Step 1: find and click the current period selector
    var allEls = Array.from(document.querySelectorAll('*'));
    var clicked = false;
    for (var el of allEls) {
        var t = el.textContent.trim();
        if (el.children.length === 0 && (t === '24 hour' || t === '24hour' || t === '24H' || t === '24h')) {
            var par = el.closest('[class*="select"],[class*="Select"],[class*="picker"],[class*="dropdown"]') || el.parentElement;
            if (par) { par.click(); clicked = true; break; }
        }
    }

    await new Promise(r => setTimeout(r, 1200));

    // Step 2: collect all visible text nodes that could be options
    var candidates = Array.from(document.querySelectorAll(
        '[class*="option"],[class*="Option"],[class*="item"],[class*="Item"],[role="option"],[role="menuitem"],li'
    )).filter(el => el.offsetParent !== null);

    var texts = candidates.map(el => el.textContent.trim()).filter(t => t && t.length < 25);

    return JSON.stringify({ clicked: clicked, options: texts.slice(0, 20) });
})()
"""
    ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {
        'expression': expr,
        'awaitPromise': True,
        'returnByValue': True
    }}))

ws_url = tab['webSocketDebuggerUrl']
ws = websocket.WebSocketApp(ws_url, on_open=on_open, on_message=on_message)
t = threading.Thread(target=lambda: ws.run_forever())
t.daemon = True
t.start()

timeout = 15
start = time.time()
while not result['done'] and time.time() - start < timeout:
    time.sleep(0.2)

if result['value']:
    data = json.loads(result['value'])
    print('Clicked:', data.get('clicked'))
    print('Options found:')
    for opt in data.get('options', []):
        print(' -', repr(opt))
else:
    print('No result after', timeout, 'seconds')
