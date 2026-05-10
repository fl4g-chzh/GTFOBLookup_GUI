export type SourceId = 'gtfobins' | 'lolbas' | 'wadcoms' | 'hijacklibs'

export type EntryExample = {
  id: string
  name?: string
  functionName?: string
  command?: string
  description?: string
  code?: string
  language?: string
}

export type EntryReference = {
  label: string
  url: string
}

export type DetailSection = {
  title: string
  items: string[]
}

export type OfflineDocument = {
  title: string
  content: string
  language?: string
}

export type EntryTechnique = {
  name: string
  reference?: string
}

export type NormalizedEntry = {
  id: string
  source: SourceId
  slug: string
  title: string
  category?: string
  platform?: string
  summary?: string
  tags: string[]
  techniques: EntryTechnique[]
  examples: EntryExample[]
  references: EntryReference[]
  detailSections?: DetailSection[]
  offlineDocuments?: OfflineDocument[]
  rawUrl?: string
  raw?: unknown
}

export type SearchQuery = {
  keyword?: string
  sources?: SourceId[]
  page?: number
  pageSize?: number
}

export type SearchResult = {
  id: string
  source: SourceId
  title: string
  category?: string
  platform?: string
  summary?: string
  tags: string[]
}

export type SearchResponse = {
  items: SearchResult[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export type AppStats = {
  totalEntries: number
  perSource: Record<SourceId, number>
  lastSyncAt?: string
}

export type SyncSummary = {
  source: SourceId
  fetched: number
  inserted: number
  updatedAt: string
}

export type SyncResponse = {
  ok: boolean
  summaries: SyncSummary[]
  error?: string
}

export type ProxySettings = {
  enabled: boolean
  server: string
}

export type ThemeMode = 'system' | 'dark' | 'light'

export type AppSettings = {
  theme: ThemeMode
  proxy: ProxySettings
}

export type LookupApi = {
  search: (query: SearchQuery) => Promise<SearchResponse>
  getEntry: (id: string) => Promise<NormalizedEntry | null>
  getStats: () => Promise<AppStats>
  syncAll: () => Promise<SyncResponse>
  getAppSettings: () => Promise<AppSettings>
  saveAppSettings: (settings: AppSettings) => Promise<AppSettings>
  getProxySettings: () => Promise<ProxySettings>
  saveProxySettings: (settings: ProxySettings) => Promise<ProxySettings>
}
