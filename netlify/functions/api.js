/**
 * Wedding Dashboard — Netlify Serverless Function
 *
 * Environment variables (set in Netlify → Site settings → Environment variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  e.g. wedding@project.iam.gserviceaccount.com
 *   GOOGLE_PRIVATE_KEY            the private_key from the service account JSON
 *   GOOGLE_SHEET_ID               the ID from your sheet URL (/d/THIS_PART/edit)
 *   SHEET_NAME                    your sheet tab name, e.g. Sheet1
 *   ANTHROPIC_API_KEY             your Anthropic API key
 */

'use strict';
const https  = require('https');
const crypto = require('crypto');

// ── CORS headers returned on every response ─────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function ok(body)  { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function err(msg)  { return { statusCode: 500, headers: CORS, body: JSON.stringify({ status: 'error', message: msg }) }; }
function bad(msg)  { return { statusCode: 400, headers: CORS, body: JSON.stringify({ status: 'error', message: msg }) }; }

// ── HTTPS helper ─────────────────────────────────────────────────────────────
function request(options, bodyData) {
  return new Promise((resolve, reject) => {
    const payload = bodyData
      ? (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData))
      : null;

    if (payload && !options.headers) options.headers = {};
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Google JWT auth ──────────────────────────────────────────────────────────
function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function normaliseKey(raw) {
  // Netlify env vars can arrive with literal \n or real newlines depending on
  // how they were pasted. Normalise both so the PEM is always valid.
  let k = raw || '';
  // Replace any literal backslash-n with a real newline
  k = k.replace(/\\n/g, '\n');
  // If the key is one long line with no newlines at all, try to reconstruct it
  if (!k.includes('\n')) {
    k = k
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
  }
  return k.trim();
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key   = normaliseKey(process.env.GOOGLE_PRIVATE_KEY);

  if (!email) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL env var is missing');
  if (!key)   throw new Error('GOOGLE_PRIVATE_KEY env var is missing');

  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = b64url(sign.sign(key));

  const jwt  = `${header}.${payload}.${sig}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  const res = await request({
    hostname: 'oauth2.googleapis.com',
    path:     '/token',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);

  if (!res.body.access_token) {
    throw new Error('Google auth failed: ' + JSON.stringify(res.body));
  }
  return res.body.access_token;
}

// ── Sheets helpers ───────────────────────────────────────────────────────────
async function sheetsGet(token, sheetId, range) {
  const r = await request({
    hostname: 'sheets.googleapis.com',
    path:     `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    method:   'GET',
    headers:  { Authorization: `Bearer ${token}` },
  });
  if (r.status !== 200) throw new Error('Sheets read failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function sheetsBatchUpdate(token, sheetId, data) {
  const r = await request({
    hostname: 'sheets.googleapis.com',
    path:     `/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    method:   'POST',
    headers:  { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, { valueInputOption: 'RAW', data });
  if (r.status !== 200) throw new Error('Sheets write failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function sheetsAppend(token, sheetId, range, values) {
  const r = await request({
    hostname: 'sheets.googleapis.com',
    path:     `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method:   'POST',
    headers:  { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, { values });
  if (r.status !== 200) throw new Error('Sheets append failed: ' + JSON.stringify(r.body));
  return r.body;
}

// ── Column index to A1 letter(s) — handles AA, AB etc ───────────────────────
function colToLetter(n) {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) {
    s = String.fromCharCode(65 + (i % 26)) + s;
  }
  return s;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleTest() {
  // Hits every env var and reports exactly what's working or missing
  const checks = {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY_set:       !!process.env.GOOGLE_PRIVATE_KEY,
    GOOGLE_PRIVATE_KEY_has_BEGIN: (process.env.GOOGLE_PRIVATE_KEY||'').includes('BEGIN'),
    GOOGLE_SHEET_ID:              !!process.env.GOOGLE_SHEET_ID,
    SHEET_NAME:                   process.env.SHEET_NAME || '(defaulting to Sheet1)',
    ANTHROPIC_API_KEY:            !!process.env.ANTHROPIC_API_KEY,
  };

  let tokenOk = false;
  let tokenError = null;
  try {
    await getAccessToken();
    tokenOk = true;
  } catch(e) {
    tokenError = e.message;
  }

  return ok({
    status: 'test',
    env_checks: checks,
    google_auth: tokenOk ? 'OK' : ('FAILED — ' + tokenError),
  });
}

async function handleRead(sheetId, sheetName) {
  const token = await getAccessToken();
  const data  = await sheetsGet(token, sheetId, `${sheetName}!A1:Z2000`);
  const rows    = data.values || [];
  const headers = rows[0]    || [];
  const guests  = rows.slice(1)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] != null ? String(row[i]) : ''; });
      return obj;
    })
    .filter(r => (r['Names'] || '').trim());
  return ok(guests);
}

