import { useEffect, useState } from "react";
import { Box, Loader2, RefreshCw, Unplug } from "lucide-react";
import { api } from "./api";
import type { BlenderStatus } from "./blenderTypes";
import type { Job } from "./types";
import "./blender-link.css";
export function BlenderLink({
  pid,
  base,
  busy,
  onJob,
  onError,
  objectId,
}: {
  pid: string;
  objectId: string | null;
  base: string | null;
  busy: boolean;
  onJob: (job: Job) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<BlenderStatus>({
    installed: false,
    connected: false,
    state: "closed",
  });
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [image, setImage] = useState("");
  const [instruction, setInstruction] = useState("");
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api<BlenderStatus>("/blender/status")
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pid, base]);
  const linked = status.projectId === pid;
  async function action(name: string, sessionId?: string) {
    if (pending || busy) return;
    setPending(true);
    try {
      const result = await api(
        `/projects/${pid}/blender/${name}`,
        name === "recover"
          ? { sessionId }
          : name === "edit"
            ? { baseRevisionId: base, objectId, prompt: instruction }
            : name === "sync"
              ? { baseRevisionId: base }
              : {},
      );
      if (name === "sync" || name === "edit") {
        onJob(result);
        if (name === "edit") setInstruction("");
      } else setStatus(result);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="blender-link">
      <button
        className="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label="Blender 联动"
      >
        <Box size={16} />
        Blender {linked && status.connected && <span className="blender-dot" />}
      </button>
      {expanded && (
        <section className="blender-popover" aria-label="Blender 连接面板">
          <strong>Blender 联动</strong>
          <p>
            {!status.installed
              ? "尚未安装 Blender MCP"
              : linked
                ? status.connected
                  ? "已连接当前作品"
                  : status.state === "opening"
                    ? "正在启动 Blender…"
                    : "连接已中断"
                : status.projectId
                  ? "Blender 正关联另一个作品"
                  : "打开可编辑源文件，与工作台同步修改"}
          </p>
          {linked && status.baseRevisionId !== base && (
            <p className="blender-warning">
              网页版本已变化，Blender
              工作副本仍保留。请另存副本后断开，再打开当前版本。
            </p>
          )}
          {linked && status.error && (
            <p className="blender-warning">{status.error}</p>
          )}
          <div className="blender-link-actions">
            {!status.projectId &&
              status.recoverable
                ?.filter((r) => r.projectId === pid)
                .map((r) => (
                  <button
                    key={r.id}
                    className="button"
                    disabled={busy || pending}
                    onClick={() => void action("recover", r.id)}
                  >
                    恢复 Blender 窗口 ·{" "}
                    {new Date(r.disconnectedAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </button>
                ))}
            {!linked && (
              <button
                className="button"
                disabled={!base || busy || pending || !!status.projectId}
                onClick={() => void action("open")}
              >
                {pending ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Box size={16} />
                )}
                在 Blender 中打开
              </button>
            )}
            {linked && !status.connected && (
              <button
                className="button"
                disabled={busy || pending}
                onClick={() => void action("reconnect")}
              >
                重新连接并读取场景
              </button>
            )}
            {linked && (
              <button
                className="button"
                disabled={
                  busy ||
                  pending ||
                  !status.connected ||
                  status.baseRevisionId !== base
                }
                onClick={() => void action("sync")}
              >
                <RefreshCw size={16} />
                同步回工作台
              </button>
            )}
            {linked && status.connected && (
              <button
                className="button"
                disabled={busy || pending}
                onClick={() =>
                  setImage(
                    `/api/projects/${pid}/blender/screenshot?t=${Date.now()}`,
                  )
                }
              >
                查看 Blender 画面
              </button>
            )}
            {linked && (
              <button
                className="button"
                disabled={busy || pending}
                onClick={() => void action("disconnect")}
              >
                <Unplug size={16} />
                断开连接
              </button>
            )}
          </div>
          {linked && status.connected && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action("edit");
              }}
            >
              <label>
                调整选中部件
                <input
                  aria-label="Blender 局部调整"
                  placeholder={
                    objectId ? "例如：把头放大 10%" : "先在画布中选中一个部件"
                  }
                  disabled={!objectId || busy || pending}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={
                  !objectId ||
                  !instruction.trim() ||
                  busy ||
                  pending ||
                  status.baseRevisionId !== base
                }
              >
                执行调整并同步
              </button>
            </form>
          )}
          <small>
            网页里的变换和基础材质调整会同步到 Blender；在 Blender
            中手动编辑后，点击“同步回工作台”。断开连接会保留窗口。
          </small>
          {image && (
            <img
              src={image}
              alt="Blender 当前视口"
              onError={() => {
                setImage("");
                onError("无法获取 Blender 画面，请检查连接");
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
