async function initDashboardSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dashboard_operators (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      operator_key VARCHAR(64) NOT NULL,
      operator_name VARCHAR(64) NOT NULL,
      password_salt VARCHAR(128) NULL DEFAULT NULL,
      password_hash VARCHAR(256) NULL DEFAULT NULL,
      password_updated_at TIMESTAMP(3) NULL DEFAULT NULL,
      last_seen_at TIMESTAMP(3) NULL DEFAULT NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_dashboard_operators_key (operator_key),
      UNIQUE KEY uniq_dashboard_operators_name (operator_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const operatorPasswordColumns = [
    ['password_salt', "ALTER TABLE dashboard_operators ADD COLUMN password_salt VARCHAR(128) NULL DEFAULT NULL AFTER operator_name"],
    ['password_hash', "ALTER TABLE dashboard_operators ADD COLUMN password_hash VARCHAR(256) NULL DEFAULT NULL AFTER password_salt"],
    ['password_updated_at', "ALTER TABLE dashboard_operators ADD COLUMN password_updated_at TIMESTAMP(3) NULL DEFAULT NULL AFTER password_hash"]
  ];
  for (const [column, ddl] of operatorPasswordColumns) {
    const [columns] = await db.query(`SHOW COLUMNS FROM dashboard_operators LIKE '${column}'`);
    if (!columns.length) await db.query(ddl);
  }

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
      note TEXT NULL,
      legacy_note_migrated_at TIMESTAMP(3) NULL DEFAULT NULL,
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_dashboard_row_actions_mode_key (mode, row_key),
      KEY idx_dashboard_row_actions_mode_status (mode, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [noteColumns] = await db.query("SHOW COLUMNS FROM dashboard_row_actions LIKE 'note'");
  if (!noteColumns.length) {
    await db.query('ALTER TABLE dashboard_row_actions ADD COLUMN note TEXT NULL AFTER status');
  }

  const [legacyNoteMigratedColumns] = await db.query("SHOW COLUMNS FROM dashboard_row_actions LIKE 'legacy_note_migrated_at'");
  if (!legacyNoteMigratedColumns.length) {
    await db.query('ALTER TABLE dashboard_row_actions ADD COLUMN legacy_note_migrated_at TIMESTAMP(3) NULL DEFAULT NULL AFTER note');
  }

  const [actionOperatorKeyColumns] = await db.query("SHOW COLUMNS FROM dashboard_row_actions LIKE 'updated_by_operator_key'");
  if (!actionOperatorKeyColumns.length) {
    await db.query("ALTER TABLE dashboard_row_actions ADD COLUMN updated_by_operator_key VARCHAR(64) NULL DEFAULT NULL AFTER status");
  }

  const [actionOperatorNameColumns] = await db.query("SHOW COLUMNS FROM dashboard_row_actions LIKE 'updated_by_operator_name'");
  if (!actionOperatorNameColumns.length) {
    await db.query("ALTER TABLE dashboard_row_actions ADD COLUMN updated_by_operator_name VARCHAR(64) NULL DEFAULT NULL AFTER updated_by_operator_key");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS dashboard_row_action_notes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      mode VARCHAR(32) NOT NULL,
      row_key VARCHAR(255) NOT NULL,
      note TEXT NOT NULL,
      created_by_operator_key VARCHAR(64) NULL DEFAULT NULL,
      created_by_operator_name VARCHAR(64) NULL DEFAULT NULL,
      updated_by_operator_key VARCHAR(64) NULL DEFAULT NULL,
      updated_by_operator_name VARCHAR(64) NULL DEFAULT NULL,
      deleted_by_operator_key VARCHAR(64) NULL DEFAULT NULL,
      deleted_by_operator_name VARCHAR(64) NULL DEFAULT NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      deleted_at TIMESTAMP(3) NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_dashboard_row_action_notes_row (mode, row_key, deleted_at, created_at),
      KEY idx_dashboard_row_action_notes_mode_id (mode, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const noteOperatorColumns = [
    ['created_by_operator_key', "ALTER TABLE dashboard_row_action_notes ADD COLUMN created_by_operator_key VARCHAR(64) NULL DEFAULT NULL AFTER note"],
    ['created_by_operator_name', "ALTER TABLE dashboard_row_action_notes ADD COLUMN created_by_operator_name VARCHAR(64) NULL DEFAULT NULL AFTER created_by_operator_key"],
    ['updated_by_operator_key', "ALTER TABLE dashboard_row_action_notes ADD COLUMN updated_by_operator_key VARCHAR(64) NULL DEFAULT NULL AFTER created_by_operator_name"],
    ['updated_by_operator_name', "ALTER TABLE dashboard_row_action_notes ADD COLUMN updated_by_operator_name VARCHAR(64) NULL DEFAULT NULL AFTER updated_by_operator_key"],
    ['deleted_by_operator_key', "ALTER TABLE dashboard_row_action_notes ADD COLUMN deleted_by_operator_key VARCHAR(64) NULL DEFAULT NULL AFTER updated_by_operator_name"],
    ['deleted_by_operator_name', "ALTER TABLE dashboard_row_action_notes ADD COLUMN deleted_by_operator_name VARCHAR(64) NULL DEFAULT NULL AFTER deleted_by_operator_key"]
  ];
  for (const [column, ddl] of noteOperatorColumns) {
    const [columns] = await db.query(`SHOW COLUMNS FROM dashboard_row_action_notes LIKE '${column}'`);
    if (!columns.length) await db.query(ddl);
  }

  await db.query(`
    INSERT INTO dashboard_operators (operator_key, operator_name)
    VALUES ('legacy-shixiaofang', '石小芳')
    ON DUPLICATE KEY UPDATE operator_name = VALUES(operator_name)
  `);

  await db.query(`
    INSERT INTO dashboard_row_action_notes (
      mode, row_key, note,
      created_by_operator_key, created_by_operator_name,
      updated_by_operator_key, updated_by_operator_name,
      created_at, updated_at
    )
    SELECT mode, row_key, note,
      'legacy-shixiaofang', '石小芳',
      'legacy-shixiaofang', '石小芳',
      COALESCE(updated_at, created_at, CURRENT_TIMESTAMP(3)), COALESCE(updated_at, created_at, CURRENT_TIMESTAMP(3))
    FROM dashboard_row_actions
    WHERE legacy_note_migrated_at IS NULL
      AND note IS NOT NULL
      AND TRIM(note) <> ''
  `);
  await db.query(`
    UPDATE dashboard_row_actions
    SET legacy_note_migrated_at = CURRENT_TIMESTAMP(3)
    WHERE legacy_note_migrated_at IS NULL
  `);

  await db.query(`
    UPDATE dashboard_row_action_notes
    SET
      created_by_operator_key = COALESCE(created_by_operator_key, 'legacy-shixiaofang'),
      created_by_operator_name = COALESCE(NULLIF(created_by_operator_name, ''), '石小芳'),
      updated_by_operator_key = COALESCE(updated_by_operator_key, created_by_operator_key, 'legacy-shixiaofang'),
      updated_by_operator_name = COALESCE(NULLIF(updated_by_operator_name, ''), NULLIF(created_by_operator_name, ''), '石小芳')
    WHERE created_by_operator_name IS NULL
      OR created_by_operator_name = ''
      OR created_by_operator_key IS NULL
      OR updated_by_operator_name IS NULL
      OR updated_by_operator_name = ''
      OR updated_by_operator_key IS NULL
  `);

  await db.query(`
    UPDATE dashboard_row_actions
    SET
      updated_by_operator_key = COALESCE(updated_by_operator_key, 'legacy-shixiaofang'),
      updated_by_operator_name = COALESCE(NULLIF(updated_by_operator_name, ''), '石小芳')
    WHERE updated_by_operator_name IS NULL
      OR updated_by_operator_name = ''
      OR updated_by_operator_key IS NULL
  `);
}

module.exports = {
  initDashboardSchema
};
