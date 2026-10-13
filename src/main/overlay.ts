import { BrowserWindow, ipcMain, screen, shell, type Display } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { dismissSplash } from './splash'

// One transparent overlay per display, keyed by the Electron display id.
const overlayWindows = new Map<number, BrowserWindow>()
// Tracks region-selection mode per overlay (keyed by BrowserWindow id) so the
// click-through toggle is scoped to the window that requested it.
const overlaySelectMode = new Map<number, boolean>()
// The overlay currently showing the settings panel, and the overlay a voice
// session is latched to. Both are app-wide singletons.
let settingsWindowId: number | undefined
let voiceWindow: BrowserWindow | undefined

// The display the user is currently pointing at. Decides which screen a voice
// question is about and where its answer is shown.
export function getTargetDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

export function getVoiceWindow(): BrowserWindow | undefined {
  return voiceWindow
}

export function setVoiceWindow(win: BrowserWindow | undefined): void {
  voiceWindow = win
}

export function isOverlayWindow(win: BrowserWindow | null | undefined): win is BrowserWindow {
  if (!win) return false
  for (const overlay of overlayWindows.values()) {
    if (overlay === win) return true
  }
  return false
}

export function getPrimaryOverlay(): BrowserWindow | undefined {
  const overlay = overlayWindows.get(screen.getPrimaryDisplay().id)
  if (overlay) return overlay
  return [...overlayWindows.values()][0]
}

export function getActiveOverlay(): BrowserWindow | undefined {
  if (overlayWindows.size === 0) return undefined
  return overlayWindows.get(getTargetDisplay().id) ?? getPrimaryOverlay()
}

export function getDisplayForWindow(win: BrowserWindow | null | undefined): Display {
  if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds())
  return getTargetDisplay()
}

export function hasOverlays(): boolean {
  return overlayWindows.size > 0
}

// Shows or hides the settings panel for one overlay. At most one overlay shows
// the panel at a time; opening it on one screen closes it on the others.
function setOverlayDebugVisible(win: BrowserWindow, visible: boolean): void {
  if (win.isDestroyed()) return
  if (visible) {
    for (const overlay of overlayWindows.values()) {
      if (overlay === win || overlay.isDestroyed()) continue
      overlay.webContents.send('overlay:debug-visibility-changed', false)
    }
    settingsWindowId = win.id
    win.show()
    win.focus()
  } else {
    if (settingsWindowId === win.id) settingsWindowId = undefined
    win.blur()
  }
  win.webContents.send('overlay:debug-visibility-changed', visible)
}

export function toggleOverlayDebugVisible(win: BrowserWindow): void {
  setOverlayDebugVisible(win, settingsWindowId !== win.id)
}

// Electron converts the initial bounds of a window that is created directly on
// a display whose DPI scale differs from the primary monitor using the wrong
// scale factor. The overlay then ends up smaller or larger than the display,
// so everything positioned inside it (indicators, toolbars) keeps its aspect
// ratio but lands at the wrong scale. Re-applying the bounds once the window
// has been assigned to the monitor makes Chromium convert them against the
// correct display.
// See electron/electron#31999 and electron/electron#10862.
function fitOverlayToDisplay(overlay: BrowserWindow, display: Display): void {
  if (overlay.isDestroyed()) return
  const { x, y, width, height } = display.bounds
  overlay.setBounds({ x, y, width, height })
}

// The display's scale factor can settle a few frames after the window is first
// shown, and moving the window onto the target monitor is what lets Chromium
// recompute the size against the right scale. Re-assert the bounds a few times
// over the first second so the overlay ends up exactly on the display even if
// the first attempt converted with the old monitor's scale factor.
export function scheduleOverlayFit(overlay: BrowserWindow, display: Display): void {
  fitOverlayToDisplay(overlay, display)
  for (const delay of [100, 300, 700]) {
    setTimeout(() => fitOverlayToDisplay(overlay, display), delay)
  }
}

