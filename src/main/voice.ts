import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getActiveOverlay, getVoiceWindow, setVoiceWindow } from './overlay'
import { ensureSpeechModelCacheDirectory, packagedBackendDirectory } from './paths'
import { getSttStatus, readLines, setSttStatus, type VoiceBackendEvent } from './status'

let voiceProcess: ChildProcess | undefined
let isStoppingVoice = false

// Routes a voice event to a single overlay. A wake word latches the overlay on
// the display under the cursor, and a question re-latches there so the answer is
// always about the screen the user is looking at. Pre-answer events (orb,
// status) follow the same window so the conversation does not jump screens.
function sendVoiceEvent(event: VoiceBackendEvent): void {
  if (event.event === 'wake_detected') {
    setVoiceWindow(getActiveOverlay())
  } else if (event.event === 'final' && !event.end_session) {
    setVoiceWindow(getActiveOverlay())
  }

  const current = getVoiceWindow()
  const target = current && !current.isDestroyed() ? current : getActiveOverlay()

  if (event.event === 'error' || (event.event === 'final' && event.end_session)) {
    setVoiceWindow(undefined)
  }

  if (target) {
    target.webContents.send('voice:event', event)
  }
}

export function startVoiceBackend(): void {
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
    sendVoiceEvent(event)
  })

  child.on('error', (error) => {
    console.error('Voice backend failed to start:', error)
    setSttStatus({
      wakeWord: { phase: 'error', message: error.message },
      transcription: { phase: 'error', message: error.message }
    })
    sendVoiceEvent({
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
  const current = getSttStatus()
  switch (event.event) {
    case 'ready':
      setSttStatus({
        ...current,
        wakeWord: {
          phase: 'ready',
          detail: event.wake_word ? `Wake word: ${event.wake_word}` : undefined
        }
      })
      break
    case 'listening':
      if (current.wakeWord.phase !== 'ready') {
        setSttStatus({ ...current, wakeWord: { phase: 'ready' } })
      }
      break
    case 'transcribing':
      setSttStatus({ ...current, transcription: { phase: 'ready', detail: 'Moonshine · en' } })
      break
    case 'status': {
      if (event.phase === 'loading') {
        setSttStatus({ ...current, transcription: { phase: 'loading', detail: event.message } })
      } else if (event.phase === 'ready') {
        setSttStatus({ ...current, transcription: { phase: 'ready', detail: event.message } })
      } else if (event.phase === 'error') {
        setSttStatus({ ...current, transcription: { phase: 'error', message: event.message } })
      } else if (event.phase === 'downloading' || /download/i.test(event.message ?? '')) {
        setSttStatus({ ...current, wakeWord: { phase: 'downloading', detail: event.message } })
      } else {
        setSttStatus({ ...current, wakeWord: { phase: 'starting', detail: event.message } })
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

export function stopVoiceBackend(): void {
  isStoppingVoice = true
  const child = voiceProcess
  voiceProcess = undefined
  if (child && !child.killed) {
    child.kill()
  }
}

export function stopVoiceSession(): void {
  if (voiceProcess?.stdin?.writable) {
    voiceProcess.stdin.write('{"command":"stop_session"}\n')
  }
}

export function setVoiceListenMode(continuous: boolean): void {
  if (voiceProcess?.stdin?.writable) {
    voiceProcess.stdin.write(
      `${JSON.stringify({ command: 'set_mode', mode: continuous ? 'continuous' : 'wake' })}\n`
    )
  }
}
