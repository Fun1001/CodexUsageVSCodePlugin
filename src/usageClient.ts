import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { CodexCredentials } from './auth';

export interface UsageWindow {
  /** 已用百分比 0-100 */
  usedPercent: number;
  /** 剩余百分比 0-100 */
  remainingPercent: number;
  /** 重置时间（unix 秒） */
  resetAt: number;
  /** 窗口时长（秒） */
  windowSeconds: number | null;
}

export interface UsageData {
  planType: string | null;
  /** 5 小时窗；接口缺字段时为 null */
  primary: UsageWindow | null;
  /** 周窗；接口缺字段时为 null */
  secondary: UsageWindow | null;
  /** 重置卡可用次数；接口缺字段时为 null */
  resetCreditsAvailable: number | null;
  /** 数据获取时刻（unix 秒） */
  fetchedAt: number;
}

export type FetchErrorKind = 'auth' | 'network' | 'http' | 'parse';

export class UsageFetchError extends Error {
  constructor(
    public readonly kind: FetchErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'UsageFetchError';
  }
}

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TIMEOUT_MS = 10_000;

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseWindow(v: unknown, nowSec: number): UsageWindow | null {
  if (typeof v !== 'object' || v === null) {
    return null;
  }
  const obj = v as Record<string, unknown>;
  const used = asNumber(obj.used_percent);
  if (used === null) {
    return null;
  }
  const clamped = Math.min(100, Math.max(0, used));
  const resetAfter = asNumber(obj.reset_after_seconds);
  const resetAt = asNumber(obj.reset_at) ?? (resetAfter !== null ? nowSec + resetAfter : nowSec);
  return {
    usedPercent: clamped,
    remainingPercent: 100 - clamped,
    resetAt,
    windowSeconds: asNumber(obj.limit_window_seconds),
  };
}

/** 宽松容错解析：字段缺失降级为 null，永不抛异常。 */
export function parseUsageResponse(body: unknown, nowSec: number): UsageData {
  if (typeof body !== 'object' || body === null) {
    throw new UsageFetchError('parse', '响应不是 JSON 对象');
  }
  const root = body as Record<string, unknown>;
  const rateLimit = (root.rate_limit ?? {}) as Record<string, unknown>;
  const resetCredits = root.rate_limit_reset_credits as Record<string, unknown> | null | undefined;

  return {
    planType: typeof root.plan_type === 'string' ? root.plan_type : null,
    primary: parseWindow(rateLimit.primary_window, nowSec),
    secondary: parseWindow(rateLimit.secondary_window, nowSec),
    resetCreditsAvailable: resetCredits ? asNumber(resetCredits.available_count) : null,
    fetchedAt: nowSec,
  };
}

export async function fetchUsage(
  creds: CodexCredentials,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<UsageData> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // undici + EnvHttpProxyAgent：自动遵循 HTTP(S)_PROXY 环境变量（Node 原生 fetch 不会）
  const dispatcher = new EnvHttpProxyAgent();
  let res;
  try {
    res = await undiciFetch(USAGE_URL, {
      dispatcher,
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'chatgpt-account-id': creds.accountId,
        'User-Agent': 'codex-cli',
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new UsageFetchError(
      'network',
      err instanceof Error && err.name === 'AbortError' ? '请求超时' : '网络请求失败',
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageFetchError('auth', '凭证失效，请重新登录 Codex', res.status);
  }
  if (!res.ok) {
    throw new UsageFetchError('http', `接口返回 HTTP ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UsageFetchError('parse', '响应不是合法 JSON');
  }
  return parseUsageResponse(body, Math.floor(Date.now() / 1000));
}
