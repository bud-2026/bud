import {
  app,
  shell,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen
} from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { findFreePort } from './freePort'
import {
  VL_MODEL_ALIAS,
  ensureLocalVlmReady,
  getLocalVlmBaseUrl,
  getVlStatus,
  startLocalVlm,
  stopLocalVlm
} from './localVlm'

dotenv.config({ path: join(app.getAppPath(), '.env') })

// Placeholder the OpenAI client requires; the bundled llama-server ignores it.
const LOCAL_VLM_API_KEY = 'local'

// Chosen at launch so the bundled TTS backend never clashes on a fixed port.
let ttsBaseUrl: string | undefined
const screenCaptureMaxDimension = 1920
const packagedBackendDirectory = join(process.resourcesPath, 'python')
const TTS_HEALTH_TIMEOUT_MS = 120_000
// Pocket-TTS built-in voice used until the user picks another one.
const DEFAULT_TTS_VOICE = 'jane'
let ttsProcess: ChildProcess | undefined
let voiceProcess: ChildProcess | undefined
let mainWindowRef: BrowserWindow | undefined
let splashWindow: BrowserWindow | undefined
let isStoppingTts = false
let isStoppingVoice = false

// Dashboard-facing provisioning state for the speech backends. Mirrors the
// phase model used by the bundled vision server so the settings panel can
// render every component the same way.
type BackendPhase = 'pending' | 'downloading' | 'loading' | 'starting' | 'ready' | 'error' | 'off'

interface BackendComponentStatus {
  phase: BackendPhase
  /** What is currently happening, e.g. the file being downloaded or loaded. */
  detail?: string
  /** Human readable failure reason when phase is 'error'. */
  message?: string
}

interface SttStatusSnapshot {
  /** openwakeword wake word detector. */
  wakeWord: BackendComponentStatus
  /** Moonshine speech recognizer (loads on first use). */
  transcription: BackendComponentStatus
}

interface VoiceBackendEvent {
  event: string
  text?: string
  final?: boolean
  end_session?: boolean
  message?: string
  wake_word?: string
  auto?: boolean
  phase?: string
}

const VOICE_OFF_STATUS: BackendComponentStatus = { phase: 'off', detail: 'Voice is off' }

let sttStatus: SttStatusSnapshot = {
  wakeWord: { ...VOICE_OFF_STATUS },
  transcription: { ...VOICE_OFF_STATUS }
}
let ttsStatus: BackendComponentStatus = { phase: 'pending' }

function broadcast(channel: string, status: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, status)
  }
}

function setSttStatus(status: SttStatusSnapshot): void {
  sttStatus = status
  broadcast('stt:status', status)
}

function setTtsStatus(status: BackendComponentStatus): void {
  ttsStatus = status
  broadcast('tts:status', status)
}

function markSttOff(): void {
  setSttStatus({ wakeWord: { ...VOICE_OFF_STATUS }, transcription: { ...VOICE_OFF_STATUS } })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// Splits a child process stream into trimmed, non-empty lines.
function readLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let pending = ''
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) onLine(line)
    }
  })
}

function getAISettingsPath(): string {
  return join(app.getPath('userData'), 'ai-settings.json')
}

// Screen analysis and classification always run on the bundled Qwen3-VL
// server; only general knowledge questions are user-configurable (Nebius API).
function getAISettings(): AISettings {
  const defaults: AISettings = {
    generalBaseUrl: process.env.GENERAL_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
    generalApiKey: process.env.GENERAL_API_KEY ?? '',
    generalModelId: process.env.GENERAL_MODEL_ID ?? '',
    generalUseLocal: process.env.GENERAL_USE_LOCAL === 'true',
    phoneticBaseUrl: process.env.PHONETIC_BASE_URL ?? '',
    phoneticApiKey: process.env.PHONETIC_API_KEY ?? '',
    phoneticModelId: process.env.PHONETIC_MODEL_ID ?? '',
    phoneticUseLocal: process.env.PHONETIC_USE_LOCAL === 'true'
  }

  try {
    const stored = JSON.parse(readFileSync(getAISettingsPath(), 'utf8')) as Partial<AISettings>
    return {
      generalBaseUrl:
        typeof stored.generalBaseUrl === 'string' ? stored.generalBaseUrl : defaults.generalBaseUrl,
      generalApiKey:
        typeof stored.generalApiKey === 'string' ? stored.generalApiKey : defaults.generalApiKey,
      generalModelId:
        typeof stored.generalModelId === 'string' ? stored.generalModelId : defaults.generalModelId,
      generalUseLocal:
        typeof stored.generalUseLocal === 'boolean'
          ? stored.generalUseLocal
          : defaults.generalUseLocal,
      phoneticBaseUrl:
        typeof stored.phoneticBaseUrl === 'string'
          ? stored.phoneticBaseUrl
          : defaults.phoneticBaseUrl,
      phoneticApiKey:
        typeof stored.phoneticApiKey === 'string' ? stored.phoneticApiKey : defaults.phoneticApiKey,
      phoneticModelId:
        typeof stored.phoneticModelId === 'string'
          ? stored.phoneticModelId
          : defaults.phoneticModelId,
      phoneticUseLocal:
        typeof stored.phoneticUseLocal === 'boolean'
          ? stored.phoneticUseLocal
          : defaults.phoneticUseLocal
    }
  } catch {
    return defaults
  }
}

function readStoredSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(getAISettingsPath(), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    // No or malformed settings file; start from an empty object.
  }
  return {}
}

// Preserves unrelated keys (such as voiceEnabled) that live in the same file.
function saveAISettings(settings: AISettings): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), ...settings }, null, 2)}\n`,
    'utf8'
  )
}

// Voice activation (openwakeword + STT) is enabled by default and remembered
// across restarts. Disabling it stops the backend process so the wake word
// detector and speech recognizer stop consuming resources.
function getVoiceEnabled(): boolean {
  const stored = readStoredSettings()
  return typeof stored.voiceEnabled === 'boolean' ? stored.voiceEnabled : true
}

function saveVoiceEnabled(enabled: boolean): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), voiceEnabled: enabled }, null, 2)}\n`,
    'utf8'
  )
}

// Whether Bud also writes its spoken answer out on screen as a caption. Off by
// default so the overlay stays quiet; remembered across restarts when enabled.
function getWriteAnswers(): boolean {
  const stored = readStoredSettings()
  return typeof stored.writeAnswersEnabled === 'boolean' ? stored.writeAnswersEnabled : false
}

