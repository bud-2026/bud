import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { findFreePort } from './freePort'
import { ensureSpeechModelCacheDirectory, packagedBackendDirectory } from './paths'
import { getTtsVoice } from './settings'
import { delay, readLines, setTtsStatus } from './status'

const TTS_HEALTH_TIMEOUT_MS = 120_000

// Chosen at launch so the bundled TTS backend never clashes on a fixed port.
let ttsBaseUrl: string | undefined
let ttsProcess: ChildProcess | undefined
let isStoppingTts = false

export async function startTTSBackend(): Promise<void> {
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

export function stopTTSBackend(): void {
  isStoppingTts = true
  if (ttsProcess && !ttsProcess.killed) {
    ttsProcess.kill()
  }
  ttsProcess = undefined
  ttsBaseUrl = undefined
}

export async function streamTTS(
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
