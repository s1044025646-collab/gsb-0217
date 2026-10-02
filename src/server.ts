import http from "node:http";
import { ExamService } from "./service.ts";
import { openDb, defaultDbPath } from "./db.ts";
import { ApiError } from "./errors.ts";

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try { return JSON.parse(text); } catch { throw new ApiError("INVALID_INPUT", "请求体不是合法 JSON"); }
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

export function createServer(service: ExamService): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = url.pathname.match(/^\/api\/exams(?:\/(\d+)(?:\/(publish|answer-keys|submissions|reports|regrade)(?:\/([^/]+))?)?)?$/);
      const method = req.method ?? "GET";

      if (url.pathname === "/api/health" && method === "GET") return send(res, 200, { ok: true });
      if (!m) throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`);

      const examId = m[1] ? Number(m[1]) : undefined;
      const sub = m[2];
      const extra = m[3] ? decodeURIComponent(m[3]) : undefined;

      if (method === "POST" && examId === undefined) {
        return send(res, 201, service.createExam(await readBody(req)));
      }
      if (examId === undefined) throw new ApiError("NOT_FOUND", "路由不存在");
      if (method === "GET" && !sub) return send(res, 200, service.getExam(examId));
      if (method === "POST" && sub === "publish") return send(res, 200, service.publishExam(examId));
      if (method === "POST" && sub === "answer-keys") return send(res, 201, service.addAnswerKey(examId, await readBody(req)));
      if (method === "GET" && sub === "answer-keys") return send(res, 200, service.listAnswerKeys(examId));
      if (method === "POST" && sub === "submissions") return send(res, 201, service.submit(examId, await readBody(req)));
      if (method === "GET" && sub === "reports" && !extra) {
        const v = url.searchParams.get("keyVersion");
        return send(res, 200, service.listReports(examId, v ? Number(v) : undefined));
      }
      if (method === "GET" && sub === "reports" && extra) {
        const v = url.searchParams.get("keyVersion");
        return send(res, 200, service.getReport(examId, extra, v ? Number(v) : undefined));
      }
      if (method === "POST" && sub === "regrade") return send(res, 200, service.regrade(examId, await readBody(req)));
      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      return send(res, 500, { error: { code: "INTERNAL", message: "服务器内部错误" } });
    }
  });
}

// 直接运行（node dist/server.js）时启动服务；被测试 import 时不启动。
const isMain = process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/")).href;
if (isMain) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0); // 默认 0 = 空闲端口
  const dbPath = process.argv.includes("--db")
    ? process.argv[process.argv.indexOf("--db") + 1]
    : defaultDbPath();
  const service = new ExamService(openDb(dbPath));
  const server = createServer(service);
  server.listen(port, () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`判分服务已启动: http://localhost:${p}  (数据库: ${dbPath})`);
  });
}