function saveWriteAnswers(enabled: boolean): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), writeAnswersEnabled: enabled }, null, 2)}\n`,
    'utf8'
  )
}

// The Pocket-TTS voice Bud speaks with. Remembered across restarts so the
// choice applies to every spoken answer, not just the settings preview.
function getTtsVoice(): string {
  const stored = readStoredSettings()
  return typeof stored.ttsVoice === 'string' && stored.ttsVoice.trim().length > 0
    ? stored.ttsVoice
    : DEFAULT_TTS_VOICE
}

function saveTtsVoice(voice: string): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), ttsVoice: voice }, null, 2)}\n`,
    'utf8'
  )
}

// The getting-started guide opens automatically once. Once the user finishes or
// skips it we remember that so it never auto-opens again; the settings panel's
// "?" button can always bring it back.
function getGuideSeen(): boolean {
  const stored = readStoredSettings()
  return typeof stored.hasSeenGuide === 'boolean' ? stored.hasSeenGuide : false
}

function saveGuideSeen(seen: boolean): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), hasSeenGuide: seen }, null, 2)}\n`,
    'utf8'
  )
}

// Drops settings that are no longer user-configurable now that screen analysis
// and classification always use the bundled Qwen3-VL server.
function migrateLegacyAISettings(): void {
  const settingsPath = getAISettingsPath()
  if (!existsSync(settingsPath)) return

  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    let changed = false

    for (const key of [
      'baseUrl',
      'apiKey',
      'modelId',
      'classificationBaseUrl',
      'classificationApiKey',
      'classificationModelId'
    ]) {
      if (key in stored) {
        delete stored[key]
        changed = true
      }
    }

    if (changed) {
      writeFileSync(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
      console.log('Migrated stored AI settings for the bundled Qwen3-VL server')
    }
  } catch (error) {
    console.error('Could not migrate stored AI settings:', error)
  }
}

// Speech models (Pocket-TTS, Moonshine) are downloaded on first launch into a
// writable user-data cache rather than being bundled with the app, so a slim
// installer can stay small at the cost of a one-time download with internet.
function ensureSpeechModelCacheDirectory(): string {
  const directory = join(app.getPath('userData'), 'model-cache')
  mkdirSync(directory, { recursive: true })
  return directory
}

async function startTTSBackend(): Promise<void> {
  const isPackaged = app.isPackaged
  const backendDirectory = isPackaged
    ? join(packagedBackendDirectory, 'tts')
    : join(app.getAppPath(), 'backend', 'tts')
  const pythonExecutable = isPackaged
    ? join(backendDirectory, 'bud-tts-backend', 'bud-tts-backend.exe')
    : join(backendDirectory, '.venv', 'Scripts', 'python.exe')
  const backendScript = join(backendDirectory, 'main.py')

  if (!existsSync(pythonExecutable) || (!isPackaged && !existsSync(backendScript))) {
    console.error(`TTS backend is not prepared: ${pythonExecutable}`)
    setTtsStatus({ phase: 'error', message: 'The text-to-speech backend is not installed.' })
    return
  }

  const port = await findFreePort()
  ttsBaseUrl = `http://127.0.0.1:${port}`
  isStoppingTts = false
  setTtsStatus({ phase: 'starting', detail: `127.0.0.1:${port}` })

  const child = spawn(
    pythonExecutable,
    isPackaged ? ['--port', String(port)] : [backendScript, '--port', String(port)],
    {
      cwd: backendDirectory,
      env: {
        ...process.env,
        HF_HOME: ensureSpeechModelCacheDirectory()
      },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true
    }
  )
  ttsProcess = child

  // Pocket-TTS reports progress on stdout while it loads and caches its model;
  // stderr is inherited so uvicorn's logs stay visible in the terminal.
  const onLine = (line: string): void => {
    if (line.includes('Loading Pocket-TTS model') || line.includes('Pre-caching voice states')) {
      setTtsStatus({ phase: 'downloading', detail: line.trim() })
    } else if (line.includes('Server ready')) {
      setTtsStatus({ phase: 'ready', detail: `127.0.0.1:${port}` })
    }
  }
  readLines(child.stdout, onLine)

  child.on('error', (error) => {
    console.error('TTS backend failed to start:', error)
    setTtsStatus({ phase: 'error', message: error.message })
  })
  child.on('exit', (code, signal) => {
    console.log(`TTS backend exited (code=${code}, signal=${signal ?? 'none'})`)
    if (ttsProcess === child) {
      ttsProcess = undefined
      ttsBaseUrl = undefined
    }
    if (!isStoppingTts) {
      setTtsStatus({
        phase: 'error',
        message: `The text-to-speech backend stopped (code=${code ?? 'unknown'}).`
      })
    }
  })

  try {
    await waitForTtsReady(child, port)
    setTtsStatus({ phase: 'ready', detail: `127.0.0.1:${port}` })
    console.log('[tts] Pocket-TTS server is ready')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[tts] Could not start the backend:', message)
    setTtsStatus({ phase: 'error', message })
  }
}

async function waitForTtsReady(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + TTS_HEALTH_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The text-to-speech backend exited before it was ready.')
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // The server is not listening yet; keep polling.
    }

    await delay(500)
  }

  throw new Error('The text-to-speech backend did not become ready in time.')
}

function stopTTSBackend(): void {
  isStoppingTts = true
  if (ttsProcess && !ttsProcess.killed) {
    ttsProcess.kill()
  }
  ttsProcess = undefined
  ttsBaseUrl = undefined
}

function startVoiceBackend(mainWindow: BrowserWindow): void {
  if (voiceProcess) return

  const isPackaged = app.isPackaged
  const backendDirectory = isPackaged
    ? join(packagedBackendDirectory, 'stt')
    : join(app.getAppPath(), 'backend', 'stt')
  const pythonExecutable = isPackaged
    ? join(backendDirectory, 'bud-stt-backend', 'bud-stt-backend.exe')
    : join(backendDirectory, '.venv', 'Scripts', 'python.exe')
  const backendScript = join(backendDirectory, 'main.py')

  if (!existsSync(pythonExecutable) || (!isPackaged && !existsSync(backendScript))) {
    console.error(`Voice backend is not prepared: ${pythonExecutable}`)
    setSttStatus({
      wakeWord: { phase: 'error', message: 'The voice backend is not installed.' },
      transcription: { phase: 'error', message: 'The voice backend is not installed.' }
    })
    return
  }

  isStoppingVoice = false
  setSttStatus({
    wakeWord: { phase: 'starting', detail: 'Starting voice listener' },
    transcription: { phase: 'pending', detail: 'Preparing speech-to-text' }
  })

  const child = spawn(pythonExecutable, [backendScript], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      HF_HOME: ensureSpeechModelCacheDirectory()
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  })
  voiceProcess = child

  readLines(child.stdout, (line) => {
    let event: VoiceBackendEvent
    try {
      event = JSON.parse(line) as VoiceBackendEvent
    } catch {
      console.error('Voice backend returned invalid event:', line)
      return
    }
    updateSttStatusFromEvent(event)
    mainWindow.webContents.send('voice:event', event)
  })

  child.on('error', (error) => {
    console.error('Voice backend failed to start:', error)
    setSttStatus({
      wakeWord: { phase: 'error', message: error.message },
      transcription: { phase: 'error', message: error.message }
    })
    mainWindow.webContents.send('voice:event', {
      event: 'error',
      message: error.message
    })
  })
  child.on('exit', (code, signal) => {
    console.log(`Voice backend exited (code=${code}, signal=${signal ?? 'none'})`)
    // Only clear the shared reference if it still points at this process, so a
    // rapid off/on toggle cannot let the old process clobber the new one.
    if (voiceProcess === child) voiceProcess = undefined
    if (!isStoppingVoice) {
      const message = `The voice backend stopped (code=${code ?? 'unknown'}).`
      setSttStatus({
        wakeWord: { phase: 'error', message },
        transcription: { phase: 'error', message }
      })
    }
  })
}

