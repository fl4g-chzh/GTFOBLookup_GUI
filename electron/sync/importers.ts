import matter from 'gray-matter'
import YAML from 'yaml'
import { z } from 'zod'
import type {
  DetailSection,
  NormalizedEntry,
  OfflineDocument,
  ProxySettings,
  SourceId,
  SyncSummary,
} from '../../src/shared/contracts'
import {
  configureRequestProxy,
  getProxySettingsFromEnv,
  resetRequestProxy,
} from './network'

type GitHubItem = {
  name: string
  download_url: string | null
  type: 'file' | 'dir'
}

const githubItemSchema = z.object({
  name: z.string(),
  download_url: z.string().nullable(),
  type: z.enum(['file', 'dir']),
})

const sourceInfo: Record<SourceId, { title: string; platform: string }> = {
  gtfobins: { title: 'GTFOBins', platform: 'linux' },
  lolbas: { title: 'LOLBAS', platform: 'windows' },
  wadcoms: { title: 'WADComs', platform: 'windows' },
  hijacklibs: { title: 'HijackLibs', platform: 'windows' },
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const withRetries = async <T>(task: () => Promise<T>, label: string, retries = 3): Promise<T> => {
  let lastError: unknown

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await wait(attempt * 750)
      }
    }
  }

  throw new Error(
    `${label} 失败：${lastError instanceof Error ? lastError.message : '未知错误'}`,
  )
}

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = currentIndex
      currentIndex += 1

      if (index >= items.length) {
        return
      }

      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

const fetchJson = async <T>(url: string): Promise<T> => {
  return withRetries(async () => {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GTFOBLookup-GUI',
      },
    })

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status} ${response.statusText} (${url})`)
    }

    return (await response.json()) as T
  }, `JSON 请求 ${url}`)
}

const fetchText = async (url: string): Promise<string> => {
  return withRetries(async () => {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/plain, text/markdown;q=0.9, application/json;q=0.8',
        'User-Agent': 'GTFOBLookup-GUI',
      },
    })

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status} ${response.statusText} (${url})`)
    }

    return response.text()
  }, `文本请求 ${url}`)
}

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return undefined
}

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .flatMap((item) => (typeof item === 'string' ? [item] : typeof item === 'object' && item ? Object.values(item) : []))
    .map(asString)
    .filter((item): item is string => Boolean(item))
}

const asRecordArray = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  )
}

const toSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

const uniq = (items: Array<string | undefined>) =>
  [...new Set(items.filter((item): item is string => Boolean(item)).map((item) => item.trim()).filter(Boolean))]

const formatFieldLabel = (value: string) =>
  value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\bSha256\b/g, 'SHA256')
    .trim()

const formatInlineValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    const items = value.map(formatInlineValue).filter((item): item is string => Boolean(item))
    return items.length ? items.join(', ') : undefined
  }

  return asString(value)
}

const createInlineRecordSummary = (
  record: Record<string, unknown>,
  preferredKeys: string[] = [],
): string | undefined => {
  const keys = uniq([...preferredKeys, ...Object.keys(record)])
  const parts = keys.flatMap((key) => {
    const value = formatInlineValue(record[key])
    if (!value) {
      return []
    }

    return [`${formatFieldLabel(key)}: ${value}`]
  })

  return parts.length ? parts.join(' | ') : undefined
}

const pushDetailSection = (
  sections: DetailSection[],
  title: string,
  items: Array<string | undefined>,
) => {
  const normalizedItems = uniq(items)
  if (normalizedItems.length) {
    sections.push({ title, items: normalizedItems })
  }
}

const pushOfflineDocument = (
  documents: OfflineDocument[],
  title: string,
  content: string | undefined,
  language?: string,
) => {
  const normalizedContent = content?.trim()
  if (!normalizedContent) {
    return
  }

  documents.push({
    title,
    content: normalizedContent,
    language,
  })
}

const createSummary = (source: SourceId, value: unknown) =>
  asString((value as Record<string, unknown> | undefined)?.Description) ??
  asString((value as Record<string, unknown> | undefined)?.description) ??
  `${sourceInfo[source].title} 离线索引条目`

