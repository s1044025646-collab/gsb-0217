import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExamService } from "../src/service.ts";
import { openDb } from "../src/db.ts";
import { ApiError } from "../src/errors.ts";

function makeService(dbPath = ":memory:") {
  const svc = new ExamService(openDb(dbPath));
  const exam = svc.createExam({
    title: "混合题型测验",
    questions: [
      { seq: 1, type: "single", points: 2, options: ["A", "B", "C", "D"] },
      { seq: 2, type: "multi", points: 4, options: ["A", "B", "C", "D"] },
      { seq: 3, type: "number", points: 3 },
    ],
  });
  svc.publishExam(exam.id);
  svc.addAnswerKey(exam.id, {
    answers: { "1": "B", "2": ["A", "C"], "3": { value: 3.14, tolerance: 0.01 } },
    note: "初版答案",
  });
  return { svc, examId: exam.id };
}

test("手算核对：全对 / 漏选半分 / 错选零分 / 未答零分", () => {
  const { svc, examId } = makeService();
  const r = svc.submit(examId, {
    code: "S1", student: "甲", keyVersion: 1,
    answers: { "1": "B", "2": ["A"], "3": 3.14 },
  });
  // 单选对 2 分；多选漏选 2 分；数值在容差内 3 分 => 7
  assert.equal(r.total, 7);
  assert.deepEqual(r.details.map((d: any) => d.score), [2, 2, 3]);

  const r2 = svc.submit(examId, {
    code: "S2", student: "乙", keyVersion: 1,
    answers: { "1": "A", "2": ["A", "B"], "3": 9 },
  });
  assert.equal(r2.total, 0); // 全错

  const r3 = svc.submit(examId, { code: "S3", student: "丙", keyVersion: 1, answers: {} });
  assert.equal(r3.total, 0); // 全部未答
  assert.ok(r3.details.every((d: any) => d.reason === "未答"));
});

test("数值容差边界：边界算对，界外算错，数值 0 不等于未答", () => {
  const { svc, examId } = makeService();
  const edge = svc.submit(examId, {
    code: "E1", student: "边界", keyVersion: 1,
    answers: { "1": "B", "2": ["A", "C"], "3": 3.15 }, // |3.15-3.14|=0.01 边界
  });
  assert.equal(edge.details[2].score, 3);
  const out = svc.submit(examId, {
    code: "E2", student: "界外", keyVersion: 1,
    answers: { "1": "B", "2": ["A", "C"], "3": 3.151 },
  });
  assert.equal(out.details[2].score, 0);

  // 数值 0：把答案键改成 0，容差 0
  svc.addAnswerKey(examId, { answers: { "1": "B", "2": ["A", "C"], "3": { value: 0, tolerance: 0 } } });
  const zero = svc.submit(examId, {
    code: "E3", student: "零", keyVersion: 2,
    answers: { "1": "B", "2": ["A", "C"], "3": 0 },
  });
  assert.equal(zero.details[2].score, 3);
  assert.notEqual(zero.details[2].reason, "未答");
});

test("多选重复选项按集合去重，不影响判分", () => {
  const { svc, examId } = makeService();
  const r = svc.submit(examId, {
    code: "D1", student: "重复", keyVersion: 1,
    answers: { "1": "B", "2": ["A", "A", "C", "C"], "3": 3.14 },
  });
  assert.equal(r.details[1].score, 4);
  assert.equal(r.total, 9);
});

test("非法输入：非法题号 / 不合法选项 / NaN / 负容限 / 非正整数分值", () => {
  const { svc, examId } = makeService();
  assert.throws(() => svc.submit(examId, { code: "X1", student: "x", keyVersion: 1, answers: { "99": "A" } }),
    (e: any) => e instanceof ApiError && e.code === "INVALID_INPUT" && /非法题号/.test(e.message));
  assert.throws(() => svc.submit(examId, { code: "X2", student: "x", keyVersion: 1, answers: { "1": "Z" } }),
    (e: any) => e.code === "INVALID_INPUT");
  assert.throws(() => svc.submit(examId, { code: "X3", student: "x", keyVersion: 1, answers: { "3": NaN } }),
    (e: any) => e.code === "INVALID_INPUT");
  assert.throws(() => svc.addAnswerKey(examId, { answers: { "1": "B", "2": ["A"], "3": { value: 1, tolerance: -1 } } }),
    (e: any) => e.code === "INVALID_INPUT");
  assert.throws(() => svc.createExam({ title: "t", questions: [{ seq: 1, type: "single", points: 0, options: ["A", "B"] }] }),
    (e: any) => e.code === "INVALID_INPUT");
});

