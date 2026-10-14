import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface BoundingBox {
    /** Coordinates from 0 to 1000 on a normalized 1000x1000 screen grid. */
    bbox: [number, number, number, number]
    label?: string
    copy?: string
  }

  interface ScreenAIResponse {
    text: string
    boxes: BoundingBox[]
  }

  interface ScreenConversationMessage {
    role: 'user' | 'assistant'
    content: string
  }

  /** Normalized screen region on the 1000x1000 display grid. */
  interface Region {
    x: number
    y: number
    width: number
    height: number
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
  }

  type SpeechMode = 'field' | 'fixed' | 'template'
  type LabelMode = 'fixed' | 'template'

  interface SpeechMapping {
    mode: SpeechMode
    value: string
  }

  interface LabelMapping {
    mode: LabelMode
    value: string
  }

  interface CustomPromptFields {
    speech: SpeechMapping
    /** Schema field whose value becomes the copy button content. */
    copy?: string
    /** Indicator label; defaults to the prompt name when omitted with a copy field. */
    label?: LabelMapping
  }

  /** A user-authored prompt preset replacing the built-in system prompt and schema. */
  interface CustomPrompt {
    id: string
    name: string
    /** Optional prefix (e.g. "translate") that activates this prompt for one question. */
    trigger?: string
    systemPrompt: string
    schema: Record<string, unknown>
    fields: CustomPromptFields
    /** true = send the screenshot/region (vision); false = general model only. */
    useScreen: boolean
    /** Default question text offered when this prompt is selected. */
    prefill?: string
  }

  type VlPhase = 'pending' | 'downloading' | 'downloaded' | 'starting' | 'ready' | 'error'

  interface VlComponentStatus {
    phase: VlPhase
    received?: number
    total?: number
    detail?: string
    message?: string
  }

  interface VlStatusSnapshot {
    llamaVersion: string
    llamaBackend: string
    modelAlias: string
    modelQuant: string
    mmprojQuant: string
    runtime: VlComponentStatus
    model: VlComponentStatus
    mmproj: VlComponentStatus
    server: VlComponentStatus
    port?: number
  }

  type BackendPhase = 'pending' | 'downloading' | 'loading' | 'starting' | 'ready' | 'error' | 'off'

  interface BackendComponentStatus {
    phase: BackendPhase
    detail?: string
    message?: string
  }

  interface SttStatusSnapshot {
    wakeWord: BackendComponentStatus
    transcription: BackendComponentStatus
  }

  interface Api {
    ai: {
      ask: (prompt: string, imageUrl?: string) => Promise<string>
      askQuestion: (
        prompt: string,
        history?: ScreenConversationMessage[],
        region?: Region,
        customPromptId?: string
      ) => Promise<ScreenAIResponse>
      askScreen: (
        prompt: string,
        history?: ScreenConversationMessage[],
        region?: Region
      ) => Promise<ScreenAIResponse>
    }
    overlay: {
      setInteractive: (interactive: boolean) => void
      setSelectMode: (active: boolean) => void
      setDebugVisible: (visible: boolean) => void
      getInfo: () => Promise<{ displayId: number; isPrimary: boolean }>
      onDebugVisibilityChanged: (callback: (visible: boolean) => void) => () => void
    }
    tts: {
      speak: (text: string, voice?: string) => Promise<void>
      getVoice: () => Promise<string>
      setVoice: (voice: string) => Promise<string>
      onStart: (
        callback: (event: { requestId: string; sampleRate: number; text: string }) => void
      ) => () => void
      onChunk: (callback: (event: { requestId: string; chunk: Uint8Array }) => void) => () => void
      onEnd: (callback: (requestId: string) => void) => () => void
      onError: (callback: (message: string) => void) => () => void
      getStatus: () => Promise<BackendComponentStatus>
      onStatus: (callback: (status: BackendComponentStatus) => void) => () => void
    }
    voice: {
      stopSession: () => Promise<void>
      setListenMode: (continuous: boolean) => Promise<void>
      getEnabled: () => Promise<boolean>
      setEnabled: (enabled: boolean) => Promise<boolean>
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
          auto?: boolean
        }) => void
      ) => () => void
    }
    answers: {
      getWrite: () => Promise<boolean>
      setWrite: (enabled: boolean) => Promise<boolean>
    }
    settings: {
      getAI: () => Promise<AISettings>
      saveAI: (settings: AISettings) => Promise<AISettings>
    }
    prompts: {
      list: () => Promise<CustomPrompt[]>
      save: (prompt: CustomPrompt) => Promise<CustomPrompt[]>
      remove: (id: string) => Promise<CustomPrompt[]>
    }
    guide: {
      getSeen: () => Promise<boolean>
      setSeen: (seen: boolean) => Promise<boolean>
    }
    vl: {
      getStatus: () => Promise<VlStatusSnapshot>
      onStatus: (callback: (status: VlStatusSnapshot) => void) => () => void
    }
    stt: {
      getStatus: () => Promise<SttStatusSnapshot>
      onStatus: (callback: (status: SttStatusSnapshot) => void) => () => void
    }
    app: {
      quit: () => Promise<void>
    }
  }

  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
