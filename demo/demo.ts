// 演示：一张混合题型试卷 + 三名虚构考生，展示漏选/错选/未答与答案更正后的分数变化。
// 运行: npm run demo   （使用独立演示数据库 data/demo.db，每次运行前重置）
import fs from "node:fs";
import path from "node:path";
import { ExamService } from "../src/service.ts";
import { openDb } from "../src/db.ts";

const dbPath = path.join(process.cwd(), "data", "demo.db");
fs.rmSync(dbPath, { force: true });
const svc = new ExamService(openDb(dbPath));
const show = (title: string, data: unknown) => {
  console.log("\n=== " + title + " ===");
  console.log(JSON.stringify(data, null, 2));
};

const exam = svc.createExam({
  title: "期末客观题测验（演示）",
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
show("试卷已发布（题号/题型/分值冻结），答案键 v1", svc.getExam(exam.id));

const subs = [
  { code: "S001", student: "小明", answers: { "1": "B", "2": ["A"], "3": 3.14 } },       // 多选漏选 -> 半分
  { code: "S002", student: "小红", answers: { "1": "B", "2": ["A", "B", "C"], "3": 3.15 } }, // 多选含错项 -> 0；数值压边界 -> 对
  { code: "S003", student: "小刚", answers: { "3": 0 } },                                 // 其余未答；数值 0 是作答不是未答
];
for (const s of subs) {
  const r = svc.submit(exam.id, { ...s, keyVersion: 1 });
  show(`答卷 ${s.code}（${s.student}）首判，总分 ${r.total}`, r.details);
}

// 重复提交同一编号且内容相同 -> 幂等返回既有结果
const dup = svc.submit(exam.id, { ...subs[0], keyVersion: 1 });
console.log(`\n重复提交 S001（内容相同）: duplicated = ${dup.duplicated}，总分仍为 ${dup.total}`);

// 答案更正：第 1 题 B -> C，第 3 题容差放宽到 0.2，产生答案键 v2
svc.addAnswerKey(exam.id, {
  answers: { "1": "C", "2": ["A", "C"], "3": { value: 3.14, tolerance: 0.2 } },
  note: "更正：第1题改为C；第3题容差放宽到0.2",
});
const re = svc.regrade(exam.id, { keyVersion: 2 });
show("用答案键 v2 批量重评（逐题与总分差异）", re.results);

show("S001 在 v1 下的旧报告（保留，未被覆盖）", svc.getReport(exam.id, "S001", 1));
show("S001 在 v2 下的新报告", svc.getReport(exam.id, "S001", 2));
show("v2 全班成绩一览", svc.listReports(exam.id, 2));
console.log(`\n演示数据库: ${dbPath}`);
