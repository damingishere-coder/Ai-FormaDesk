import type { Job } from "./types";
export const stages = [
  "等待执行",
  "创作脚本",
  "Blender 建模",
  "生成基础预览",
  "保存作品",
  "加载预览",
];
export function stageIndex(stage: string) {
  if (/排队/.test(stage)) return 0;
  if (/脚本/.test(stage)) return 1;
  if (/识别|三视图/.test(stage)) return 1;
  if (/执行建模/.test(stage)) return 2;
  if (/验证|校验|生成.*预览|预览细节/.test(stage)) return /已完成/.test(stage) ? 5 : 3;
  if (/检查|材质|纹理|贴图|压缩|布光|烘焙/.test(stage)) return 3;
  if (/保存/.test(stage)) return 4;
  if (/完成/.test(stage)) return 5;
  return 0;
}
export function estimateJob(job: Job, history: Job[]) {
  const samples = history
    .filter(
      (j) =>
        j.type === job.type &&
        j.status === "succeeded" &&
        j.id !== job.id &&
        j.events?.length,
    )
    .slice(-20);
  const index = job.stageIndex ?? stageIndex(job.stage);
  if (samples.length < 5)
    return { low: 120, high: 300, source: "initial" as const };
  const durations = samples
    .map((j) => {
      const start = j.events!.find(
        (e) => (e.index ?? stageIndex(e.stage)) >= Math.max(1, index),
      );
      return start
        ? Math.max(1, (Date.parse(j.updatedAt) - Date.parse(start.at)) / 1000)
        : 0;
    })
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (durations.length < 5)
    return { low: 120, high: 300, source: "initial" as const };
  return {
    low: durations[Math.floor(durations.length * 0.25)],
    high: durations[
      Math.min(durations.length - 1, Math.floor(durations.length * 0.75))
    ],
    source: "history" as const,
  };
}
export function etaText(job: Job, time: number) {
  if (job.status === "queued") return "排队中 · 执行后估计剩余时间";
  if (["failed", "cancelled", "succeeded"].includes(job.status)) {
    if (job.type === "preview") return job.stage;
    return job.status === "succeeded" ? "作品已保存" : job.stage;
  }
  if (job.type === "preview") return "基础预览已保存 · 正在补充表面细节";
  if (job.visual) return "多阶段生成中 · 实际耗时以各阶段记录为准";
  const estimate = job.estimate || { low: 120, high: 300, source: "initial" };
  const start =
    estimate.source === "history"
      ? job.events?.at(-1)?.at
      : job.events?.find((e) => e.stage !== "排队等待")?.at;
  const elapsed = Math.max(
    0,
    (time - Date.parse(start || job.createdAt)) / 1000,
  );
  if (elapsed > estimate.high) return "比预计耗时更久，仍在处理";
  if (estimate.source === "initial")
    return "参考耗时约 2～5 分钟，复杂模型可能更久";
  return `预计剩余 ${Math.max(1, Math.ceil((estimate.low - elapsed) / 60))}～${Math.max(1, Math.ceil((estimate.high - elapsed) / 60))} 分钟 · 本机历史估计`;
}
export function connectionText(job: Job, disconnected: boolean, time: number) {
  return disconnected && ["queued", "running"].includes(job.status)
    ? "正在重新连接 · 正在核实任务状态"
    : etaText(job, time);
}
export const elapsedText = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