// Maps the STT backend's event stream onto the wake word / transcription rows.
function updateSttStatusFromEvent(event: VoiceBackendEvent): void {
  switch (event.event) {
    case 'ready':
      setSttStatus({
        ...sttStatus,
        wakeWord: {
          phase: 'ready',
          detail: event.wake_word ? `Wake word: ${event.wake_word}` : undefined
        }
      })
      break
    case 'listening':
      if (sttStatus.wakeWord.phase !== 'ready') {
        setSttStatus({ ...sttStatus, wakeWord: { phase: 'ready' } })
      }
      break
    case 'transcribing':
      setSttStatus({ ...sttStatus, transcription: { phase: 'ready', detail: 'Moonshine · en' } })
      break
    case 'status': {
      if (event.phase === 'loading') {
        setSttStatus({ ...sttStatus, transcription: { phase: 'loading', detail: event.message } })
      } else if (event.phase === 'ready') {
        setSttStatus({ ...sttStatus, transcription: { phase: 'ready', detail: event.message } })
      } else if (event.phase === 'error') {
        setSttStatus({ ...sttStatus, transcription: { phase: 'error', message: event.message } })
      } else if (event.phase === 'downloading' || /download/i.test(event.message ?? '')) {
        setSttStatus({ ...sttStatus, wakeWord: { phase: 'downloading', detail: event.message } })
      } else {
        setSttStatus({ ...sttStatus, wakeWord: { phase: 'starting', detail: event.message } })
      }
      break
    }
    case 'error': {
      const message = event.message ?? 'The voice backend reported an error.'
      setSttStatus({
        wakeWord: { phase: 'error', message },
        transcription: { phase: 'error', message }
      })
      break
    }
    default:
      break
  }
}

function stopVoiceBackend(): void {
  isStoppingVoice = true
  const child = voiceProcess
  voiceProcess = undefined
  if (child && !child.killed) {
    child.kill()
  }
}

function stopVoiceSession(): void {
  if (voiceProcess?.stdin?.writable) {
    voiceProcess.stdin.write('{"command":"stop_session"}\n')
  }
}

function setVoiceListenMode(continuous: boolean): void {
  if (voiceProcess?.stdin?.writable) {
    voiceProcess.stdin.write(
      `${JSON.stringify({ command: 'set_mode', mode: continuous ? 'continuous' : 'wake' })}\n`
    )
  }
}

// A small, frame-less window shown while the overlay renderer boots. It loads a
// lightweight static page (src/renderer/splash.html) so it appears before the
// heavier React overlay bundle is ready.
//
// Note: `ready-to-show` is unreliable for transparent windows that are not
// fullscreen, so the splash is revealed from `did-finish-load` too. A minimum
// visible time keeps it from flashing away before a user can register it.
const SPLASH_MIN_VISIBLE_MS = 1500
let splashShownAt = 0

