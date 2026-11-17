import path from 'node:path';

export type AppConfig = {
  baseUrl: string;
  profileDir: string;
  authStatePath: string;
  downloadDir: string;
  stateDir: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  browserChannel?: 'msedge' | 'chrome';
  filingRootDir: string;
  pendingDir: string;
  completedDir: string;
  reportResultDir: string;
  serviceHost: string;
  servicePort: number;
  serviceToken?: string;
  remoteLogUrl?: string;
  remoteLogToken?: string;
  remoteLogTimeoutMs: number;
  wechatWorkWebhookUrl?: string;
  loginPhone?: string;
};

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数，当前值为：${value}`);
  }
  return parsed;
}

function resolveFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function loadConfig(env = process.env): AppConfig {
  const baseUrl = env.MOBILE_PORTAL_BASE_URL ?? 'https://wap.hn.10086.cn/ismsports/';
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') throw new Error('only HTTPS is allowed');
  } catch {
    throw new Error(`MOBILE_PORTAL_BASE_URL 必须是有效 HTTPS 地址，当前值为：${baseUrl}`);
  }

  // 默认使用本机安装的 Google Chrome；只有明确设置时才切换到其他受支持浏览器。
  const browserChannel = env.BROWSER_CHANNEL?.trim() || 'chrome';
  if (browserChannel && browserChannel !== 'msedge' && browserChannel !== 'chrome') {
    throw new Error('BROWSER_CHANNEL 仅支持 msedge 或 chrome。');
  }

  const filingRootDir = resolveFromCwd(env.FILING_ROOT_DIR ?? 'D:\\报备');
  const pendingDir = resolveFromCwd(env.PENDING_DIR ?? path.join(filingRootDir, '待报备'));
  const completedDir = resolveFromCwd(env.COMPLETED_DIR ?? path.join(filingRootDir, '已经报备'));
  const reportResultDir = resolveFromCwd(env.REPORT_RESULT_DIR ?? env.SEDP_DIR ?? path.join(filingRootDir, '报备结果资料'));
  const remoteLogUrl = env.REMOTE_LOG_URL?.trim() || undefined;
  if (remoteLogUrl) {
    try {
      const parsed = new URL(remoteLogUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('only HTTP(S) is allowed');
    } catch {
      throw new Error(`REMOTE_LOG_URL 必须是有效的 HTTP(S) 地址，当前值为：${remoteLogUrl}`);
    }
  }
  const wechatWorkWebhookUrl = env.WECHAT_WORK_WEBHOOK_URL?.trim() || undefined;
  if (wechatWorkWebhookUrl) {
    try {
      const parsed = new URL(wechatWorkWebhookUrl);
      if (parsed.protocol !== 'https:') throw new Error('only HTTPS is allowed');
      if (parsed.hostname !== 'qyapi.weixin.qq.com') throw new Error('unexpected host');
    } catch {
      throw new Error(`WECHAT_WORK_WEBHOOK_URL 必须是有效的企业微信 HTTPS 机器人地址，当前值为：${wechatWorkWebhookUrl}`);
    }
  }
  const loginPhone = env.LOGIN_PHONE?.trim() || undefined;
  if (loginPhone && !/^1[3-9]\d{9}$/.test(loginPhone)) {
    throw new Error('LOGIN_PHONE 必须是以 1 开头的 11 位手机号。');
  }

  // 浏览器运行配置与登录凭据分别保存：浏览器配置损坏时可换用新目录，
  // 不会丢失登录状态；WorkBuddy 升级/重装也不会影响二者。
  const runtimeDir = path.join(filingRootDir, '运行状态');
  const profileDir = resolveFromCwd(env.PLAYWRIGHT_PROFILE_DIR ?? path.join(runtimeDir, 'Chrome自动化会话'));

  return {
    baseUrl,
    profileDir,
    authStatePath: resolveFromCwd(env.PLAYWRIGHT_AUTH_STATE_PATH ?? path.join(runtimeDir, 'auth-state.json')),
    downloadDir: resolveFromCwd(env.DOWNLOAD_DIR ?? 'downloads'),
    stateDir: resolveFromCwd(env.STATE_DIR ?? 'reports'),
    pollIntervalMs: positiveInt(env.RESULT_POLL_INTERVAL_MS, 15_000, 'RESULT_POLL_INTERVAL_MS'),
    pollTimeoutMs: positiveInt(env.RESULT_POLL_TIMEOUT_MS, 1_800_000, 'RESULT_POLL_TIMEOUT_MS'),
    browserChannel: browserChannel as AppConfig['browserChannel'],
    filingRootDir,
    pendingDir,
    completedDir,
    reportResultDir,
    serviceHost: env.SERVICE_HOST ?? '127.0.0.1',
    servicePort: positiveInt(env.SERVICE_PORT, 8787, 'SERVICE_PORT'),
    serviceToken: env.SERVICE_TOKEN?.trim() || undefined,
    remoteLogUrl,
    remoteLogToken: env.REMOTE_LOG_TOKEN?.trim() || undefined,
    remoteLogTimeoutMs: positiveInt(env.REMOTE_LOG_TIMEOUT_MS, 10_000, 'REMOTE_LOG_TIMEOUT_MS'),
    wechatWorkWebhookUrl,
    loginPhone,
  };
}
