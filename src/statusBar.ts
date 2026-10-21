import * as vscode from 'vscode';
import type { UsageData, UsageWindow } from './usageClient';

export interface StatusState {
  /** 上次成功获取的数据；从未成功为 null */
  data: UsageData | null;
  /** 有缓存数据但最近一次刷新失败 */
  stale: boolean;
  /** 最近一次失败原因（用户可读，不含凭证） */
  errorMessage: string | null;
  /** 凭证失效（401/403/凭证文件缺失） */
  authFailed: boolean;
  /** 正在请求中 */
  loading: boolean;
  /** 重置卡列表查到的可用张数；列表查询失败为 null（此时隐藏用卡入口） */
  resetCardsFromList: number | null;
}

function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) {
    return `${d}d${h}h`;
  }
  if (h > 0) {
    return `${h}h${m}m`;
  }
  if (m > 0) {
    return `${m}m${s}s`;
  }
  return `${s}s`;
}

function formatClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function windowLine(label: string, w: UsageWindow | null): string {
  if (!w) {
    return `- ${label}：N/A`;
  }
  return `- ${label}：剩余 **${w.remainingPercent}%**（已用 ${w.usedPercent}%，重置于 ${formatClock(w.resetAt)}）`;
}

export class CodexUsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private resetFired = false;

  constructor(
    private readonly onResetReached: () => void,
    private readonly getFormat: () => string,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codexUsage.refresh';
  }

  show(): void {
    this.item.show();
  }

  /** 每次刷新后调用：重置倒计时应答并立即渲染。 */
  update(state: StatusState): void {
    this.resetFired = false;
    this.render(state);
  }

  /** 启动本地 1s 倒计时 tick（不打网络）。 */
  startTick(state: StatusState): void {
    this.stopTick();
    this.tickTimer = setInterval(() => this.onTick(state), 1000);
  }

  stopTick(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private onTick(state: StatusState): void {
    const nextReset = this.nextResetAt(state.data);
    if (nextReset !== null && !this.resetFired) {
      const remain = nextReset - Date.now() / 1000;
      if (remain <= 0) {
        this.resetFired = true; // 只触发一次，等待刷新后 update() 复位
        this.onResetReached();
      }
    }
    this.render(state);
  }

  private nextResetAt(data: UsageData | null): number | null {
    if (!data) {
      return null;
    }
    const candidates = [data.primary?.resetAt, data.secondary?.resetAt].filter(
      (v): v is number => typeof v === 'number',
    );
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  private render(state: StatusState): void {
    this.item.text = this.buildText(state);
    this.item.tooltip = this.buildTooltip(state);
  }

  private buildText(state: StatusState): string {
    const prefix = state.loading ? '$(sync~spin) ' : '';
    if (state.authFailed) {
      return `${prefix}$(warning) Codex: 请重新登录`;
    }
    if (!state.data) {
      return `${prefix}$(warning) Codex: 数据不可用`;
    }
    const { primary, secondary } = state.data;
    const nextReset = this.nextResetAt(state.data);
    const resetText =
      nextReset !== null ? formatDuration(nextReset - Date.now() / 1000) : 'N/A';
    const staleMark = state.stale ? '*' : '';
    const text = this.getFormat()
      .replace('{5h}', primary ? `${primary.remainingPercent}%` : 'N/A')
      .replace('{week}', secondary ? `${secondary.remainingPercent}%` : 'N/A')
      .replace('{reset}', resetText)
      .replace(
        '{credits}',
        state.data.resetCreditsAvailable !== null
          ? String(state.data.resetCreditsAvailable)
          : 'N/A',
      );
    return `${prefix}$(pulse) ${text}${staleMark}`;
  }

  private buildTooltip(state: StatusState): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true; // 需要执行 command: 链接（使用重置卡入口）
    md.appendMarkdown('**Codex 配额**\n\n');
    if (state.data) {
      const cardCount = state.resetCardsFromList ?? state.data.resetCreditsAvailable;
      md.appendMarkdown(`- 套餐：${state.data.planType ?? '未知'}\n`);
      md.appendMarkdown(windowLine('5 小时窗口', state.data.primary) + '\n');
      md.appendMarkdown(windowLine('每周窗口', state.data.secondary) + '\n');
      md.appendMarkdown(
        `- 重置卡：${cardCount !== null ? `${cardCount} 张可用` : 'N/A'}\n`,
      );
      md.appendMarkdown(
        `- 上次刷新：${formatClock(state.data.fetchedAt)}${state.stale ? '（此后刷新失败，数据为缓存）' : ''}\n`,
      );
    }
    // 仅当列表查询成功且有可用卡时显示入口（查询失败降级隐藏）
    if (state.resetCardsFromList !== null && state.resetCardsFromList > 0) {
      md.appendMarkdown(
        `\n[使用重置卡 (×${state.resetCardsFromList})](command:codexUsage.useResetCard)\n`,
      );
    }
    if (state.authFailed) {
      md.appendMarkdown('\n$(warning) 凭证失效或未登录，请重新登录 Codex 后点击刷新。\n');
    } else if (state.errorMessage) {
      md.appendMarkdown(`\n$(warning) 最近刷新失败：${state.errorMessage}\n`);
    }
    md.appendMarkdown('\n点击立即刷新');
    return md;
  }

  dispose(): void {
    this.stopTick();
    this.item.dispose();
  }
}
