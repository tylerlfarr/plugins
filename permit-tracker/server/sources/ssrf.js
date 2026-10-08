/**
 * SSRF hardening for operator-supplied source inspection URLs.
 * Blocks private/link-local/metadata targets after DNS resolution.
 * Does not invent allowlists that pretend unsupported hosts are safe.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
]);

/** @param {string} ip */
export function isBlockedIp(ip) {
  const v = String(ip || '').trim().toLowerCase();
  if (!v) return true;
  if (v === '::1' || v === '0:0:0:0:0:0:0:1') return true;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.includes(':')) {
    // IPv4-mapped IPv6
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Validate URL shape + resolve host; throw on SSRF risk.
 * @returns {Promise<{ href: string, hostname: string, addresses: string[] }>}
 */
export async function assertSafeOutboundUrl(rawUrl, { allowHttp = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    const err = new Error('Invalid URL');
    err.code = 'ssrf_invalid_url';
    throw err;
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'https:' && !(allowHttp && proto === 'http:')) {
    const err = new Error('Only http(s) URLs are allowed for source inspection');
    err.code = 'ssrf_bad_scheme';
    throw err;
  }
  if (parsed.username || parsed.password) {
    const err = new Error('URLs with embedded credentials are not allowed');
    err.code = 'ssrf_credentials';
    throw err;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname)) {
    const err = new Error('Host is not allowed for outbound fetch');
    err.code = 'ssrf_blocked_host';
    throw err;
  }
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    const err = new Error('Internal hostnames are not allowed');
    err.code = 'ssrf_blocked_host';
    throw err;
  }

  let addresses = [];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const looked = await dns.lookup(hostname, { all: true, verbatim: true });
      addresses = looked.map((r) => r.address);
    } catch (e) {
      const err = new Error(`DNS lookup failed for host: ${e.message || e}`);
      err.code = 'ssrf_dns_failed';
      throw err;
    }
  }
  if (!addresses.length) {
    const err = new Error('Host resolved to no addresses');
    err.code = 'ssrf_dns_empty';
    throw err;
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      const err = new Error(`Blocked private or link-local target (${addr})`);
      err.code = 'ssrf_private_ip';
      throw err;
    }
  }
  return { href: parsed.href, hostname, addresses };
}
