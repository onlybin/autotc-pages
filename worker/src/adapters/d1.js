/** D1 适配器：把 D1 的异步接口塑造成 store.js 期望的形状 */
export function d1Adapter(db) {
  return {
    async all(sql, params) {
      const result = await db.prepare(sql).bind(...params).all();
      return result.results || [];
    },
    async get(sql, params) {
      return (await db.prepare(sql).bind(...params).first()) ?? null;
    },
    async run(sql, params) {
      const result = await db.prepare(sql).bind(...params).run();
      return {
        changes: result.meta?.changes ?? 0,
        lastRowId: result.meta?.last_row_id ?? 0,
      };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async batch(statements) {
      if (!statements.length) return [];
      return db.batch(statements.map((item) => db.prepare(item.sql).bind(...item.params)));
    },
  };
}
