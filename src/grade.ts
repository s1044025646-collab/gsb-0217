// 判分核心规则：单选 / 多选 / 数值填空。
// 首次判分与重评使用完全相同的纯函数，保证结果一致、可解释。

export type QuestionType = "single" | "multi" | "number";

export interface Question {
  seq: number;
  type: QuestionType;
  points: number; // 正整数
  options: string[]; // single/multi 的合法选项；number 题型为空数组
}

export interface KeyAnswer {
  single?: string;
  multi?: string[];
  number?: { value: number; tolerance: number };
}

export interface QuestionResult {
  seq: number;
  type: QuestionType;
  points: number;
  answer: unknown; // 考生原始作答（null 表示未答）
  key: KeyAnswer;
  score: number;
  reason: string;
}

export function assertFiniteNumber(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new Error(`${what} 必须是有限数值（收到: ${String(x)}）`);
  }
  return x;
}

// 单选：答对满分，否则 0 分。
export function gradeSingle(q: Question, key: string, answer: unknown): QuestionResult {
  const base = { seq: q.seq, type: q.type, points: q.points, answer: answer ?? null, key: { single: key } };
  if (answer === null || answer === undefined) return { ...base, score: 0, reason: "未答" };
  if (answer === key) return { ...base, score: q.points, reason: "答对" };
  return { ...base, score: 0, reason: "答错" };
}

// 多选：全对满分；只漏选且无错项得半分；含错项或未答 0 分。
// 作答中的重复选项按集合去重处理。
export function gradeMulti(q: Question, key: string[], answer: unknown): QuestionResult {
  const keySet = new Set(key);
  const base = { seq: q.seq, type: q.type, points: q.points, answer: answer ?? null, key: { multi: key } };
  if (answer === null || answer === undefined || (Array.isArray(answer) && answer.length === 0)) {
    return { ...base, score: 0, reason: "未答" };
  }
  const chosen = new Set(answer as string[]);
  let wrong = 0;
  for (const c of chosen) if (!keySet.has(c)) wrong++;
  if (wrong > 0) return { ...base, score: 0, reason: "含错项，得 0 分" };
  if (chosen.size === keySet.size) return { ...base, score: q.points, reason: "全对" };
  return { ...base, score: q.points / 2, reason: "漏选（无错项），得半分" };
}

// 数值填空：|answer - key| <= tolerance 得满分（含边界），否则 0 分。
// 数值 0 是合法作答，不视为未答。
export function gradeNumber(
  q: Question,
  key: { value: number; tolerance: number },
  answer: unknown,
): QuestionResult {
  const base = { seq: q.seq, type: q.type, points: q.points, answer: answer ?? null, key: { number: key } };
  if (answer === null || answer === undefined) return { ...base, score: 0, reason: "未答" };
  const a = answer as number;
  const diff = Math.abs(a - key.value);
  if (diff <= key.tolerance) {
    return { ...base, score: q.points, reason: `在容差范围内（|${a} - ${key.value}| = ${diff} <= ${key.tolerance}）` };
  }
  return { ...base, score: 0, reason: `超出容差（|${a} - ${key.value}| = ${diff} > ${key.tolerance}）` };
}
