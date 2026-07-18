import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DatabaseHandle = Database.Database

const DEFAULT_DATABASE_PATH = 'data/custos.db'

export function openDatabase(databasePath = DEFAULT_DATABASE_PATH): DatabaseHandle {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  const db = new Database(databasePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL UNIQUE,
      title TEXT,
      brand TEXT,
      imageUrl TEXT,
      category TEXT,
      rankCategory TEXT,
      addedAt TEXT NOT NULL,
      source TEXT NOT NULL CHECK (
        source IN ('manual', 'import', 'seed', 'extension', 'aurora', 'selleramp')
      ),
      isArchived INTEGER NOT NULL DEFAULT 0 CHECK (isArchived IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      ts TEXT NOT NULL,
      buyBoxPrice REAL,
      lowestNewPrice REAL,
      lowestFbaPrice REAL,
      offerCount INTEGER,
      fbaOfferCount INTEGER,
      salesRank INTEGER,
      rankCategory TEXT
    );

    CREATE INDEX IF NOT EXISTS snapshots_asin_ts_idx ON snapshots (asin, ts);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      ruleType TEXT NOT NULL CHECK (
        ruleType IN (
          'price_below', 'drop_percent', 'back_in_stock',
          'rank_below', 'buybox_change'
        )
      ),
      threshold REAL,
      windowHours REAL NOT NULL DEFAULT 24,
      isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
      cooldownHours REAL NOT NULL DEFAULT 24,
      lastFiredAt TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alertId INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      asin TEXT NOT NULL,
      ts TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
      deliveryError TEXT,
      isRead INTEGER NOT NULL DEFAULT 0 CHECK (isRead IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS seed_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      addedAt TEXT NOT NULL,
      lastRunAt TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lwaClientId TEXT,
      lwaClientSecret TEXT,
      refreshToken TEXT,
      marketplaceId TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
      region TEXT NOT NULL DEFAULT 'na',
      sweepIntervalMin INTEGER NOT NULL DEFAULT 60,
      ntfyTopic TEXT,
      ntfyServer TEXT NOT NULL DEFAULT 'https://ntfy.sh'
    );

    CREATE TABLE IF NOT EXISTS registry_product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL UNIQUE,
      canonical_product_id TEXT NOT NULL UNIQUE,
      registry_version INTEGER,
      created_by_us INTEGER NOT NULL DEFAULT 0 CHECK (created_by_us IN (0, 1)),
      resolved_at TEXT NOT NULL
    );

    -- Transactional outbox for history events (PLATFORM-INTEGRATION.md D5).
    -- Mirrors aurora's platform_outbox. Enqueue is a no-op without Hub config
    -- at the call site; rows only appear when emission is gated on.
    CREATE TABLE IF NOT EXISTS platform_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      envelope TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'poison')) DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      enqueued_at TEXT NOT NULL,
      delivered_at TEXT,
      sequence INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_platform_outbox_status_next_attempt
      ON platform_outbox (status, next_attempt_at);

    -- Materialized daily market aggregates (D8). Raw snapshots remain source
    -- of truth; rollups rebuildable by replay. date is UTC day YYYY-MM-DD.
    CREATE TABLE IF NOT EXISTS daily_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      date TEXT NOT NULL,
      snapshot_count INTEGER NOT NULL,
      buybox_median_cents INTEGER,
      buybox_min_cents INTEGER,
      buybox_max_cents INTEGER,
      lowest_new_median_cents INTEGER,
      lowest_fba_median_cents INTEGER,
      offer_count_median INTEGER,
      fba_offer_count_median INTEGER,
      sales_rank_median INTEGER,
      sales_rank_min INTEGER,
      sales_rank_max INTEGER,
      rank_category TEXT,
      estimated_sales INTEGER,
      emitted_event_id TEXT,
      computed_at TEXT NOT NULL,
      UNIQUE(asin, date)
    );

    -- Rank-spike inference records (history.rank.spike.v1 source).
    -- detected_at = latest snapshot ts that completed the spike pair.
    CREATE TABLE IF NOT EXISTS history_spikes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      rank_before INTEGER NOT NULL,
      rank_after INTEGER NOT NULL,
      rank_category TEXT,
      improvement_percent REAL NOT NULL,
      emitted_event_id TEXT,
      UNIQUE(asin, detected_at)
    );
  `)

  // SQLite cannot extend a CHECK constraint in place. Rebuild early Custos
  // product tables once so existing databases can record SellerAmp provenance.
  const productTable = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'
  `).get() as { sql: string } | undefined
  if (productTable && !productTable.sql.includes("'selleramp'")) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE products RENAME TO products_before_selleramp;

        CREATE TABLE products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asin TEXT NOT NULL UNIQUE,
          title TEXT,
          brand TEXT,
          imageUrl TEXT,
          category TEXT,
          rankCategory TEXT,
          addedAt TEXT NOT NULL,
          source TEXT NOT NULL CHECK (
            source IN ('manual', 'import', 'seed', 'extension', 'aurora', 'selleramp')
          ),
          isArchived INTEGER NOT NULL DEFAULT 0 CHECK (isArchived IN (0, 1))
        );

        INSERT INTO products (
          id, asin, title, brand, imageUrl, category, rankCategory, addedAt, source, isArchived
        )
        SELECT
          id, asin, title, brand, imageUrl, category, rankCategory, addedAt, source, isArchived
        FROM products_before_selleramp;

        DROP TABLE products_before_selleramp;
      `)
    })()
  }

  // The inbox API requires read state even though the initial design's compact
  // alert_events column list omits it. Keep this guarded for early databases.
  const eventColumns = db.pragma('table_info(alert_events)') as Array<{ name: string }>
  if (!eventColumns.some((column) => column.name === 'isRead')) {
    db.exec(`
      ALTER TABLE alert_events ADD COLUMN isRead INTEGER NOT NULL DEFAULT 0
      CHECK (isRead IN (0, 1))
    `)
  }

  db.exec(`
    INSERT OR IGNORE INTO settings (
      id, lwaClientId, lwaClientSecret, refreshToken, marketplaceId, region,
      sweepIntervalMin, ntfyTopic, ntfyServer
    ) VALUES (
      1, NULL, NULL, NULL, 'ATVPDKIKX0DER', 'na', 60, NULL, 'https://ntfy.sh'
    );
  `)

  return db
}

export const openDb = openDatabase
