import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import type {
  AppSettings,
  AppStats,
  NormalizedEntry,
  ProxySettings,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SourceId,
  SyncSummary,
  ThemeMode,
} from '../../src/shared/contracts'
import { seedEntries } from './seed'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  platform TEXT,
  summary TEXT,
  tags_text TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_title ON entries(title);
`

type CountRow = { source: SourceId; total: number }

const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  enabled: false,
  server: '',
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  proxy: DEFAULT_PROXY_SETTINGS,
}

export class DatabaseService {
  private sql?: SqlJsStatic
  private db?: Database
  private readonly dbPath = path.join(app.getPath('userData'), 'lookup.sqlite')

  async init() {
    if (this.db) {
      return
    }

    const wasmBase = path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')
    this.sql = await initSqlJs({
      locateFile: (file: string) => path.join(wasmBase, file),
    })

    if (fs.existsSync(this.dbPath)) {
      this.db = new this.sql.Database(fs.readFileSync(this.dbPath))
    } else {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
      this.db = new this.sql.Database()
    }

    this.db.exec(SCHEMA_SQL)

    if (this.getTotalEntries() === 0) {
      this.replaceAllEntries(seedEntries, [])
    }
  }

  search(query: SearchQuery): SearchResponse {
    const db = this.requireDb()
    const sources = query.sources?.length ? query.sources : null
    const keyword = query.keyword?.trim().toLowerCase() ?? ''
    const keywordLike = `%${keyword}%`
    const pageSize = Math.max(1, Math.min(200, Math.floor(query.pageSize ?? 25)))
    const page = Math.max(1, Math.floor(query.page ?? 1))

    const clauses = [
      keyword
        ? `(lower(title) LIKE $keyword OR lower(coalesce(summary, '')) LIKE $keyword OR lower(tags_text) LIKE $keyword OR lower(source) LIKE $keyword)`
        : '1 = 1',
    ]

    if (sources) {
      clauses.push(`source IN (${sources.map((_, index) => `$source${index}`).join(', ')})`)
    }

    const whereClause = clauses.join(' AND ')

    const countSql = `
      SELECT COUNT(*) AS total
      FROM entries
      WHERE ${whereClause};
    `

    const countStatement = db.prepare(countSql)
    countStatement.bind({
      $keyword: keywordLike,
      ...Object.fromEntries((sources ?? []).map((source, index) => [`$source${index}`, source])),
    })
    const total = countStatement.step()
      ? Number((countStatement.getAsObject() as Record<string, string | number>).total)
      : 0
    countStatement.free()
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1
    const normalizedPage = Math.min(page, totalPages)
    const offset = (normalizedPage - 1) * pageSize

    const sql = `
      SELECT id, source, title, category, platform, summary, tags_text
      FROM entries
      WHERE ${whereClause}
      ORDER BY title COLLATE NOCASE ASC
      LIMIT $limit OFFSET $offset;
    `

    const statement = db.prepare(sql)
    statement.bind({
      $keyword: keywordLike,
      $limit: pageSize,
      $offset: offset,
      ...Object.fromEntries((sources ?? []).map((source, index) => [`$source${index}`, source])),
    })

    const results: SearchResult[] = []
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, string | null>
      results.push({
        id: String(row.id),
        source: row.source as SourceId,
        title: String(row.title),
        category: row.category ?? undefined,
        platform: row.platform ?? undefined,
        summary: row.summary ?? undefined,
        tags: this.parseTags(row.tags_text),
      })
    }
    statement.free()
    return {
      items: results,
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
    }
  }

  getEntry(id: string): NormalizedEntry | null {
    const db = this.requireDb()
    const statement = db.prepare('SELECT entry_json FROM entries WHERE id = $id LIMIT 1;')
    statement.bind({ $id: id })
    const hasRow = statement.step()
    if (!hasRow) {
      statement.free()
      return null
    }

    const row = statement.getAsObject() as Record<string, string>
    statement.free()
    return JSON.parse(row.entry_json) as NormalizedEntry
  }

  getStats(): AppStats {
    const db = this.requireDb()
    const totalRow = db.exec('SELECT COUNT(*) AS total FROM entries;')
    const totalEntries = Number(totalRow[0]?.values[0]?.[0] ?? 0)

    const perSource: AppStats['perSource'] = {
      gtfobins: 0,
      lolbas: 0,
      wadcoms: 0,
      hijacklibs: 0,
    }

    const statement = db.prepare(
      'SELECT source, COUNT(*) AS total FROM entries GROUP BY source ORDER BY source ASC;',
    )
    while (statement.step()) {
      const row = statement.getAsObject() as unknown as CountRow
      perSource[row.source] = Number(row.total)
    }
    statement.free()

    const metaStatement = db.prepare("SELECT value FROM meta WHERE key = 'lastSyncAt' LIMIT 1;")
    const lastSyncAt = metaStatement.step()
      ? String((metaStatement.getAsObject() as Record<string, string>).value)
      : undefined
    metaStatement.free()

    return { totalEntries, perSource, lastSyncAt }
  }

  getProxySettings(): ProxySettings {
    return this.getAppSettings().proxy
  }

  getAppSettings(): AppSettings {
    const db = this.requireDb()
    const statement = db.prepare("SELECT value FROM meta WHERE key = 'appSettings' LIMIT 1;")
    const hasRow = statement.step()
    if (hasRow) {
      const row = statement.getAsObject() as Record<string, string>
      statement.free()

      try {
        return this.normalizeAppSettings(JSON.parse(row.value) as Partial<AppSettings>)
      } catch {
        return DEFAULT_APP_SETTINGS
      }
    }

    statement.free()

    const legacyStatement = db.prepare("SELECT value FROM meta WHERE key = 'proxySettings' LIMIT 1;")
    const hasLegacyRow = legacyStatement.step()
    if (!hasLegacyRow) {
      legacyStatement.free()
      return DEFAULT_APP_SETTINGS
    }

    const legacyRow = legacyStatement.getAsObject() as Record<string, string>
    legacyStatement.free()

    try {
      const parsed = JSON.parse(legacyRow.value) as Partial<ProxySettings>
      return this.normalizeAppSettings({ proxy: parsed })
    } catch {
      return DEFAULT_APP_SETTINGS
    }
  }

  saveProxySettings(settings: ProxySettings): ProxySettings {
    const saved = this.saveAppSettings({
      ...this.getAppSettings(),
      proxy: settings,
    })
    return saved.proxy
  }

  saveAppSettings(settings: AppSettings): AppSettings {
    const normalized = this.normalizeAppSettings(settings)
    this.upsertMeta('appSettings', JSON.stringify(normalized))
    this.upsertMeta('proxySettings', JSON.stringify(normalized.proxy))
    this.persist()
    return normalized
  }

  replaceAllEntries(entries: NormalizedEntry[], summaries: SyncSummary[]) {
    const db = this.requireDb()
    const timestamp = new Date().toISOString()
    const currentSettings = this.getAppSettings()

    db.exec('BEGIN TRANSACTION;')
    db.exec('DELETE FROM entries;')
    db.exec("DELETE FROM meta WHERE key NOT IN ('appSettings', 'proxySettings');")

    const statement = db.prepare(`
      INSERT INTO entries (
        id, source, slug, title, category, platform, summary, tags_text, entry_json, updated_at
      ) VALUES (
        $id, $source, $slug, $title, $category, $platform, $summary, $tagsText, $entryJson, $updatedAt
      );
    `)

    for (const entry of entries) {
      statement.run({
        $id: entry.id,
        $source: entry.source,
        $slug: entry.slug,
        $title: entry.title,
        $category: entry.category ?? null,
        $platform: entry.platform ?? null,
        $summary: entry.summary ?? null,
        $tagsText: entry.tags.join(', '),
        $entryJson: JSON.stringify(entry),
        $updatedAt: timestamp,
      })
    }
    statement.free()

    this.upsertMeta('lastSyncAt', timestamp)
    this.upsertMeta('lastSyncSummaries', JSON.stringify(summaries))
    this.upsertMeta('appSettings', JSON.stringify(currentSettings))
    this.upsertMeta('proxySettings', JSON.stringify(currentSettings.proxy))

    db.exec('COMMIT;')
    this.persist()
  }

  persist() {
    const db = this.requireDb()
    fs.writeFileSync(this.dbPath, Buffer.from(db.export()))
  }

  private getTotalEntries(): number {
    const db = this.requireDb()
    const row = db.exec('SELECT COUNT(*) AS total FROM entries;')
    return Number(row[0]?.values[0]?.[0] ?? 0)
  }

  private parseTags(raw: string | null | undefined) {
    return (raw ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  private normalizeAppSettings(settings: {
    theme?: unknown
    proxy?: Partial<ProxySettings> | null
  }): AppSettings {
    return {
      theme: this.normalizeTheme(settings.theme),
      proxy: {
        enabled: Boolean(settings.proxy?.enabled),
        server: typeof settings.proxy?.server === 'string' ? settings.proxy.server.trim() : '',
      },
    }
  }

  private normalizeTheme(theme: unknown): ThemeMode {
    if (theme === 'dark' || theme === 'light' || theme === 'system') {
      return theme
    }

    return DEFAULT_APP_SETTINGS.theme
  }

  private upsertMeta(key: string, value: string) {
    const db = this.requireDb()
    const statement = db.prepare(`
      INSERT INTO meta (key, value)
      VALUES ($key, $value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `)
    statement.run({
      $key: key,
      $value: value,
    })
    statement.free()
  }

  private requireDb() {
    if (!this.db) {
      throw new Error('DatabaseService 尚未初始化')
    }

    return this.db
  }
}

export const databaseService = new DatabaseService()