const createReferences = (raw: unknown, fallbackUrl?: string) => {
  const value = raw as Record<string, unknown>
  const resources = Array.isArray(value.Resources) ? value.Resources : []
  const structuredReferences = resources
    .map((item) => {
      const record = item as Record<string, unknown>
      const url = asString(record.Link) ?? asString(record.URL) ?? asString(record.url)
      if (!url) {
        return null
      }

      return {
        label: asString(record.Description) ?? asString(record.label) ?? 'Reference',
        url,
      }
    })
    .filter((item): item is { label: string; url: string } => Boolean(item))

  const resourceLinks = asStringArray(value.Resources).map((url) => ({
    label: 'Resource',
    url,
  }))

  const flatReferences = asStringArray(value.references).map((url) => ({
    label: 'Reference',
    url,
  }))

  const references = [...structuredReferences, ...resourceLinks, ...flatReferences]

  if (fallbackUrl) {
    references.unshift({ label: 'Source', url: fallbackUrl })
  }

  return references
}

const createCommandExamples = (entryId: string, rawCommands: unknown) => {
  if (!Array.isArray(rawCommands)) {
    return []
  }

  return rawCommands.flatMap((item, index) => {
    const record = item as Record<string, unknown>
    const command =
      asString(record.Command) ??
      asString(record.Code) ??
      asString(record.command) ??
      asString(record.code)

    const functionName =
      asString(record.Category) ??
      asString(record.Function) ??
      asString(record.Name) ??
      asString(record.name)

    if (!command && !functionName) {
      return []
    }

    return [
      {
        id: `${entryId}:example:${index + 1}`,
        functionName,
        command,
        description: asString(record.Description) ?? asString(record.Usecase),
        language: 'powershell',
      },
    ]
  })
}

const normalizeSigmaFeedDocument = (rawDocument: string) =>
  rawDocument
    .replace(/^\s*\|\s*replace:[^\n]*title:\s*/m, 'title: ')
    .trim()

const getSigmaDocumentDllName = (record: Record<string, unknown>) => {
  const title = asString(record.title)
  const titleMatch = title?.match(/(?:of|for)\s+([a-z0-9._-]+\.dll)/i)
  if (titleMatch?.[1]) {
    return titleMatch[1].toLowerCase()
  }

  const detection = record.detection as Record<string, unknown> | undefined
  const selection = detection?.selection as Record<string, unknown> | undefined
  if (!selection) {
    return undefined
  }

  for (const value of Object.values(selection)) {
    const text = asString(value)
    const match = text?.match(/([a-z0-9._-]+\.dll)/i)
    if (match?.[1]) {
      return match[1].toLowerCase()
    }
  }

  return undefined
}

const createSigmaFeedMap = async (
  url: string,
  titlePrefix: string,
): Promise<Map<string, OfflineDocument[]>> => {
  const rawFeed = await fetchText(url)
  const documentBlocks = rawFeed
    .split(/^---\s*$/m)
    .map(normalizeSigmaFeedDocument)
    .filter(Boolean)

  const documentsByDll = new Map<string, OfflineDocument[]>()

  for (const block of documentBlocks) {
    try {
      const parsed = YAML.parse(block) as Record<string, unknown> | null
      if (!parsed) {
        continue
      }

      const dllName = getSigmaDocumentDllName(parsed)
      if (!dllName) {
        continue
      }

      const title = asString(parsed.title) ?? titlePrefix
      const description = asString(parsed.description)
      const content = description ? `# ${title}\n\n${description}\n\n${block}` : `# ${title}\n\n${block}`
      const current = documentsByDll.get(dllName) ?? []
      pushOfflineDocument(current, titlePrefix, content, 'yaml')
      documentsByDll.set(dllName, current)
    } catch {
      continue
    }
  }

  return documentsByDll
}

const mergeOfflineDocumentMaps = (...maps: Array<Map<string, OfflineDocument[]>>) => {
  const merged = new Map<string, OfflineDocument[]>()

  for (const map of maps) {
    for (const [dllName, documents] of map.entries()) {
      const current = merged.get(dllName) ?? []
      current.push(...documents)
      merged.set(dllName, current)
    }
  }

  return merged
}