async function handleUpdate(sheetId, sheetName, body) {
  if (!body.Names || !body.Side) return bad('Names and Side are required');

  const token = await getAccessToken();
  const data  = await sheetsGet(token, sheetId, `${sheetName}!A1:Z2000`);
  const rows    = data.values || [];
  const headers = rows[0]    || [];

  const nameIdx = headers.indexOf('Names');
  const sideIdx = headers.indexOf('Side');
  if (nameIdx === -1) return bad('Could not find Names column in sheet');

  let targetRow = -1;
  for (let i = 1; i < rows.length; i++) {
    const rName = (rows[i][nameIdx] || '').trim();
    const rSide = (rows[i][sideIdx] || '').trim();
    if (rName === body.Names.trim() && rSide === (body.Side || '').trim()) {
      targetRow = i + 1; // 1-indexed for Sheets API
      break;
    }
  }
  if (targetRow === -1) return ok({ status: 'error', message: 'Guest not found: ' + body.Names });

  const updatable = ['RSVP','Quantity','Pick up needed','Arrival Time',
                     'Flight Details','Train Details','Drop needed','Drop Time','Accomodation'];

  const updates = updatable
    .filter(f => body[f] !== undefined)
    .map(f => {
      const ci = headers.indexOf(f);
      if (ci === -1) return null;
      return {
        range:  `${sheetName}!${colToLetter(ci)}${targetRow}`,
        values: [[body[f]]],
      };
    })
    .filter(Boolean);

  if (updates.length) await sheetsBatchUpdate(token, sheetId, updates);

  // Log the update
  try {
    await sheetsAppend(token, sheetId, 'Updates Log!A:A', [[
      new Date().toISOString(),
      body.Names||'', body.Side||'', body.RSVP||'', body.Quantity||'',
      body['Pick up needed']||'', body['Arrival Time']||'',
      body['Flight Details']||'', body['Train Details']||'',
      body['Drop needed']||'', body['Drop Time']||'', body['Accomodation']||'',
    ]]);
  } catch(_) { /* log failure must not break the main update */ }

  return ok({ status: 'ok', name: body.Names, rowUpdated: targetRow });
}

async function handleAI(body) {
  const { guests: gd, vehicles, driveTime } = body;
  if (!gd || !gd.length) return bad('No guest data provided');

  const prompt =
    'You are a wedding logistics coordinator. Organise transport for a wedding.\n\n' +
    'GUESTS NEEDING TRANSPORT:\n' + JSON.stringify(gd, null, 2) + '\n\n' +
    'VEHICLES: ' + (vehicles || 'Tempo Traveller (12), Innova (6), Sedan (4)') + '\n' +
    'DRIVE TIME to venue: ' + (driveTime || '45') + ' mins\n\n' +
    'RULES:\n' +
    '1. Group arrivals within 45 min of each other into shared pickup runs\n' +
    '2. Group departures within 45 min of each other into shared drop runs\n' +
    '3. Fill larger vehicles first\n' +
    '4. Pickup depart_venue_time = arrival_time minus drive_time minus 15 min buffer\n' +
    '5. Flag if same vehicle needed for pickup and drop with under 30 min turnaround\n' +
    '6. If times are missing, group by flight/train and mark times TBC\n\n' +
    'Reply ONLY with valid JSON, no markdown, no extra text:\n' +
    '{"runs":[{"id":"R1","type":"pickup","label":"Morning arrivals","vehicle":"Tempo Traveller",' +
    '"capacity":12,"total_pax":8,"guests":["Name1","Name2"],"airport_time":"10:30",' +
    '"depart_venue_time":"09:30","notes":"note"}],' +
    '"conflicts":[{"message":"..."}],"summary":"One paragraph"}';

  const res = await request({
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers:  {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
  }, { model: 'claude-sonnet-4-20250514', max_tokens: 2000,
       messages: [{ role: 'user', content: prompt }] });

  if (res.body.error) throw new Error('Anthropic error: ' + res.body.error.message);
  const text = (res.body.content || []).map(c => c.text || '').join('');
  return ok({ status: 'ok', text });
}

// ── Main entry point ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const qs       = event.queryStringParameters || {};
  const action   = qs.action || 'read';
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SHEET_NM = process.env.SHEET_NAME || 'Sheet1';

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch(_) {}
  }

  try {
    if (action === 'test')   return await handleTest();
    if (action === 'read')   return await handleRead(SHEET_ID, SHEET_NM);
    if (action === 'update') return await handleUpdate(SHEET_ID, SHEET_NM, body);
    if (action === 'ai')     return await handleAI(body);
    return bad('Unknown action: ' + action);
  } catch(e) {
    return err(e.message);
  }
};