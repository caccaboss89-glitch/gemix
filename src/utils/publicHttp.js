// src/utils/publicHttp.js
//
// Public-only HTTP(S) boundary for model-selected downloads. DNS uses the host
// resolver first and public resolvers when the host has rewritten a public name
// to a local address. Every result must be globally routable and the request is
// pinned to one validated address. Redirects repeat the same validation.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_REDIRECTS = 5;
const PUBLIC_DNS_SERVERS = Object.freeze(['1.1.1.1', '1.0.0.1']);

function _publicIpv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && p[2] === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && p[2] === 100) return false;
  if (a === 203 && b === 0 && p[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIp(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(value);
  if (family === 4) return _publicIpv4(value);
  if (family !== 6) return false;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return _publicIpv4(mapped[1]);
  const numeric = _ipv6ToBigInt(value);
  if (numeric === null || !_inIpv6Cidr(numeric, '2000', 3)) return false;
  // IETF special-purpose, documentation and transition ranges inside 2000::/3.
  if (_inIpv6Cidr(numeric, '2001', 23)
      || _inIpv6Cidr(numeric, '20010db8', 32)
      || _inIpv6Cidr(numeric, '2002', 16)
      || _inIpv6Cidr(numeric, '3fff', 20)) return false;
  return true;
}

function _ipv6ToBigInt(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function _inIpv6Cidr(address, prefixHex, prefixLength) {
  const prefix = BigInt(`0x${prefixHex}`) << BigInt(128 - prefixHex.length * 4);
  const shift = BigInt(128 - prefixLength);
  return address >> shift === prefix >> shift;
}

function parsePublicUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new Error(`Invalid URL: "${String(raw).slice(0, 120)}"`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error(`Invalid public HTTP(S) URL: "${String(raw).slice(0, 120)}"`);
  }
  if (url.hostname.toLowerCase() === 'localhost' || url.hostname.toLowerCase().endsWith('.localhost')) {
    throw new Error('Private or local URL targets are not allowed.');
  }
  return url;
}

async function _lookupWithDeadline(hostname, timeoutMs, signal, lookup) {
  if (signal?.aborted) throw signal.reason || new Error('Download aborted.');
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timed out for ${hostname}.`)), timeoutMs);
        timer.unref?.();
        if (signal) {
          onAbort = () => reject(signal.reason || new Error('Download aborted.'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function _lookupPublicDns(hostname) {
  const resolver = new dns.Resolver();
  resolver.setServers(PUBLIC_DNS_SERVERS);
  const settled = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname)
  ]);
  const answers = settled.flatMap((result, index) => result.status === 'fulfilled'
    ? result.value.map(address => ({ address, family: index === 0 ? 4 : 6 }))
    : []);
  if (answers.length === 0) {
    const firstError = settled.find(result => result.status === 'rejected')?.reason;
    throw firstError || new Error(`No DNS answer for ${hostname}.`);
  }
  return answers;
}

/**
 * Every address this name may be connected to, all of them validated. A broken
 * ISP search suffix may rewrite a public name to loopback; when the host answer
 * is unusable, resolve the same name through public DNS and validate it fully.
 */
async function resolvePublicAddresses(url, opts = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (!isPublicIp(hostname)) throw new Error('Private or local URL targets are not allowed.');
    return [{ address: hostname, family: literalFamily }];
  }

  const timeoutMs = opts.timeoutMs || 60_000;
  const deadline = Date.now() + timeoutMs;
  const systemLookup = opts.lookup || dns.lookup;
  const publicLookup = opts.publicLookup || _lookupPublicDns;
  let systemError = null;
  let answers = [];
  try {
    answers = await _lookupWithDeadline(hostname, timeoutMs, opts.signal, systemLookup);
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason || err;
    systemError = err;
  }
  if (answers.length > 0 && answers.every(answer => isPublicIp(answer.address))) return answers;

  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`DNS lookup timed out for ${hostname}.`);
    answers = await _lookupWithDeadline(hostname, remaining, opts.signal, publicLookup);
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason || err;
    if (systemError) throw new Error(`DNS lookup failed for ${url.hostname}: ${systemError.message}`);
    throw new Error('Private, local or unresolved URL targets are not allowed.');
  }
  if (!answers.length || answers.some(answer => !isPublicIp(answer.address))) {
    throw new Error('Private, local or unresolved URL targets are not allowed.');
  }
  return answers;
}

function _requestPinned(url, target, opts) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, {
      headers: opts.headers,
      signal: opts.signal,
      lookup: _pinnedLookup(target)
    }, resolve);
    request.setTimeout(opts.timeoutMs, () => {
      request.destroy(new Error(`Timeout (${opts.timeoutMs / 1000}s) reached for ${url.href}`));
    });
    request.on('error', reject);
  });
}

/** Node 22 requests an array when autoSelectFamily sets lookup options.all. */
function _pinnedLookup(target) {
  return (_hostname, lookupOpts, callback) => {
    if (lookupOpts?.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

/** Open a validated response stream, returning the final URL after redirects. */
async function openPublicHttp(raw, opts = {}) {
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || 60_000);
  const deadline = Date.now() + timeoutMs;
  let url = parsePublicUrl(raw);

  for (let redirects = 0; ; redirects++) {
    if (opts.signal?.aborted) throw opts.signal.reason || new Error('Download aborted.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timeout (${timeoutMs / 1000}s) reached for ${url.href}`);
    const targets = await resolvePublicAddresses(url, { timeoutMs: remaining, signal: opts.signal });
    let response = null;
    let lastErr = null;
    for (const target of targets) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        response = await _requestPinned(url, target, {
          headers: opts.headers,
          signal: opts.signal,
          timeoutMs: left
        });
        break;
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason || err;
        lastErr = err;
      }
    }
    if (!response) {
      throw lastErr || new Error(`Timeout (${timeoutMs / 1000}s) reached for ${url.href}`);
    }
    const location = response.headers.location;
    if (response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
      url = parsePublicUrl(new URL(location, url).href);
      continue;
    }
    return { response, url };
  }
}

export {
  _pinnedLookup,
  isPublicIp,
  openPublicHttp,
  parsePublicUrl,
  resolvePublicAddresses
};
