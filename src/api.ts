let token = "";
let sessionPromise: Promise<void> | null = null;
export async function initSession() {
  if (!sessionPromise)
    sessionPromise = fetch("/api/session")
      .then((r) => r.json())
      .then((v) => {
        token = v.token;
      })
      .finally(() => (sessionPromise = null));
  return sessionPromise;
}
export async function api<T = any>(
  url: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  if (!token) await initSession();
  const r = await fetch("/api" + url, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Forma-Session": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) {
    await initSession();
    throw new Error("后台已重新启动，请重新加载当前项目后再操作。");
  }
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || "请求失败");
  return v;
}

export async function uploadAttachment<T>(pid: string, file: File): Promise<T> {
  if (!token) await initSession();
  const r = await fetch(`/api/projects/${pid}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Forma-Session": token,
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || "上传失败");
  return v;
}

export async function uploadVideoFile(pid: string, id: string, blob: Blob) {
  if (!token) await initSession();
  const r = await fetch(`/api/projects/${pid}/videos/${id}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Forma-Session": token,
    },
    body: blob,
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || "视频上传失败");
  return v;
}