const createMarkdownEntry = (
  source: SourceId,
  slug: string,
  downloadUrl: string,
  content: string,
): NormalizedEntry => {
  const parsed = matter(content)
  const data = parsed.data as Record<string, unknown>
  const title = asString(data.title) ?? slug
  const summary = asString(data.description) ?? `${sourceInfo[source].title} 离线索引条目`
  const tags = uniq([
    ...asStringArray(data.tags),
    ...asStringArray(data.items),
    ...asStringArray(data.services),
    ...asStringArray(data.os),
    ...asStringArray(data.OS),
    ...asStringArray(data.attack_type),
    ...asStringArray(data.attack_types),
    ...asStringArray(data.privilege),
  ])

  const examples = []
  const functions = data.functions as Record<string, unknown> | undefined
  if (functions) {
    for (const [functionName, values] of Object.entries(functions)) {
      if (!Array.isArray(values)) {
        continue
      }

      for (const [index, value] of values.entries()) {
        const record = value as Record<string, unknown>
        examples.push({
          id: `${source}:${slug}:${functionName}:${index + 1}`,
          functionName,
          command: asString(record.code),
          code: asString(record.code),
          description: asString(record.description),
          language: 'bash',
        })
      }
    }
  }

  const directCommand = asString(data.command)
  if (directCommand) {
    examples.push({
      id: `${source}:${slug}:command`,
      functionName: source === 'wadcoms' ? 'command' : undefined,
      command: directCommand,
      code: directCommand,
      description: summary,
      language: source === 'gtfobins' ? 'bash' : 'powershell',
    })
  }

  if (examples.length === 0) {
    const body = parsed.content.trim()
    if (body) {
      examples.push({
        id: `${source}:${slug}:body`,
        description: body,
        code: body,
        language: 'markdown',
      })
    }
  }

  return {
    id: `${source}:${slug}`,
    source,
    slug,
    title,
    category: source === 'wadcoms' ? 'tool' : 'binary',
    platform: sourceInfo[source].platform,
    summary,
    tags,
    techniques: [],
    examples,
    references: createReferences(data, downloadUrl),
    rawUrl: downloadUrl,
    raw: data,
  }
}

const normalizeLolbasRecord = (item: unknown): NormalizedEntry[] => {
  const record = item as Record<string, unknown>
  const title = asString(record.Name) ?? asString(record.name)
  if (!title) {
    return []
  }

  const slug = toSlug(title.replace(/\.exe$/i, ''))
  const entryId = `lolbas:${slug}`
  const examples = createCommandExamples(entryId, record.Commands)
  const tags = uniq([
    ...examples.map((example) => example.functionName),
    ...asStringArray(record.Full_Path),
    asString(record.Type),
  ])
  const techniques = Array.isArray(record.Commands)
    ? record.Commands.flatMap((command) => {
        const itemRecord = command as Record<string, unknown>
        const name = asString(itemRecord.MitreID) ?? asString(itemRecord.MitreId)
        if (!name) {
          return []
        }

        return [{ name, reference: asString(itemRecord.MitreLink) }]
      })
    : []

  return [
    {
      id: entryId,
      source: 'lolbas',
      slug,
      title,
      category: asString(record.Type)?.toLowerCase() ?? 'binary',
      platform: 'windows',
      summary: createSummary('lolbas', record),
      tags,
      techniques,
      examples,
      references: createReferences(record, `https://lolbas-project.github.io/`),
      raw: record,
    },
  ]
}

const createHijackLibsSummary = (
  title: string,
  record: Record<string, unknown>,
  vulnerableExecutables: Array<Record<string, unknown>>,
) => {
  const vendor = asString(record.Vendor)
  const cve = asString(record.CVE)
  const types = uniq(vulnerableExecutables.map((item) => asString(item.Type)))
  const parts = [
    `${title} 可用于 DLL 劫持`,
    vendor ? `厂商 ${vendor}` : undefined,
    types.length ? `类型 ${types.join(' / ')}` : undefined,
    vulnerableExecutables.length ? `涉及 ${vulnerableExecutables.length} 个可执行文件` : undefined,
    cve,
  ]

  return parts.filter((item): item is string => Boolean(item)).join('，')
}

