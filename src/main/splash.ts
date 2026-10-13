import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'

// A small, frame-less window shown while the overlay renderer boots. It loads a
// lightweight static page (src/renderer/splash.html) so it appears before the
// heavier React overlay bundle is ready.
//
// Note: `ready-to-show` is unreliable for transparent windows that are not
// fullscreen, so the splash is revealed from `did-finish-load` too. A minimum
// visible time keeps it from flashing away before a user can register it.
const SPLASH_MIN_VISIBLE_MS = 1500

let splashWindow: BrowserWindow | undefined
let splashShownAt = 0

export function createSplashWindow(): void {
  if (splashWindow) return

  const splash = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    hasShadow: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      sandbox: false
    }
  })

  // Keep the splash above the overlay (which also uses the screen-saver level)
  // until it is closed.
  splash.setAlwaysOnTop(true, 'screen-saver')
  splashWindow = splash

  const revealSplash = (): void => {
    if (splash.isDestroyed() || splash.isVisible()) return
    if (!splashShownAt) splashShownAt = Date.now()
    // showInactive keeps the fullscreen overlay's focus intact.
    splash.showInactive()
  }

  // Whichever fires first wins; `ready-to-show` avoids a flash of empty space
  // where it works, `did-finish-load` covers transparent windows where it does.
  splash.once('ready-to-show', revealSplash)
  splash.webContents.once('did-finish-load', revealSplash)

  splash.on('closed', () => {
    if (splashWindow === splash) splashWindow = undefined
  })

  // Load the static splash straight from disk in both dev and production. It is
  // self-contained, so there is no reason to fetch it through the renderer dev
  // server, which can take seconds to answer its first request while it compiles
  // the overlay bundle.
  const splashFile = is.dev
    ? join(app.getAppPath(), 'src/renderer/splash.html')
    : join(__dirname, '../renderer/splash.html')
  void splash.loadFile(splashFile)
}

// Closes the splash once the overlay is up, but never sooner than the minimum
// visible time measured from when the splash actually appeared.
export function dismissSplash(): void {
  if (!splashWindow) return
  const remaining = splashShownAt
    ? Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAt))
    : 0
  if (remaining === 0) {
    closeSplash()
    return
  }
  setTimeout(closeSplash, remaining)
}

export function closeSplash(): void {
  const splash = splashWindow
  splashWindow = undefined
  splashShownAt = 0
  if (splash && !splash.isDestroyed()) splash.close()
}
