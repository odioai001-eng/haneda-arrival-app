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
      res.on('end', () => resolve(JSON.parse(data)));
    });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`羽田空港 乗り場別到着便ビューアー`);
  console.log(`http://localhost:${PORT}`);
});
