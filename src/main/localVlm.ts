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
import { findFreePort } from './freePort'

/** Alias advertised by llama-server; the local OpenAI client targets it. */
export const VL_MODEL_ALIAS = 'qwen/qwen3-vl-4b'

const VL_CONTEXT_SIZE = 8192
const HEALTH_TIMEOUT_MS = 180_000
const DOWNLOAD_PROGRESS_INTERVAL_MS = 500

const MODEL_REPOSITORY_BASE_URL =
  'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main'

const LLAMA_VERSION = 'b10792'
const LLAMA_BACKEND = 'CUDA 12.4'
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

const MODEL_QUANT = 'Q4_K_M'
const MMPROJ_QUANT = 'Q8_0'

export type VlPhase = 'pending' | 'downloading' | 'downloaded' | 'starting' | 'ready' | 'error'

export interface VlComponentStatus {
  phase: VlPhase
  /** Bytes received so far (only meaningful while downloading). */
  received?: number
  /** Total bytes expected, when known (only meaningful while downloading). */
  total?: number
  /** What is currently happening, e.g. the file being downloaded. */
  detail?: string
  /** Human readable failure reason when phase is 'error'. */
  message?: string
}

export interface VlStatusSnapshot {
  llamaVersion: string
  llamaBackend: string
  modelAlias: string
  modelQuant: string
  mmprojQuant: string
  runtime: VlComponentStatus
  model: VlComponentStatus
  mmproj: VlComponentStatus
  server: VlComponentStatus
  /** Port the bundled server bound to, once it is starting or ready. */
  port?: number
}

type VlComponentId = 'runtime' | 'model' | 'mmproj' | 'server'

let serverProcess: ChildProcess | undefined
let readyPromise: Promise<void> | undefined
let isStopping = false
let activePort: number | undefined

const componentStatus: Record<VlComponentId, VlComponentStatus> = {
  runtime: { phase: 'pending' },
  model: { phase: 'pending' },
  mmproj: { phase: 'pending' },
  server: { phase: 'pending' }
}

function buildStatusSnapshot(): VlStatusSnapshot {
  return {
    llamaVersion: LLAMA_VERSION,
    llamaBackend: LLAMA_BACKEND,
    modelAlias: VL_MODEL_ALIAS,
    modelQuant: MODEL_QUANT,
    mmprojQuant: MMPROJ_QUANT,
    runtime: { ...componentStatus.runtime },
    model: { ...componentStatus.model },
    mmproj: { ...componentStatus.mmproj },
    server: { ...componentStatus.server },
    port: activePort
  }
}

/** Current provisioning state of the bundled llama.cpp runtime and model files. */
export function getVlStatus(): VlStatusSnapshot {
  return buildStatusSnapshot()
}

function broadcastStatus(): void {
  const snapshot = buildStatusSnapshot()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('vl:status', snapshot)
  }
}