test("重复提交：内容相同返回既有结果，内容不同报冲突", () => {
  const { svc, examId } = makeService();
  const body = { code: "R1", student: "幂等", keyVersion: 1, answers: { "1": "B", "2": ["A", "C"], "3": 3.14 } };
  const first = svc.submit(examId, body);
  const again = svc.submit(examId, body);
  assert.equal(again.duplicated, true);
  assert.equal(again.total, first.total);
  assert.throws(() => svc.submit(examId, { ...body, answers: { "1": "A" } }),
    (e: any) => e instanceof ApiError && e.code === "CONFLICT" && e.status === 409);
});

test("重评：输出差异、保留旧报告、两版均可查询、总分等于逐题和", () => {
  const { svc, examId } = makeService();
  svc.submit(examId, { code: "G1", student: "小明", keyVersion: 1, answers: { "1": "B", "2": ["A"], "3": 3.0 } });
  svc.submit(examId, { code: "G2", student: "小红", keyVersion: 1, answers: { "1": "C", "2": ["A", "C"], "3": 3.14 } });
  // 更正：第 1 题 B -> C，第 3 题容差放宽到 0.2
  svc.addAnswerKey(examId, {
    answers: { "1": "C", "2": ["A", "C"], "3": { value: 3.14, tolerance: 0.2 } },
    note: "更正第1题并放宽第3题容差",
  });
  const re = svc.regrade(examId, { keyVersion: 2 });
  assert.equal(re.regraded, 2);
  const g1 = re.results.find((r: any) => r.code === "G1");
  // G1 旧分: 2 + 2 + 0 = 4；新分: 0 + 2 + 3 = 5
  assert.equal(g1.oldTotal, 4);
  assert.equal(g1.newTotal, 5);
  assert.equal(g1.totalDelta, 1);
  assert.ok(g1.changedQuestions.some((d: any) => d.seq === 1 && d.delta === -2));
  assert.ok(g1.changedQuestions.some((d: any) => d.seq === 3 && d.delta === 3));

  // 两版报告均可查询，旧报告未被覆盖
  const v1 = svc.getReport(examId, "G1", 1);
  const v2 = svc.getReport(examId, "G1", 2);
  assert.equal(v1.total, 4);
  assert.equal(v2.total, 5);
  for (const rep of [v1, v2]) {
    const sum = rep.details.reduce((s: number, d: any) => s + d.score, 0);
    assert.equal(rep.total, sum);
  }
});

test("重启后两版报告仍可查询（SQLite 持久化）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "examdb-"));
  const dbFile = path.join(dir, "exam.db");
  const { svc, examId } = makeService(dbFile);
  svc.submit(examId, { code: "P1", student: "持久", keyVersion: 1, answers: { "1": "B", "2": ["A", "C"], "3": 3.14 } });
  svc.addAnswerKey(examId, { answers: { "1": "A", "2": ["A", "C"], "3": { value: 3.14, tolerance: 0.01 } } });
  svc.regrade(examId, { keyVersion: 2 });

  // 模拟重启：用同一文件重新打开
  const svc2 = new ExamService(openDb(dbFile));
  assert.equal(svc2.getReport(examId, "P1", 1).total, 9);
  assert.equal(svc2.getReport(examId, "P1", 2).total, 7); // 第1题改答案后丢 2 分
  svc.close(); svc2.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("未发布试卷不能提交；答案键必须覆盖全部题目", () => {
  const svc = new ExamService(openDb(":memory:"));
  const exam = svc.createExam({ title: "t", questions: [{ seq: 1, type: "single", points: 1, options: ["A", "B"] }] });
  assert.throws(() => svc.submit(exam.id, { code: "c", student: "s", keyVersion: 1, answers: {} }),
    (e: any) => e.code === "INVALID_STATE");
  svc.publishExam(exam.id);
  assert.throws(() => svc.addAnswerKey(exam.id, { answers: {} }),
    (e: any) => e.code === "INVALID_INPUT" && /缺少第 1 题/.test(e.message));
});

