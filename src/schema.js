async function initDashboardSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dashboard_snapshots (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      mode VARCHAR(32) NOT NULL,
      generated_at VARCHAR(64) NOT NULL,
      summary_json JSON NOT NULL,
      sources_json JSON NOT NULL,
      row_count INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_dashboard_snapshots_mode_id (mode, id),
      KEY idx_dashboard_snapshots_mode_created (mode, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dashboard_rows (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      snapshot_id BIGINT UNSIGNED NOT NULL,
      mode VARCHAR(32) NOT NULL,
      row_index INT UNSIGNED NOT NULL,
      row_key VARCHAR(255) NOT NULL,
      row_json JSON NOT NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_dashboard_rows_snapshot (snapshot_id, row_index),
      KEY idx_dashboard_rows_mode_snapshot (mode, snapshot_id),
      KEY idx_dashboard_rows_mode_key (mode, row_key),
      CONSTRAINT fk_dashboard_rows_snapshot
        FOREIGN KEY (snapshot_id) REFERENCES dashboard_snapshots(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      source VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      finished_at TIMESTAMP(3) NULL DEFAULT NULL,
      row_count INT UNSIGNED NOT NULL DEFAULT 0,
      message TEXT NULL,
      summary_json JSON NULL,
      PRIMARY KEY (id),
      KEY idx_sync_runs_source_started (source, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dashboard_row_actions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      mode VARCHAR(32) NOT NULL,
      row_key VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT '未处理',
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_dashboard_row_actions_mode_key (mode, row_key),
      KEY idx_dashboard_row_actions_mode_status (mode, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

module.exports = {
  initDashboardSchema
};
