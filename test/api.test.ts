import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ExamService } from "../src/service.ts";
import { createServer } from "../src/server.ts";
import { openDb } from "../src/db.ts";
import type http from "node:http";

let server: http.Server;
let base: string;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

before(async () => {
  server = createServer(new ExamService(openDb(":memory:")));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("HTTP API 全流程：建卷→发布→答案键→提交→报告→更正→重评", async () => {
  let r = await api("POST", "/api/exams", {
    title: "API 测验",
    questions: [
      { seq: 1, type: "single", points: 2, options: ["A", "B"] },
      { seq: 2, type: "multi", points: 4, options: ["A", "B", "C"] },
      { seq: 3, type: "number", points: 3 },
    ],
  });
  assert.equal(r.status, 201);
  const id = r.json.id;

  r = await api("POST", `/api/exams/${id}/publish`);
  assert.equal(r.json.status, "published");

  r = await api("POST", `/api/exams/${id}/answer-keys`, { answers: { "1": "A", "2": ["A", "B"], "3": { value: 10, tolerance: 0.5 } } });
  assert.equal(r.json.version, 1);

  r = await api("POST", `/api/exams/${id}/submissions`, { code: "A01", student: "测试", keyVersion: 1, answers: { "1": "A", "2": ["A"], "3": 10.4 } });
  assert.equal(r.status, 201);
  assert.equal(r.json.total, 7); // 2 + 2(漏选半分) + 3

  // 重复提交幂等
  r = await api("POST", `/api/exams/${id}/submissions`, { code: "A01", student: "测试", keyVersion: 1, answers: { "1": "A", "2": ["A"], "3": 10.4 } });
  assert.equal(r.json.duplicated, true);
  // 冲突
  r = await api("POST", `/api/exams/${id}/submissions`, { code: "A01", student: "测试", keyVersion: 1, answers: { "1": "B" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "CONFLICT");

  // 更正答案键并批量重评
  r = await api("POST", `/api/exams/${id}/answer-keys`, { answers: { "1": "B", "2": ["A", "B"], "3": { value: 10, tolerance: 0.5 } }, note: "第1题改B" });
  assert.equal(r.json.version, 2);
  r = await api("POST", `/api/exams/${id}/regrade`, { keyVersion: 2 });
  assert.equal(r.json.results[0].oldTotal, 7);
  assert.equal(r.json.results[0].newTotal, 5); // 0 + 2 + 3

  // 两版报告均可查询
  r = await api("GET", `/api/exams/${id}/reports/A01?keyVersion=1`);
  assert.equal(r.json.total, 7);
  r = await api("GET", `/api/exams/${id}/reports/A01?keyVersion=2`);
  assert.equal(r.json.total, 5);

  // 错误码
  r = await api("GET", "/api/exams/999");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
  r = await api("POST", `/api/exams/${id}/submissions`, { code: "A02", student: "x", keyVersion: 1, answers: { "3": "abc" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "INVALID_INPUT");
});
