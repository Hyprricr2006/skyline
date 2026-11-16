// Skyline server: serves the app and ranks live fares from Ignav (https://ignav.com).
// Run: IGNAV_API_KEY=your_key node server.js   (Node 18+, no dependencies)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.IGNAV_API_KEY;
const MARKET = process.env.MARKET || 'US';          // pricing country/currency, e.g. GB, DE, RO if supported
const HOUR = Number(process.env.HOUR_VALUE) || 20;  // what an hour of your time is worth, in the fare currency
const STOP = Number(process.env.STOP_PENALTY) || 25;// extra cost per connection
const PORT = process.env.PORT || 3000;
const CABIN = {economy: 'economy', premium: 'premium_economy', business: 'business', first: 'first'};
const fail = (m, status = 502) => Object.assign(new Error(m), {status});

async function call(endpoint, body) {
  const r = await fetch('https://ignav.com' + endpoint, {
    method: 'POST',
    headers: {'X-Api-Key': KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail((typeof j.error === 'string' ? j.error : j.error?.message) || j.message || 'Provider error ' + r.status);
  return j;
}

const legsOf = it => it.legs || [it.outbound, it.inbound].filter(Boolean);
const segs = g => g.map((x, i) => ({
  code: x.marketing_carrier_code || '', flight: (x.marketing_carrier_code || '') + (x.flight_number || ''), carrier: x.operating_carrier_name || x.marketing_carrier_code,
  from: x.departure_airport, to: x.arrival_airport, dep: x.departure_time_local, arr: x.arrival_time_local,
  mins: x.duration_minutes, aircraft: x.aircraft || '',
  layover: g[i + 1] && x.arrival_time_utc && g[i + 1].departure_time_utc ? Math.round((new Date(g[i + 1].departure_time_utc) - new Date(x.arrival_time_utc)) / 60000) : 0
}));
const slice = l => {
  const g = l.segments, a = g[0], b = g[g.length - 1];
  return {from: a.departure_airport, to: b.arrival_airport, dep: a.departure_time_local, arr: b.arrival_time_local,
          mins: l.duration_minutes, stops: g.length - 1, segs: segs(g),
          carriers: [...new Set(g.map(x => x.operating_carrier_name || x.marketing_carrier_code))]};
};
function shape(it) {
  const slices = legsOf(it).map(slice);
  const price = Number(it.price.amount), mins = slices.reduce((t, s) => t + s.mins, 0), stops = slices.reduce((t, s) => t + s.stops, 0);
  return {id: it.ignav_id, price, cur: it.price.currency, airline: slices[0].carriers.join(', '),
          mins, stops, slices, score: price + (mins / 60) * HOUR + stops * STOP,
          cabin: it.cabin_class || '', bags: it.bags || null, mixed: !!it.has_mixed_carriers, status: it.price.status || ''};
}
const base = (adults, cabin) => ({adults: Math.min(+adults || 1, 9), cabin_class: CABIN[cabin] || 'economy', market: MARKET});

async function search({legs, adults, cabin}) {
  if (!KEY) throw fail('Set IGNAV_API_KEY on the server to turn on live fares', 503);
  if (!Array.isArray(legs) || !legs.length || legs.length > 6) throw fail('Bad itinerary', 400);
  const opts = base(adults, cabin);

  // One or two legs (one-way, return, open-jaw): a single request returns complete priced journeys.
  if (legs.length <= 2) {
    const j = await call('/api/fares/search', {...opts, legs: legs.map(l => ({origin: l.f, destination: l.t, departure_date: l.d}))});
    return {offers: (j.itineraries || []).map(shape).sort((a, b) => a.score - b.score).slice(0, 40)};
  }

  // Three or more legs: price each flight on its own and add them up (approximate, separate tickets).
  const per = await Promise.all(legs.map(l =>
    call('/api/fares/one-way', {...opts, origin: l.f, destination: l.t, departure_date: l.d})
      .then(j => (j.itineraries || []).map(shape).sort((a, b) => a.score - b.score))));
  if (per.some(p => !p.length)) return {offers: []};
  const join = parts => {
    const slices = parts.flatMap(p => p.slices), price = parts.reduce((t, p) => t + p.price, 0);
    const mins = parts.reduce((t, p) => t + p.mins, 0), stops = parts.reduce((t, p) => t + p.stops, 0);
    return {id: parts.map(p => p.id).join('+'), price, cur: parts[0].cur,
            airline: [...new Set(parts.map(p => p.airline))].join(' + '), mins, stops, slices, cabin: parts[0].cabin, bags: null, mixed: parts.some(p => p.mixed), status: parts.every(p => p.status === 'verified') ? 'verified' : '',
            score: price + (mins / 60) * HOUR + stops * STOP};
  };
  const picks = [
    per.map(p => p[0]),
    per.map(p => [...p].sort((a, b) => a.price - b.price)[0]),
    per.map(p => [...p].sort((a, b) => a.mins - b.mins)[0])
  ];
  for (let i = 1; i < Math.min(6, ...per.map(p => p.length)); i++) picks.push(per.map(p => p[i]));
  const seen = new Set();
  const offers = picks.map(join).filter(o => !seen.has(o.id) && seen.add(o.id)).sort((a, b) => a.score - b.score);
  return {offers};
}

async function book({id, adults}) {
  if (!KEY) throw fail('Set IGNAV_API_KEY on the server', 503);
  const ids = String(id || '').split('+').filter(Boolean);
  if (!ids.length || ids.length > 6) throw fail('Bad id', 400);
  const fix = u => (/^https?:\/\//.test(u) ? u : 'https://' + u);
  const out = [];
  for (const [n, one] of ids.entries()) {
    const j = await call('/api/fares/booking-links', {ignav_id: one, adults: Math.min(+adults || 1, 9), market: MARKET});
    const total = j.itinerary?.legs?.length || 1;
    for (const o of j.booking_options || []) for (const l of o.links || [])
      out.push({provider: l.provider_name, type: l.provider_type, price: l.price?.amount, cur: l.price?.currency, url: fix(l.url),
                legs: ids.length > 1 ? String(n + 1) : (o.leg_indexes && o.leg_indexes.length < total ? o.leg_indexes.map(i => i + 1).join(',') : '')});
  }
  return {links: out.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)).slice(0, 12)};
}

const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'};
http.createServer(async (req, res) => {
  const send = (c, t, b) => { res.writeHead(c, {'Content-Type': t, 'Cache-Control': 'no-store'}); res.end(b); };
  try {
    if (req.method === 'POST' && req.url === '/api/search') {
      let raw = ''; for await (const c of req) raw += c;
      return send(200, 'application/json', JSON.stringify(await search(JSON.parse(raw || '{}'))));
    }
    if (req.method === 'POST' && req.url === '/api/book') {
      let raw = ''; for await (const c of req) raw += c;
      return send(200, 'application/json', JSON.stringify(await book(JSON.parse(raw || '{}'))));
    }
    const f = path.join(dir, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(path.join(dir, 'public')) || !fs.existsSync(f)) return send(404, 'application/json', '{"error":"Not found"}');
    send(200, types[path.extname(f)] || 'application/octet-stream', fs.readFileSync(f));
  } catch (e) { send(e.status || 500, 'application/json', JSON.stringify({error: e.message})); }
}).listen(PORT, () => console.log('Skyline on http://localhost:' + PORT));