function createSplashWindow(): void {
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
function dismissSplash(): void {
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

function closeSplash(): void {
  const splash = splashWindow
  splashWindow = undefined
  splashShownAt = 0
  if (splash && !splash.isDestroyed()) splash.close()
}

function createWindow(): void {
  // Create a transparent overlay that covers the current display.
  const mainWindow = new BrowserWindow({
    fullscreen: true,
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

  // Keep the overlay visible locally without including it in supported screen captures.
  // mainWindow.setContentProtection(true)
  mainWindowRef = mainWindow

  // Use the highest Electron stacking level so the overlay remains above
  // fullscreen applications and regular always-on-top windows.
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  // Start click-through. The renderer promotes the window to interactive while
  // the pointer is over the toolbar, panel, or ask bar, and never forces it back
  // itself, so a click is not immediately followed by a pass-through window.
  mainWindow.setIgnoreMouseEvents(true, { forward: true })

  let selectMode = false
  // Tracked here so the global shortcut and the toolbar/close button stay in
  // sync: every path funnels through setDebugVisible, which owns this value.
  let isDebugVisible = false
  const setDebugVisible = (visible: boolean): void => {
    isDebugVisible = visible

    // Showing or hiding the panel must not change mouse interactivity; that is
    // owned entirely by the renderer's hover tracking.
    if (visible) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      mainWindow.blur()
    }

    mainWindow.webContents.send('overlay:debug-visibility-changed', visible)
  }

  ipcMain.on('overlay:set-interactive', (event, interactive: unknown) => {
    // Region selection forces interactivity on, so hover-driven updates are
    // ignored while it is active.
    if (event.sender !== mainWindow.webContents || selectMode || typeof interactive !== 'boolean') {
      return
    }
    mainWindow.setIgnoreMouseEvents(!interactive, { forward: true })
  })

  // Region selection needs the overlay to capture mouse input even while the
  // debug panel is hidden and the window would otherwise be click-through.
  ipcMain.on('overlay:set-select-mode', (event, active: unknown) => {
    if (event.sender !== mainWindow.webContents || typeof active !== 'boolean') {
      return
    }
    selectMode = active
    if (active) {
      mainWindow.setIgnoreMouseEvents(false)
      mainWindow.show()
      mainWindow.focus()
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  // Lets the always-visible toolbar open/close the settings panel without
  // relying on the Ctrl+Shift+Space global shortcut.
  ipcMain.on('overlay:set-debug-visible', (event, visible: unknown) => {
    if (event.sender !== mainWindow.webContents || typeof visible !== 'boolean') {
      return
    }
    setDebugVisible(visible)
  })

  mainWindow.on('ready-to-show', () => {
    setDebugVisible(true)
    mainWindow.show()
    // The overlay has painted, so the splash has done its job.
    dismissSplash()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const toggleDebugVisibility = (): void => {
    setDebugVisible(!isDebugVisible)
  }

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleDebugVisibility)) {
    console.error('Could not register debug visibility shortcut: Ctrl+Shift+Space')
  }

  mainWindow.on('closed', () => {
    globalShortcut.unregister('CommandOrControl+Shift+Space')
    mainWindowRef = undefined
  })
}

interface AIRequest {
  prompt: string
  imageUrl?: string
}

interface AISettings {
  generalBaseUrl: string
  generalApiKey: string
  generalModelId: string
  generalUseLocal: boolean
  phoneticBaseUrl: string
  phoneticApiKey: string
  phoneticModelId: string
  phoneticUseLocal: boolean
  voiceEnabled?: boolean
}

interface BoundingBox {
  bbox: [number, number, number, number]
  label?: string
  copy?: string
}

/** Normalized screen region on the 1000x1000 display grid. */
interface Region {
  x: number
  y: number
  width: number
  height: number
}

interface ScreenAIResponse {
  text: string
  boxes: BoundingBox[]
}

interface ScreenConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

const systemPrompt = `
You are Bud, a friendly, intelligent, and direct voice assistant. You assist users with general information and help them read, analyze, or locate items on their screen.

CRITICAL INSTRUCTIONS:
1. VOICE & PERSONALITY ("text"):
   - Speak as Bud: warm, direct, helpful, and natural.
   - Limit answers strictly to what was asked without volunteer trivia or unnecessary details.
   - For capability/permission questions (e.g., "Can you..."), vary your starting response naturally using context-neutral openers (e.g., "Yes,", "Sure,", "I've got it,", "Absolutely,"). Never repeat the same opener consecutively.
   - For direct factual or visual-reading requests (e.g., "Bud, what time is it?", "Read the title"), state the answer directly without introductory filler.

2. VISUAL GROUNDING ("boxes") - STRICT MANDATE:
   - IF YOU MENTION OR DESCRIBE ANY VISUAL ELEMENT, TEXT BLOCK, BUTTON, ICON, OR UI REGION IN YOUR "text" FIELD, YOU MUST INCLUDE ITS BOUNDING BOX IN THE "boxes" ARRAY.
   - NEVER leave the "boxes" array empty if your spoken text answers a screen-based or visual query.
   - For each box, specify the "label" and "copy" text FIRST, then output the "bbox" coordinates.
   - Set "copy" to null UNLESS the user explicitly asks to copy, read, extract, or transcribe text. When text extraction IS requested, include the exact, raw text in "copy" (with original symbols, numbers, and formatting).
   - Bounding box coordinates MUST follow native [xmin, ymin, xmax, ymax] format normalized on a 1000x1000 grid (integers 0 to 1000).
   - Top-left is [0, 0] and bottom-right is [1000, 1000].
   - Do NOT use percentages, decimals, pixel dimensions, or [ymin, xmin, ymax, xmax] order.

JSON Schema:
{
  "boxes": [
    {
      "label": "descriptive label matching the spoken text",
      "copy": "exact raw text extracted ONLY if requested by user, otherwise null",
      "bbox": [xmin, ymin, xmax, ymax]
    }
  ],
  "text": "spoken response in natural written form"
}

Example Output (General Localization - No copy requested):
{
  "boxes": [
    {
      "label": "submit button",
      "copy": null,
      "bbox": [800, 50, 950, 120]
    }
  ],
  "text": "There is a submit button in the top right."
}

Example Output (Text Extraction Requested):
{
  "boxes": [
    {
      "label": "meeting start time",
      "copy": "3:30 PM",
      "bbox": [145, 210, 520, 380]
    }
  ],
  "text": "The meeting starts at 3:30 PM."
}

Use an empty "boxes" array ONLY when the user's question is completely unrelated to the screen image (e.g., general knowledge queries). Respond strictly with raw JSON.
`

const questionClassificationSystemPrompt = `You are a strict text classification assistant.
Analyze the user's question and determine if it pertains to the visual screen/UI display or dynamic system state, vs. a general knowledge question.

DEFAULT RULE:
If there is any ambiguity, doubt, or implicit reference to context (e.g., short queries, follow-up questions, or vague pronouns), ALWAYS default to "screen".

Classify as "screen" if:
- The question asks about visual UI elements, text, buttons, images, errors, or content on the display.
- The question relies on visual context or implicitly refers to something being viewed (e.g., "What does this mean?", "Where do I click?", "Read this label", "How do I fix this?").
- The question asks about real-time system state visible on a device status bar or widget (e.g., "What time is it?", "What is the date?", "What is my battery level?", "What network am I connected to?").
- You are unsure whether the user is referring to something on their screen versus a general concept.

Classify as "general" ONLY if:
- The question is unambiguously a self-contained factual, conceptual, or general knowledge query completely independent of the screen or current device state (e.g., "Why is the sky blue?", "How many miles is a marathon?", "Explain quantum computing").

Return JSON: {"type": "screen" | "general"}`

const generalSystemPrompt = `You are Bud, a friendly, intelligent, and direct voice assistant. You assist users with general information and help them read, analyze, or locate items on their screen.

SCOPE OF THIS MODE:
- You are handling general information and everyday queries independent of the user's screen display.
- Do not make references to visual elements or screen layouts unless explicitly brought up by the user.

CRITICAL INSTRUCTIONS:
1. VOICE & PERSONALITY ("text"):
   - Speak as Bud: warm, direct, helpful, and natural.
   - Limit answers strictly to what was asked without volunteer trivia or unnecessary details.
   - For capability/permission questions (e.g., "Can you..."), vary your starting response naturally using context-neutral openers (e.g., "Yes,", "Sure,", "I've got it,", "Absolutely,"). Never repeat the same opener consecutively.
   - For direct factual requests (e.g., "Bud, what is the capital of France?"), state the answer directly without introductory filler.`

// Dedicated system prompt for the separate text-to-speech normalization pass.
// It rewrites an answer into spoken form so the TTS engine reads numbers, dates,
// units, and symbols correctly.
const phoneticFormattingSystemPrompt = `You are an expert Text-to-Speech (TTS) Text Normalization and Formatting Assistant. Your primary objective is to take raw, written text and rewrite it so that a TTS engine can read it aloud with maximum accuracy, natural pacing, and proper pronunciation, avoiding any awkward robotic misinterpretations.

### Core Guidelines & Transformation Rules:

1. **Numbers & Digits:**
   * **Spell out all numbers** unless they represent a specific year or formatted date that the TTS handles well, but when in doubt, spell them out or use phonetic approximations.
   * *Examples:* Change "5" to "five", "100" to "one hundred", "42nd" to "forty-second".
   * **Phone numbers & IDs:** Group them with hyphens or spaces to control pacing (e.g., "555-0199" -> "5-5-5, dash, 0-1-9-9").

2. **Dates, Times, & Measurements:**
   * **Dates:** Convert numerical dates into spoken words. (e.g., "10/13/2026" -> "October thirteenth, twenty twenty-six").
   * **Times:** Spell out times clearly. (e.g., "3:45 PM" -> "three forty-five p.m.").
   * **Measurements & Units:** Spell out abbreviations to prevent letter-by-letter spelling. (e.g., "10kg" -> "ten kilograms", "5mi" -> "five miles", "60mph" -> "sixty miles per hour").

3. **Symbols, Punctuation, & Abbreviations:**
   * **Currencies:** Place the word after the number or spell it naturally. (e.g., "$50" -> "fifty dollars", "€20" -> "twenty euros").
   * **Math & Special Symbols:** Replace symbols with words. (e.g., "+" -> " plus ", "=" -> " equals ", "%" -> " percent ", "&" -> " and ").
   * **Acronyms & Abbreviations:** If an acronym should be spelled out letter-by-letter, add spaces or hyphens (e.g., "NASA" can usually be read as a word, but "HTML" might need "H-T-M-L" if the TTS struggles). Expand common ones like "Dr." to "Doctor" and "Mr." to "Mister".

4. **Urls, Emails, & Code:**
   * **URLs & Emails:** Break them down phonetically if necessary, replacing symbols: "support@example.com" -> "support at example dot com".
   * **Code/Technical terms:** Spell out programming syntax or variables if a standard TTS would choke on them.

5. **Punctuation for Pacing:**
   * Use commas \`,\`, em-dashes —, and ellipses \`...\` strategically to force natural pauses where the TTS might otherwise rush through a sentence.

### Output Requirements:
* Output **only** the TTS-optimized text.
* Do not include conversational filler, meta-commentary, or explanations unless explicitly requested by the user.`

type QuestionType = 'screen' | 'general'

export function sanitizeForTTS(text: string): string {
  const preserveContractions = true
  const normalizeWhitespace = true

  if (!text || typeof text !== 'string') {
    return ''
  }

  let cleaned = text

  // 1. Remove Markdown syntax: headers (#), bold/italic (*, _), strikethrough (~), code blocks (`)
  cleaned = cleaned.replace(/[*_~#`]/g, '')

  // 2. Remove URLs and domain names
  cleaned = cleaned.replace(/https?:\/\/\S+|www\.\S+/gi, '')

  // 3. Remove standalone special symbols and bracket characters
  cleaned = cleaned.replace(/[\[\](){}<>@\/\^|\\]/g, ' ')

  // 4. Strip emojis and non-standard Unicode symbols
  // Uses Unicode property escapes (\p{Extended_Pictographic})
  cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '')

  // 5. Remove any character that is NOT a letter, number, white-space, or speech punctuation
  // Preserved punctuation: . , ! ? - and conditionally '
  const allowedCharsRegex = preserveContractions
    ? /[^a-zA-Target-zA-Z0-9\s.,!?'\-]/g
    : /[^a-zA-Target-zA-Z0-9\s.,!?\-]/g

  cleaned = cleaned.replace(allowedCharsRegex, '')

  // 6. Fix orphaned hyphens or repetitive punctuation
  cleaned = cleaned.replace(/(?<!\w)-(?!\w)/g, ' ') // remove floating dashes
  cleaned = cleaned.replace(/[-]{2,}/g, ' ') // collapse multiple dashes

  // 7. Normalize whitespaces and trim leading/trailing spaces
  if (normalizeWhitespace) {
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
  }

  return cleaned
}

// Converts a finished answer into TTS-friendly spoken text using the separately
// configured phonetic formatting model. Falls back to the regex cleanup when
// that model is not configured or the request fails, so speech is never blocked.
async function formatTextForSpeech(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const settings = getAISettings()
  const useLocal = settings.phoneticUseLocal

  if (
    !useLocal &&
    (!settings.phoneticBaseUrl || !settings.phoneticApiKey || !settings.phoneticModelId)
  ) {
    return sanitizeForTTS(trimmed)
  }

  try {
    if (useLocal) await ensureLocalVlmReady()
    const { client, model } = createPhoneticClient(settings)
    const response = await client.chat.completions.create({
      model,
      temperature: 0.0,
      ...(useLocal ? {} : { reasoning_effort: 'none' as const }),
      messages: [
        { role: 'system', content: phoneticFormattingSystemPrompt },
        { role: 'user', content: trimmed }
      ]
    })

    const content = response.choices[0]?.message.content
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new Error('The phonetic model returned an empty response')
    }

    return sanitizeForTTS(content.trim())
  } catch (error) {
    console.error('Phonetic formatting failed; falling back to text cleanup:', error)
    return sanitizeForTTS(trimmed)
  }
}

function parseScreenResponse(content: string): ScreenAIResponse {
  const cleanedContent = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const firstObject = cleanedContent.indexOf('{')
  const lastObject = cleanedContent.lastIndexOf('}')
  const jsonContent =
    firstObject >= 0 && lastObject > firstObject
      ? cleanedContent.slice(firstObject, lastObject + 1)
      : cleanedContent

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonContent)
  } catch {
    console.error('Failed to parse AI response as JSON:', jsonContent)
    throw new Error('The AI returned an invalid screen analysis response')
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('text' in parsed) ||
    typeof parsed.text !== 'string' ||
    !('boxes' in parsed) ||
    !Array.isArray(parsed.boxes)
  ) {
    throw new Error('The AI returned an invalid screen analysis shape')
  }

  const validatedBoxes: BoundingBox[] = []

  for (const box of parsed.boxes) {
    if (
      typeof box !== 'object' ||
      box === null ||
      !('label' in box) ||
      typeof box.label !== 'string' ||
      !('bbox' in box) ||
      !Array.isArray(box.bbox) ||
      box.bbox.length !== 4
    ) {
      throw new Error('The AI returned an invalid bounding box shape')
    }

    const isValidBbox = box.bbox.every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        coordinate >= 0 &&
        coordinate <= 1000
    )

    if (!isValidBbox) {
      throw new Error('The AI returned an invalid bounding box coordinate range')
    }

    let copy: string | undefined = undefined
    if ('copy' in box && box.copy !== null && box.copy !== undefined) {
      if (typeof box.copy !== 'string') {
        throw new Error('The AI returned an invalid copy value in bounding box')
      }
      copy = box.copy
    }

    validatedBoxes.push({
      label: box.label,
      bbox: box.bbox as [number, number, number, number],
      ...(copy !== undefined ? { copy } : {})
    })
  }

  return {
    text: parsed.text.trim(),
    boxes: validatedBoxes
  }
}

// Validates an optional screen region from the renderer. Regions use the same
// 0-1000 normalized grid as bounding boxes, relative to the full display.
function parseRegion(value: unknown): Region | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'object') {
    throw new Error('Screen region must be an object')
  }

  const record = value as Record<string, unknown>
  const coordinates: Array<keyof Region> = ['x', 'y', 'width', 'height']

  for (const key of coordinates) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
      throw new Error(`Screen region ${key} must be a finite number`)
    }
  }

  const region: Region = {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number
  }

  if (
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1000 ||
    region.y + region.height > 1000
  ) {
    throw new Error('Screen region must be within the 0-1000 display grid')
  }

  return region
}

