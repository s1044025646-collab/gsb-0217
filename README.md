# 多题型试卷自动判分与重评后端

纯本地运行的客观题判分服务：TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖），
提供 HTTP API 与 CLI。支持单选、多选、数值填空三种题型的首次判分与答案更正后的批量重评。

## 环境要求

- Windows 本地，Node.js >= 22.5（开发基于 Node 25 验证）
- 不需要 Docker / WSL / 任何外部服务；除开发依赖 TypeScript 外无运行时依赖

## 快速开始

```powershell
npm install      # 安装开发依赖（typescript、@types/node）
npm run build    # 编译到 dist/
npm test         # 运行全部测试（9 个用例）
npm start        # 启动 HTTP 服务（默认自动选择空闲端口，--port 指定端口）
npm run demo     # 运行演示（独立数据库 data/demo.db，每次重置）
```

数据目录默认为项目内 `data/`，数据库文件 `data/exam.db`；可用环境变量 `EXAM_DB`
或 CLI 参数 `--db <路径>` 覆盖。

## 判分规则（首判与重评完全一致）

| 题型 | 规则 |
| --- | --- |
| 单选 `single` | 答对得满分，答错或未答 0 分 |
| 多选 `multi` | 全对满分；只漏选且无错项得半分；含错项或未答 0 分；作答中重复选项按集合去重 |
| 数值填空 `number` | 答案键给出 `{value, tolerance}`（容限为非负绝对误差），`|作答 - value| <= tolerance` 得满分（含边界），否则 0 分 |

- 题目满分限定为正整数，总分可含半分，不设倒扣。
- 数值 `0` 是合法作答，不会当作未答；`NaN`、`Infinity`、不合法选项、非法题号一律报 `INVALID_INPUT` 错误。
- 一次答卷的逐题明细与总分在同一事务写入 SQLite，不存在只写部分题目的情况。

## 核心概念

- **试卷**：创建为草稿，`publish` 后冻结题号、题型、分值，不可再改。
- **答案键版本**：每次发布更正答案产生新版本（版本号自动递增），旧版本永久保留。
- **答卷**：提交时必须指定 `keyVersion`；同一试卷内 `code`（答卷编号）唯一。
  重复提交且内容完全相同 → 幂等返回既有结果（`duplicated: true`）；内容不同 → `409 CONFLICT`。
- **报告**：以 `(答卷, 答案键版本)` 为主键保存。重评写入新版本的报告并输出逐题与总分差异，
  **旧报告不被覆盖**，两个版本可分别查询。

## HTTP API

启动：`npm start`（或 `node dist/server.js --port 8080 --db data/exam.db`）。
未指定端口时自动选择空闲端口并打印实际地址。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/exams` | 创建试卷（含题目） |
| GET | `/api/exams/:id` | 查看试卷 |
| POST | `/api/exams/:id/publish` | 发布试卷（冻结题目） |
| POST | `/api/exams/:id/answer-keys` | 发布答案键（版本自动递增） |
| GET | `/api/exams/:id/answer-keys` | 列出答案键版本 |
| POST | `/api/exams/:id/submissions` | 提交答卷并判分 |
| GET | `/api/exams/:id/reports` | 整卷成绩一览（`?keyVersion=`） |
| GET | `/api/exams/:id/reports/:code` | 单份答卷报告（`?keyVersion=`） |
| POST | `/api/exams/:id/regrade` | 用指定版本答案键批量重评 |
| GET | `/api/health` | 健康检查 |

### 请求 / 响应样例

创建试卷：

```json
POST /api/exams
{
  "title": "期末客观题测验",
  "questions": [
    { "seq": 1, "type": "single", "points": 2, "options": ["A", "B", "C", "D"] },
    { "seq": 2, "type": "multi",  "points": 4, "options": ["A", "B", "C", "D"] },
    { "seq": 3, "type": "number", "points": 3 }
  ]
}
```

发布答案键（数值题必须给出 `value` 与非负 `tolerance`）：

```json
POST /api/exams/1/answer-keys
{ "answers": { "1": "B", "2": ["A", "C"], "3": { "value": 3.14, "tolerance": 0.01 } },
  "note": "初版答案" }
→ 201 { "examId": 1, "version": 1, "note": "初版答案" }
```

提交答卷（响应含逐题明细与原因）：

```json
POST /api/exams/1/submissions
{ "code": "S001", "student": "小明", "keyVersion": 1,
  "answers": { "1": "B", "2": ["A"], "3": 3.14 } }
→ 201 {
    "submissionId": 1, "code": "S001", "keyVersion": 1, "total": 7,
    "details": [
      { "seq": 1, "type": "single", "points": 2, "answer": "B",   "score": 2, "reason": "答对", ... },
      { "seq": 2, "type": "multi",  "points": 4, "answer": ["A"], "score": 2, "reason": "漏选（无错项），得半分", ... },
      { "seq": 3, "type": "number", "points": 3, "answer": 3.14,  "score": 3, "reason": "在容差范围内（|3.14 - 3.14| = 0 <= 0.01）", ... }
    ]
  }
