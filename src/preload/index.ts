import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ScreenAIResponse {
  text: string
  boxes: Array<{
    bbox: [number, number, number, number]
    label?: string
  }>
}

/** Normalized screen region on the 1000x1000 display grid. */
interface Region {
  x: number
  y: number
  width: number
  height: number
}

interface ScreenConversationMessage {
  role: 'user' | 'assistant'
  content: string
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

interface TTSStartEvent {
  requestId: string
  sampleRate: number
  text: string
}

interface TTSChunkEvent {
  requestId: string
  chunk: Uint8Array
}

interface VoiceEvent {
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

// Custom APIs for renderer
const api = {
  ai: {
    ask: (prompt: string, imageUrl?: string): Promise<string> =>
      ipcRenderer.invoke('ai:ask', { prompt, imageUrl }),
    askQuestion: (
      prompt: string,
      history?: ScreenConversationMessage[],
      region?: Region
    ): Promise<ScreenAIResponse> =>
      ipcRenderer.invoke('ai:ask-question', { prompt, history, region }),
    askScreen: (
      prompt: string,
      history?: ScreenConversationMessage[],
      region?: Region
    ): Promise<ScreenAIResponse> => ipcRenderer.invoke('ai:ask-screen', { prompt, history, region })
  },
  overlay: {
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send('overlay:set-interactive', interactive)
    },
    setSelectMode: (active: boolean): void => {
      ipcRenderer.send('overlay:set-select-mode', active)
    },
    setDebugVisible: (visible: boolean): void => {
      ipcRenderer.send('overlay:set-debug-visible', visible)
    },
    onDebugVisibilityChanged: (callback: (visible: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean): void => {
        callback(visible)
      }
      ipcRenderer.on('overlay:debug-visibility-changed', listener)
      return () => ipcRenderer.removeListener('overlay:debug-visibility-changed', listener)
    }
  },
  tts: {
    speak: (text: string, voice?: string): Promise<void> =>
      ipcRenderer.invoke('tts:speak', text, voice),
    getVoice: (): Promise<string> => ipcRenderer.invoke('tts:get-voice'),
    setVoice: (voice: string): Promise<string> => ipcRenderer.invoke('tts:set-voice', voice),
    onStart: (callback: (event: TTSStartEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: TTSStartEvent): void =>
        callback(data)
      ipcRenderer.on('tts:start', listener)
      return () => ipcRenderer.removeListener('tts:start', listener)
    },
    onChunk: (callback: (event: TTSChunkEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: TTSChunkEvent): void =>
        callback(data)
      ipcRenderer.on('tts:chunk', listener)
      return () => ipcRenderer.removeListener('tts:chunk', listener)
    },
    onEnd: (callback: (requestId: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }): void =>
        callback(data.requestId)
      ipcRenderer.on('tts:end', listener)
      return () => ipcRenderer.removeListener('tts:end', listener)
    },
    onError: (callback: (message: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { message: string }): void =>
        callback(data.message)
      ipcRenderer.on('tts:error', listener)
      return () => ipcRenderer.removeListener('tts:error', listener)
    },
    getStatus: (): Promise<BackendComponentStatus> => ipcRenderer.invoke('tts:get-status'),
    onStatus: (callback: (status: BackendComponentStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: BackendComponentStatus): void =>
        callback(data)
      ipcRenderer.on('tts:status', listener)
      return () => ipcRenderer.removeListener('tts:status', listener)
    }
  },
  voice: {
    stopSession: (): Promise<void> => ipcRenderer.invoke('voice:stop-session'),
    setListenMode: (continuous: boolean): Promise<void> =>
      ipcRenderer.invoke('voice:set-listen-mode', continuous),
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke('voice:get-enabled'),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('voice:set-enabled', enabled),
    onEvent: (callback: (event: VoiceEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: VoiceEvent): void => callback(data)
      ipcRenderer.on('voice:event', listener)
      return () => ipcRenderer.removeListener('voice:event', listener)
    }
  },
  answers: {
    getWrite: (): Promise<boolean> => ipcRenderer.invoke('answers:get-write'),
    setWrite: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('answers:set-write', enabled)
  },
  vl: {
    getStatus: (): Promise<VlStatusSnapshot> => ipcRenderer.invoke('vl:get-status'),
    onStatus: (callback: (status: VlStatusSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: VlStatusSnapshot): void =>
        callback(data)
      ipcRenderer.on('vl:status', listener)
      return () => ipcRenderer.removeListener('vl:status', listener)
    }
  },
  stt: {
    getStatus: (): Promise<SttStatusSnapshot> => ipcRenderer.invoke('stt:get-status'),
    onStatus: (callback: (status: SttStatusSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: SttStatusSnapshot): void =>
        callback(data)
      ipcRenderer.on('stt:status', listener)
      return () => ipcRenderer.removeListener('stt:status', listener)
    }
  },
  settings: {
    getAI: (): Promise<AISettings> => ipcRenderer.invoke('settings:get-ai'),
    saveAI: (settings: AISettings): Promise<AISettings> =>
      ipcRenderer.invoke('settings:save-ai', settings)
  },
  guide: {
    getSeen: (): Promise<boolean> => ipcRenderer.invoke('guide:get-seen'),
    setSeen: (seen: boolean): Promise<boolean> => ipcRenderer.invoke('guide:set-seen', seen)
  },
  app: {
    quit: (): Promise<void> => ipcRenderer.invoke('app:quit')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
