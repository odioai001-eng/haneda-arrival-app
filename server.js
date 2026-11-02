const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || '1862';
const SESSION_TOKEN = require('crypto').randomBytes(32).toString('hex');

// Aircraft IATA type code → typical total seat count
const AIRCRAFT_SEATS = {
  '100': 76, '146': 100,
  '319': 128, '320': 165, '321': 194,
  '332': 266, '333': 298,
  '350': 325, '35K': 369,
  '388': 516,
  '737': 162, '73C': 120, '73H': 162, '73N': 162, '738': 162, '739': 178,
  '762': 210, '763': 261, '76E': 261, '767': 245,
  '772': 320, '773': 375, '77N': 396, '77W': 396,
  '787': 240, '788': 240, '789': 296, '78E': 318,
  '78I': 250, '78J': 296,
  'E70': 76, 'E90': 98, 'E95': 116,
  'CR7': 70, 'CRJ': 50,
  'DH8': 78, 'DH4': 78,
  'AT7': 70, 'AT5': 48,
  'SF3': 30, 'SB2': 19,
};

function postJson(url, body, referer) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': referer,
        'Origin': 'https://tokyo-haneda.com',
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        // 空港側がメンテナンス等でJSON以外（HTMLなど）を返した時に、サーバーごと落ちないよう、解析の失敗は呼び出し元に返す
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('空港のAPIの応答を解析できません（HTTP ' + res.statusCode + '）')); }
      });
      res.on('error', reject);
    });
    // 応答が返ってこない時に、取得中のまま待ち続けないようにする
    req.setTimeout(15000, () => req.destroy(new Error('空港のAPIの応答がありません（15秒）')));
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function addMinutes(timeStr, minutes) {
  if (!timeStr || timeStr === '-') return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

function toMinutes(timeStr) {
  if (!timeStr || timeStr === '-') return Infinity;
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return Infinity;
  // 7:00-29:00 timeline: treat 0:00-5:59 as 24:00-29:59 (next day early morning)
  const adjustedH = h < 7 ? h + 24 : h;
  return adjustedH * 60 + m;
}

function getGate(flight) {
  const term = flight.terminal ? flight.terminal.terminal : '';

  if (flight.flightType === 'international' && term === 'T2') return '4号乗り場';
  if (flight.flightType === 'international') return null; // T3 etc. — not in scope

  // Domestic: find exitGate option
  const exitOpt = (flight.options || []).find(o => o.type === 'exitGate');
  if (!exitOpt || !exitOpt.items || exitOpt.items.length === 0) return null;

  const gateNum = parseInt(exitOpt.items[0].name, 10);
  if (term === 'T1') {
    if (gateNum >= 1 && gateNum <= 4) return '1号乗り場';
    if (gateNum >= 5 && gateNum <= 8) return '2号乗り場';
  } else if (term === 'T2') {
    if (gateNum >= 1 && gateNum <= 3) return '3号乗り場';
    if (gateNum >= 4 && gateNum <= 6) return '4号乗り場';
  }
  return null;
}

function getModelCode(flight) {
  const opt = (flight.options || []).find(o => o.type === 'modelCode');
  if (opt && opt.items && opt.items.length > 0) return opt.items[0].name;
  return null;
}

function getExitGates(flight) {
  const opt = (flight.options || []).find(o => o.type === 'exitGate');
  if (opt && opt.items) return opt.items.map(i => i.name);
  return [];
}

function processFlights(rawList, isInternational) {
  const offset = isInternational ? 30 : 15;
  return rawList
    .map(f => {
      const gate = getGate(f);
      if (!gate) return null;

      const displayTime = (f.change_time && f.change_time !== '-') ? f.change_time : f.on_time;
      const adjustedTime = addMinutes(displayTime, offset);
      const modelCode = getModelCode(f);
      const seats = modelCode ? (AIRCRAFT_SEATS[modelCode] || null) : null;

      return {
        gate,
        flightType: f.flightType,
        area: f.area_name,
        viaArea: f.via_area_name || '',
        airlines: f.airlines.map(a => ({ code: a.airline, flightNumber: a.flightNumber, icon: a.icon_url })),
        scheduledTime: f.on_time,
        displayTime,
        adjustedTime,
        adjustedMinutes: toMinutes(adjustedTime),
        isDelayed: f.change_time && f.change_time !== '-' && f.change_time !== f.on_time,
        terminal: f.terminal ? f.terminal.terminal : '',
        exitGates: getExitGates(f),
        status: f.status,
        modelCode,
        seats,
      };
    })
    .filter(Boolean);
}

async function fetchFlights(dateStr) {
  const base = 'https://tokyo-haneda.com/app/api/v2/flight/search';
  const params = { arrivalType: 2, searchDt: dateStr, airportCodes: [], airlineCodes: [], flightNumber: '', status: [0] };

  const [dmsData, intData] = await Promise.all([
    postJson(base, { ...params, flightType: 1 }, 'https://tokyo-haneda.com/flight/dms_search.html'),
    postJson(base, { ...params, flightType: 2 }, 'https://tokyo-haneda.com/flight/int_search.html'),
  ]);

  const domestic = processFlights(dmsData.flightlists || [], false);
  const international = processFlights(intData.flightlists || [], true);
  const all = [...domestic, ...international];

  // Group by gate
  const gates = { '1号乗り場': [], '2号乗り場': [], '3号乗り場': [], '4号乗り場': [] };
  all.forEach(f => {
    if (gates[f.gate]) gates[f.gate].push(f);
  });

  // Sort each gate by adjustedMinutes
  Object.keys(gates).forEach(g => {
    gates[g].sort((a, b) => a.adjustedMinutes - b.adjustedMinutes);
  });

  return {
    fetchedAt: new Date().toISOString(),
    date: dateStr,
    serverDate: dmsData.date,
    gates,
  };
}

// ---------------------------------------------------------------------------
// 数字だけを返す公開用の窓口  GET /api/counts
//
// チームアプリ（イチバン羽田チームアプリ）の地図画面に、各乗り場の「前30分-後1h」の便数を出すためのもの。
// 画面（public/index.html）の calcWindowCount() と同じ計算を、サーバー側で行って返す。
// ・返すのは便数の集計だけ（便名・出発地などは返さない）なので、パスワード無しで見られる（他の窓口は、これまでどおりパスワードが要る）
// ・何人が見ても、空港のAPIへの問い合わせは、日付ごとに55秒に1回まで（取得結果を使い回す）。問い合わせに失敗した時は、
//   10分以内の取得結果があれば、古くてもそれで答える（stale:true）
// ・「いま」は日本時間。乗り場の一覧は、朝7時に日が替わる（7:00-29:00軸。朝7時前は前日の一覧）
// ---------------------------------------------------------------------------
const COUNTS_CACHE_MS = 55 * 1000;
const COUNTS_STALE_MAX_MS = 10 * 60 * 1000;
const GATE_NAMES = ['1号乗り場', '2号乗り場', '3号乗り場', '4号乗り場'];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const flightsCache = new Map();    // 日付(YYYYMMDD) -> { at, data }
const flightsInflight = new Map(); // 日付 -> 取得中のPromise（同時に来た分は、1回の問い合わせにまとめる）
let fetchFlightsImpl = fetchFlights; // 試験で差し替える
let nowFn = () => Date.now();        // 試験で差し替える

function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS); // ずらした日時のUTCの値＝日本時間の値（日本に夏時間は無い）
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