// The bundled Qwen3-VL server always uses a fixed alias and placeholder key;
// only its base URL varies (the free port chosen at launch).
function createLocalVlmClient(): { client: OpenAI; model: string } {
  return {
    client: new OpenAI({ baseURL: getLocalVlmBaseUrl(), apiKey: LOCAL_VLM_API_KEY }),
    model: VL_MODEL_ALIAS
  }
}

// Each configurable service (general answers, phonetic formatting) runs either
// against the external endpoint the user configured or the bundled local server.
function createGeneralClient(settings: AISettings): { client: OpenAI; model: string } {
  if (settings.generalUseLocal) return createLocalVlmClient()
  if (!settings.generalApiKey) throw new Error('general API key is not configured')
  if (!settings.generalModelId) throw new Error('general model ID is not configured')
  return {
    client: new OpenAI({ baseURL: settings.generalBaseUrl, apiKey: settings.generalApiKey }),
    model: settings.generalModelId
  }
}

function createPhoneticClient(settings: AISettings): { client: OpenAI; model: string } {
  if (settings.phoneticUseLocal) return createLocalVlmClient()
  if (!settings.phoneticBaseUrl) throw new Error('phonetic base URL is not configured')
  if (!settings.phoneticApiKey) throw new Error('phonetic API key is not configured')
  if (!settings.phoneticModelId) throw new Error('phonetic model ID is not configured')
  return {
    client: new OpenAI({ baseURL: settings.phoneticBaseUrl, apiKey: settings.phoneticApiKey }),
    model: settings.phoneticModelId
  }
}

