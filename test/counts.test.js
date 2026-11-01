// 数字だけを返す窓口（GET /api/counts）の試験。実際の空港のAPIには接続せず、作り物の便の一覧で確かめる。
//   node --test test/counts.test.js      （または npm test）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const srv = require('../server.js');

// ---- 作り物の便 ----
const mk = (adjustedMinutes, o = {}) => Object.assign({
  gate: '1号乗り場', flightType: 'domestic', area: 'テスト', viaArea: '', airlines: [{ code: 'JAL', flightNumber: '123', icon: '/x.png' }],
  scheduledTime: '10:00', displayTime: '10:00', adjustedTime: '10:15', adjustedMinutes, isDelayed: false, terminal: 'T1', exitGates: ['1'],
  status: { category: 'normal', text: '運航中' }, modelCode: '788', seats: 240,
}, o);
const ARRIVED = { category: 'arrived', text: '到着済み' };
const DELAYED = { category: 'delayed', text: '遅延' };
const WEATHER = { category: 'delayed', text: '天候調査中' };
const CANCELED = { category: 'canceled', text: '欠航' };

// 日本時間 y-m-d h:mi の、UTCのミリ秒
const jst = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi);

// ---- 日付・時刻の扱い ----
test('いまの時刻（日本時間）を、7:00-29:00軸の分にする', () => {
  assert.equal(srv.nowMinutesOnAxis(jst(2026, 11, 1, 7, 0)), 7 * 60);
  assert.equal(srv.nowMinutesOnAxis(jst(2026, 11, 1, 12, 34)), 12 * 60 + 34);
  assert.equal(srv.nowMinutesOnAxis(jst(2026, 11, 1, 23, 59)), 23 * 60 + 59);
  assert.equal(srv.nowMinutesOnAxis(jst(2026, 11, 2, 0, 0)), 24 * 60);
  assert.equal(srv.nowMinutesOnAxis(jst(2026, 11, 2, 1, 53)), 25 * 60 + 53);
  assert.equal(srv.nowMinutesOnAxis(jst(2026, 11, 2, 6, 59)), 30 * 60 + 59);
  // サーバーの時刻がUTCでも、日本時間で数える（UTCの 22:30 ＝ 日本時間の翌日 7:30）
  assert.equal(srv.nowMinutesOnAxis(Date.UTC(2026, 10, 1, 22, 30)), 7 * 60 + 30);
});

test('使う一覧の日付は、日本時間の朝7時に替わる（朝7時前は前日）', () => {
  assert.equal(srv.businessDateStr(jst(2026, 11, 1, 7, 0)), '20261101');
  assert.equal(srv.businessDateStr(jst(2026, 11, 1, 23, 59)), '20261101');
  assert.equal(srv.businessDateStr(jst(2026, 11, 2, 0, 0)), '20261101');
  assert.equal(srv.businessDateStr(jst(2026, 11, 2, 6, 59)), '20261101');
  assert.equal(srv.businessDateStr(jst(2026, 11, 2, 7, 0)), '20261102');
  // UTCの日付ではなく、日本時間で決める（UTCの 11/1 22:30 ＝ 日本時間の 11/2 7:30 → 20261102）
  assert.equal(srv.businessDateStr(Date.UTC(2026, 10, 1, 22, 30)), '20261102');
  // 月またぎ・年またぎ
  assert.equal(srv.businessDateStr(jst(2026, 12, 1, 3, 0)), '20261130');
  assert.equal(srv.businessDateStr(jst(2027, 1, 1, 6, 30)), '20261231');
  assert.equal(srv.businessDateStr(jst(2027, 1, 1, 7, 0)), '20270101');
});

// ---- 計算式: 画面（public/index.html）の calcWindowCount と同じになること ----
function loadFrontendCalc() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf('function calcWindowCount(flights)');
  const b = html.indexOf('function renderPanel(data)');
  assert.ok(a > 0 && b > a, '画面の calcWindowCount が見つかりません');
  const src = html.slice(a, b);
  return (h, m) => {
    const FakeDate = function () { return { getHours: () => h, getMinutes: () => m }; };
    return new Function('Date', src + '\nreturn calcWindowCount;')(FakeDate);
  };
}