function setComponentStatus(id: VlComponentId, status: VlComponentStatus): void {
  componentStatus[id] = status
  broadcastStatus()
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

/** Base URL of the running bundled server (uses the free port chosen at launch). */
export function getLocalVlmBaseUrl(): string {
  if (!activePort) throw new Error('The local Qwen3-VL server is not running')
  return `http://127.0.0.1:${activePort}/v1/`
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
  component: VlComponentId,
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

  setComponentStatus(component, {
    phase: 'downloading',
    detail: description,
    received,
    total
  })

  const progress = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      received += chunk.length
      const now = Date.now()
      if (now - lastProgressUpdate >= DOWNLOAD_PROGRESS_INTERVAL_MS) {
        lastProgressUpdate = now
        setComponentStatus(component, {
          phase: 'downloading',
          detail: description,
          received,
          total
        })
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
    setComponentStatus(component, {
      phase: 'downloading',
      detail: description,
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
    setComponentStatus(component, {
      phase: 'error',
      detail: description,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function ensureModelFiles(): Promise<{ modelPath: string; mmprojPath: string }> {
  const directory = modelDirectory()
  mkdirSync(directory, { recursive: true })

  const targets: ReadonlyArray<{ file: ModelFile; component: VlComponentId }> = [
    { file: MODEL_GGUF, component: 'model' },
    { file: MMPROJ_GGUF, component: 'mmproj' }
  ]

  for (const { file, component } of targets) {
    const destination = join(directory, file.fileName)
    if (existsSync(destination) && statSync(destination).size >= file.minBytes) {
      setComponentStatus(component, { phase: 'downloaded', detail: file.fileName })
      continue
    }
    await downloadToFile(
      `${MODEL_REPOSITORY_BASE_URL}/${file.fileName}`,
      destination,
      component,
      file.fileName,
      file.minBytes
    )
    setComponentStatus(component, { phase: 'downloaded', detail: file.fileName })
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
      'The llama.cpp runtime is only auto-provisioned on Windows. On other platforms, ' +
        'stage a llama-server binary in build/vl/bin first.'
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
    setComponentStatus('runtime', {
      phase: 'downloading',
      detail: `build ${LLAMA_VERSION} (${LLAMA_BACKEND})`
    })
    for (const archive of LLAMA_WIN_ARCHIVES) {
      const archivePath = join(provisionDir, archive.name)
      await downloadToFile(
        `${LLAMA_RELEASE_BASE_URL}/${archive.name}`,
        archivePath,
        'runtime',
        archive.name,
        archive.minBytes
      )
      archivePaths.push(archivePath)
    }

    setComponentStatus('runtime', { phase: 'downloading', detail: 'Extracting llama.cpp runtime' })
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

    setComponentStatus('runtime', {
      phase: 'downloaded',
      detail: `build ${LLAMA_VERSION} (${LLAMA_BACKEND})`
    })
    return executable
  } catch (error) {
    setComponentStatus('runtime', {
      phase: 'error',
      detail: `build ${LLAMA_VERSION} (${LLAMA_BACKEND})`,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
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
  const runtimeDetail = `build ${LLAMA_VERSION} (${LLAMA_BACKEND})`

  // A runtime manually staged inside packaged resources, if any. Slim installs no
  // longer ship build/vl — the runtime is downloaded into the user-data directory.
  if (app.isPackaged) {
    const packagedExecutable = join(process.resourcesPath, 'vl', 'bin', binaryName)
    if (existsSync(packagedExecutable)) {
      setComponentStatus('runtime', { phase: 'downloaded', detail: runtimeDetail })
      return packagedExecutable
    }
  }

  // Development builds can use a manually pre-staged copy under build/vl/bin.
  const stagedExecutable = join(app.getAppPath(), 'build', 'vl', 'bin', binaryName)
  if (existsSync(stagedExecutable)) {
    setComponentStatus('runtime', { phase: 'downloaded', detail: runtimeDetail })
    return stagedExecutable
  }

  const provisionedExecutable = join(provisionDirectory(), 'bin', binaryName)
  if (existsSync(provisionedExecutable)) {
    setComponentStatus('runtime', { phase: 'downloaded', detail: runtimeDetail })
    return provisionedExecutable
  }

  return provisionLlamaRuntime()
}

function spawnServer(
  executablePath: string,
  binDirectory: string,
  port: number,
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
    String(port),
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
    setComponentStatus('server', {
      phase: 'error',
      message: `Qwen3-VL server exited (code=${code ?? 'unknown'})`
    })
  })

  return child
}

async function waitForServer(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Qwen3-VL server exited before it became ready (code=${child.exitCode})`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
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

  const port = await findFreePort()
  activePort = port
  console.log(`[vl] Starting Qwen3-VL server on port ${port}`)
  setComponentStatus('server', { phase: 'starting', detail: `127.0.0.1:${port}` })
  const child = spawnServer(executablePath, dirname(executablePath), port, modelPath, mmprojPath)
  serverProcess = child

  await waitForServer(child, port)
  setComponentStatus('server', { phase: 'ready', detail: `127.0.0.1:${port}` })
  console.log('[vl] Qwen3-VL server is ready')
}

function stopServer(): void {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill()
  }
  serverProcess = undefined
  activePort = undefined
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
      if (componentStatus.server.phase === 'starting') {
        setComponentStatus('server', { phase: 'error', message })
      }
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