const createHijackLibsExamples = (
  slug: string,
  vulnerableExecutables: Array<Record<string, unknown>>,
) => {
  return vulnerableExecutables.flatMap((executable, index) => {
    const path = asString(executable.Path)
    if (!path) {
      return []
    }

    const notes = uniq([
      asString(executable.Type) ? `类型: ${asString(executable.Type)}` : undefined,
      asString(executable.Variable) ? `变量: ${asString(executable.Variable)}` : undefined,
      asString(executable.Condition) ? `条件: ${asString(executable.Condition)}` : undefined,
      executable.AutoElevate === true ? '自动提权: true' : undefined,
      executable.PrivilegeEscalation === true ? '高权限运行: true' : undefined,
      asStringArray(executable.SHA256).length
        ? `SHA256: ${asStringArray(executable.SHA256).join(', ')}`
        : undefined,
    ])

    return [
      {
        id: `hijacklibs:${slug}:exe:${index + 1}`,
        name: path.split(/[\\/]/).pop() ?? `Executable ${index + 1}`,
        description: [path, ...notes].join(' | '),
      },
    ]
  })
}

const createHijackLibsDetailSections = (
  record: Record<string, unknown>,
  vulnerableExecutables: Array<Record<string, unknown>>,
) => {
  const sections: DetailSection[] = []

  pushDetailSection(sections, '基础信息', [
    asString(record.Vendor) ? `Vendor: ${asString(record.Vendor)}` : undefined,
    asString(record.Author) ? `Author: ${asString(record.Author)}` : undefined,
    asString(record.Created) ? `Created: ${asString(record.Created)}` : undefined,
    asString(record.CVE) ? `CVE: ${asString(record.CVE)}` : undefined,
    asString(record.url) ? `Entry URL: ${asString(record.url)}` : undefined,
  ])

  pushDetailSection(sections, '预期位置', asStringArray(record.ExpectedLocations))
  pushDetailSection(
    sections,
    '劫持类型',
    vulnerableExecutables.map((item) => asString(item.Type)),
  )

  pushDetailSection(
    sections,
    '易受影响可执行文件',
    vulnerableExecutables.map((item) =>
      createInlineRecordSummary(item, [
        'Path',
        'Type',
        'Variable',
        'Condition',
        'AutoElevate',
        'PrivilegeEscalation',
        'SHA256',
      ]),
    ),
  )

  pushDetailSection(
    sections,
    'DLL 版本信息',
    asRecordArray(record.ExpectedVersionInformation).map((item) =>
      createInlineRecordSummary(item, [
        'OriginalFilename',
        'InternalName',
        'FileDescription',
        'ProductName',
        'FileVersion',
        'LegalCopyright',
      ]),
    ),
  )

  pushDetailSection(
    sections,
    'DLL 签名信息',
    asRecordArray(record.ExpectedSignatureInformation).map((item) =>
      createInlineRecordSummary(item, ['Type', 'Subject', 'Issuer']),
    ),
  )

  pushDetailSection(
    sections,
    '可执行文件版本信息',
    vulnerableExecutables.flatMap((executable) => {
      const path = asString(executable.Path) ?? 'Executable'
      return asRecordArray(executable.ExpectedVersionInformation).map((item) => {
        const detail = createInlineRecordSummary(item, [
          'OriginalFilename',
          'InternalName',
          'FileDescription',
          'ProductName',
          'FileVersion',
          'LegalCopyright',
        ])
        return detail ? `${path} | ${detail}` : undefined
      })
    }),
  )

  pushDetailSection(
    sections,
    '可执行文件签名信息',
    vulnerableExecutables.flatMap((executable) => {
      const path = asString(executable.Path) ?? 'Executable'
      return asRecordArray(executable.ExpectedSignatureInformation).map((item) => {
        const detail = createInlineRecordSummary(item, ['Type', 'Subject', 'Issuer'])
        return detail ? `${path} | ${detail}` : undefined
      })
    }),
  )

  pushDetailSection(
    sections,
    '致谢',
    asRecordArray(record.Acknowledgements).map((item) =>
      createInlineRecordSummary(item, ['Name', 'Company', 'Twitter']),
    ),
  )

  pushDetailSection(sections, '资源链接', asStringArray(record.Resources))

  return sections
}

