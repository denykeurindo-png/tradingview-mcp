import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const FUNC_CONTENT = fs.readFileSync(path.join(process.cwd(), 'scratch/heatmap_func.js'), 'utf8');

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }

    const writeStream = sftp.createWriteStream('/tmp/heatmap_func.js');
    writeStream.write(FUNC_CONTENT);
    writeStream.end();
    writeStream.on('close', () => {
      console.log('heatmap_func.js uploaded');

      const PATCH = `
import sys

func_content = open('/tmp/heatmap_func.js').read()

# Patch heatmap.js
with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.js', 'r') as f:
    js = f.read()

# 1. Restore renderLiquidationTables call (only if not already present)
if 'renderLiquidationTables(result)' not in js:
    js = js.replace(
        '      renderKPIs(result, lastUpdate);\\n      renderHeatmap(result);\\n    } else {',
        '      renderKPIs(result, lastUpdate);\\n      renderHeatmap(result);\\n      renderLiquidationTables(result);\\n    } else {'
    )
    print('call restored')
else:
    print('call already present')

# 2. Insert function before ECharts section (only if not already present)
if 'function renderLiquidationTables' not in js:
    js = js.replace(
        '// ─── ECharts 2D HeatMap with Candlestick Overlay ────────────',
        func_content + '\\n// ─── ECharts 2D HeatMap with Candlestick Overlay ────────────'
    )
    print('function inserted')
else:
    print('function already present')

with open('/home/binance/tradingview-mcp/src/dashboard/public/heatmap.js', 'w') as f:
    f.write(js)

print('heatmap.js done')
`;
      const pyStream = sftp.createWriteStream('/tmp/patch_heatmap.py');
      pyStream.write(PATCH);
      pyStream.end();
      pyStream.on('close', () => {
        console.log('patch script uploaded');
        conn.exec('python3 /tmp/patch_heatmap.py', (err, stream) => {
          if (err) { console.error(err); conn.end(); return; }
          stream.on('close', () => conn.end());
          stream.on('data', d => process.stdout.write(d.toString()));
          stream.stderr.on('data', d => process.stderr.write(d.toString()));
        });
      });
    });
  });
}).on('error', err => {
  console.error('SSH error:', err.message);
  process.exit(1);
}).connect({ host: '103.55.37.239', port: 22, username: 'binance', password: '!Yurika01' });
