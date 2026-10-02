import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      exam_id INTEGER NOT NULL REFERENCES exams(id),
      seq INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('single','multi','number')),
      points INTEGER NOT NULL CHECK (points > 0),
      options TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (exam_id, seq)
    );

    CREATE TABLE IF NOT EXISTS answer_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id),
      version INTEGER NOT NULL,
      answers TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (exam_id, version)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id),
      code TEXT NOT NULL,
      student TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      answers TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (exam_id, code)
    );

    CREATE TABLE IF NOT EXISTS reports (
      submission_id INTEGER NOT NULL REFERENCES submissions(id),
      key_version INTEGER NOT NULL,
      total REAL NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (submission_id, key_version)
    );
  `);
  return db;
}

export function defaultDbPath(): string {
  return process.env.EXAM_DB ?? path.join(process.cwd(), "data", "exam.db");
}
