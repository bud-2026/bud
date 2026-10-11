import { app, BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync
} from 'fs'
import { dirname, join } from 'path'
import { Readable, Transform, type TransformCallback } from 'stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'stream/promises'

/** Local port served by the bundled llama-server process. */
export const VL_PORT = 8766

/** OpenAI-compatible base URL of the bundled Qwen3-VL server. */
export const VL_BASE_URL = `http://127.0.0.1:${VL_PORT}/v1/`

/** Alias advertised by llama-server, matches the model ID stored in AI settings. */
const VL_MODEL_ALIAS = 'qwen/qwen3-vl-4b'
const VL_CONTEXT_SIZE = 8192
const HEALTH_TIMEOUT_MS = 180_000
const DOWNLOAD_PROGRESS_INTERVAL_MS = 500

const MODEL_REPOSITORY_BASE_URL =
  'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main'

const LLAMA_VERSION = 'b10792'
const LLAMA_RELEASE_BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`
const LLAMA_WIN_ARCHIVES = [
  {
    name: `llama-${LLAMA_VERSION}-bin-win-cuda-12.4-x64.zip`,
    minBytes: 50_000_000
  },
  {
    name: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
    minBytes: 100_000_000
  }
]

interface ModelFile {
  fileName: string
  minBytes: number
}

const MODEL_GGUF: ModelFile = {
  fileName: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
  minBytes: 1_500_000_000
}

const MMPROJ_GGUF: ModelFile = {
  fileName: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
  minBytes: 200_000_000
}

export type VlStatusState = 'downloading' | 'loading' | 'ready' | 'error'

export interface VlStatusEvent {
  state: VlStatusState
  file?: string
  received?: number
  total?: number
  message?: string
}

let serverProcess: ChildProcess | undefined
let readyPromise: Promise<void> | undefined
let isStopping = false

function broadcastStatus(event: VlStatusEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('vl:status', event)
  }
}

function modelDirectory(): string {
  return join(app.getPath('userData'), 'models')
}

function provisionDirectory(): string {
  return join(app.getPath('userData'), 'llama-cpp', LLAMA_VERSION)
}

function serverBinaryName(): string {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

/** Returns true when the given base URL points at the bundled Qwen3-VL server. */
export function isLocalVlmUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl.trim())
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    return isLoopback && url.port === String(VL_PORT)
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  try {
    await runCommand('tar.exe', ['-xf', zipPath, '-C', destination])
    return
  } catch {
    // Fall back to PowerShell's Expand-Archive (bundled with Windows).
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destination}' -Force`
    ])
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  description: string,
  minBytes: number
): Promise<void> {
  const partialPath = `${destination}.part`
  console.log(`[vl] Downloading ${description}`)

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${description} (HTTP ${response.status})`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  let lastProgressUpdate = 0

  const progress = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      received += chunk.length
      const now = Date.now()
      if (now - lastProgressUpdate >= DOWNLOAD_PROGRESS_INTERVAL_MS) {
        lastProgressUpdate = now
        broadcastStatus({ state: 'downloading', file: description, received, total })
      }
      callback(null, chunk)
    }
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      progress,
      createWriteStream(partialPath)
    )

    const downloadedBytes = statSync(partialPath).size
    if (total > 0 && downloadedBytes !== total) {
      throw new Error(`Incomplete download of ${description} (${downloadedBytes}/${total} bytes)`)
    }
    if (downloadedBytes < minBytes) {
      throw new Error(`Download of ${description} is too small (${downloadedBytes} bytes)`)
    }

    renameSync(partialPath, destination)
    broadcastStatus({
      state: 'downloading',
      file: description,
      received: downloadedBytes,
      total: downloadedBytes
    })
    console.log(`[vl] Finished downloading ${description}`)
  } catch (error) {
    if (existsSync(partialPath)) {
      try {
        unlinkSync(partialPath)
      } catch {
        // Leftover .part files are removed on the next download attempt.
      }
    }
    throw error
  }
}

async function ensureModelFiles(): Promise<{ modelPath: string; mmprojPath: string }> {
  const directory = modelDirectory()
  mkdirSync(directory, { recursive: true })

  for (const file of [MODEL_GGUF, MMPROJ_GGUF]) {
    const destination = join(directory, file.fileName)
    if (existsSync(destination) && statSync(destination).size >= file.minBytes) {
      continue
    }
    await downloadToFile(
      `${MODEL_REPOSITORY_BASE_URL}/${file.fileName}`,
      destination,
      file.fileName,
      file.minBytes
    )
  }

  return {
    modelPath: join(directory, MODEL_GGUF.fileName),
    mmprojPath: join(directory, MMPROJ_GGUF.fileName)
  }
}

// Copies every file under sourceDir into destinationDir, flattening the
// directory tree (matching the layout of a pre-staged build/vl).
function flattenCopy(sourceDir: string, destinationDir: string): void {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    if (entry.isDirectory()) {
      flattenCopy(sourcePath, destinationDir)
    } else {
      copyFileSync(sourcePath, join(destinationDir, entry.name))
    }
  }
}

// Downloads and extracts the llama.cpp runtime on first launch. The archives
// are fetched into the user data directory and deleted after extraction.
async function provisionLlamaRuntime(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(
      'llama-server is not prepared. Stage it in build/vl first (run "npm run prepare:vl").'
    )
  }

  const provisionDir = provisionDirectory()
  const binDir = join(provisionDir, 'bin')
  const extractDir = join(provisionDir, '.extract')
  const executable = join(binDir, serverBinaryName())

  mkdirSync(provisionDir, { recursive: true })
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })

  const archivePaths: string[] = []
  try {
    for (const archive of LLAMA_WIN_ARCHIVES) {
      const archivePath = join(provisionDir, archive.name)
      await downloadToFile(
        `${LLAMA_RELEASE_BASE_URL}/${archive.name}`,
        archivePath,
        archive.name,
        archive.minBytes
      )
      archivePaths.push(archivePath)
    }

    for (const archivePath of archivePaths) {
      await extractZip(archivePath, extractDir)
    }

    mkdirSync(binDir, { recursive: true })
    flattenCopy(extractDir, binDir)

    if (!existsSync(executable)) {
      throw new Error(
        'llama-server.exe is missing after extracting the llama.cpp release archives.'
      )
    }

    return executable
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
    for (const archivePath of archivePaths) {
      try {
        unlinkSync(archivePath)
      } catch {
        // Archive cleanup is best-effort; already-downloaded files are reused on retry.
      }
    }
  }
}

async function ensureServerExecutable(): Promise<string> {
  const binaryName = serverBinaryName()

  // Packaged apps ship the runtime inside the app resources.
  if (app.isPackaged) {
    const packagedExecutable = join(process.resourcesPath, 'vl', 'bin', binaryName)
    if (existsSync(packagedExecutable)) return packagedExecutable
  }

  // Development builds can use a pre-staged copy (npm run prepare:vl).
  const stagedExecutable = join(app.getAppPath(), 'build', 'vl', 'bin', binaryName)
  if (existsSync(stagedExecutable)) return stagedExecutable

  const provisionedExecutable = join(provisionDirectory(), 'bin', binaryName)
  if (existsSync(provisionedExecutable)) return provisionedExecutable

  return provisionLlamaRuntime()
}

function spawnServer(
  executablePath: string,
  binDirectory: string,
  modelPath: string,
  mmprojPath: string
): ChildProcess {
  const args = [
    '-m',
    modelPath,
    '--mmproj',
    mmprojPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(VL_PORT),
    '--alias',
    VL_MODEL_ALIAS,
    '--jinja',
    '-ngl',
    '999',
    '--ctx-size',
    String(VL_CONTEXT_SIZE)
  ]

  const child = spawn(executablePath, args, {
    cwd: binDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const logChunk = (chunk: string): void => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) console.log(`[vl] ${line}`)
    }
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', logChunk)
  child.stderr?.on('data', logChunk)

  child.on('error', (error) => console.error('Local vision backend failed to start:', error))
  child.on('exit', (code, signal) => {
    console.log(`Local vision backend exited (code=${code}, signal=${signal ?? 'none'})`)
    if (serverProcess === child) serverProcess = undefined
    if (isStopping) return
    readyPromise = undefined
    broadcastStatus({
      state: 'error',
      message: `Qwen3-VL server exited (code=${code ?? 'unknown'})`
    })
  })

  return child
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Qwen3-VL server exited before it became ready (code=${child.exitCode})`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${VL_PORT}/health`)
      if (response.ok) return
    } catch {
      // The server is not listening yet; keep polling.
    }

    await delay(500)
  }

  throw new Error(`Qwen3-VL server did not become ready within ${HEALTH_TIMEOUT_MS / 1000} seconds`)
}

async function launchLocalVlm(): Promise<void> {
  const executablePath = await ensureServerExecutable()
  const { modelPath, mmprojPath } = await ensureModelFiles()

  broadcastStatus({ state: 'loading' })
  const child = spawnServer(executablePath, dirname(executablePath), modelPath, mmprojPath)
  serverProcess = child

  await waitForServer(child)
  broadcastStatus({ state: 'ready' })
  console.log('[vl] Qwen3-VL server is ready')
}

function stopServer(): void {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill()
  }
  serverProcess = undefined
}

/**
 * Resolves once the bundled Qwen3-VL server is downloaded, started, and healthy.
 * Failures reset the attempt so a later request can retry.
 */
export function ensureLocalVlmReady(): Promise<void> {
  if (!readyPromise) {
    isStopping = false
    const attempt = launchLocalVlm().catch((error: unknown) => {
      if (readyPromise === attempt) readyPromise = undefined
      stopServer()
      const message = error instanceof Error ? error.message : String(error)
      console.error('[vl] Could not start the local Qwen3-VL server:', message)
      broadcastStatus({ state: 'error', message })
      throw error
    })
    readyPromise = attempt
  }
  return readyPromise
}

/** Starts downloading the model and launching the server right away. */
export function startLocalVlm(): void {
  void ensureLocalVlmReady().catch(() => {
    // The failure is already logged and broadcast as a status event.
  })
}

/** Stops the bundled server; called when the app is quitting. */
export function stopLocalVlm(): void {
  isStopping = true
  readyPromise = undefined
  stopServer()
}
