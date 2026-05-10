import { useEffect, useMemo, useState } from 'react'
import './App.css'
import type {
  AppSettings,
  AppStats,
  NormalizedEntry,
  SearchResponse,
  SourceId,
  ThemeMode,
} from './shared/contracts'

const sourceOptions: Array<{ id: SourceId; label: string }> = [
  { id: 'gtfobins', label: 'GTFOBins' },
  { id: 'lolbas', label: 'LOLBAS' },
  { id: 'wadcoms', label: 'WADComs' },
  { id: 'hijacklibs', label: 'HijackLibs' },
]

const themeOptions: Array<{ id: ThemeMode; label: string; hint: string }> = [
  { id: 'system', label: '跟随系统', hint: '自动匹配系统明暗色' },
  { id: 'dark', label: '深色', hint: '适合暗背景使用' },
  { id: 'light', label: '浅色', hint: '适合亮背景使用' },
]

const defaultSettings: AppSettings = {
  theme: 'system',
  proxy: {
    enabled: false,
    server: '',
  },
}

const PAGE_SIZE = 25

function App() {
  const hasApi = typeof window.lookupApi !== 'undefined'
  const [activeView, setActiveView] = useState<'search' | 'settings'>('search')
  const [keyword, setKeyword] = useState('')
  const [selectedSources, setSelectedSources] = useState<SourceId[]>([])
  const [page, setPage] = useState(1)
  const [searchResponse, setSearchResponse] = useState<SearchResponse>({
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    totalPages: 1,
  })
  const [selectedEntry, setSelectedEntry] = useState<NormalizedEntry | null>(null)
  const [stats, setStats] = useState<AppStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [status, setStatus] = useState(
    hasApi ? '正在加载本地数据库...' : '当前页面未运行在 Electron 容器中。请使用 npm run dev 启动。',
  )

  const activeSources = useMemo(
    () => (selectedSources.length ? selectedSources : undefined),
    [selectedSources],
  )

  const results = searchResponse.items
  const renderedCount = results.length

  const dedupeList = (items: Array<string | undefined>) =>
    [...new Set(items.filter((item): item is string => Boolean(item)))]

  const loadStats = async () => {
    if (!hasApi) {
      return
    }

    const nextStats = await window.lookupApi.getStats()
    setStats(nextStats)
  }

  useEffect(() => {
    if (!hasApi) {
      return
    }

    let cancelled = false

    void (async () => {
      const [nextSettings, nextStats, nextResponse] = await Promise.all([
        window.lookupApi.getAppSettings(),
        window.lookupApi.getStats(),
        window.lookupApi.search({
          keyword: '',
          page: 1,
          pageSize: PAGE_SIZE,
        }),
      ])

      if (cancelled) {
        return
      }

      setSettings(nextSettings)
      setStats(nextStats)
      setSearchResponse(nextResponse)

      if (!nextResponse.items.length) {
        setSelectedEntry(null)
        setStatus('没有匹配结果，可以尝试切换来源或执行同步。')
        return
      }

      const firstItem = nextResponse.items[0]
      const detail = firstItem ? await window.lookupApi.getEntry(firstItem.id) : null
      if (cancelled) {
        return
      }

      setSelectedEntry(detail)
      setStatus(`共匹配 ${nextResponse.total} 条结果。`)
    })()

    return () => {
      cancelled = true
    }
  }, [hasApi])

  useEffect(() => {
    if (!hasApi) {
      return
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const nextResponse = await window.lookupApi.search({
          keyword,
          sources: activeSources,
          page,
          pageSize: PAGE_SIZE,
        })
        setSearchResponse(nextResponse)
        if (nextResponse.page !== page) {
          setPage(nextResponse.page)
        }

        if (!nextResponse.items.length) {
          setSelectedEntry(null)
          setStatus('没有匹配结果，可以尝试切换来源或执行同步。')
          return
        }

        const shouldKeepCurrent = nextResponse.items.some((item) => item.id === selectedEntry?.id)
        const targetId = shouldKeepCurrent ? selectedEntry?.id : nextResponse.items[0]?.id
        const detail = targetId ? await window.lookupApi.getEntry(targetId) : null
        setSelectedEntry(detail)

        if (nextResponse.totalPages > 1) {
          setStatus(
            `共匹配 ${nextResponse.total} 条，当前第 ${nextResponse.page} / ${nextResponse.totalPages} 页。`,
          )
          return
        }

        setStatus(`共匹配 ${nextResponse.total} 条结果。`)
      })()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [activeSources, hasApi, keyword, page, selectedEntry?.id])

  const toggleSource = (source: SourceId) => {
    setSelectedSources((current) =>
      current.includes(source) ? current.filter((item) => item !== source) : [...current, source],
    )
    setPage(1)
  }

  const openEntry = async (id: string) => {
    if (!hasApi) {
      return
    }

    const detail = await window.lookupApi.getEntry(id)
    setSelectedEntry(detail)
  }

  const goToPage = (nextPage: number) => {
    const clampedPage = Math.min(Math.max(1, nextPage), searchResponse.totalPages)
    if (clampedPage !== searchResponse.page) {
      setPage(clampedPage)
    }
  }

  const syncAll = async () => {
    if (!hasApi) {
      return
    }

    setBusy(true)
    setStatus('正在同步四个数据源，请稍候...')
    const response = await window.lookupApi.syncAll()
    setBusy(false)

    if (!response.ok) {
      setStatus(response.error ?? '同步失败')
      return
    }

    await loadStats()
    const nextResponse = await window.lookupApi.search({
      keyword,
      sources: activeSources,
      page: 1,
      pageSize: PAGE_SIZE,
    })
    setPage(1)
    setSearchResponse(nextResponse)
    if (nextResponse.items.length) {
      const detail = await window.lookupApi.getEntry(nextResponse.items[0].id)
      setSelectedEntry(detail)
    }
    setStatus(
      `同步完成：${response.summaries.map((item) => `${item.source} ${item.inserted}`).join(' / ')}`,
    )
  }

  const saveAppSettings = async () => {
    if (!hasApi) {
      return
    }

    if (settings.proxy.enabled && !settings.proxy.server.trim()) {
      setStatus('已启用代理时，代理地址不能为空。')
      return
    }

    setSettingsBusy(true)
    const saved = await window.lookupApi.saveAppSettings({
      theme: settings.theme,
      proxy: {
        enabled: settings.proxy.enabled,
        server: settings.proxy.server.trim(),
      },
    })
    setSettingsBusy(false)
    setSettings(saved)
    setStatus(
      saved.proxy.enabled && saved.proxy.server
        ? `设置已保存，当前代理：${saved.proxy.server}`
        : `设置已保存，当前主题：${themeOptions.find((item) => item.id === saved.theme)?.label ?? saved.theme}`,
    )
  }

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = () => {
      const nextTheme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme
      root.dataset.theme = nextTheme
      root.dataset.themeMode = settings.theme
    }

    applyTheme()
    media.addEventListener('change', applyTheme)

    return () => {
      media.removeEventListener('change', applyTheme)
    }
  }, [settings.theme])

  const pageStart = searchResponse.total === 0 ? 0 : (searchResponse.page - 1) * searchResponse.pageSize + 1
  const pageEnd = pageStart === 0 ? 0 : pageStart + renderedCount - 1
  const paginationItems = (() => {
    const pages = new Set<number>([1, searchResponse.totalPages, searchResponse.page - 1, searchResponse.page, searchResponse.page + 1])
    const sortedPages = [...pages]
      .filter((value) => value >= 1 && value <= searchResponse.totalPages)
      .sort((left, right) => left - right)

    const items: Array<number | string> = []
    for (const [index, pageNumber] of sortedPages.entries()) {
      const previousPage = sortedPages[index - 1]
      if (typeof previousPage === 'number' && pageNumber - previousPage > 1) {
        items.push(`ellipsis-${previousPage}-${pageNumber}`)
      }
      items.push(pageNumber)
    }

    return items
  })()

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <h1>GTFOBLookup</h1>
        </div>
        <div className="topbar-actions">
          <div className="view-switcher" role="tablist" aria-label="页面切换">
            <button
              type="button"
              className={activeView === 'search' ? 'switch-button active' : 'switch-button'}
              onClick={() => setActiveView('search')}
            >
              检索
            </button>
            <button
              type="button"
              className={activeView === 'settings' ? 'switch-button active' : 'switch-button'}
              onClick={() => setActiveView('settings')}
            >
              设置
            </button>
          </div>
          <div className="meta-chip">
            <span>上次同步</span>
            <strong>{stats?.lastSyncAt ? new Date(stats.lastSyncAt).toLocaleString() : '未同步'}</strong>
          </div>
          <button type="button" className="primary-button" onClick={syncAll} disabled={busy || !hasApi}>
            {busy ? '同步中...' : '同步数据'}
          </button>
        </div>
      </header>

      <section className="stats-strip">
        <article className="stat-pill stat-pill-primary">
          <span>总条目</span>
          <strong>{stats?.totalEntries ?? '-'}</strong>
        </article>
        {sourceOptions.map((source) => (
          <article className="stat-pill" key={source.id}>
            <span>{source.label}</span>
            <strong>{stats?.perSource[source.id] ?? 0}</strong>
          </article>
        ))}
      </section>

      {activeView === 'search' ? (
        <section className="search-stage">
          <div className="search-stage-inner">
            <label className="search-field search-field-centered">
              <input
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value)
                  setPage(1)
                }}
                placeholder="名称、摘要、标签、来源"
              />
            </label>
            <div className="source-panel source-panel-centered">
              <span>数据源</span>
              <div className="source-pills">
                {sourceOptions.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={selectedSources.includes(source.id) ? 'pill active' : 'pill'}
                    onClick={() => toggleSource(source.id)}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="settings-layout">
          <article className="settings-card">
            <div className="panel-title settings-title">
              <div>
                <h2>设置</h2>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label-group">
                <span>主题模式</span>
              </div>
              <div className="theme-grid">
                {themeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={settings.theme === option.id ? 'theme-option active' : 'theme-option'}
                    onClick={() => setSettings((current) => ({ ...current, theme: option.id }))}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <div className="proxy-head">
                <div className="settings-label-group">
                  <span>同步代理</span>
                </div>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings.proxy.enabled}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        proxy: { ...current.proxy, enabled: event.target.checked },
                      }))
                    }
                  />
                  <span>启用代理</span>
                </label>
              </div>
              <div className="proxy-controls">
                <input
                  value={settings.proxy.server}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      proxy: { ...current.proxy, server: event.target.value },
                    }))
                  }
                  placeholder="http://127.0.0.1:7890"
                  disabled={!settings.proxy.enabled}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={saveAppSettings}
                  disabled={settingsBusy || !hasApi}
                >
                  {settingsBusy ? '保存中...' : '保存设置'}
                </button>
              </div>
            </div>
          </article>
        </section>
      )}

      {activeView === 'search' ? (
        <p className="status-line">
          {status}
        </p>
      ) : null}

      {activeView === 'search' ? (
        <section className="workspace">
          <aside className="results-panel">
            <div className="panel-title results-header">
              <div>
                <h2>结果</h2>
                <p>
                  共 {searchResponse.total} 条，第 {searchResponse.page} / {searchResponse.totalPages} 页
                  {renderedCount ? `，当前 ${pageStart}-${pageEnd}` : ''}
                </p>
              </div>
            </div>
            <div className="results-list">
              {results.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={selectedEntry?.id === item.id ? 'result-card selected' : 'result-card'}
                  onClick={() => void openEntry(item.id)}
                >
                  <div className="result-row">
                    <div className="result-main">
                      <div className="result-head">
                        <strong>{item.title}</strong>
                        <span>[{item.source}]</span>
                      </div>
                      <p className="result-summary">{item.summary ?? '暂无摘要'}</p>
                    </div>
                    <div className="result-tags">
                      {dedupeList([item.platform, item.category, ...item.tags]).slice(0, 4).map((tag) => (
                        <span className="tag" key={`${item.id}:${tag}`}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            {searchResponse.totalPages > 1 ? (
              <div className="pagination-bar">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => goToPage(searchResponse.page - 1)}
                  disabled={searchResponse.page <= 1}
                >
                  上一页
                </button>
                <div className="pagination-pages">
                  {paginationItems.map((item) =>
                    typeof item === 'number' ? (
                      <button
                        key={item}
                        type="button"
                        className={item === searchResponse.page ? 'page-button active' : 'page-button'}
                        onClick={() => goToPage(item)}
                      >
                        {item}
                      </button>
                    ) : (
                      <span key={item} className="pagination-ellipsis" aria-hidden="true">
                        ...
                      </span>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => goToPage(searchResponse.page + 1)}
                  disabled={searchResponse.page >= searchResponse.totalPages}
                >
                  下一页
                </button>
              </div>
            ) : null}
          </aside>

          <section className="detail-panel">
            {selectedEntry ? (
              <>
                <div className="panel-title">
                  <div>
                    <p className="detail-source">[{selectedEntry.source}]</p>
                    <h2>{selectedEntry.title}</h2>
                  </div>
                </div>

                <p className="detail-summary">{selectedEntry.summary ?? '暂无摘要'}</p>

                <div className="detail-meta">
                  {dedupeList([selectedEntry.platform, selectedEntry.category, ...selectedEntry.tags]).map((tag) => (
                    <span className="tag" key={`${selectedEntry.id}:${tag}`}>
                      {tag}
                    </span>
                  ))}
                </div>

                {selectedEntry.detailSections?.length ? (
                  <section className="detail-section">
                    <h3>离线详情</h3>
                    <div className="detail-sections-grid">
                      {selectedEntry.detailSections.map((section) => (
                        <article
                          className="detail-section-card"
                          key={`${selectedEntry.id}:${section.title}`}
                        >
                          <h4>{section.title}</h4>
                          <div className="detail-section-items">
                            {section.items.map((item, index) => (
                              <p className="detail-section-item" key={`${selectedEntry.id}:${section.title}:${index + 1}`}>
                                {item}
                              </p>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}

                {selectedEntry.offlineDocuments?.length ? (
                  <section className="detail-section">
                    <h3>离线文档</h3>
                    <div className="offline-documents">
                      {selectedEntry.offlineDocuments.map((document, index) => (
                        <article
                          className="offline-document-card"
                          key={`${selectedEntry.id}:${document.title}:${index + 1}`}
                        >
                          <div className="example-head">
                            <strong>{document.title}</strong>
                            {document.language ? <span>{document.language}</span> : null}
                          </div>
                          <pre>{document.content}</pre>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className="detail-section">
                  <h3>示例</h3>
                  {selectedEntry.examples.length ? (
                    selectedEntry.examples.map((example) => (
                      <article className="example-card" key={example.id}>
                        <div className="example-head">
                          <strong>{example.functionName ?? example.name ?? 'Example'}</strong>
                          {example.language ? <span>{example.language}</span> : null}
                        </div>
                        {example.description ? <p>{example.description}</p> : null}
                        {example.command || example.code ? (
                          <pre>{example.command ?? example.code}</pre>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <p>暂无示例。</p>
                  )}
                </section>

                <section className="detail-section">
                  <h3>链接</h3>
                  {selectedEntry.references.length ? (
                    <div className="links-list">
                      {selectedEntry.references.map((reference) => (
                        <a
                          key={`${selectedEntry.id}:${reference.url}`}
                          href={reference.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {reference.label}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p>当前条目没有额外链接。</p>
                  )}
                </section>
              </>
            ) : (
              <div className="empty-state">
                <h2>未选择条目</h2>
                <p>从左侧结果列表选择一项。</p>
              </div>
            )}
          </section>
        </section>
      ) : null}
    </main>
  )
}

export default App
