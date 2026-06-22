async function test() {
  try {
    const res = await fetch('http://103.55.37.239:4000/api/jda-signal', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from('admin:admin123').toString('base64')
      }
    });
    const json = await res.json();
    console.log('SUCCESS:', json.success);
    if (json.success) {
      console.log('DATA KEYS:', Object.keys(json.data));
      console.log('FINAL CALL:', json.data.finalCall);
      console.log('ALIGNED:', json.data.aligned);
      console.log('EMA FILTER:', json.data.emaFilter);
      console.log('ADX FILTER:', json.data.adxFilter);
      console.log('CROSS FILTER:', json.data.crossFilter);
      console.log('15M STATE:', json.data.timeframes['15m'].state);
      console.log('15M VZO:', json.data.timeframes['15m'].vzo);
      console.log('15M SIGNAL:', json.data.timeframes['15m'].signal);
      console.log('15M TREND:', json.data.timeframes['15m'].trend);
    } else {
      console.error('ERROR:', json.error);
    }
  } catch (e) {
    console.error('FETCH FAILED:', e.message);
  }
}
test();