// いま使う一覧の日付。朝7時（日本時間）に替わる。朝7時前は、前日の一覧
function businessDateStr(ms) {
  const base = jstParts(ms).h >= 7 ? ms : ms - 24 * 60 * 60 * 1000;
  const q = jstParts(base);
  return `${q.y}${String(q.mo).padStart(2, '0')}${String(q.d).padStart(2, '0')}`;
}

// いまの時刻（日本時間）を、7:00-29:00軸の「分」にしたもの（朝7時前は24時間足す。toMinutesと同じ）
function nowMinutesOnAxis(ms) {
  const p = jstParts(ms);
  const h = p.h < 7 ? p.h + 24 : p.h;
  return h * 60 + p.mi;
}

// public/index.html の calcWindowCount() と同じ計算（便が無い乗り場は null）
function computeWindowCounts(flights, nowMin) {
  if (!flights || flights.length === 0) return null;
  const before = flights.filter(f => f.adjustedMinutes >= nowMin - 30 && f.adjustedMinutes < nowMin);
  const after = flights.filter(f => f.adjustedMinutes >= nowMin && f.adjustedMinutes <= nowMin + 60);
  const statusOf = f => f.status && f.status.category;
  const isWeather = f => /天候/.test((f.status && f.status.text) || '');
  const afterArrived = after.filter(f => statusOf(f) === 'arrived').length;
  const afterWeather = after.filter(f => statusOf(f) !== 'arrived' && statusOf(f) !== 'canceled' && isWeather(f)).length;
  const afterDelayed = after.filter(f => statusOf(f) === 'delayed' && !isWeather(f)).length;
  const afterNormal = after.filter(f => statusOf(f) !== 'arrived' && statusOf(f) !== 'delayed' && statusOf(f) !== 'canceled' && !isWeather(f)).length;
  const allCanceled = flights.filter(f => statusOf(f) === 'canceled').length;
  return {
    before: before.length,
    beforeDisplay: before.length + afterArrived, // 前30分の表示数には、後1hのうち既に到着済みの便も合算する
    after: after.length,
    intlBefore: before.filter(f => f.flightType === 'international').length,
    intlAfter: after.filter(f => f.flightType === 'international').length,
    arrivedTotal: afterArrived,
    afterNormal,
    afterDelayed,
    afterWeather,
    allCanceled,
  };
}

