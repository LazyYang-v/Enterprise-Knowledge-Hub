// 出网目标校验：统一 MCP / 模型端点使用的私网、回环、链路本地与元数据地址规则。
// 注意：调用前 DNS 校验无法完全消除 DNS rebinding；调用方仍需禁用重定向并限制主机白名单。
import dns from 'node:dns';
import net from 'node:net';

export class EgressDeniedError extends Error {
  constructor(message, code = 'egress_denied'){
    super(message);
    this.name = 'EgressDeniedError';
    this.code = code;
    this.status = 400;
    this.retryable = false;
  }
}

function bareHost(hostname){
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseIpv4(ip){
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function inV4(ip, a, b, c, d, bits){
  const n = parseIpv4(ip);
  if (!n) return false;
  const value = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isPrivateAddress(ip){
  const value = bareHost(ip);
  const family = net.isIP(value);
  if (family === 4){
    return inV4(value, 0, 0, 0, 0, 8)
      || inV4(value, 10, 0, 0, 0, 8)
      || inV4(value, 100, 64, 0, 0, 10)
      || inV4(value, 127, 0, 0, 0, 8)
      || inV4(value, 169, 254, 0, 0, 16)
      || inV4(value, 172, 16, 0, 0, 12)
      || inV4(value, 192, 0, 0, 0, 24)
      || inV4(value, 192, 0, 2, 0, 24)
      || inV4(value, 192, 168, 0, 0, 16)
      || inV4(value, 198, 18, 0, 0, 15)
      || inV4(value, 198, 51, 100, 0, 24)
      || inV4(value, 203, 0, 113, 0, 24)
      || inV4(value, 224, 0, 0, 0, 4)
      || inV4(value, 240, 0, 0, 0, 4);
  }
  if (family === 6){
    const v = value.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // fc00::/7
    if (/^ff[0-9a-f]{2}:/.test(v)) return true; // multicast
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export function isMetadataAddress(ip){
  const value = bareHost(ip);
  if (value === '169.254.169.254' || value === 'fd00:ec2::254' || value === '100.100.100.200') return true;
  return false;
}

export function isPrivateHost(hostname){
  const h = bareHost(hostname);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  if (isPrivateAddress(h)) return true;
  return false;
}

function hostAllowed(host, allowlist){
  if (!allowlist?.length) return true;
  const h = bareHost(host);
  return allowlist.some(entry => {
    const e = bareHost(entry);
    return e && (h === e || h.endsWith(`.${e}`));
  });
}

/**
 * 校验出网 URL。allowlist 为空表示不限制主机（仍拒绝私网/元数据）。
 * lookup 可注入，便于测试与避免真实 DNS。
 */
export async function assertEgressTarget(rawUrl, {
  allowPrivate = false,
  allowMetadata = false,
  allowlist = [],
  lookup = dns.promises.lookup,
} = {}){
  let url;
  try { url = new URL(String(rawUrl || '')); }
  catch { throw new EgressDeniedError('出网地址不是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new EgressDeniedError('出网地址只支持 http/https');
  if (url.username || url.password) throw new EgressDeniedError('出网地址不能包含用户凭证');
  const host = bareHost(url.hostname);
  if (!host) throw new EgressDeniedError('出网地址缺少主机');
  if (isMetadataAddress(host) && !allowMetadata) throw new EgressDeniedError('出网地址不能指向元数据服务');
  if (isPrivateHost(host) && !allowPrivate) throw new EgressDeniedError('出网地址不能指向本机、私网或内部域名');
  if (!hostAllowed(host, allowlist)) throw new EgressDeniedError('出网地址不在允许列表内');
  if (!net.isIP(host)){
    let addresses;
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new EgressDeniedError('出网主机解析失败');
    }
    if (!Array.isArray(addresses) || !addresses.length) throw new EgressDeniedError('出网主机没有可用地址');
    for (const item of addresses){
      const address = item?.address || item;
      if (isMetadataAddress(address) && !allowMetadata) throw new EgressDeniedError('出网主机解析到元数据地址');
      if (isPrivateAddress(address) && !allowPrivate) throw new EgressDeniedError('出网主机解析到私网地址');
    }
  }
  return url;
}
