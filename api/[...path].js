import http from 'node:http';
import https from 'node:https';

export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  const origin = process.env.RENDER_API_ORIGIN;
  const secret = process.env.PRODUCTPULSE_PROXY_SECRET;
  if (!origin || !secret) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'API proxy is not configured.' }));
    return;
  }

  let target;
  try {
    const requestUrl = new URL(req.url || '/', 'https://vercel.invalid');
    if (!requestUrl.pathname.startsWith('/api/')) throw new Error('Invalid API path');
    const apiOrigin = new URL(origin);
    if (apiOrigin.protocol !== 'https:') throw new Error('API origin must use HTTPS');
    target = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin);
  } catch {
    res.statusCode = 400;
    res.end('Invalid API destination.');
    return;
  }

  const headers = { ...req.headers, host: target.host, 'x-productpulse-proxy-secret': secret };
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']) delete headers[name];
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: req.method, headers }, response => {
    res.statusCode = response.statusCode || 502;
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) res.setHeader(name, value);
    }
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.end();
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Render API is unavailable.' }));
  });
  req.pipe(upstream);
}