function createOverlayForDisplay(display: Display): BrowserWindow {
  // Create a transparent overlay that covers this display. Explicit bounds are
  // used instead of `fullscreen` because Windows pins fullscreen windows to a
  // single monitor and ignores bounds.
  const { x, y, width, height } = display.bounds
  const overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  overlayWindows.set(display.id, overlay)
  overlaySelectMode.set(overlay.id, false)

  // Keep the overlay visible locally without including it in supported screen
  // captures. overlay.setContentProtection(true)

  // Use the highest Electron stacking level so the overlay remains above
  // fullscreen applications and regular always-on-top windows.
  overlay.setAlwaysOnTop(true, 'screen-saver')

  // Start click-through. The renderer promotes the window to interactive while
  // the pointer is over the toolbar, panel, or ask bar, and never forces it back
  // itself, so a click is not immediately followed by a pass-through window.
  overlay.setIgnoreMouseEvents(true, { forward: true })
  overlay.setFullScreenable(false)

  // Fix mixed-DPI placement as soon as the window has a monitor, and again over
  // the next second in case the scale factor settles late.
  scheduleOverlayFit(overlay, display)

  overlay.on('ready-to-show', () => {
    // Only the primary overlay restores the settings panel on startup; showing
    // it on every display would produce a wall of duplicate panels.
    if (display.id === screen.getPrimaryDisplay().id) {
      setOverlayDebugVisible(overlay, true)
    }
    fitOverlayToDisplay(overlay, display)
    overlay.show()
    // The overlay has painted, so the splash has done its job.
    dismissSplash()
  })

  overlay.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlay.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlay.loadFile(join(__dirname, '../renderer/index.html'))
  }

  overlay.on('closed', () => {
    overlayWindows.delete(display.id)
    overlaySelectMode.delete(overlay.id)
    if (settingsWindowId === overlay.id) settingsWindowId = undefined
    if (voiceWindow === overlay) voiceWindow = undefined
  })

  return overlay
}

export function createOverlays(): void {
  for (const display of screen.getAllDisplays()) {
    createOverlayForDisplay(display)
  }
}

export function addOverlayForDisplay(display: Display): void {
  if (!overlayWindows.has(display.id)) createOverlayForDisplay(display)
}

export function removeOverlayForDisplay(display: Display): void {
  const overlay = overlayWindows.get(display.id)
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlayWindows.delete(display.id)
}

export function refitOverlayForDisplay(display: Display): void {
  const overlay = overlayWindows.get(display.id)
  if (overlay && !overlay.isDestroyed()) scheduleOverlayFit(overlay, display)
}

// Overlay window IPC is registered once and resolves the target window from the
// sender, so it works for every display without re-registering per window.
export function registerOverlayIpc(): void {
  ipcMain.on('overlay:set-interactive', (event, interactive: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    // Region selection forces interactivity on, so hover-driven updates are
    // ignored while it is active.
    if (
      !isOverlayWindow(win) ||
      overlaySelectMode.get(win.id) ||
      typeof interactive !== 'boolean'
    ) {
      return
    }
    win.setIgnoreMouseEvents(!interactive, { forward: true })
  })

  // Region selection needs the overlay to capture mouse input even while the
  // settings panel is hidden and the window would otherwise be click-through.
  ipcMain.on('overlay:set-select-mode', (event, active: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!isOverlayWindow(win) || typeof active !== 'boolean') {
      return
    }
    overlaySelectMode.set(win.id, active)
    if (active) {
      win.setIgnoreMouseEvents(false)
      win.show()
      win.focus()
    } else {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  // Lets the always-visible toolbar open/close the settings panel without
  // relying on the Ctrl+Shift+Space global shortcut.
  ipcMain.on('overlay:set-debug-visible', (event, visible: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!isOverlayWindow(win) || typeof visible !== 'boolean') {
      return
    }
    setOverlayDebugVisible(win, visible)
  })

  // Tells each overlay which display it covers so the renderer can gate global
  // surfaces (guide, settings) and keep per-display toolbar state.
  ipcMain.handle('overlay:get-info', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const display = getDisplayForWindow(win)
    return { displayId: display.id, isPrimary: display.id === screen.getPrimaryDisplay().id }
  })
}
