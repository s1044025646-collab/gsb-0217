import fs from "node:fs";
import { ExamService } from "./service.ts";
import { openDb, defaultDbPath } from "./db.ts";
import { ApiError } from "./errors.ts";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k.startsWith("--")) throw new ApiError("INVALID_INPUT", `无法解析参数: ${k}`);
    opts[k.slice(2)] = rest[i + 1] ?? "";
  }
  return { cmd, opts };
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e: any) { throw new ApiError("INVALID_INPUT", `读取 JSON 文件失败 (${file}): ${e.message}`); }
}

const HELP = `
用法: node dist/cli.js <命令> [参数]   （数据库默认 data/exam.db，可用 --db 或 EXAM_DB 覆盖）

  create-exam  --file exam.json                     创建试卷（含题目）
  publish      --exam <id>                          发布试卷（冻结题目）
  add-key      --exam <id> --file key.json [--note 说明]   发布答案键（版本自动递增）
  keys         --exam <id>                          列出答案键版本
  submit       --exam <id> --code <编号> --student <姓名> --key-version <n> --file answers.json
  report       --exam <id> --code <编号> [--key-version <n>]
  reports      --exam <id> [--key-version <n>]      整卷成绩一览
  regrade      --exam <id> --key-version <n>        用指定版本答案键批量重评
  exam         --exam <id>                          查看试卷
`;

export function run(argv: string[], dbPath: string = defaultDbPath()): unknown {
  const { cmd, opts } = parseArgs(argv);
  const svc = new ExamService(openDb(dbPath));
  const examId = opts.exam ? Number(opts.exam) : NaN;
  const needExam = () => {
    if (!Number.isInteger(examId)) throw new ApiError("INVALID_INPUT", "缺少 --exam <id>");
    return examId;
  };
  switch (cmd) {
    case "create-exam": return svc.createExam(readJson(opts.file ?? ""));
    case "publish": return svc.publishExam(needExam());
    case "add-key": return svc.addAnswerKey(needExam(), { ...readJson(opts.file ?? "") as object, note: opts.note });
    case "keys": return svc.listAnswerKeys(needExam());
    case "submit":
      return svc.submit(needExam(), {
        code: opts.code, student: opts.student,
        keyVersion: Number(opts["key-version"]), answers: readJson(opts.file ?? ""),
      });
    case "report":
      return svc.getReport(needExam(), opts.code ?? "", opts["key-version"] ? Number(opts["key-version"]) : undefined);
    case "reports":
      return svc.listReports(needExam(), opts["key-version"] ? Number(opts["key-version"]) : undefined);
    case "regrade": return svc.regrade(needExam(), { keyVersion: Number(opts["key-version"]) });
    case "exam": return svc.getExam(needExam());
    case "help": return HELP;
    default: throw new ApiError("INVALID_INPUT", `未知命令: ${cmd}\n${HELP}`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/")).href;
if (isMain) {
  try {
    const dbIdx = process.argv.indexOf("--db");
    const dbPath = dbIdx >= 0 ? process.argv[dbIdx + 1] : defaultDbPath();
    const args = process.argv.slice(2).filter((_, i) => {
      const real = i + 2;
      return real !== dbIdx && real !== dbIdx + 1;
    });
    const out = run(args, dbPath);
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`错误 [${e.code}]: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
