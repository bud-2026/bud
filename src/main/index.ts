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
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

dotenv.config({ path: join(app.getAppPath(), '.env') })

const ttsPort = Number(process.env.TTS_BACKEND_PORT ?? 8765)
const ttsBaseUrl = process.env.TTS_BACKEND_URL ?? `http://127.0.0.1:${ttsPort}`
let ttsProcess: ChildProcess | undefined
let voiceProcess: ChildProcess | undefined

function startTTSBackend(): void {
  const backendDirectory = join(app.getAppPath(), 'backend')
  const ttsDirectory = join(app.getAppPath(), 'backend', 'tts')
  const venvPython = join(ttsDirectory, '.venv', 'Scripts', 'python.exe')
  const pythonExecutable = existsSync(venvPython) ? venvPython : 'python'
  const backendScript = join(ttsDirectory, 'main.py')

  if (!existsSync(backendScript)) {
    console.error(`TTS backend script not found: ${backendScript}`)
    return
  }

  ttsProcess = spawn(pythonExecutable, [backendScript, '--port', String(ttsPort)], {
    cwd: backendDirectory,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  })
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
  const backendDirectory = join(app.getAppPath(), 'backend', 'stt')
  const venvPython = join(backendDirectory, '.venv', 'Scripts', 'python.exe')
  const pythonExecutable = existsSync(venvPython) ? venvPython : 'python'
  const backendScript = join(backendDirectory, 'main.py')

  if (!existsSync(backendScript)) {
    console.error(`Voice backend script not found: ${backendScript}`)
    return
  }

  voiceProcess = spawn(pythonExecutable, [backendScript], {
    cwd: backendDirectory,
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
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

  const setOverlayFocused = (focused: boolean): void => {
    mainWindow.setIgnoreMouseEvents(!focused, { forward: true })

    if (focused) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      mainWindow.blur()
    }

    mainWindow.webContents.send('overlay:focus-changed', focused)
  }

  mainWindow.on('ready-to-show', () => {
    setOverlayFocused(true)
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

  const toggleOverlayFocus = (): void => {
    setOverlayFocused(mainWindow.isFocused() === false)
  }

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlayFocus)) {
    console.error('Could not register overlay focus shortcut: Ctrl+Shift+Space')
  }

  mainWindow.on('closed', () => {
    globalShortcut.unregister('CommandOrControl+Shift+Space')
  })
}

interface AIRequest {
  prompt: string
  imageUrl?: string
}

interface BoundingBox {
  topLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
  label?: string
}

interface ScreenAIResponse {
  text: string
  boxes: BoundingBox[]
}

const systemPrompt = `
Analyze the image. Return ONLY valid JSON matching the schema below.

CRITICAL INSTRUCTIONS:
1. "text": Write in a conversational, friendly, and concise spoken style suitable for a voice assistant (like Siri). Avoid overly formal language or robotic listings—phrase it naturally as if speaking aloud to the user.
2. "boxes": Highlight every relevant object or visual element referenced in your spoken text.
3. Coordinates MUST use a 1000x1000 grid, from 0 to 1000 on both axes [ymin, xmin, ymax, xmax]. Top-left is (0,0) and bottom-right is (1000,1000).
4. DO NOT return percentages or absolute pixel dimensions.

JSON Schema:
{
  "text": "spoken response to the user",
  "boxes": [
    {
      "topLeft": { "x": 0, "y": 0 },
      "bottomRight": { "x": 0, "y": 0 },
      "label": "descriptive label matching the spoken text"
    }
  ]
}

Example Output:
{
  "text": "It looks like the train is arriving at 7:15 PM.",
  "boxes": [
    {
      "topLeft": { "x": 438, "y": 577 },
      "bottomRight": { "x": 663, "y": 653 },
      "label": "train departure time"
    }
  ]
}

Use an empty "boxes" array only when no relevant spatial objects are present. Respond ONLY with raw JSON.
`

function parseScreenResponse(content: string): ScreenAIResponse {
  const jsonContent = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

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
    if (typeof box !== 'object' || box === null || !('topLeft' in box) || !('bottomRight' in box)) {
      return false
    }

    const points = [box.topLeft, box.bottomRight]
    return points.every(
      (point) =>
        typeof point === 'object' &&
        point !== null &&
        'x' in point &&
        'y' in point &&
        typeof point.x === 'number' &&
        typeof point.y === 'number' &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= 1000 &&
        point.y >= 0 &&
        point.y <= 1000
    )
  })

  if (boxes.length !== parsed.boxes.length) {
    throw new Error('The AI returned an invalid bounding box')
  }

  return { text: parsed.text, boxes }
}

async function askAI({ prompt, imageUrl }: AIRequest): Promise<string> {
  const apiKey = process.env.NEBIUS_API_KEY
  const model = process.env.NEBIUS_MODEL_ID

  if (!apiKey) {
    throw new Error('NEBIUS_API_KEY is not configured')
  }

  if (!model) {
    throw new Error('NEBIUS_MODEL_ID is not configured')
  }

  const client = new OpenAI({
    baseURL: process.env.AI_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
    apiKey
  })
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: process.env.NEBIUS_SYSTEM_PROMPT ?? 'You are a helpful assistant.'
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
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: display.size.width,
      height: display.size.height
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

async function askAboutScreen(prompt: string): Promise<ScreenAIResponse> {
  const imageUrl = await capturePrimaryScreen()
  const apiKey = process.env.NEBIUS_API_KEY
  const model = process.env.NEBIUS_MODEL_ID

  if (!apiKey || !model) {
    throw new Error('NEBIUS_API_KEY and NEBIUS_MODEL_ID must be configured')
  }

  const client = new OpenAI({
    baseURL: process.env.AI_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
    apiKey
  })
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
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

  ipcMain.handle('ai:ask-screen', async (_event, prompt: unknown) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('Screen analysis prompt must be a non-empty string')
    }

    const result = await askAboutScreen(prompt)
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
