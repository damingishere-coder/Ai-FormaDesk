let token = "";
let sessionPromise: Promise<void> | null = null;

export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
const READ_TIMEOUT = 15_000;
const WRITE_TIMEOUT = 30_000;
const UPLOAD_TIMEOUT = 120_000;

export class ApiRequestError extends Error {
  reconciliation?: unknown;
  reconciled = false;
  constructor(message: string, public outcomeUnknown = false) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  { signal, timeoutMs = READ_TIMEOUT }: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const write = !["GET", "HEAD"].includes(init.method || "GET");
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch("/api" + url, { ...init, signal: controller.signal });
    if (response.status === 401) {
      if (url === "/session") throw new ApiRequestError("无法建立后台会话，请重新加载工作台。");
      token = "";
      try { await initSession(); } catch { /* Never replay the original write. */ }
      throw new ApiRequestError("后台会话已失效，请重新加载当前项目后再操作。");
    }
    let value: T & { error?: string };
    try {
      value = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ApiRequestError("后台返回了无法读取的响应。", write && (response.ok || response.status >= 500));
    }
    if (!response.ok)
      throw new ApiRequestError(value?.error || `请求失败（${response.status}）`, write && response.status >= 500);
    return value;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(
      timedOut ? "请求超时" : controller.signal.aborted ? "请求已中止" : "无法连接后台，请检查工作台是否运行。",
      write,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function initSession() {
  if (!sessionPromise)
    sessionPromise = fetchJson<{ token: string }>("/session", { method: "GET" })
      .then((value) => {
        if (typeof value.token !== "string" || !value.token)
          throw new ApiRequestError("无法建立后台会话，请重新加载工作台。");
        token = value.token;
      })
      .finally(() => (sessionPromise = null));
  return sessionPromise;
}

// A lost write response cannot prove failure: reconcile with reads, never resend.
async function reconcileWrite(url: string, error: ApiRequestError) {
  try {
    const project = url.match(/^\/projects\/([^/?]+)/);
    const job = url.match(/^\/jobs\/([^/?]+)/);
    let read = project ? `/projects/${project[1]}/scene` : "/projects";
    if (job) {
      const value = await api<{ projectId: string }>(`/jobs/${job[1]}`);
      read = `/projects/${value.projectId}/scene`;
    } else if (url.startsWith("/health/")) read = "/health";
    else if (url.startsWith("/blender/")) read = "/blender/status";
    error.reconciliation = await api(read);
    error.reconciled = true;
    error.message += "；已核对最新状态，请确认结果后再操作。";
  } catch {
    error.message += "；请求可能已被后台接受，暂时无法核对，请重新加载项目后确认，勿重复提交。";
  }
}

async function request<T>(url: string, init: RequestInit, options: RequestOptions) {
  if (options.signal?.aborted) throw new ApiRequestError("请求已中止");
  if (!token) await initSession();
  if (options.signal?.aborted) throw new ApiRequestError("请求已中止");
  try {
    return await fetchJson<T>(url, {
      ...init,
      headers: { ...init.headers, "X-Forma-Session": token },
    }, options);
  } catch (error) {
    if (error instanceof ApiRequestError && error.outcomeUnknown)
      await reconcileWrite(url, error);
    throw error;
  }
}

export async function api<T = any>(
  url: string,
  body?: unknown,
  method?: string,
  options: RequestOptions = {},
): Promise<T> {
  const verb = (method || (body === undefined ? "GET" : "POST")).toUpperCase();
  return request<T>(url, {
    method: verb,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, {
    timeoutMs: ["GET", "HEAD"].includes(verb) ? READ_TIMEOUT : url === "/health/recheck" ? 120_000 : WRITE_TIMEOUT,
    ...options,
  });
}

export async function uploadAttachment<T>(pid: string, file: File, options: RequestOptions = {}): Promise<T> {
  return request<T>(`/projects/${pid}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  }, { timeoutMs: UPLOAD_TIMEOUT, ...options });
}

export async function uploadVideoFile(pid: string, id: string, blob: Blob, options: RequestOptions = {}) {
  return request<any>(`/projects/${pid}/videos/${id}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
  }, { timeoutMs: UPLOAD_TIMEOUT, ...options });
}
