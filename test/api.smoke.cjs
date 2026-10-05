const { openDb } = require('../dist/src/db');
const { Service } = require('../dist/src/service');
const { startServer } = require('../dist/src/server');

(async () => {
  const svc = new Service(openDb(process.env.AC_DATA_DIR));
  const port = await startServer(svc, 0);
  const base = 'http://127.0.0.1:' + port + '/api';
  const j = async (u, m, b) => {
    const r = await fetch(base + u, {
      method: m || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { s: r.status, b: await r.json() };
  };
  let r = await j('/pattern-sets', 'POST', { name: 'api', patterns: ['he', 'she', 'his', 'hers'] });
  console.log('set', r.s, JSON.stringify(r.b));
  const vid = r.b.versionId;
  console.log('compile', (await j('/versions/' + vid + '/compile', 'POST')).s);
  r = await j('/scans', 'POST', { versionId: vid });
  const sid = r.b.scanId;
  console.log('scan', sid);
  console.log('append0', JSON.stringify((await j('/scans/' + sid + '/append', 'POST', { seq: 0, text: 'ush' })).b));
  console.log('append1', JSON.stringify((await j('/scans/' + sid + '/append', 'POST', { seq: 1, text: 'ers' })).b));
  console.log('dup', JSON.stringify((await j('/scans/' + sid + '/append', 'POST', { seq: 1, text: 'ers' })).b));
  const conf = await j('/scans/' + sid + '/append', 'POST', { seq: 1, text: 'XX' });
  console.log('conflict', conf.s, conf.b.error.code);
  await j('/scans/' + sid + '/finish', 'POST');
  console.log('hits', JSON.stringify((await j('/scans/' + sid + '/hits')).b));
  const fin = await j('/scans/' + sid + '/append', 'POST', { seq: 2, text: 'x' });
  console.log('after-finish', fin.s, fin.b.error.code);
  const bad = await j('/pattern-sets', 'POST', { name: 'x', patterns: ['a', 'a'] });
  console.log('dup-pattern', bad.s, bad.b.error.code);
  console.log('explain', JSON.stringify((await j('/scans/' + sid + '/explain?from=3&to=5')).b));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