```

更正答案并批量重评（旧报告保留）：

```json
POST /api/exams/1/answer-keys
{ "answers": { "1": "C", "2": ["A", "C"], "3": { "value": 3.14, "tolerance": 0.2 } },
  "note": "更正：第1题改C；第3题容差放宽" }

POST /api/exams/1/regrade
{ "keyVersion": 2 }
→ 200 { "regraded": 1, "results": [ {
      "code": "S001", "oldKeyVersion": 1, "newKeyVersion": 2,
      "oldTotal": 7, "newTotal": 5, "totalDelta": -2,
      "changedQuestions": [
        { "seq": 1, "oldScore": 2, "newScore": 0, "delta": -2, "reason": "答错" }
      ] } ] }

GET /api/exams/1/reports/S001?keyVersion=1   → 旧报告 total = 7（未被覆盖）
GET /api/exams/1/reports/S001?keyVersion=2   → 新报告 total = 5
```

### 错误码

所有错误返回 `{ "error": { "code", "message" } }`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_INPUT` | 400 | 参数校验失败（非法题号、不合法选项、NaN/Infinity、负容限、非正整数分值等） |
| `INVALID_STATE` | 400 | 状态不允许（未发布就提交、重复发布等） |
| `NOT_FOUND` | 404 | 试卷 / 答卷 / 答案键版本不存在 |
| `CONFLICT` | 409 | 同一答卷编号重复提交但内容不同 |

## CLI

```powershell
node dist/cli.js create-exam --file examples/exam.json
node dist/cli.js publish --exam 1
node dist/cli.js add-key --exam 1 --file examples/key-v1.json --note 初版
node dist/cli.js submit --exam 1 --code S001 --student 小明 --key-version 1 --file examples/answers-s001.json
node dist/cli.js submit --exam 1 --code S002 --student 小红 --key-version 1 --file examples/answers-s002.json
node dist/cli.js submit --exam 1 --code S003 --student 小刚 --key-version 1 --file examples/answers-s003.json
node dist/cli.js report --exam 1 --code S001
node dist/cli.js add-key --exam 1 --file examples/key-v2.json
node dist/cli.js regrade --exam 1 --key-version 2
node dist/cli.js report --exam 1 --code S001 --key-version 1   # 旧版报告仍在
node dist/cli.js reports --exam 1 --key-version 2              # 全班新版成绩
```

`examples/` 中的答卷演示了漏选（S001 第 2 题半分）、错选（S002 第 2 题含错项 0 分）、
未答与数值零（S003 只答第 3 题且答 0）。

## 演示

`npm run demo` 使用独立数据库 `data/demo.db`（每次运行前重置），完整走一遍：
建卷 → 发布 → 答案键 v1 → 三名虚构考生提交 → 幂等重复提交 → 发布更正答案 v2 →
批量重评（输出逐题差异）→ 分别查询 v1 / v2 两版报告。

演示预期总分：S001 首判 7 → 重评后 5；S002 首判 5 → 重评后 3；S003 始终 0。

## 测试

`npm test` 覆盖：手算分数核对、容差边界（边界算对 / 界外算错）、数值零不等于未答、
多选重复选项去重、非法题号 / 不合法选项 / NaN / 负容限报错、重复提交幂等与 409 冲突、
重评不覆盖旧报告且两版可查、总分等于逐题得分之和、重启（重开 SQLite 文件）后两版报告仍可查询。

## 目录结构

```
src/grade.ts    判分规则（纯函数）
src/service.ts  业务逻辑：校验、判分、报告、重评
src/db.ts       SQLite 连接与建表
src/server.ts   HTTP API（node:http）
src/cli.ts      命令行入口
test/           node:test 测试
demo/demo.ts    演示脚本
examples/       可直接复现的输入 JSON
data/           默认数据目录（SQLite 文件）
```

## 假设与限制

- 仅客观题（单选 / 多选 / 数值填空）；不做主观题、AI 阅卷、考试排期、用户系统与排名统计。
- 多选半分规则固定为“只漏选且无错项得半分”，不支持其他部分给分策略。
- 数值容限为非负绝对误差；浮点比较直接使用 IEEE 754 双精度（如 `|2.55-2.5|` 实际为
  `0.04999999999999982`，仍 ≤ 0.1 判对；极端边界场景请留意浮点表示误差）。
- 单机单进程服务，无鉴权；适用于本地判分场景。
- `node:sqlite` 在 Node 22/25 中仍带 ExperimentalWarning，功能可用但 API 未来可能微调。
