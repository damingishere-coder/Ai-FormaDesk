import { Check, Loader2, Square, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Job } from "./types";
import { elapsedText, connectionText, stageIndex, stages } from "./progress";
export function BuildProgress({
  job,
  preview,
  disconnected,
  onRetry,
  onReload,
  onStop,
  onChat,
}: {
  job: Job;
  preview: "loading" | "ready" | "failed";
  disconnected: boolean;
  onRetry: () => void;
  onReload: () => void;
  onStop: () => void;
  onChat: () => void;
}) {
  const [time, setTime] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const terminal = ["succeeded", "failed", "cancelled"].includes(job.status),
    failed = ["failed", "cancelled"].includes(job.status);
  const index = job.stageIndex ?? stageIndex(job.stage),
    current = job.status === "succeeded" ? 5 : index;
  return (
    <section
      className="build-progress"
      aria-label="建模流程"
      aria-live="polite"
    >
      <div className="build-heading">
        <div>
          <small>{job.visual ? "从图片到可编辑模型" : "从想法到作品"}</small>
          <h3>{job.title || "正在实现你的方案"}</h3>
        </div>
        <button className="button" onClick={onChat}>
          查看对话
        </button>
      </div>
      <div className="build-time">
        <strong>
          {elapsedText(
            Math.max(
              0,
              ((terminal ? Date.parse(job.updatedAt) : time) -
                Date.parse(job.createdAt)) /
                1000,
            ),
          )}
        </strong>
        <span>
          已用时间
          <br />
          {connectionText(job, disconnected, time)}
        </span>
      </div>
      <small className="queue-time">
        排队用时{" "}
        {elapsedText(
          Math.max(
            0,
            ((job.events?.find((e) => e.stage !== "排队等待")
              ? Date.parse(job.events.find((e) => e.stage !== "排队等待")!.at)
              : time) -
              Date.parse(job.createdAt)) /
              1000,
          ),
        )}
      </small>
      <ol className="build-stages">
        {(job.visual ? ["等待执行", "三视图与脚本", "Blender 建模", "材质与导出", "保存作品", "加载预览"] : stages).map((label, i) => {
          const done =
            i < current ||
            (i === 5 && job.status === "succeeded" && preview === "ready");
          const active = i === current && !done;
          return (
            <li
              key={label}
              className={
                done
                  ? "done"
                  : active
                    ? failed || (i === 5 && preview === "failed")
                      ? "failed"
                      : "active"
                    : ""
              }
            >
              <span>
                {done ? (
                  <Check size={15} />
                ) : active && !failed ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  i + 1
                )}
              </span>
              <b>{label}</b>
            </li>
          );
        })}
      </ol>
      <div className="build-detail">
        <h4>
          {job.type === "preview" ? job.stage : job.status === "succeeded"
            ? preview === "ready"
              ? "作品已就绪"
              : preview === "failed"
                ? "作品已保存，预览加载失败"
                : "作品已保存，正在加载预览"
            : job.stage}
        </h4>
        <p>
          {job.type === "preview"
            ? failed ? "模型和基础预览已保留，可以继续生成细节。" : "基础预览可查看和编辑。正在补充表面凹凸等细节，原始模型保持不变。"
            : failed
            ? job.error
            : job.visual
              ? "三视图只生成一轮，随后直接建模。模型效果由你查看预览判断。"
            : current === 1
              ? "正在根据方案和参考图编写建模脚本。"
              : current === 2
                ? "Blender 正在创建形状、材质和场景。"
                : current === 3
                  ? "校验文件并导出基础材质，模型外观由你查看判断。"
                  : current === 4
                    ? "正在保存新版本，已有作品会保留。"
                    : "你可以查看对话，也可以收起窗口等待。"}
        </p>
      </div>
      {!!job.visual?.steps?.length && <details open className="build-step-times"><summary>各阶段实际用时</summary>{job.visual.steps.map((step, i) => <p key={`${step.id}-${i}`}><span>{step.label}</span> · {elapsedText(Math.max(0, (Date.parse(step.endedAt || (terminal ? job.updatedAt : new Date(time).toISOString())) - Date.parse(step.startedAt)) / 1000))} · {step.status === "running" ? (terminal ? "已中断" : "处理中") : step.status === "failed" ? "未完成" : "已完成"}</p>)}</details>}
      {!terminal && (job.message || job.visual?.activity) && <small>{job.message || job.visual?.activity}</small>}
      {!!job.events?.some((e) => e.error) && (
        <details>
          <summary>查看修复记录</summary>
          {job.events
            .filter((e) => e.error)
            .map((e, i) => (
              <p key={i}>{e.error}</p>
            ))}
        </details>
      )}
      <div className="build-actions">
        {!terminal && (
          <button className="button" onClick={onStop}>
            <Square size={14} />
            停止任务
          </button>
        )}
        {failed && (
          <button className="button" onClick={onRetry}>
            <RotateCw size={14} />
            {job.type === "preview" ? "继续生成预览细节" : job.recoverablePreview || (index === 3 && !job.visual) ? "继续生成预览" : "重试建模"}
          </button>
        )}
        {!!job.savedBlendArtifactId && <a className="button" href={`/api/artifacts/${job.savedBlendArtifactId}`} download="已生成模型.blend">下载已生成模型</a>}
        {job.status === "succeeded" && preview === "failed" && (
          <button className="button" onClick={onReload}>
            重新加载预览
          </button>
        )}
      </div>
    </section>
  );
}
