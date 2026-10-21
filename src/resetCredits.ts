import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { randomUUID } from 'node:crypto';
import type { CodexCredentials } from './auth';
import { UsageFetchError } from './usageClient';

export interface ResetCredit {
  id: string;
  /** available / redeemed / ... */
  status: string;
  /** ISO 时间字符串；缺失为 null */
  expiresAt: string | null;
}

const LIST_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
const DEFAULT_TIMEOUT_MS = 10_000;

async function request(
  creds: CodexCredentials,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = new EnvHttpProxyAgent();
  let res;
  try {
    res = await undiciFetch(url, {
      dispatcher,
      method: init.method,
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'chatgpt-account-id': creds.accountId,
        'User-Agent': 'codex-cli',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
  return res;
}

function parseCredit(v: unknown): ResetCredit | null {
  if (typeof v !== 'object' || v === null) {
    return null;
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return null;
  }
  return {
    id: obj.id,
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    expiresAt: typeof obj.expires_at === 'string' ? obj.expires_at : null,
  };
}

/** 查询重置卡列表；字段缺失容错，永不抛解析异常。 */
export async function fetchResetCredits(
  creds: CodexCredentials,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ResetCredit[]> {
  const res = await request(creds, LIST_URL, { method: 'GET' }, timeoutMs);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UsageFetchError('parse', '响应不是合法 JSON');
  }
  const list = (body as { credits?: unknown } | null)?.credits;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map(parseCredit).filter((c): c is ResetCredit => c !== null);
}

/** 可用卡中选最早过期的一张（无过期时间的排最后）；无可用卡返回 null。 */
export function pickEarliestExpiring(credits: ResetCredit[]): ResetCredit | null {
  const available = credits.filter((c) => c.status === 'available');
  if (available.length === 0) {
    return null;
  }
  const time = (c: ResetCredit) =>
    c.expiresAt !== null ? Date.parse(c.expiresAt) : Number.POSITIVE_INFINITY;
  return available.reduce((a, b) => (time(a) <= time(b) ? a : b));
}

export function newRedeemRequestId(): string {
  return randomUUID();
}

/** 核销一张重置卡。成功无返回值；失败抛 UsageFetchError。 */
export async function consumeResetCredit(
  creds: CodexCredentials,
  creditId: string,
  requestId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await request(
    creds,
    CONSUME_URL,
    { method: 'POST', body: { credit_id: creditId, redeem_request_id: requestId } },
    timeoutMs,
  );
}