async function classifyQuestion(
  prompt: string,
  history: ScreenConversationMessage[]
): Promise<QuestionType> {
  await ensureLocalVlmReady()
  const { client, model } = createLocalVlmClient()

  const response = await client.chat.completions.create({
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'question_classification',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['screen', 'general'],
              description: 'The classification category for the user prompt.'
            }
          },
          required: ['type'],
          additionalProperties: false
        }
      }
    },
    messages: [
      {
        role: 'system',
        content: `${questionClassificationSystemPrompt}

Prior messages in this conversation may or may not be related to the user's current request.
Use prior messages to resolve references (such as "that", "it", or "the previous item") and context.
Determine whether a follow-up question relies on prior screen context or previous non-screen discussions, and answer accordingly.
Regardless of context, always return the exact same JSON object structure. Never return plain conversational text.`
      },
      ...history.filter((msg) => msg.role === 'user'),
      { role: 'user', content: prompt }
    ]
  })

  const rawContent = response.choices[0]?.message.content

  if (!rawContent) {
    throw new Error('AI failed to return content for question classification')
  }

  const parsed = JSON.parse(rawContent) as { type: QuestionType }

  if (parsed.type !== 'screen' && parsed.type !== 'general') {
    throw new Error(`The AI returned an invalid question classification: ${parsed.type}`)
  }

  return parsed.type
}

async function askAI({ prompt, imageUrl }: AIRequest): Promise<string> {
  await ensureLocalVlmReady()
  const { client, model } = createLocalVlmClient()

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          },
          ...(imageUrl
            ? [
                {
                  type: 'image_url' as const,
                  image_url: {
                    url: imageUrl
                  }
                }
              ]
            : [])
        ]
      }
    ]
  })

  const content = response.choices[0]?.message.content
  if (!content) {
    throw new Error('The AI returned an empty response')
  }

  return content
}

async function askGeneral(
  prompt: string,
  history: ScreenConversationMessage[] = []
): Promise<ScreenAIResponse> {
  const settings = getAISettings()
  if (settings.generalUseLocal) await ensureLocalVlmReady()
  const { client, model } = createGeneralClient(settings)

  const response = await client.chat.completions.create({
    model,
    // reasoning_effort only applies to the hosted reasoning models.
    ...(settings.generalUseLocal ? {} : { reasoning_effort: 'none' as const }),
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'general_response',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: 'A concise spoken answer in natural written form.'
            }
          },
          required: ['text']
        }
      }
    },
    messages: [
      {
        role: 'system',
        content: `${generalSystemPrompt}

Prior messages in this conversation may or may not be related to the user's current request.
Use prior messages to resolve references (such as "that", "it", or "the previous item") and context.
Determine whether a follow-up question relies on prior screen context or previous non-screen discussions, and answer accordingly.
Regardless of context, always return the exact same JSON object structure. Never return plain conversational text.`
      },
      ...history,
      { role: 'user', content: prompt }
    ]
  })

  const content = response.choices[0]?.message.content

  if (!content || typeof content !== 'string') {
    throw new Error('The AI returned an empty general response')
  }

  const parsed = JSON.parse(content) as { text: string }

  return { text: parsed.text.trim(), boxes: [] }
}

async function askQuestion(
  prompt: string,
  history: ScreenConversationMessage[] = [],
  region?: Region
): Promise<ScreenAIResponse> {
  const questionType = await classifyQuestion(prompt, history)
  return questionType === 'screen'
    ? askAboutScreen(prompt, history, region)
    : askGeneral(prompt, history)
}

async function capturePrimaryScreen(region?: Region): Promise<string> {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size
  const maxDimension =
    Number.isFinite(screenCaptureMaxDimension) && screenCaptureMaxDimension > 0
      ? screenCaptureMaxDimension
      : 1920
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    },
    fetchWindowIcons: false
  })
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]

  if (!source) {
    throw new Error('Could not capture the primary screen')
  }

  if (!region) {
    return source.thumbnail.toDataURL()
  }

  const { width: imageWidth, height: imageHeight } = source.thumbnail.getSize()
  const rawX = Math.round((region.x / 1000) * imageWidth)
  const rawY = Math.round((region.y / 1000) * imageHeight)
  const cropX = Math.max(0, Math.min(rawX, imageWidth - 1))
  const cropY = Math.max(0, Math.min(rawY, imageHeight - 1))
  const cropWidth = Math.max(
    1,
    Math.min(Math.round((region.width / 1000) * imageWidth), imageWidth - cropX)
  )
  const cropHeight = Math.max(
    1,
    Math.min(Math.round((region.height / 1000) * imageHeight), imageHeight - cropY)
  )

  return source.thumbnail
    .crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight })
    .toDataURL()
}

