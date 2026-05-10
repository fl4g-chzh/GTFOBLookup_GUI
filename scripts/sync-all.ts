import { syncAllSources } from '../electron/sync/importers'

const main = async () => {
  const { entries, summaries } = await syncAllSources()
  console.table(
    summaries.map((item) => ({
      source: item.source,
      fetched: item.fetched,
      inserted: item.inserted,
      updatedAt: item.updatedAt,
    })),
  )
  console.log(`Total entries: ${entries.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
