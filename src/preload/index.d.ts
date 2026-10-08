import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface BoundingBox {
    /** Coordinates from 0 to 1000 on a normalized 1000x1000 screen grid. */
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

    interface AISettings {
      baseUrl: string
      apiKey: string
      modelId: string
    }

  interface Api {
    ai: {
      ask: (prompt: string, imageUrl?: string) => Promise<string>
      askScreen: (
        prompt: string,
        history?: ScreenConversationMessage[]
      ) => Promise<ScreenAIResponse>
    }
    overlay: {
      onDebugVisibilityChanged: (callback: (visible: boolean) => void) => () => void
    }
    tts: {
      speak: (text: string) => Promise<void>
      onStart: (callback: (event: { requestId: string; sampleRate: number }) => void) => () => void
      onChunk: (callback: (event: { requestId: string; chunk: Uint8Array }) => void) => () => void
      onEnd: (callback: (requestId: string) => void) => () => void
      onError: (callback: (message: string) => void) => () => void
    }
    voice: {
      stopSession: () => Promise<void>
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
          end_session?: boolean
          message?: string
          wake_word?: string
        }) => void
      ) => () => void
    }
    settings: {
      getAI: () => Promise<AISettings>
      saveAI: (settings: AISettings) => Promise<AISettings>
    }
  }

  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