// The vision model returns boxes relative to the cropped image it was given.
// Translate them back onto the full-screen 0-1000 grid so the overlay lands
// the indicators in the right place.
function remapBoxesToScreen(boxes: BoundingBox[], region: Region): BoundingBox[] {
  const mapX = (value: number): number =>
    Math.min(1000, Math.max(0, Math.round(region.x + (value / 1000) * region.width)))
  const mapY = (value: number): number =>
    Math.min(1000, Math.max(0, Math.round(region.y + (value / 1000) * region.height)))

  return boxes.map((box) => {
    const [xmin, ymin, xmax, ymax] = box.bbox
    return { ...box, bbox: [mapX(xmin), mapY(ymin), mapX(xmax), mapY(ymax)] }
  })
}

async function askAboutScreen(
  prompt: string,
  history: ScreenConversationMessage[] = [],
  region?: Region
): Promise<ScreenAIResponse> {
  await ensureLocalVlmReady()
  const imageUrl = await capturePrimaryScreen(region)
  const { client, model } = createLocalVlmClient()

  const response = await client.chat.completions.create({
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'screen_analysis',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: 'A concise spoken answer for the user.'
            },
            boxes: {
              type: 'array',
              description:
                'List of visual bounding boxes matching elements mentioned in text. Must not be empty if visual elements are identified.',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: {
                    type: 'string',
                    description: 'A concise label for the highlighted region.'
                  },
                  copy: {
                    type: ['string', 'null'],
                    description:
                      'Exact raw extracted text from the region, or null if non-text object.'
                  },
                  bbox: {
                    type: 'array',
                    description:
                      'Bounding box coordinates normalized to 0-1000 grid: [xmin, ymin, xmax, ymax].',
                    items: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1000
                    },
                    minItems: 4,
                    maxItems: 4
                  }
                },
                required: ['label', 'copy', 'bbox']
              }
            }
          },
          required: ['text', 'boxes']
        }
      }
    },
    messages: [
      {
        role: 'system',
        content: `${systemPrompt}

Prior messages in this conversation may or may not be related to the user's current request.
Use prior messages to resolve references (such as "that", "it", or "the previous item") only if the request depends on them; otherwise, process the new request independently.
Regardless of context, always return the exact same JSON object structure. Never return plain conversational text.`
      },
      ...history,
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ]
  })

  const content = response.choices[0]?.message.content

  if (!content || typeof content !== 'string') {
    throw new Error('The AI returned an empty screen analysis response')
  }

  const result = parseScreenResponse(content)
  return region ? { ...result, boxes: remapBoxesToScreen(result.boxes, region) } : result
}

