import { useEffect, useRef, useState } from "react";
import { Box, Loader2, RefreshCw, Unplug } from "lucide-react";
import { api } from "./api";
import type { BlenderStatus } from "./blenderTypes";
import "./blender-link.css";
export function BlenderLink({
  pid,
  base,
  busy,
  onStartJob,
  onError,
  objectId,
}: {
  pid: string;
  objectId: string | null;
  base: string | null;
  busy: boolean;
  onStartJob: (endpoint: string, body: unknown) => Promise<boolean>;
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
  const [statusError, setStatusError] = useState("");
  const mounted = useRef(false), pendingLock = useRef(false), statusSequence = useRef(0);
  const context = useRef({ pid, base });
  context.current = { pid, base };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; statusSequence.current++; };
  }, []);
  async function refreshStatus(signal?: AbortSignal) {
    const sequence = ++statusSequence.current;
    try {
      const value = await api<BlenderStatus>("/blender/status", undefined, undefined, { signal });
      if (mounted.current && sequence === statusSequence.current) {
        setStatus(value);
        setStatusError("");
      }
    } catch (error) {
      if (mounted.current && sequence === statusSequence.current && !signal?.aborted) {
        setStatus(value => ({ ...value, connected: false }));
        setStatusError("连接状态已过期：" + (error as Error).message);
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try { await refreshStatus(controller.signal); }
      finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); statusSequence.current++; clearInterval(timer); };
  }, [pid, base]);
  const linked = status.projectId === pid;
  async function action(name: string, sessionId?: string) {
    if (pendingLock.current || busy) return;
    const expected = { pid, base };
    const validContext = () => mounted.current && context.current.pid === expected.pid && context.current.base === expected.base;
    pendingLock.current = true;
    setPending(true);
    try {
      const body = name === "recover" ? { sessionId } : name === "edit"
        ? { baseRevisionId: base, objectId, prompt: instruction }
        : name === "sync" ? { baseRevisionId: base } : {};
      if (name === "sync" || name === "edit") {
        const accepted = await onStartJob(`blender/${name}`, body);
        if (accepted && name === "edit" && validContext()) setInstruction("");
      } else {
        const result = await api<BlenderStatus>(`/projects/${pid}/blender/${name}`, body);
        if (validContext()) { statusSequence.current++; setStatus(result); setStatusError(""); }
      }
    } catch (error) {
      if (validContext()) onError((error as Error).message);
    } finally {
      pendingLock.current = false;
      if (mounted.current) setPending(false);
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
          {statusError && <p className="blender-warning" role="alert">{statusError}</p>}
          <p>
            {statusError ? "暂时无法确认 Blender 连接，请刷新后再同步。" : !status.installed
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
            {statusError && <button className="button" disabled={pending} onClick={() => { void refreshStatus(); }}>刷新连接状态</button>}
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
                disabled={!base || busy || pending || !!status.projectId || !!statusError}
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
