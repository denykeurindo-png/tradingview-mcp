with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'r') as f:
    src = f.read()

# Replace the click expression with React fiber approach
old_click = '''  // Click "3 day" period on the CoinGlass heatmap page
  const clickResult = await cdp('Runtime.evaluate', {
    expression: `
      (async function() {
        function rc(el) {
          ['mousedown','mouseup','click'].forEach(ev =>
            el.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window}))
          );
        }

        // Walk all elements looking for "24 hour" text (using textContent — no innerText needed)
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var nodes24 = [];
        var node;
        while (node = walker.nextNode()) {
          if (/^24\\s*hour$/i.test(node.nodeValue.trim())) nodes24.push(node.parentElement);
        }

        if (nodes24.length === 0) {
          // Fallback: any element whose direct text content is "24 hour"
          var all = Array.from(document.querySelectorAll('*'));
          var el = all.find(e => /^24\\s*hour$/i.test(Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.nodeValue).join('').trim()));
          if (el) nodes24.push(el);
        }

        if (nodes24.length === 0) {
          return 'no 24h text node; page title=' + document.title.slice(0,40) + '; body text sample=' + document.body.innerText.slice(0,100).replace(/\\n/g,' ');
        }

        var el24 = nodes24[0];
        // Click el24 and ancestors up to 10 levels
        var node2 = el24;
        for (var i = 0; i < 10; i++) {
          rc(node2);
          if (!node2.parentElement || node2 === document.body) break;
          node2 = node2.parentElement;
        }
        await new Promise(r => setTimeout(r, 2500));

        // Find "3 day" text node
        var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var day3El = null;
        while (node = walker2.nextNode()) {
          if (/^3\\s*day$/i.test(node.nodeValue.trim())) { day3El = node.parentElement; break; }
        }

        if (day3El) {
          rc(day3El);
          if (day3El.parentElement) rc(day3El.parentElement);
          await new Promise(r => setTimeout(r, 1000));
          return 'clicked 3day: ' + day3El.tagName;
        }

        return 'no 3day found (clicked 24h el: ' + el24.tagName + ')';
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });'''

new_click = '''  // Change to "3 day" period via React fiber onChange (bypasses DOM event issues)
  const clickResult = await cdp('Runtime.evaluate', {
    expression: `
      (async function() {
        function rc(el) {
          ['mousedown','mouseup','click'].forEach(ev =>
            el.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window}))
          );
        }

        // Strategy 1: Find the Select component via React fiber and call onChange directly
        var selects = Array.from(document.querySelectorAll('[class*="MuiSelect"]'));
        var periodSelect = null;
        for (var sel of selects) {
          if (sel.textContent.includes('hour') || sel.textContent.includes('day')) {
            periodSelect = sel; break;
          }
        }

        if (periodSelect) {
          // Get React fiber
          var fk = Object.keys(periodSelect).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
          if (fk) {
            var fiber = periodSelect[fk];
            // Walk fiber to find onChange
            var f = fiber;
            var onChange = null;
            for (var depth = 0; depth < 30 && f; depth++) {
              if (f.memoizedProps && typeof f.memoizedProps.onChange === 'function') {
                onChange = f.memoizedProps.onChange; break;
              }
              f = f.return;
            }
            if (onChange) {
              // Call onChange with '3 day' value
              try {
                onChange(null, '3 day');
                await new Promise(r => setTimeout(r, 2000));
                return 'React onChange called with 3 day';
              } catch(e) {
                return 'onChange failed: ' + e.message;
              }
            }
          }
        }

        // Strategy 2: Open dropdown and click option
        // Click the period button to open dropdown
        var allEls = Array.from(document.querySelectorAll('*'));
        var el24 = allEls.find(e => (e.textContent||'').trim() === '24 hour' && e.tagName === 'BUTTON');
        if (!el24) el24 = allEls.find(e => (e.textContent||'').trim() === '24 hour');
        if (!el24) return 'no 24h element found';

        rc(el24);
        if (el24.parentElement) rc(el24.parentElement);
        await new Promise(r => setTimeout(r, 1500));

        // Find 3 day option in now-visible dropdown
        var day3 = allEls.find(e => (e.textContent||'').trim() === '3 day' && e.tagName === 'LI');
        if (!day3) day3 = allEls.find(e => (e.textContent||'').trim() === '3 day');
        if (day3) {
          rc(day3);
          if (day3.parentElement) rc(day3.parentElement);
          await new Promise(r => setTimeout(r, 1000));
          return 'clicked 3day via dropdown: ' + day3.tagName;
        }
        return 'no 3day option found';
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });'''

cnt = src.count(old_click)
src = src.replace(old_click, new_click, 1)
print('click replaced:', cnt)

with open('/home/binance/tradingview-mcp/src/dashboard/server.js', 'w') as f:
    f.write(src)
print('done')
