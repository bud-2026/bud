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
}

interface TTSStartEvent {
  requestId: string
  sampleRate: number
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
    onDebugVisibilityChanged: (callback: (visible: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean): void => {
        callback(visible)
      }
      ipcRenderer.on('overlay:debug-visibility-changed', listener)
      return () => ipcRenderer.removeListener('overlay:debug-visibility-changed', listener)
    }
  },
  tts: {
    speak: (text: string): Promise<void> => ipcRenderer.invoke('tts:speak', text),
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
    }
  },
  voice: {
    stopSession: (): Promise<void> => ipcRenderer.invoke('voice:stop-session'),
    setListenMode: (continuous: boolean): Promise<void> =>
      ipcRenderer.invoke('voice:set-listen-mode', continuous),
    onEvent: (callback: (event: VoiceEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: VoiceEvent): void => callback(data)
      ipcRenderer.on('voice:event', listener)
      return () => ipcRenderer.removeListener('voice:event', listener)
    }
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
  settings: {
    getAI: (): Promise<AISettings> => ipcRenderer.invoke('settings:get-ai'),
    saveAI: (settings: AISettings): Promise<AISettings> =>
      ipcRenderer.invoke('settings:save-ai', settings)
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
