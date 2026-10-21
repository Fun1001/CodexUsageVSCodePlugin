import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

export type AuthErrorKind = 'missing' | 'invalid';

export class AuthLoadError extends Error {
  constructor(
    public readonly kind: AuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AuthLoadError';
  }
}

export function authFilePath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/** 只读解析 ~/.codex/auth.json，绝不写回。token 不出本函数以外的内存。 */
export async function loadCodexCredentials(): Promise<CodexCredentials> {
  const file = authFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new AuthLoadError('missing', '未找到 Codex 凭证文件（请先登录 Codex）');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthLoadError('invalid', 'Codex 凭证文件不是合法 JSON');
  }

  const tokens = (parsed as { tokens?: unknown }).tokens;
  const accessToken = (tokens as { access_token?: unknown } | undefined)?.access_token;
  const accountId = (tokens as { account_id?: unknown } | undefined)?.account_id;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new AuthLoadError('invalid', 'Codex 凭证中缺少 access_token');
  }
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new AuthLoadError('invalid', 'Codex 凭证中缺少 account_id');
  }
  return { accessToken, accountId };
}
