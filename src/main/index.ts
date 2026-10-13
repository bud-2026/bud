import { app, globalShortcut, screen } from 'electron'
import { join } from 'path'
import dotenv from 'dotenv'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { startLocalVlm, stopLocalVlm } from './localVlm'
import {
  addOverlayForDisplay,
  createOverlays,
  getActiveOverlay,
  getPrimaryOverlay,
  hasOverlays,
  refitOverlayForDisplay,
  removeOverlayForDisplay,
  toggleOverlayDebugVisible
} from './overlay'
import { getVoiceEnabled, migrateLegacyAISettings } from './settings'
import { closeSplash, createSplashWindow } from './splash'
import { startTTSBackend, stopTTSBackend } from './tts'
import { startVoiceBackend, stopVoiceBackend } from './voice'

dotenv.config({ path: join(app.getAppPath(), '.env') })

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Show the splash first so something is on screen while the overlay renderer
  // and its backends spin up.
  createSplashWindow()
  migrateLegacyAISettings()
  void startTTSBackend()
  startLocalVlm()
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createOverlays()

  // Keep one overlay per connected display as monitors are plugged, unplugged,
  // or reconfigured.
  screen.on('display-added', (_event, display) => addOverlayForDisplay(display))
  screen.on('display-removed', (_event, display) => removeOverlayForDisplay(display))
  screen.on('display-metrics-changed', (_event, display) => refitOverlayForDisplay(display))

  // Toggle the settings panel on the display under the cursor.
  if (
    !globalShortcut.register('CommandOrControl+Shift+Space', () => {
      const overlay = getActiveOverlay()
      if (overlay) toggleOverlayDebugVisible(overlay)
    })
  ) {
    console.error('Could not register debug visibility shortcut: Ctrl+Shift+Space')
  }

  const primaryOverlay = getPrimaryOverlay()
  if (primaryOverlay) {
    primaryOverlay.webContents.once('did-finish-load', () => {
      if (getVoiceEnabled()) {
        startVoiceBackend()
      }
    })
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (!hasOverlays()) createOverlays()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  closeSplash()
  stopTTSBackend()
  stopVoiceBackend()
  stopLocalVlm()
})
