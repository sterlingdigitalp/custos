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
        source IN ('manual', 'import', 'seed', 'extension', 'aurora')
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
  `)

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