async function getFlightsCached(dateStr, nowMs) {
  const hit = flightsCache.get(dateStr);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < COUNTS_CACHE_MS) return { data: hit.data, at: hit.at, stale: false };
  let p = flightsInflight.get(dateStr);
  if (!p) {
    p = fetchFlightsImpl(dateStr)
      .then(data => { const entry = { at: nowFn(), data }; flightsCache.set(dateStr, entry); return entry; })
      .finally(() => flightsInflight.delete(dateStr));
    flightsInflight.set(dateStr, p);
  }
  try {
    const entry = await p;
    return { data: entry.data, at: entry.at, stale: false };
  } catch (e) {
    if (hit && nowMs - hit.at < COUNTS_STALE_MAX_MS) return { data: hit.data, at: hit.at, stale: true };
    throw e;
  }
}

async function handleCounts(req, res) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', // 便数の集計だけ（公開の空港情報）なので、どのページからでも読める
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405, headers); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return; }
  try {
    const nowMs = nowFn();
    const dateStr = businessDateStr(nowMs);
    const { data, at, stale } = await getFlightsCached(dateStr, nowMs);
    const nowMin = nowMinutesOnAxis(nowMs);
    const gates = {};
    GATE_NAMES.forEach(g => { gates[g] = computeWindowCounts((data.gates || {})[g] || [], nowMin); });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, date: dateStr, now: new Date(nowMs).toISOString(), nowMinutes: nowMin, fetchedAt: new Date(at).toISOString(), stale, gates }));
  } catch (e) {
    console.error('counts failed', e);
    res.writeHead(502, headers);
    res.end(JSON.stringify({ ok: false, error: 'upstream failed' }));
  }
}

// SVGアイコンをPNGとして返す（簡易版）
function serveIcon(res, size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${size*0.18}" fill="#003087"/>
    <text x="${size/2}" y="${size*0.62}" font-size="${size*0.52}" text-anchor="middle" fill="white">🛬</text>
  </svg>`;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(svg);
}

// Simple static file server
function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url)
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// クッキーを解析
function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(c => {
    const [key, ...val] = c.split('=');
    list[key.trim()] = val.join('=').trim();
  });
  return list;
}

// ログインページHTML
function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>並べ替え</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #003087; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
  .box { background: #fff; border-radius: 16px; padding: 40px 32px; text-align: center; width: 280px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
  h1 { font-size: 18px; color: #003087; margin-bottom: 8px; }
  p { font-size: 13px; color: #888; margin-bottom: 24px; }
  input { width: 100%; padding: 12px; font-size: 20px; text-align: center; letter-spacing: 8px; border: 2px solid #ddd; border-radius: 8px; box-sizing: border-box; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #003087; }
  button { width: 100%; padding: 12px; background: #003087; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  .error { color: #e74c3c; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="box">
  <h1>🛬 並べ替え</h1>
  <p>パスワードを入力してください</p>
  ${error ? '<div class="error">パスワードが違います</div>' : ''}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="----" autofocus>
    <button type="submit">ログイン</button>
  </form>
</div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  // 数字だけを返す公開用の窓口（パスワード無し・CORS可）
  if (req.url.split('?')[0] === '/api/counts') { await handleCounts(req, res); return; }

  // ログイン処理
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        res.writeHead(302, {
          'Set-Cookie': `session=${SESSION_TOKEN}; Path=/; HttpOnly`,
          'Location': '/'
        });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage(true));
      }
    });
    return;
  }

  // 認証チェック（ログインページとアイコンは除外）
  if (req.url !== '/login' && !req.url.startsWith('/icon-')) {
    const cookies = parseCookies(req);
    if (cookies.session !== SESSION_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(false));
      return;
    }
  }

  if (req.url === '/icon-192.png') { serveIcon(res, 192); return; }
  if (req.url === '/icon-512.png') { serveIcon(res, 512); return; }

  if (req.url.startsWith('/api/flights')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const today = new Date();
    const defaultDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    const dateStr = urlObj.searchParams.get('date') || defaultDate;

    try {
      const data = await fetchFlights(dateStr);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  serveStatic(req, res);
});

// 試験から読み込んだ時は、起動しない
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`羽田空港 乗り場別到着便ビューアー`);
    console.log(`http://localhost:${PORT}`);
  });
}

module.exports = {
  server, computeWindowCounts, businessDateStr, nowMinutesOnAxis, postJson,
  __setFetchFlights(fn) { fetchFlightsImpl = fn; flightsCache.clear(); flightsInflight.clear(); },
  __setNow(fn) { nowFn = fn; },
};
