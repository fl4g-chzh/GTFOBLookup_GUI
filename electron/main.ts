import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { databaseService } from './database/service'
import { syncAllSources } from './sync/importers'
import type { AppSettings, ProxySettings, SearchQuery, SyncResponse } from '../src/shared/contracts'

const createWindow = async () => {
  await databaseService.init()
  const packagedIconPath = path.join(app.getAppPath(), 'build', 'icon.ico')
  const devIconPath = path.join(app.getAppPath(), 'build', 'icon.ico')

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    icon: process.env.VITE_DEV_SERVER_URL ? devIconPath : packagedIconPath,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    await window.loadFile(path.join(app.getAppPath(), 'app-dist', 'index.html'))
  }
}

const registerIpc = () => {
  ipcMain.handle('lookup:search', async (_event, query: SearchQuery) => databaseService.search(query))
  ipcMain.handle('lookup:get-entry', async (_event, id: string) => databaseService.getEntry(id))
  ipcMain.handle('lookup:get-stats', async () => databaseService.getStats())
  ipcMain.handle('lookup:get-app-settings', async () => databaseService.getAppSettings())
  ipcMain.handle('lookup:save-app-settings', async (_event, settings: AppSettings) =>
    databaseService.saveAppSettings(settings),
  )
  ipcMain.handle('lookup:get-proxy-settings', async () => databaseService.getProxySettings())
  ipcMain.handle('lookup:save-proxy-settings', async (_event, settings: ProxySettings) =>
    databaseService.saveProxySettings(settings),
  )
  ipcMain.handle('lookup:sync-all', async (): Promise<SyncResponse> => {
    try {
      const proxySettings = databaseService.getAppSettings().proxy
      const { entries, summaries } = await syncAllSources({ proxySettings })
      databaseService.replaceAllEntries(entries, summaries)
      return { ok: true, summaries }
    } catch (error) {
      return {
        ok: false,
        summaries: [],
        error: error instanceof Error ? error.message : '同步失败',
      }
    }
  })
}

app.whenReady().then(async () => {
  registerIpc()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
