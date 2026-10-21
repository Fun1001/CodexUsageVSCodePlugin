import * as vscode from 'vscode';
import { AuthLoadError, loadCodexCredentials } from './auth';
import { fetchUsage, UsageFetchError } from './usageClient';
import {
  consumeResetCredit,
  fetchResetCredits,
  newRedeemRequestId,
  pickEarliestExpiring,
  type ResetCredit,
} from './resetCredits';
import { CodexUsageStatusBar, StatusState } from './statusBar';

const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 600;

function configuredIntervalSec(): number {
  const v = vscode.workspace
    .getConfiguration('codexUsage')
    .get<number>('refreshInterval', DEFAULT_INTERVAL_SEC);
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, v));
}

function configuredFormat(): string {
  return vscode.workspace
    .getConfiguration('codexUsage')
    .get<string>('displayFormat', '5h {5h} 周 {week} 重置 {reset}');
}

export function activate(context: vscode.ExtensionContext): void {
  const state: StatusState = {
    data: null,
    stale: false,
    errorMessage: null,
    authFailed: false,
    loading: false,
    resetCardsFromList: null,
  };
  /** 最近一次成功查询的重置卡列表；null = 查询失败/未查询 */
  let creditsList: ResetCredit[] | null = null;

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;

  const bar = new CodexUsageStatusBar(() => {
    // 倒计时归零 → 触发一次刷新
    void refresh(false);
  }, configuredFormat);

  function restartPolling(): void {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    // 凭证失效时降频到上限，其余按配置间隔
    const intervalSec = state.authFailed ? MAX_INTERVAL_SEC : configuredIntervalSec();
    pollTimer = setInterval(() => {
      if (vscode.window.state.focused) {
        void refresh(false);
      }
    }, intervalSec * 1000);
  }

  async function refresh(manual: boolean): Promise<void> {
    if (refreshing) {
      return;
    }
    refreshing = true;
    state.loading = true;
    bar.update(state);
    try {
      // 每次刷新重新读凭证文件：Codex 重新登录/续期后无需重启扩展
      const creds = await loadCodexCredentials();
      // 卡列表与配额并行拉取；列表失败静默降级为 null（隐藏用卡入口），不影响主流程
      const creditsPromise = fetchResetCredits(creds).catch(() => null);
      state.data = await fetchUsage(creds);
      creditsList = await creditsPromise;
      state.resetCardsFromList =
        creditsList === null
          ? null
          : creditsList.filter((c) => c.status === 'available').length;
      state.stale = false;
      state.errorMessage = null;
      if (state.authFailed) {
        state.authFailed = false;
        restartPolling(); // 恢复正常轮询间隔
      }
    } catch (err) {
      if (err instanceof AuthLoadError || (err instanceof UsageFetchError && err.kind === 'auth')) {
        const wasAuthFailed = state.authFailed;
        state.authFailed = true;
        state.errorMessage = err instanceof Error ? err.message : '凭证失效';
        if (!wasAuthFailed) {
          restartPolling(); // 降频
        }
      } else {
        state.errorMessage = err instanceof Error ? err.message : '未知错误';
      }
      // 有旧数据则保留并标记过期；无数据则显示不可用
      state.stale = state.data !== null;
      if (manual && state.data === null && !state.authFailed) {
        // 手动刷新且无任何可展示数据时才打扰用户一次
        void vscode.window.showWarningMessage(`Codex 配额获取失败：${state.errorMessage}`);
      }
    } finally {
      state.loading = false;
      refreshing = false;
      bar.update(state);
    }
  }

  async function useResetCard(): Promise<void> {
    const card = creditsList !== null ? pickEarliestExpiring(creditsList) : null;
    if (card === null) {
      void vscode.window.showWarningMessage('当前没有可用的重置卡');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      '将消耗 1 张重置卡：5 小时窗口与每周配额将同时重置，且每周重置日会改变。确定继续吗？',
      { modal: true },
      '确认使用',
    );
    if (choice !== '确认使用') {
      return; // 取消/关闭：无副作用
    }
    const requestId = newRedeemRequestId(); // 每次确认生成一次，重试复用，防重复核销
    try {
      const creds = await loadCodexCredentials();
      await consumeResetCredit(creds, card.id, requestId);
      void vscode.window.showInformationMessage('重置卡已使用，配额已重置');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      void vscode.window.showWarningMessage(`重置卡使用失败：${msg}`);
    }
    // 成功刷新拿到重置后数据；失败也刷新以对齐服务端真实状态
    await refresh(false);
  }

  context.subscriptions.push(
    bar,
    vscode.commands.registerCommand('codexUsage.refresh', () => refresh(true)),
    vscode.commands.registerCommand('codexUsage.useResetCard', () => useResetCard()),
    vscode.window.onDidChangeWindowState((winState) => {
      if (winState.focused) {
        // 聚焦时立即补一次刷新（失焦期间轮询暂停）
        void refresh(false);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codexUsage')) {
        restartPolling();
        bar.update(state);
      }
    }),
    { dispose: () => pollTimer !== undefined && clearInterval(pollTimer) },
  );

  bar.show();
  bar.startTick(state);
  restartPolling();
  void refresh(false); // 启动即刷新一次
}

export function deactivate(): void {
  // 定时器与状态栏均通过 subscriptions dispose
}
