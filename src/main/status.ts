import { BrowserWindow } from 'electron'

// Dashboard-facing provisioning state for the speech backends. Mirrors the
// phase model used by the bundled vision server so the settings panel can
// render every component the same way.
export type BackendPhase =
  'pending' | 'downloading' | 'loading' | 'starting' | 'ready' | 'error' | 'off'

export interface BackendComponentStatus {
  phase: BackendPhase
  /** What is currently happening, e.g. the file being downloaded or loaded. */
  detail?: string
  /** Human readable failure reason when phase is 'error'. */
  message?: string
}

export interface SttStatusSnapshot {
  /** openwakeword wake word detector. */
  wakeWord: BackendComponentStatus
  /** Moonshine speech recognizer (loads on first use). */
  transcription: BackendComponentStatus
}

export interface VoiceBackendEvent {
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

export function broadcast(channel: string, status: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, status)
  }
}

export function getSttStatus(): SttStatusSnapshot {
  return sttStatus
}

export function getTtsStatus(): BackendComponentStatus {
  return ttsStatus
}

export function setSttStatus(status: SttStatusSnapshot): void {
  sttStatus = status
  broadcast('stt:status', status)
}

export function setTtsStatus(status: BackendComponentStatus): void {
  ttsStatus = status
  broadcast('tts:status', status)
}

export function markSttOff(): void {
  setSttStatus({ wakeWord: { ...VOICE_OFF_STATUS }, transcription: { ...VOICE_OFF_STATUS } })
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// Splits a child process stream into trimmed, non-empty lines.
export function readLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void
): void {
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
