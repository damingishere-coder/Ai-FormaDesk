// Static Vite only: never import the backend or proxy to a user's workbench.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.FORMA_MOCK_PORT || 19143);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8765, 5173].includes(port))
  throw new Error("FORMA_MOCK_PORT 必须是独立测试端口，不能使用 8765/5173");

const server = await createServer({
  configFile: false,
  plugins: [react(), {
    name: "forma-mock-api-boundary",
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!/^\/api(?:\/|\?|$)/.test(request.url || "")) return next();
        // This remains a hard boundary even if a spec accidentally calls
        // route.continue() and bypasses the Playwright fixture's fallback.
        response.statusCode = 599;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("X-Forma-Mock-Guard", "unmocked-api");
        response.end(JSON.stringify({ error: "未 mock 的 API 请求已拒绝；测试服务没有后台代理" }));
      });
    },
  }],
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {} },
});
await server.listen();
console.log(`FORMA_MOCK_WEB_READY http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => { await server.close(); process.exit(0); });
