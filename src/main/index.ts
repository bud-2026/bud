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
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

dotenv.config({ path: join(app.getAppPath(), '.env') })

const ttsPort = 8765
const ttsBaseUrl = `http://127.0.0.1:${ttsPort}`
const screenCaptureMaxDimension = 1920
const packagedBackendDirectory = join(process.resourcesPath, 'python')
let ttsProcess: ChildProcess | undefined
let voiceProcess: ChildProcess | undefined

function getAISettingsPath(): string {
  return join(app.getPath('userData'), 'ai-settings.json')
}

function getAISettings(): AISettings {
  const defaults: AISettings = {
    baseUrl: process.env.AI_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
    apiKey: process.env.NEBIUS_API_KEY ?? '',
    modelId: process.env.NEBIUS_MODEL_ID ?? ''
  }

  try {
    const stored = JSON.parse(readFileSync(getAISettingsPath(), 'utf8')) as Partial<AISettings>
    return {
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : defaults.baseUrl,
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : defaults.apiKey,
      modelId: typeof stored.modelId === 'string' ? stored.modelId : defaults.modelId
    }
  } catch {
    return defaults
  }
}

function saveAISettings(settings: AISettings): void {
  writeFileSync(getAISettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function startTTSBackend(): void {
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
    return
  }

  ttsProcess = spawn(
    pythonExecutable,
    isPackaged ? ['--port', String(ttsPort)] : [backendScript, '--port', String(ttsPort)],
    {
      cwd: backendDirectory,
      env: {
        ...process.env,
        ...(isPackaged ? { HF_HOME: join(packagedBackendDirectory, 'model-cache') } : {})
      },
      stdio: 'inherit',
      windowsHide: true
    }
  )
  ttsProcess.on('error', (error) => console.error('TTS backend failed to start:', error))
  ttsProcess.on('exit', (code, signal) => {
    console.log(`TTS backend exited (code=${code}, signal=${signal ?? 'none'})`)
    ttsProcess = undefined
  })
}

function stopTTSBackend(): void {
  if (ttsProcess && !ttsProcess.killed) {
    ttsProcess.kill()
    ttsProcess = undefined
  }
}

function startVoiceBackend(mainWindow: BrowserWindow): void {
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
    return
  }

  voiceProcess = spawn(pythonExecutable, [backendScript], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      ...(isPackaged ? { HF_HOME: join(packagedBackendDirectory, 'model-cache') } : {})
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  })

  let pending = ''
  voiceProcess.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        mainWindow.webContents.send('voice:event', JSON.parse(line))
      } catch {
        console.error('Voice backend returned invalid event:', line)
      }
    }
  })
  voiceProcess.on('error', (error) => {
    console.error('Voice backend failed to start:', error)
    mainWindow.webContents.send('voice:event', {
      event: 'error',
      message: error.message
    })
  })
  voiceProcess.on('exit', (code, signal) => {
    console.log(`Voice backend exited (code=${code}, signal=${signal ?? 'none'})`)
    voiceProcess = undefined
  })
}

function stopVoiceBackend(): void {
  if (voiceProcess && !voiceProcess.killed) {
    voiceProcess.kill()
    voiceProcess = undefined
  }
}

function stopVoiceSession(): void {
  if (voiceProcess?.stdin?.writable) {
    voiceProcess.stdin.write('{"command":"stop_session"}\n')
  }
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
  mainWindow.setContentProtection(true)

  // Use the highest Electron stacking level so the overlay remains above
  // fullscreen applications and regular always-on-top windows.
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  const setDebugVisible = (visible: boolean): void => {
    mainWindow.setIgnoreMouseEvents(!visible, { forward: true })

    if (visible) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      mainWindow.blur()
    }

    mainWindow.webContents.send('overlay:debug-visibility-changed', visible)
  }

  mainWindow.on('ready-to-show', () => {
    setDebugVisible(false)
    mainWindow.show()
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

  let isDebugVisible = false
  const toggleDebugVisibility = (): void => {
    isDebugVisible = !isDebugVisible
    setDebugVisible(isDebugVisible)
  }

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleDebugVisibility)) {
    console.error('Could not register debug visibility shortcut: Ctrl+Shift+Space')
  }

  mainWindow.on('closed', () => {
    globalShortcut.unregister('CommandOrControl+Shift+Space')
  })
}

interface AIRequest {
  prompt: string
  imageUrl?: string
}

interface AISettings {
  baseUrl: string
  apiKey: string
  modelId: string
}

