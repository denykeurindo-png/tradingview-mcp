import WebSocket from './node_modules/ws/index.js';
import http from 'http';

const list = await new Promise((res,rej) => {
  http.get('http://localhost:9222/json/list', r => {
    let d=''; r.on('data',c=>d+=c);
    r.on('end',()=>res(JSON.parse(d)));
  }).on('error',rej);
});

const tab = list.find(t => t.url && t.url.includes('coinglass') && t.type==='page');
if(!tab){console.log('no coinglass tab'); process.exit(0);}
console.log('Tab:', tab.url.slice(0,60));

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r=>ws.once('open',r));
let id=1;
const cdp=(m,p={})=>new Promise((res,rej)=>{
  const i=id++;
  const t=setTimeout(()=>rej(new Error('timeout '+m)),8000);
  ws.once('message',function h(raw){
    const msg=JSON.parse(raw);
    if(msg.id===i){clearTimeout(t);if(msg.error)rej(new Error(msg.error.message));else res(msg.result);}
    else ws.once('message',h);
  });
  ws.send(JSON.stringify({id:i,method:m,params:p}));
});

await cdp('Runtime.enable');

// Find all LI elements with "3 day" text and show context
const r = await cdp('Runtime.evaluate', {
  expression: `(function() {
    var all = Array.from(document.querySelectorAll('*'))
      .filter(e => e.children.length === 0 && e.textContent.trim() === '3 day');
    return JSON.stringify(all.map(el => {
      var p = el.parentElement;
      var gp = p && p.parentElement;
      return {
        tag: el.tagName,
        cls: el.className.slice(0,50),
        parentTag: p ? p.tagName : '',
        parentCls: p ? p.className.slice(0,50) : '',
        gpTag: gp ? gp.tagName : '',
        gpCls: gp ? gp.className.slice(0,50) : '',
        visible: !!el.offsetParent
      };
    }));
  })()`,
  returnByValue: true
});

ws.close();
console.log('3 day elements:', r?.result?.value);
