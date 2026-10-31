/**
 * Node 适配器：仅用于本地回归测试，把 node:sqlite 的同步接口包成异步，
 * 让同一份 store.js 能在本机与 D1 上跑出完全相同的结果。
 */
import { DatabaseSync } from "node:sqlite";

export function nodeAdapter(filename) {
  const db = new DatabaseSync(filename);
  return {
    async all(sql, params) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, params) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async run(sql, params) {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes || 0), lastRowId: Number(result.lastInsertRowid || 0) };
    },
    async exec(sql) {
      db.exec(sql);
    },
    async batch(statements) {
      const results = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of statements) results.push(db.prepare(item.sql).run(...item.params));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return results;
    },
    close() {
      db.close();
    },
  };
}
