import { isIP } from "node:net";
import type { PluginPermissions } from "@deskpet/plugin-sdk";

function safeHttps(input: string): URL | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        url.hostname.endsWith(".") || isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return null;
    return url;
  } catch {
    return null;
  }
}

export function allowedNetworkUrl(input: string, hosts: readonly string[] = []): URL | null {
  const url = safeHttps(input);
  return url && hosts.includes(url.hostname) ? url : null;
}

export function allowedExternalUrl(input: string, patterns: readonly string[] = []): URL | null {
  const url = safeHttps(input);
  if (!url) return null;
  return patterns.some((pattern) => {
    const declared = safeHttps(pattern);
    if (!declared || declared.search || declared.hash || declared.hostname !== url.hostname) return false;
    const path = declared.pathname;
    return path.endsWith("/*") ? url.pathname.startsWith(path.slice(0, -1)) : url.pathname === path;
  }) ? url : null;
}

export function allowedWindowRequest(id: string, initialUrl: string, permissions: PluginPermissions): boolean {
  return permissions.windows?.includes(id) === true && allowedNetworkUrl(initialUrl, permissions.network) !== null;
}
