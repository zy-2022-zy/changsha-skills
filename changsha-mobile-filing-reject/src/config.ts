import path from 'node:path';
export function loadConfig(env = process.env) {
  const baseUrl = env.MOBILE_PORTAL_BASE_URL || 'https://wap.hn.10086.cn/ismsports/';
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('门户地址必须使用 HTTPS。');
  const browserChannel = env.BROWSER_CHANNEL || 'chrome';
  if (!['chrome', 'msedge', 'chromium'].includes(browserChannel)) throw new Error('浏览器仅支持 chrome、msedge、chromium。');
  const cdpUrl = env.BROWSER_CDP_URL?.trim() || undefined;
  if (cdpUrl) {
    let parsed: URL;
    try {
      parsed = new URL(cdpUrl);
    } catch {
      throw new Error('BROWSER_CDP_URL 必须是有效的云浏览器 CDP 地址。');
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      throw new Error('BROWSER_CDP_URL 仅支持 http、https、ws、wss 协议。');
    }
  }
  const positive = (key: string, fallback: number) => {
    const n = Number(env[key] || fallback);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${key} 必须为正整数。`);
    return n;
  };
  const loginPhone = env.LOGIN_PHONE?.trim();
  if (loginPhone && !/^1[3-9]\d{9}$/.test(loginPhone)) throw new Error('LOGIN_PHONE 必须为 11 位手机号。');
  return {
    baseUrl, browserChannel: browserChannel === 'chromium' ? undefined : browserChannel,
    cdpUrl, cdpConnectTimeoutMs: positive('BROWSER_CDP_CONNECT_TIMEOUT_MS', 15_000),
    downloadDir: path.resolve(env.DOWNLOAD_DIR || 'D:\\报备\\集团驳回'),
    stateDir: path.resolve(env.STATE_DIR || 'reports'),
    authDir: path.resolve(env.AUTH_DIR || '.runtime'), loginPhone,
    loginTimeoutMs: positive('LOGIN_TIMEOUT_MS', 600_000),
    pollIntervalMs: positive('RESULT_POLL_INTERVAL_MS', 15_000),
    pollTimeoutMs: positive('RESULT_POLL_TIMEOUT_MS', 1_800_000),
  };
}
export type Config = ReturnType<typeof loadConfig>;
