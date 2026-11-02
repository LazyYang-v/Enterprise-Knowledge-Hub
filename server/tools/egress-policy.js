// MCP 出网策略：连接级 allowlist 优先，其次全局 allowlist；始终拒绝私网/元数据（除非显式放开）。
import { config } from '../config.js';
import { assertEgressTarget } from '../net/ssrf.js';

export function mcpEgressOptions(connection = {}){
  const perConnection = Array.isArray(connection.egress_allowlist) ? connection.egress_allowlist : [];
  return {
    allowPrivate: config.mcp.allowPrivateHosts,
    allowMetadata: config.mcp.allowMetadataHosts,
    allowlist: perConnection.length ? perConnection : config.mcp.egressAllowlist,
  };
}

export async function assertMcpEndpoint(connection){
  return assertEgressTarget(connection?.endpoint, mcpEgressOptions(connection));
}
