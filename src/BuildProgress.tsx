import { Check, Loader2, Square, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Job } from "./types";
import { elapsedText, etaText, stageIndex, stages } from "./progress";
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
          <small>从想法到作品</small>
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
          {disconnected
            ? "正在重新连接 · 正在核实任务状态"
            : etaText(job, time)}
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
        {stages.map((label, i) => {
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
          {job.status === "succeeded"
            ? preview === "ready"
              ? "作品已就绪"
              : preview === "failed"
                ? "作品已保存，预览加载失败"
                : "作品已保存，正在加载预览"
            : job.stage}
        </h4>
        <p>
          {failed
            ? job.error
            : current === 1
              ? "正在根据方案和参考图编写建模脚本。"
              : current === 2
                ? "Blender 正在创建形状、材质和场景。"
                : current === 3
                  ? "检查模型结构和可编辑文件。"
                  : current === 4
                    ? "正在保存新版本，已有作品会保留。"
                    : "你可以查看对话，也可以收起窗口等待。"}
        </p>
      </div>
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
            重试建模
          </button>
        )}
        {job.status === "succeeded" && preview === "failed" && (
          <button className="button" onClick={onReload}>
            重新加载预览
          </button>
        )}
      </div>
    </section>
  );
}
