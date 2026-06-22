// Diagnostic: inspect CoinGlass period selector DOM on VPS
import WebSocket from 'ws';
import http from 'http';

const tabs = await new Promise((res, rej) => {
  http.get('http://127.0.0.1:9222/json', r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});

const tab = tabs.find(t => t.url?.includes('coinglass'));
if (!tab) { console.log('No CoinGlass tab found'); process.exit(1); }
console.log('Tab:', tab.url);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.on('open', r));

let mid = 1;
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = mid++;
  const t = setTimeout(() => rej(new Error('timeout: ' + method)), 15000);
  const h = data => {
    const m = JSON.parse(data);
    if (m.id === id) { clearTimeout(t); ws.off('message', h); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else ws.once('message', h);
  };
  ws.once('message', h);
  ws.send(JSON.stringify({ id, method, params }));
});

const getLIs = async () => {
  const r = await cdp('Runtime.evaluate', {
    expression: `(function(){
      return JSON.stringify(Array.from(document.querySelectorAll('li')).map(function(li){
        var r = li.getBoundingClientRect();
        var s = window.getComputedStyle(li);
        return {
          text: (li.innerText||li.textContent||'').trim().slice(0,30),
          x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
          w: Math.round(r.width), h: Math.round(r.height),
          display: s.display, visibility: s.visibility, opacity: s.opacity
        };
      }).filter(i => i.text && i.w > 0));
    })()`,
    returnByValue: true
  });
  return JSON.parse(r?.result?.value || '[]');
};

console.log('\n=== LIs BEFORE click ===');
const before = await getLIs();
before.forEach(i => console.log(JSON.stringify(i)));

// Find and click 24hour button
const btnR = await cdp('Runtime.evaluate', {
  expression: `(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var b = btns.find(b => /24.{0,5}hour/i.test(b.innerText||''));
    if (!b) return JSON.stringify({err:'no 24h btn', found: btns.map(b=>(b.innerText||'').trim().slice(0,20))});
    b.scrollIntoView({block:'center'});
    var r = b.getBoundingClientRect();
    return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2, text:b.innerText.trim().slice(0,30)});
  })()`,
  returnByValue: true
});
const btn = JSON.parse(btnR?.result?.value || '{}');
console.log('\n=== 24h BUTTON ===', JSON.stringify(btn));

if (btn.x && btn.y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, button: 'none', clickCount: 0 });
  await new Promise(r => setTimeout(r, 80));
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 80));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise(r => setTimeout(r, 1500));
}

console.log('\n=== LIs AFTER click ===');
const after = await getLIs();
after.forEach(i => console.log(JSON.stringify(i)));

// Find 3day and show detail
const day3 = after.filter(i => /3\s*day/i.test(i.text));
console.log('\n=== 3day items ===', JSON.stringify(day3));

ws.close();