const createHijackLibsOfflineDocuments = (
  title: string,
  record: Record<string, unknown>,
  detailSections: DetailSection[],
  sigmaDocuments: OfflineDocument[],
) => {
  const documents: OfflineDocument[] = []

  const sectionText = detailSections
    .map((section) => `## ${section.title}\n\n${section.items.map((item) => `- ${item}`).join('\n')}`)
    .join('\n\n')

  const resources = asStringArray(record.Resources)
  const acknowledgements = asRecordArray(record.Acknowledgements)
    .map((item) => createInlineRecordSummary(item, ['Name', 'Company', 'Twitter']))
    .filter((item): item is string => Boolean(item))

  const overview = [
    `# ${title}`,
    '',
    asString(record.Vendor) ? `- Vendor: ${asString(record.Vendor)}` : undefined,
    asString(record.Author) ? `- Author: ${asString(record.Author)}` : undefined,
    asString(record.Created) ? `- Created: ${asString(record.Created)}` : undefined,
    asString(record.CVE) ? `- CVE: ${asString(record.CVE)}` : undefined,
    asString(record.url) ? `- Source: ${asString(record.url)}` : undefined,
    '',
    sectionText,
    resources.length ? `\n## Resources\n\n${resources.map((item) => `- ${item}`).join('\n')}` : undefined,
    acknowledgements.length
      ? `\n## Acknowledgements\n\n${acknowledgements.map((item) => `- ${item}`).join('\n')}`
      : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join('\n')

  pushOfflineDocument(documents, '离线总览', overview, 'markdown')
  documents.push(...sigmaDocuments)
  return documents
}

const syncLolbasViaApi = async (): Promise<NormalizedEntry[]> => {
  const payload = await fetchJson<unknown>('https://lolbas-project.github.io/api/lolbas.json')
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown>).lolbas)
      ? ((payload as Record<string, unknown>).lolbas as unknown[])
      : Object.values(payload as Record<string, unknown>)

  return records.flatMap(normalizeLolbasRecord)
}

const syncLolbasViaGithub = async (): Promise<NormalizedEntry[]> => {
  const rootPayload = await fetchJson<unknown>(
    'https://api.github.com/repos/LOLBAS-Project/LOLBAS/contents/yml',
  )
  const rootItems = z.array(githubItemSchema).parse(rootPayload)
  const directories = rootItems.filter((item) => item.type === 'dir')

  const directoryListings = await mapWithConcurrency(directories, 4, async (directory) => {
    const listingPayload = await fetchJson<unknown>(
      `https://api.github.com/repos/LOLBAS-Project/LOLBAS/contents/yml/${directory.name}`,
    )
    return z.array(githubItemSchema).parse(listingPayload)
  })

  const files = directoryListings
    .flat()
    .filter((item) => item.type === 'file' && item.name.toLowerCase().endsWith('.yml'))

  const entries = await mapWithConcurrency(files, 8, async (item) => {
    try {
      if (!item.download_url) {
        return []
      }

      const content = await fetchText(item.download_url)
      const record = YAML.parse(content) as unknown
      return normalizeLolbasRecord(record)
    } catch {
      return []
    }
  })

  return entries.flat()
}

export const syncLolbas = async (): Promise<NormalizedEntry[]> => {
  try {
    return await syncLolbasViaApi()
  } catch {
    return syncLolbasViaGithub()
  }
}

