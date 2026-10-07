import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface BoundingBox {
    /** Coordinates from 0 to 1000 on a normalized 1000x1000 screen grid. */
    topLeft: { x: number; y: number }
    bottomRight: { x: number; y: number }
    label?: string
  }

  interface ScreenAIResponse {
    text: string
    boxes: BoundingBox[]
  }

  interface Api {
    ai: {
      ask: (prompt: string, imageUrl?: string) => Promise<string>
      askScreen: (prompt: string) => Promise<ScreenAIResponse>
    }
    overlay: {
      onFocusChanged: (callback: (focused: boolean) => void) => () => void
    }
    tts: {
      speak: (text: string) => Promise<void>
      onStart: (callback: (event: { requestId: string; sampleRate: number }) => void) => () => void
      onChunk: (callback: (event: { requestId: string; chunk: Uint8Array }) => void) => () => void
      onEnd: (callback: (requestId: string) => void) => () => void
      onError: (callback: (message: string) => void) => () => void
    }
    voice: {
      onEvent: (
        callback: (event: {
          event:
            | 'ready'
            | 'listening'
            | 'wake_detected'
            | 'transcribing'
            | 'transcript'
            | 'final'
            | 'status'
            | 'error'
          text?: string
          final?: boolean
          message?: string
          wake_word?: string
        }) => void
      ) => () => void
    }
  }

  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
