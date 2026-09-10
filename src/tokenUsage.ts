import type { Project } from "./types";

export function formatTokenCount(value: number) {
  const count = Math.max(0, Math.floor(value));
  // Promote near-boundary values instead of displaying 1000K.
  if (count >= 999950) return `${Number((count / 1000000).toFixed(1))}M`;
  if (count >= 1000) return `${Number((count / 1000).toFixed(1))}K`;
  return String(count);
}

export function tokenUsageLabel(usage: Project["tokenUsage"]) {
  if (!usage) return "Token 未统计";
  return `${usage.partial ? "≥" : ""}${formatTokenCount(usage.totalTokens)} tokens`;
}

export function tokenUsageTitle(usage: Project["tokenUsage"]) {
  if (!usage) return "暂无可靠的 Codex 用量记录；之后的调用会自动累计。";
  return `${usage.partial ? "已记录至少" : "累计"} ${usage.totalTokens.toLocaleString("zh-CN")} 个 Codex token（输入与输出，包含已上报的推理用量）。${usage.partial ? "历史或部分调用记录不完整。" : ""}不代表订阅额度百分比，也不包含图像工具单独计费的用量。`;
}