export const syncHijackLibs = async (): Promise<NormalizedEntry[]> => {
  const [payload, sigmaImageMap, sigmaFileMap, sigmaSignatureMap] = await Promise.all([
    fetchJson<unknown>('https://hijacklibs.net/api/hijacklibs.json'),
    createSigmaFeedMap('https://hijacklibs.net/api/sigma_feed_image.yml', 'Sigma: Image Load'),
    createSigmaFeedMap('https://hijacklibs.net/api/sigma_feed_file.yml', 'Sigma: File Write'),
    createSigmaFeedMap(
      'https://hijacklibs.net/api/sigma_feed_signature.yml',
      'Sigma: Signature Mismatch',
    ),
  ])
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown>).hijacklibs)
      ? ((payload as Record<string, unknown>).hijacklibs as unknown[])
      : Object.values(payload as Record<string, unknown>)
  const sigmaDocumentsByDll = mergeOfflineDocumentMaps(
    sigmaImageMap,
    sigmaFileMap,
    sigmaSignatureMap,
  )

  return records.flatMap((item, index) => {
    const record = item as Record<string, unknown>
    const title =
      asString(record.Name) ??
      asString(record.name) ??
      asString(record.DLL) ??
      asString(record.dll) ??
      asString(record.Library) ??
      asString(record.library)

    if (!title) {
      return []
    }

    const slug = toSlug(title)
    const vulnerableExecutables = asRecordArray(
      record.VulnerableExecutables ?? record.Executables,
    )
    const pageUrl = asString(record.url) ?? 'https://hijacklibs.net/'
    const examples = createHijackLibsExamples(slug, vulnerableExecutables)
    const detailSections = createHijackLibsDetailSections(record, vulnerableExecutables)
    const offlineDocuments = createHijackLibsOfflineDocuments(
      title,
      record,
      detailSections,
      sigmaDocumentsByDll.get(title.toLowerCase()) ?? [],
    )
    const executableTypes = uniq(vulnerableExecutables.map((item) => asString(item.Type)))

    return [
      {
        id: `hijacklibs:${slug}:${index + 1}`,
        source: 'hijacklibs',
        slug,
        title,
        category: 'dll',
        platform: 'windows',
        summary: createHijackLibsSummary(title, record, vulnerableExecutables),
        tags: uniq([
          asString(record.Vendor),
          asString(record.Author),
          asString(record.CVE),
          ...asStringArray(record.ExpectedLocations),
          ...executableTypes,
          ...vulnerableExecutables.map((item) => asString(item.Path)),
          ...vulnerableExecutables.map((item) => asString(item.Variable)),
          ...asStringArray(record.Prerequisites),
          ...asStringArray(record.Tags),
          ...asRecordArray(record.Acknowledgements).flatMap((item) => [
            asString(item.Name),
            asString(item.Company),
            asString(item.Twitter),
          ]),
        ]),
        techniques: [],
        examples,
        references: createReferences(record, pageUrl),
        detailSections,
        offlineDocuments,
        rawUrl: pageUrl,
        raw: record,
      },
    ]
  })
}

const syncMarkdownRepo = async (
  source: SourceId,
  apiUrl: string,
  fileFilter: (item: GitHubItem) => boolean,
): Promise<NormalizedEntry[]> => {
  const payload = await fetchJson<unknown>(apiUrl)
  const items = z.array(githubItemSchema).parse(payload)
  const filteredItems = items.filter(fileFilter)
  const entries = await mapWithConcurrency(filteredItems, 8, async (item) => {
    try {
      const downloadUrl = item.download_url
      if (!downloadUrl) {
        return null
      }

      const content = await fetchText(downloadUrl)
      const slug = toSlug(item.name.replace(/\.(md|markdown)$/i, ''))
      return createMarkdownEntry(source, slug, downloadUrl, content)
    } catch {
      return null
    }
  })

  return entries.filter((entry): entry is NormalizedEntry => Boolean(entry))
}

export const syncGTFOBins = () =>
  syncMarkdownRepo(
    'gtfobins',
    'https://api.github.com/repos/GTFOBins/GTFOBins.github.io/contents/_gtfobins',
    (item) => item.type === 'file' && !item.name.startsWith('.'),
  )

export const syncWADComs = () =>
  syncMarkdownRepo(
    'wadcoms',
    'https://api.github.com/repos/WADComs/WADComs.github.io/contents/_wadcoms',
    (item) => item.type === 'file' && item.name.endsWith('.md'),
  )

export const syncAllSources = async (options?: {
  proxySettings?: ProxySettings
}): Promise<{
  entries: NormalizedEntry[]
  summaries: SyncSummary[]
}> => {
  const activeProxySettings = options?.proxySettings ?? getProxySettingsFromEnv()
  configureRequestProxy(activeProxySettings)

  const sources: Array<{ source: SourceId; run: () => Promise<NormalizedEntry[]> }> = [
    { source: 'gtfobins', run: syncGTFOBins },
    { source: 'lolbas', run: syncLolbas },
    { source: 'wadcoms', run: syncWADComs },
    { source: 'hijacklibs', run: syncHijackLibs },
  ]

  const entries: NormalizedEntry[] = []
  const summaries: SyncSummary[] = []

  try {
    for (const item of sources) {
      try {
        const fetched = await item.run()
        entries.push(...fetched)
        summaries.push({
          source: item.source,
          fetched: fetched.length,
          inserted: fetched.length,
          updatedAt: new Date().toISOString(),
        })
      } catch {
        summaries.push({
          source: item.source,
          fetched: 0,
          inserted: 0,
          updatedAt: new Date().toISOString(),
        })
      }
    }
  } finally {
    resetRequestProxy()
  }

  return { entries, summaries }
}
