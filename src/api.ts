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
    headers: { "Content-Type": "application/json", "X-Forma-Session": token },
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
