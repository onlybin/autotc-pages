
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rule_sets(
    id INTEGER PRIMARY KEY AUTOINCREMENT, effective_from TEXT NOT NULL, created_at TEXT NOT NULL,
    source TEXT NOT NULL, superseded_at TEXT, superseded_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS rule_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT, rule_set_id INTEGER NOT NULL REFERENCES rule_sets(id),
    rule_key TEXT NOT NULL, name TEXT NOT NULL, pack_price REAL NOT NULL, carton_price REAL NOT NULL,
    min_pack_price REAL NOT NULL DEFAULT 0, min_carton_price REAL NOT NULL DEFAULT 0,
    commission REAL NOT NULL, source TEXT NOT NULL, UNIQUE(rule_set_id, rule_key)
  );
  CREATE TABLE IF NOT EXISTS import_batches(
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_month TEXT NOT NULL, source_filename TEXT NOT NULL,
    source_sha256 TEXT, started_at TEXT NOT NULL, completed_at TEXT, is_month_close INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0, error_message TEXT,
    UNIQUE(target_month, source_filename, source_sha256)
  );
  CREATE TABLE IF NOT EXISTS orders(
    line_key TEXT PRIMARY KEY, store TEXT, order_id TEXT, payment_no TEXT, product_id TEXT, product_name TEXT NOT NULL,
    unit TEXT, original_quantity REAL NOT NULL, quantity REAL NOT NULL, quantity_basis TEXT, unit_price REAL NOT NULL,
    amount REAL NOT NULL, order_amount REAL NOT NULL DEFAULT 0, refund REAL NOT NULL, status TEXT NOT NULL, cashier TEXT, checkout_time TEXT, order_date TEXT NOT NULL,
    rule_set_id INTEGER REFERENCES rule_sets(id), rule_key TEXT, rule_name TEXT, commission_per_unit REAL NOT NULL,
    commission REAL NOT NULL, match_type TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    source_batch_id INTEGER REFERENCES import_batches(id),
    -- 以下 9 列在原实现里由 ensureColumn 补加，这里直接建进表结构
    expected_amount REAL NOT NULL DEFAULT 0, min_allowed_amount REAL NOT NULL DEFAULT 0,
    actual_amount REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0,
    discount_rate REAL NOT NULL DEFAULT 0, price_status TEXT NOT NULL DEFAULT '',
    commission_status TEXT NOT NULL DEFAULT '', audit_status TEXT NOT NULL DEFAULT '',
    audit_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
  CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout_time);
  CREATE TABLE IF NOT EXISTS manual_orders(
    id TEXT PRIMARY KEY, order_date TEXT NOT NULL, checkout_time TEXT, product_name TEXT NOT NULL, unit_price REAL NOT NULL,
    quantity REAL NOT NULL, cashier TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT '正常',
    rule_set_id INTEGER REFERENCES rule_sets(id), rule_key TEXT, rule_name TEXT, commission_per_unit REAL NOT NULL,
    commission REAL NOT NULL, match_type TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shift_share_windows(
    id TEXT PRIMARY KEY, cashier TEXT NOT NULL, shift_name TEXT, shift_type TEXT, segment_index INTEGER NOT NULL DEFAULT 1,
    total_segments INTEGER NOT NULL DEFAULT 1, cross_day INTEGER NOT NULL DEFAULT 0,
    shift_date TEXT NOT NULL, start_time TEXT NOT NULL,
    end_time TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, effective_from TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shift_share_windows_time ON shift_share_windows(enabled,start_at,end_at,effective_from);
  CREATE TABLE IF NOT EXISTS monthly_sales_targets(
    target_month TEXT PRIMARY KEY,
    target_sales REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sales_target_supplements(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplement_date TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_target_supplements_date ON sales_target_supplements(supplement_date);
  CREATE TABLE IF NOT EXISTS order_amount_allocations(
    order_id TEXT NOT NULL,
    line_key TEXT NOT NULL,
    allocated_amount REAL NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(order_id,line_key)
  );
  INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, datetime('now','localtime'));

  -- 后台登录会话（替代原实现的内存 Map：Worker 实例之间不共享内存）
  CREATE TABLE IF NOT EXISTS admin_sessions(
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_created ON admin_sessions(created_at);