test('画面の calcWindowCount と、全ての時刻・便の組み合わせで同じ結果になる', () => {
  const frontend = loadFrontendCalc();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const statuses = [{ category: 'normal', text: '運航中' }, ARRIVED, DELAYED, WEATHER, CANCELED, { text: '天候不良' }, { category: 'arrived', text: '天候' }, undefined, null];
  let compared = 0;
  for (let round = 0; round < 40; round++) {
    const n = Math.floor(rnd() * 60);
    const flights = Array.from({ length: n }, () => mk(420 + Math.floor(rnd() * 1500), {
      flightType: rnd() < 0.25 ? 'international' : 'domestic', status: statuses[Math.floor(rnd() * statuses.length)],
    }));
    for (let hh = 0; hh < 24; hh++) {
      for (const mi of [0, 1, 29, 30, 31, 59]) {
        const ms = jst(2026, 11, 1, hh, mi);
        const want = frontend(hh, mi)(flights);
        const got = srv.computeWindowCounts(flights, srv.nowMinutesOnAxis(ms));
        assert.deepEqual(got, want, `一致しない: ${hh}:${mi} 便${n}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 5000);
});

test('便が1つも無い乗り場は null（画面と同じ）', () => {
  assert.equal(srv.computeWindowCounts([], 600), null);
  assert.equal(srv.computeWindowCounts(null, 600), null);
});

test('境目: 前30分は含む／ちょうど「いま」は後1hに入る／後1hは60分先まで含む', () => {
  const now = 12 * 60;
  const f = [mk(now - 31), mk(now - 30), mk(now - 1), mk(now), mk(now + 60), mk(now + 61)];
  const c = srv.computeWindowCounts(f, now);
  assert.equal(c.before, 2);  // now-30, now-1
  assert.equal(c.after, 2);   // now, now+60
});

test('前30分の表示数には、後1hのうち到着済みの便も合算する。国際線の内訳は、前と後で別', () => {
  const now = 12 * 60;
  const f = [
    mk(now - 10), mk(now - 5, { flightType: 'international' }),
    mk(now + 10, { status: ARRIVED }), mk(now + 20, { flightType: 'international', status: ARRIVED }), mk(now + 30),
    mk(now + 40, { status: DELAYED }), mk(now + 50, { status: WEATHER }), mk(now + 55, { status: CANCELED }),
  ];
  const c = srv.computeWindowCounts(f, now);
  assert.equal(c.before, 2);
  assert.equal(c.arrivedTotal, 2);
  assert.equal(c.beforeDisplay, 4);          // 2 + 到着済み2
  assert.equal(c.after, 6);
  assert.equal(c.intlBefore, 1);
  assert.equal(c.intlAfter, 1);
  assert.equal(c.afterDelayed, 1);
  assert.equal(c.afterWeather, 1);
  assert.equal(c.allCanceled, 1);
  assert.equal(c.afterNormal, 1);            // 運行中（now+30）
});

// ---- HTTP: パスワード無しで見られるのは数字だけ。他は、これまでどおりパスワードが要る ----
function request(port, method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: headers || {} }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); req.end();
  });
}

test('HTTP: /api/counts', async (t) => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  t.after(() => srv.server.close());

  let clock = jst(2026, 11, 1, 12, 0);
  srv.__setNow(() => clock);
  const nowMin = 12 * 60;
  const gatesData = {
    '1号乗り場': [mk(nowMin - 10), mk(nowMin + 20), mk(nowMin + 30, { status: ARRIVED })],
    '2号乗り場': [mk(nowMin + 5, { gate: '2号乗り場' })],
    '3号乗り場': [],
    '4号乗り場': [mk(nowMin - 3, { gate: '4号乗り場', flightType: 'international' }), mk(nowMin + 15, { gate: '4号乗り場' })],
  };
  let upstreamCalls = []; let failNext = false; let delay = 0;
  srv.__setFetchFlights(async (dateStr) => {
    upstreamCalls.push(dateStr);
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (failNext) throw new Error('空港のAPIに接続できません（試験）');
    return { fetchedAt: new Date(clock).toISOString(), date: dateStr, gates: gatesData };
  });

  await t.test('パスワード・Cookie無しで、数字が取れる。CORSで、どのページからでも読める', async () => {
    const r = await request(port, 'GET', '/api/counts', { Origin: 'https://odioai001-eng.github.io' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(j.date, '20261101');
    assert.equal(j.nowMinutes, nowMin);
    assert.equal(j.stale, false);
    assert.deepEqual(Object.keys(j.gates), ['1号乗り場', '2号乗り場', '3号乗り場', '4号乗り場']);
    assert.equal(j.gates['1号乗り場'].beforeDisplay, 2);  // 前30分1 + 到着済み1
    assert.equal(j.gates['1号乗り場'].after, 2);
    assert.equal(j.gates['2号乗り場'].after, 1);
    assert.equal(j.gates['3号乗り場'], null);             // 便が無い乗り場
    assert.equal(j.gates['4号乗り場'].intlBefore, 1);
    assert.equal(j.gates['4号乗り場'].intlAfter, 0);
    assert.deepEqual(upstreamCalls, ['20261101']);
  });

  await t.test('返すのは便数の集計だけ（便名・出発地・経由地などは返さない）', async () => {
    const r = await request(port, 'GET', '/api/counts');
    assert.ok(!/JAL|テスト|airlines|area|viaArea|flightNumber/.test(r.body), r.body.slice(0, 200));
  });

  await t.test('OPTIONS（事前確認）は204で、CORSの許可を返す', async () => {
    const r = await request(port, 'OPTIONS', '/api/counts', { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.match(r.headers['access-control-allow-methods'], /GET/);
  });

  await t.test('GET・OPTIONS以外は405', async () => {
    const r = await request(port, 'POST', '/api/counts');
    assert.equal(r.status, 405);
  });

  await t.test('他の窓口は、これまでどおりパスワードが要る（/api/flights・トップ・クエリ付きの別の道）', async () => {
    for (const p of ['/api/flights?date=20261101', '/', '/index.html', '/api/countsX', '/api/counts/x']) {
      const r = await request(port, 'GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], /text\/html/, p);
      assert.match(r.body, /パスワードを入力してください/, p);
    }
    assert.equal(upstreamCalls.length, 1, 'パスワード無しのアクセスで、空港に問い合わせてはいけない');
  });

  await t.test('55秒以内は、空港に問い合わせず、取得結果を使い回す。時刻は進む', async () => {
    upstreamCalls = [];
    srv.__setFetchFlights(async (d) => { upstreamCalls.push(d); return { gates: gatesData }; });
    clock = jst(2026, 11, 1, 12, 0);
    const a = JSON.parse((await request(port, 'GET', '/api/counts')).body);
    clock += 54 * 1000;
    const b = JSON.parse((await request(port, 'GET', '/api/counts')).body);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(a.fetchedAt, b.fetchedAt);
    clock += 2 * 1000; // 56秒
    await request(port, 'GET', '/api/counts');
    assert.equal(upstreamCalls.length, 2);
    // 1分進むと、数える範囲も1分進む（同じ便でも、前→後ろ側へ入れ替わる）
    clock = jst(2026, 11, 1, 12, 10);
    const c = JSON.parse((await request(port, 'GET', '/api/counts')).body);
    assert.equal(c.nowMinutes, 12 * 60 + 10);
    assert.equal(c.gates['1号乗り場'].before, 1);   // 12:00の10分前（11:50）の便は、12:10では20分前＝まだ前30分の中。12:20の便（後ろ側）は、まだ「いま」の後
  });

  await t.test('同時に来た分は、空港への問い合わせを1回にまとめる', async () => {
    upstreamCalls = []; delay = 80;
    srv.__setFetchFlights(async (d) => { upstreamCalls.push(d); await new Promise(r => setTimeout(r, delay)); return { gates: gatesData }; });
    clock = jst(2026, 11, 1, 13, 0);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(port, 'GET', '/api/counts')));
    assert.ok(rs.every(r => r.status === 200));
    assert.equal(upstreamCalls.length, 1);
    delay = 0;
  });

  await t.test('朝7時で、使う一覧の日付が替わる（6:59は前日、7:00は当日）', async () => {
    upstreamCalls = [];
    srv.__setFetchFlights(async (d) => { upstreamCalls.push(d); return { gates: gatesData }; });
    clock = jst(2026, 11, 2, 6, 59);
    const a = JSON.parse((await request(port, 'GET', '/api/counts')).body);
    clock = jst(2026, 11, 2, 7, 0);
    const b = JSON.parse((await request(port, 'GET', '/api/counts')).body);
    assert.equal(a.date, '20261101');
    assert.equal(b.date, '20261102');
    assert.deepEqual(upstreamCalls, ['20261101', '20261102']);
  });
});

test('空港への問い合わせに失敗した時: 10分以内の取得結果があれば古いまま答え、10分を過ぎたら502', async (t) => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  t.after(() => srv.server.close());
  let clock = jst(2026, 11, 1, 15, 0);
  srv.__setNow(() => clock);
  const gatesData = { '1号乗り場': [mk(15 * 60 + 10)], '2号乗り場': [], '3号乗り場': [], '4号乗り場': [] };
  let mode = 'ok';
  srv.__setFetchFlights(async () => { if (mode === 'fail') throw new Error('空港のAPIに接続できません（試験）'); return { gates: gatesData }; });
  const a = JSON.parse((await request(port, 'GET', '/api/counts')).body);
  assert.equal(a.stale, false);
  mode = 'fail';
  clock += 56 * 1000;  // 取得結果は古い（55秒を過ぎた）ので、空港に問い合わせる → 失敗 → 古い結果で答える
  let r = await request(port, 'GET', '/api/counts');
  assert.equal(r.status, 200);
  let j = JSON.parse(r.body);
  assert.equal(j.stale, true);
  assert.equal(j.fetchedAt, a.fetchedAt);
  assert.equal(j.gates['1号乗り場'].after, 1);
  clock += 9 * 60 * 1000 + 10 * 1000;  // 取得から10分を過ぎる（56秒 + 9分10秒）
  r = await request(port, 'GET', '/api/counts');
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.body).ok, false);
  assert.equal(r.headers['access-control-allow-origin'], '*'); // 失敗の時も、ページ側が読めるよう、CORSは付ける
  assert.ok(!/試験|接続できません/.test(r.body), '内部のエラー内容を返してはいけない');
  mode = 'ok';
  r = await request(port, 'GET', '/api/counts');  // 回復すれば、また普通に答える
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).stale, false);
});

// ---- 空港のAPIの応答がJSONでない時に、サーバーが落ちない ----
test('postJson: JSON以外の応答は、エラーとして返す（プロセスが落ちない）', async () => {
  const https = require('https');
  const orig = https.request;
  https.request = (options, cb) => {
    const { EventEmitter } = require('events');
    const req = new EventEmitter(); req.write = () => {}; req.setTimeout = () => {};
    req.end = () => { const res = new EventEmitter(); res.statusCode = 503; cb(res); res.emit('data', '<html>メンテナンス中</html>'); res.emit('end'); };
    return req;
  };
  try {
    await assert.rejects(srv.postJson('https://tokyo-haneda.com/app/api/v2/flight/search', {}, 'https://tokyo-haneda.com/'), /解析できません.*503/);
  } finally { https.request = orig; }
});