async function streamTTS(
  text: string,
  webContents: Electron.WebContents,
  voice?: string,
  caption?: string
): Promise<void> {
  if (!ttsBaseUrl) throw new Error('TTS backend is not available')
  const requestId = randomUUID()
  const response = await fetch(`${ttsBaseUrl}/tts-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: voice ?? getTtsVoice() })
  })

  if (!response.ok || !response.body) {
    throw new Error(`TTS backend returned HTTP ${response.status}`)
  }

  const sampleRateHeader = response.headers.get('x-sample-rate')
  const sampleRate = Number(sampleRateHeader)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('TTS backend returned an invalid sample rate')
  }

  webContents.send('tts:start', { requestId, sampleRate, text: caption ?? text })
  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        webContents.send('tts:chunk', {
          requestId,
          chunk: Buffer.from(value)
        })
      }
    }
    webContents.send('tts:end', { requestId })
  } finally {
    reader.releaseLock()
  }
}

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

  ipcMain.handle('ai:ask', async (_event, request: unknown) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      !('prompt' in request) ||
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0
    ) {
      throw new Error('AI prompt must be a non-empty string')
    }

    const imageUrl = 'imageUrl' in request ? request.imageUrl : undefined
    if (imageUrl !== undefined && typeof imageUrl !== 'string') {
      throw new Error('AI imageUrl must be a string')
    }

    if (
      imageUrl !== undefined &&
      !imageUrl.startsWith('data:image/') &&
      !imageUrl.startsWith('https://')
    ) {
      throw new Error('AI imageUrl must be an image data URL or an HTTPS URL')
    }

    const response = await askAI({
      prompt: request.prompt,
      imageUrl
    })
    const spoken = await formatTextForSpeech(response)
    void streamTTS(spoken, _event.sender, undefined, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return response
  })

  ipcMain.handle('ai:ask-screen', async (_event, request: unknown) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      !('prompt' in request) ||
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0
    ) {
      throw new Error('Screen analysis prompt must be a non-empty string')
    }

    const history = 'history' in request ? request.history : undefined
    if (
      history !== undefined &&
      (!Array.isArray(history) ||
        history.some(
          (message) =>
            typeof message !== 'object' ||
            message === null ||
            !('role' in message) ||
            (message.role !== 'user' && message.role !== 'assistant') ||
            !('content' in message) ||
            typeof message.content !== 'string'
        ))
    ) {
      throw new Error('Screen analysis history must contain valid messages')
    }

    const result = await askAboutScreen(
      request.prompt,
      history,
      parseRegion('region' in request ? request.region : undefined)
    )
    const spoken = await formatTextForSpeech(result.text)
    void streamTTS(spoken, _event.sender, undefined, result.text).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return result
  })

  ipcMain.handle('ai:ask-question', async (_event, request: unknown) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      !('prompt' in request) ||
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0
    ) {
      throw new Error('Question prompt must be a non-empty string')
    }

    const history = 'history' in request ? request.history : undefined
    if (
      history !== undefined &&
      (!Array.isArray(history) ||
        history.some(
          (message) =>
            typeof message !== 'object' ||
            message === null ||
            !('role' in message) ||
            (message.role !== 'user' && message.role !== 'assistant') ||
            !('content' in message) ||
            typeof message.content !== 'string'
        ))
    ) {
      throw new Error('Question history must contain valid messages')
    }

    const result = await askQuestion(
      request.prompt,
      history,
      parseRegion('region' in request ? request.region : undefined)
    )
    const spoken = await formatTextForSpeech(result.text)
    void streamTTS(spoken, _event.sender, undefined, result.text).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return result
  })

  ipcMain.handle('tts:speak', async (_event, text: unknown, voice: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('TTS text must be a non-empty string')
    }

    if (voice !== undefined && (typeof voice !== 'string' || voice.trim().length === 0)) {
      throw new Error('TTS voice must be a non-empty string')
    }

    void streamTTS(
      text.trim(),
      _event.sender,
      typeof voice === 'string' ? voice.trim() : undefined,
      text.trim()
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
  })

  ipcMain.handle('tts:get-voice', () => getTtsVoice())

  ipcMain.handle('tts:set-voice', (_event, voice: unknown) => {
    if (typeof voice !== 'string' || voice.trim().length === 0) {
      throw new Error('TTS voice must be a non-empty string')
    }

    const trimmed = voice.trim()
    saveTtsVoice(trimmed)
    return trimmed
  })

  ipcMain.handle('voice:stop-session', () => {
    stopVoiceSession()
  })

  ipcMain.handle('voice:get-enabled', () => getVoiceEnabled())

  ipcMain.handle('voice:set-enabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Voice enabled must be a boolean')
    }

    saveVoiceEnabled(enabled)

    if (enabled) {
      const mainWindow = mainWindowRef ?? BrowserWindow.getAllWindows()[0]
      if (mainWindow) startVoiceBackend(mainWindow)
    } else {
      stopVoiceSession()
      stopVoiceBackend()
      markSttOff()
    }

    return enabled
  })

  ipcMain.handle('voice:set-listen-mode', (_event, continuous: unknown) => {
    if (typeof continuous !== 'boolean') {
      throw new Error('Voice listen mode must be a boolean')
    }
    setVoiceListenMode(continuous)
  })

  ipcMain.handle('answers:get-write', () => getWriteAnswers())

  ipcMain.handle('answers:set-write', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Write answers flag must be a boolean')
    }

    saveWriteAnswers(enabled)
    return enabled
  })

  ipcMain.handle('settings:get-ai', () => getAISettings())

  ipcMain.handle('guide:get-seen', () => getGuideSeen())

  ipcMain.handle('guide:set-seen', (_event, seen: unknown) => {
    if (typeof seen !== 'boolean') {
      throw new Error('Guide seen flag must be a boolean')
    }

    saveGuideSeen(seen)
    return seen
  })

  ipcMain.handle('vl:get-status', () => getVlStatus())

  ipcMain.handle('stt:get-status', () => sttStatus)

  ipcMain.handle('tts:get-status', () => ttsStatus)

  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  ipcMain.handle('settings:save-ai', (_event, settings: unknown) => {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('AI settings must be an object')
    }

    const trim = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

    const generalUseLocal = 'generalUseLocal' in settings ? settings.generalUseLocal : undefined
    if (generalUseLocal !== undefined && typeof generalUseLocal !== 'boolean') {
      throw new Error('General use-local flag must be a boolean')
    }
    const phoneticUseLocal = 'phoneticUseLocal' in settings ? settings.phoneticUseLocal : undefined
    if (phoneticUseLocal !== undefined && typeof phoneticUseLocal !== 'boolean') {
      throw new Error('Phonetic use-local flag must be a boolean')
    }
    const useLocalForGeneral = generalUseLocal === true
    const useLocalForPhonetic = phoneticUseLocal === true

    // The external endpoint is only required when the service is not set to
    // run on the bundled local model.
    if (
      !useLocalForGeneral &&
      (!('generalBaseUrl' in settings) ||
        typeof settings.generalBaseUrl !== 'string' ||
        !settings.generalBaseUrl.trim() ||
        !('generalApiKey' in settings) ||
        typeof settings.generalApiKey !== 'string' ||
        !settings.generalApiKey.trim() ||
        !('generalModelId' in settings) ||
        typeof settings.generalModelId !== 'string' ||
        !settings.generalModelId.trim())
    ) {
      throw new Error('AI settings require a base URL, API key, and model ID')
    }

    const trimmedGeneralBaseUrl = trim('generalBaseUrl' in settings ? settings.generalBaseUrl : '')
    if (!useLocalForGeneral) {
      try {
        const baseUrl = new URL(trimmedGeneralBaseUrl)
        if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
          throw new Error('unsupported protocol')
        }
      } catch {
        throw new Error('AI base URLs must be valid HTTP or HTTPS URLs')
      }
    }

    const phoneticBaseUrl = 'phoneticBaseUrl' in settings ? settings.phoneticBaseUrl : undefined
    if (phoneticBaseUrl !== undefined && typeof phoneticBaseUrl !== 'string') {
      throw new Error('Phonetic base URL must be a string')
    }
    const phoneticApiKey = 'phoneticApiKey' in settings ? settings.phoneticApiKey : undefined
    if (phoneticApiKey !== undefined && typeof phoneticApiKey !== 'string') {
      throw new Error('Phonetic API key must be a string')
    }
    const phoneticModelId = 'phoneticModelId' in settings ? settings.phoneticModelId : undefined
    if (phoneticModelId !== undefined && typeof phoneticModelId !== 'string') {
      throw new Error('Phonetic model ID must be a string')
    }

    const trimmedPhoneticBaseUrl = typeof phoneticBaseUrl === 'string' ? phoneticBaseUrl.trim() : ''
    if (trimmedPhoneticBaseUrl) {
      try {
        const phoneticUrl = new URL(trimmedPhoneticBaseUrl)
        if (phoneticUrl.protocol !== 'http:' && phoneticUrl.protocol !== 'https:') {
          throw new Error('unsupported protocol')
        }
      } catch {
        throw new Error('Phonetic base URL must be a valid HTTP or HTTPS URL')
      }
    }

    const savedSettings = {
      generalBaseUrl: trimmedGeneralBaseUrl,
      generalApiKey: trim('generalApiKey' in settings ? settings.generalApiKey : ''),
      generalModelId: trim('generalModelId' in settings ? settings.generalModelId : ''),
      generalUseLocal: useLocalForGeneral,
      phoneticBaseUrl: trimmedPhoneticBaseUrl,
      phoneticApiKey: typeof phoneticApiKey === 'string' ? phoneticApiKey.trim() : '',
      phoneticModelId: typeof phoneticModelId === 'string' ? phoneticModelId.trim() : '',
      phoneticUseLocal: useLocalForPhonetic
    }
    saveAISettings(savedSettings)
    return savedSettings
  })

  createWindow()
  const mainWindow = mainWindowRef ?? BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (getVoiceEnabled()) {
        startVoiceBackend(mainWindow)
      }
    })
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