interface BoundingBox {
  bbox: [number, number, number, number]
  label?: string
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
   - For capability/permission questions (e.g., "Bud, can you see...", "Can you find..."), vary your starting responses naturally (e.g., "Yes,", "I see it,", "Sure,", "I got it,"). Never repeat the same opener consecutively.
   - For direct factual or visual-reading requests (e.g., "Bud, what time is it?", "Read the title"), state the answer directly without introductory filler.

2. TTS PHONETIC FORMATTING:
   - Convert ALL numbers, dates, times, units, currencies, and symbols into full phonetic words for the text-to-speech engine.
   - Examples: write "seven fifteen p m" (not "7:15 PM"), "forty-two dollars" (not "$42"), "percent" (not "%"), "twenty-twenty-six" (not "2026").

3. VISUAL GROUNDING ("boxes"):
   - Highlight any specific region, UI element, text block, or object directly mentioned in your response.
   - Bounding box coordinates MUST follow [ymin, xmin, ymax, xmax] format normalized on a 1000x1000 grid (integers 0 to 1000).
   - Top-left is [0, 0] and bottom-right is [1000, 1000].
   - Do NOT use percentages, decimals, pixel dimensions, or [xmin, ymin, xmax, ymax] order.

JSON Schema:
{
  "text": "spoken response formatted phonetically for text-to-speech",
  "boxes": [
    {
      "bbox": [ymin, xmin, ymax, xmax],
      "label": "descriptive label matching the spoken text"
    }
  ]
}

Example Output:
{
  "text": "The meeting starts at three thirty p m.",
  "boxes": [
    {
      "bbox": [210, 145, 380, 520],
      "label": "meeting start time"
    }
  ]
}

Use an empty "boxes" array when no relevant visual objects are present. Respond strictly with raw JSON.
`

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

  const boxes = parsed.boxes.filter((box): box is BoundingBox => {
    if (
      typeof box !== 'object' ||
      box === null ||
      !('bbox' in box) ||
      !Array.isArray(box.bbox) ||
      box.bbox.length !== 4
    ) {
      return false
    }

    return box.bbox.every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        coordinate >= 0 &&
        coordinate <= 1000
    )
  })

  if (boxes.length !== parsed.boxes.length) {
    throw new Error('The AI returned an invalid bounding box')
  }

  return { text: parsed.text, boxes }
}

async function askAI({ prompt, imageUrl }: AIRequest): Promise<string> {
  const settings = getAISettings()
  const apiKey = settings.apiKey
  const model = settings.modelId

  if (!apiKey) {
    throw new Error('NEBIUS_API_KEY is not configured')
  }

  if (!model) {
    throw new Error('NEBIUS_MODEL_ID is not configured')
  }

  const client = new OpenAI({
    baseURL: settings.baseUrl,
    apiKey
  })
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

async function capturePrimaryScreen(): Promise<string> {
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

  return source.thumbnail.toDataURL()
}

async function askAboutScreen(
  prompt: string,
  history: ScreenConversationMessage[] = []
): Promise<ScreenAIResponse> {
  const imageUrl = await capturePrimaryScreen()
  const settings = getAISettings()
  const apiKey = settings.apiKey
  const model = settings.modelId

  if (!apiKey || !model) {
    throw new Error('NEBIUS_API_KEY and NEBIUS_MODEL_ID must be configured')
  }

  const client = new OpenAI({
    baseURL: settings.baseUrl,
    apiKey
  })
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    top_p: 0.95,
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
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  bbox: {
                    type: 'array',
                    description: '[ymin, xmin, ymax, xmax], normalized from 0 to 1000.',
                    items: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1000
                    },
                    minItems: 4,
                    maxItems: 4
                  },
                  label: {
                    type: 'string',
                    description: 'A concise label for the highlighted region.'
                  }
                },
                required: ['bbox', 'label']
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

  return parseScreenResponse(content)
}

async function streamTTS(text: string, webContents: Electron.WebContents): Promise<void> {
  const requestId = randomUUID()
  const response = await fetch(`${ttsBaseUrl}/tts-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  })

  if (!response.ok || !response.body) {
    throw new Error(`TTS backend returned HTTP ${response.status}`)
  }

  const sampleRateHeader = response.headers.get('x-sample-rate')
  const sampleRate = Number(sampleRateHeader)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('TTS backend returned an invalid sample rate')
  }

  webContents.send('tts:start', { requestId, sampleRate })
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
  startTTSBackend()
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
    void streamTTS(response, _event.sender).catch((error: unknown) => {
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

    const result = await askAboutScreen(request.prompt, history)
    void streamTTS(result.text, _event.sender).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return result
  })

  ipcMain.handle('tts:speak', async (_event, text: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('TTS text must be a non-empty string')
    }

    void streamTTS(text.trim(), _event.sender).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
  })

  ipcMain.handle('voice:stop-session', () => {
    stopVoiceSession()
  })

  ipcMain.handle('settings:get-ai', () => getAISettings())

  ipcMain.handle('settings:save-ai', (_event, settings: unknown) => {
    if (
      typeof settings !== 'object' ||
      settings === null ||
      !('baseUrl' in settings) ||
      typeof settings.baseUrl !== 'string' ||
      !settings.baseUrl.trim() ||
      !('apiKey' in settings) ||
      typeof settings.apiKey !== 'string' ||
      !settings.apiKey.trim() ||
      !('modelId' in settings) ||
      typeof settings.modelId !== 'string' ||
      !settings.modelId.trim()
    ) {
      throw new Error('AI settings require a base URL, API key, and model ID')
    }

    try {
      const baseUrl = new URL(settings.baseUrl)
      if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
        throw new Error('unsupported protocol')
      }
    } catch {
      throw new Error('AI base URL must be a valid HTTP or HTTPS URL')
    }

    const savedSettings = {
      baseUrl: settings.baseUrl.trim(),
      apiKey: settings.apiKey.trim(),
      modelId: settings.modelId.trim()
    }
    saveAISettings(savedSettings)
    return savedSettings
  })

  createWindow()
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => startVoiceBackend(mainWindow))
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
  stopTTSBackend()
  stopVoiceBackend()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
