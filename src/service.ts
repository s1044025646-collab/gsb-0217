import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.ts";
import type { Question, QuestionResult, QuestionType } from "./grade.ts";
import { gradeSingle, gradeMulti, gradeNumber, assertFiniteNumber } from "./grade.ts";

const now = () => new Date().toISOString();

// ---------- 输入校验 ----------

function asObject(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail("INVALID_INPUT", `${what} 必须是对象`);
  return x as Record<string, unknown>;
}

function asNonEmptyString(x: unknown, what: string): string {
  if (typeof x !== "string" || x.trim() === "") fail("INVALID_INPUT", `${what} 必须是非空字符串`);
  return x;
}

function asPositiveInt(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) fail("INVALID_INPUT", `${what} 必须是正整数`);
  return x;
}

function parseOptions(x: unknown, what: string): string[] {
  if (!Array.isArray(x) || x.length < 2) fail("INVALID_INPUT", `${what} 至少需要 2 个选项`);
  const opts = x.map((o, i) => asNonEmptyString(o, `${what}[${i}]`));
  if (new Set(opts).size !== opts.length) fail("INVALID_INPUT", `${what} 存在重复选项定义`);
  return opts;
}

// ---------- 服务 ----------

export class ExamService {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  close() { this.db.close(); }

  createExam(input: unknown): { id: number; title: string; status: string } {
    const body = asObject(input, "请求体");
    const title = asNonEmptyString(body.title, "title");
    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      fail("INVALID_INPUT", "questions 必须是非空数组");
    }
    const seen = new Set<number>();
    const questions = body.questions.map((raw, i) => {
      const q = asObject(raw, `questions[${i}]`);
      const seq = asPositiveInt(q.seq, `questions[${i}].seq`);
      if (seen.has(seq)) fail("INVALID_INPUT", `题号 ${seq} 重复`);
      seen.add(seq);
      const type = q.type;
      if (type !== "single" && type !== "multi" && type !== "number") {
        fail("INVALID_INPUT", `questions[${i}].type 必须是 single|multi|number`);
      }
      const points = asPositiveInt(q.points, `questions[${i}].points`);
      const options = type === "number" ? [] : parseOptions(q.options, `questions[${i}].options`);
      return { seq, type: type as QuestionType, points, options };
    });
    this.db.exec("BEGIN");
    try {
      const r = this.db.prepare("INSERT INTO exams (title, status, created_at) VALUES (?, 'draft', ?)").run(title, now());
      const id = Number(r.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO questions (exam_id, seq, type, points, options) VALUES (?,?,?,?,?)");
      for (const q of questions) ins.run(id, q.seq, q.type, q.points, JSON.stringify(q.options));
      this.db.exec("COMMIT");
      return { id, title, status: "draft" };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  getExam(examId: number) {
    const exam = this.db.prepare("SELECT * FROM exams WHERE id = ?").get(examId) as any;
    if (!exam) fail("NOT_FOUND", `试卷 ${examId} 不存在`);
    const questions = this.db.prepare("SELECT seq, type, points, options FROM questions WHERE exam_id = ? ORDER BY seq").all(examId) as any[];
    return {
      id: exam.id, title: exam.title, status: exam.status, createdAt: exam.created_at,
      questions: questions.map((q) => ({ seq: q.seq, type: q.type, points: q.points, options: JSON.parse(q.options) })),
    };
  }

  publishExam(examId: number) {
    const exam = this.getExam(examId);
    if (exam.status === "published") fail("INVALID_STATE", `试卷 ${examId} 已发布，题目已冻结`);
    this.db.prepare("UPDATE exams SET status = 'published' WHERE id = ?").run(examId);
    return { id: examId, status: "published" };
  }

  private requirePublished(examId: number) {
    const exam = this.getExam(examId);
    if (exam.status !== "published") fail("INVALID_STATE", `试卷 ${examId} 尚未发布`);
    return exam;
  }

  private loadQuestions(examId: number): Question[] {
    const rows = this.db.prepare("SELECT seq, type, points, options FROM questions WHERE exam_id = ? ORDER BY seq").all(examId) as any[];
    return rows.map((r) => ({ seq: r.seq, type: r.type, points: r.points, options: JSON.parse(r.options) }));
  }

  // 校验并规范化一份答案（答案键或答卷），返回 { seq: 规范答案 }
  private validateAnswers(examId: number, raw: unknown, isKey: boolean): Map<number, unknown> {
    const questions = this.loadQuestions(examId);
    const bySeq = new Map(questions.map((q) => [q.seq, q]));
    const body = asObject(raw, isKey ? "答案键" : "答卷");
    const label = isKey ? "答案键" : "答卷";
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(body)) {
      const seq = Number(k);
      if (!Number.isInteger(seq) || !bySeq.has(seq)) fail("INVALID_INPUT", `${label} 包含非法题号: ${k}`);
      const q = bySeq.get(seq)!;
      if (q.type === "single") {
        if (typeof v !== "string" || !q.options.includes(v)) fail("INVALID_INPUT", `第 ${seq} 题作答必须是合法选项之一`);
        out.set(seq, v);
      } else if (q.type === "multi") {
        if (!Array.isArray(v)) fail("INVALID_INPUT", `第 ${seq} 题作答必须是选项数组`);
        for (const o of v) {
          if (typeof o !== "string" || !q.options.includes(o)) fail("INVALID_INPUT", `第 ${seq} 题包含不合法选项: ${String(o)}`);
        }
        out.set(seq, [...new Set(v as string[])]); // 重复选项去重
      } else if (isKey) {
        out.set(seq, v); // 数值题答案键为 { value, tolerance }，在下方统一校验
      } else {
        try { assertFiniteNumber(v, `第 ${seq} 题作答`); } catch (e: any) { fail("INVALID_INPUT", e.message); }
        out.set(seq, v);
      }
    }
    if (isKey) {
      for (const q of questions) {
        if (!out.has(q.seq)) fail("INVALID_INPUT", `答案键缺少第 ${q.seq} 题`);
      }
      // 数值题答案键需要 { value, tolerance }
      for (const q of questions) {
        if (q.type !== "number") continue;
        const v = out.get(q.seq);
        const obj = asObject(v, `答案键第 ${q.seq} 题`);
        const value = assertFiniteNumberOrFail(obj.value, `答案键第 ${q.seq} 题 value`);
        const tol = assertFiniteNumberOrFail(obj.tolerance, `答案键第 ${q.seq} 题 tolerance`);
        if (tol < 0) fail("INVALID_INPUT", `第 ${q.seq} 题容限必须是非负数`);
        out.set(q.seq, { value, tolerance: tol });
      }
    }
    return out;
  }

  addAnswerKey(examId: number, input: unknown) {
    this.requirePublished(examId);
    const body = asObject(input, "请求体");
    const answers = this.validateAnswers(examId, body.answers, true);
    const note = body.note === undefined ? "" : asNonEmptyString(body.note, "note");
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM answer_keys WHERE exam_id = ?").get(examId) as any;
    const version = Number(row.v) + 1;
    const obj: Record<string, unknown> = {};
    for (const [seq, a] of answers) obj[String(seq)] = a;
    this.db.prepare("INSERT INTO answer_keys (exam_id, version, answers, note, created_at) VALUES (?,?,?,?,?)")
      .run(examId, version, JSON.stringify(obj), note, now());
    return { examId, version, note };
  }

  listAnswerKeys(examId: number) {
    this.getExam(examId);
    const rows = this.db.prepare("SELECT version, note, created_at FROM answer_keys WHERE exam_id = ? ORDER BY version").all(examId) as any[];
    return rows.map((r) => ({ version: r.version, note: r.note, createdAt: r.created_at }));
  }

  private loadKey(examId: number, version: number): Map<number, unknown> {
    const row = this.db.prepare("SELECT answers FROM answer_keys WHERE exam_id = ? AND version = ?").get(examId, version) as any;
    if (!row) fail("NOT_FOUND", `试卷 ${examId} 的答案键版本 ${version} 不存在`);
    const obj = JSON.parse(row.answers) as Record<string, unknown>;
    return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
  }

  private gradeWithKey(examId: number, keyVersion: number, answers: Map<number, unknown>) {
    const questions = this.loadQuestions(examId);
    const key = this.loadKey(examId, keyVersion);
    const details: QuestionResult[] = questions.map((q) => {
      const a = answers.get(q.seq);
      const k = key.get(q.seq) as any;
      if (q.type === "single") return gradeSingle(q, k as string, a);
      if (q.type === "multi") return gradeMulti(q, k as string[], a);
      return gradeNumber(q, k as { value: number; tolerance: number }, a);
    });
    const total = details.reduce((s, d) => s + d.score, 0);
    return { details, total };
  }

  // 提交答卷：同事卷同 code 幂等；内容不同返回 409 冲突。
  submit(examId: number, input: unknown) {
    this.requirePublished(examId);
    const body = asObject(input, "请求体");
    const code = asNonEmptyString(body.code, "code");
    const student = asNonEmptyString(body.student, "student");
    const keyVersion = asPositiveInt(body.keyVersion, "keyVersion");
    this.loadKey(examId, keyVersion); // 确认版本存在
    const answers = this.validateAnswers(examId, body.answers ?? {}, false);
    const obj: Record<string, unknown> = {};
    for (const seq of [...answers.keys()].sort((a, b) => a - b)) obj[String(seq)] = answers.get(seq);
    const answersJson = JSON.stringify(obj);

    const existing = this.db.prepare("SELECT * FROM submissions WHERE exam_id = ? AND code = ?").get(examId, code) as any;
    if (existing) {
      if (existing.answers === answersJson && Number(existing.key_version) === keyVersion) {
        return { ...this.reportFor(existing.id, keyVersion), code, student: existing.student, duplicated: true };
      }
      fail("CONFLICT", `答卷编号 ${code} 已存在且内容不同`);
    }

    this.db.exec("BEGIN");
    try {
      const r = this.db.prepare("INSERT INTO submissions (exam_id, code, student, key_version, answers, created_at) VALUES (?,?,?,?,?,?)")
        .run(examId, code, student, keyVersion, answersJson, now());
      const submissionId = Number(r.lastInsertRowid);
      const { details, total } = this.gradeWithKey(examId, keyVersion, answers);
      // 明细与总分作为完整结果在同一事务写入
      this.db.prepare("INSERT INTO reports (submission_id, key_version, total, details, created_at) VALUES (?,?,?,?,?)")
        .run(submissionId, keyVersion, total, JSON.stringify(details), now());
      this.db.exec("COMMIT");
      return { submissionId, code, student, keyVersion, total, details, duplicated: false };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  private reportFor(submissionId: number, keyVersion: number) {
    const row = this.db.prepare("SELECT * FROM reports WHERE submission_id = ? AND key_version = ?").get(submissionId, keyVersion) as any;
    if (!row) fail("NOT_FOUND", "该版本下没有评分报告");
    return { submissionId, keyVersion, total: row.total, details: JSON.parse(row.details) };
  }

  getReport(examId: number, code: string, keyVersion?: number) {
    this.getExam(examId);
    const sub = this.db.prepare("SELECT * FROM submissions WHERE exam_id = ? AND code = ?").get(examId, code) as any;
    if (!sub) fail("NOT_FOUND", `答卷 ${code} 不存在`);
    const version = keyVersion ?? Number(sub.key_version);
    return { code, student: sub.student, examId, ...this.reportFor(sub.id, version) };
  }

  listReports(examId: number, keyVersion?: number) {
    this.getExam(examId);
    const subs = this.db.prepare("SELECT * FROM submissions WHERE exam_id = ? ORDER BY code").all(examId) as any[];
    return subs.map((s) => {
      const version = keyVersion ?? Number(s.key_version);
      const rep = this.db.prepare("SELECT total FROM reports WHERE submission_id = ? AND key_version = ?").get(s.id, version) as any;
      return { code: s.code, student: s.student, keyVersion: version, total: rep ? rep.total : null };
    });
  }

  // 批量重评：用指定答案键版本对全部答卷重新判分。
  // 旧报告保留（reports 以 submission_id+key_version 为主键），输出逐题与总分差异。
  regrade(examId: number, input: unknown) {
    this.requirePublished(examId);
    const body = asObject(input, "请求体");
    const keyVersion = asPositiveInt(body.keyVersion, "keyVersion");
    this.loadKey(examId, keyVersion);
    const subs = this.db.prepare("SELECT * FROM submissions WHERE exam_id = ? ORDER BY code").all(examId) as any[];
    const results: any[] = [];
    this.db.exec("BEGIN");
    try {
      for (const s of subs) {
        const answers = new Map(Object.entries(JSON.parse(s.answers) as Record<string, unknown>).map(([k, v]) => [Number(k), v]));
        const { details, total } = this.gradeWithKey(examId, keyVersion, answers);
        const oldRow = this.db.prepare("SELECT total, details FROM reports WHERE submission_id = ? AND key_version = ?")
          .get(s.id, Number(s.key_version)) as any;
        const oldDetails: QuestionResult[] = oldRow ? JSON.parse(oldRow.details) : [];
        const oldBySeq = new Map(oldDetails.map((d) => [d.seq, d]));
        const diffs = details.map((d) => {
          const old = oldBySeq.get(d.seq);
          return {
            seq: d.seq,
            oldScore: old ? old.score : null,
            newScore: d.score,
            delta: old ? d.score - old.score : null,
            reason: d.reason,
          };
        }).filter((d) => d.delta === null || d.delta !== 0);
        this.db.prepare("INSERT OR REPLACE INTO reports (submission_id, key_version, total, details, created_at) VALUES (?,?,?,?,?)")
          .run(s.id, keyVersion, total, JSON.stringify(details), now());
        results.push({
          code: s.code, student: s.student,
          oldKeyVersion: Number(s.key_version), newKeyVersion: keyVersion,
          oldTotal: oldRow ? oldRow.total : null, newTotal: total,
          totalDelta: oldRow ? total - oldRow.total : null,
          changedQuestions: diffs,
        });
      }
      this.db.exec("COMMIT");
      return { examId, keyVersion, regraded: results.length, results };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

function assertFiniteNumberOrFail(x: unknown, what: string): number {
  try { return assertFiniteNumber(x, what); } catch (e: any) { fail("INVALID_INPUT", e.message); }
}




