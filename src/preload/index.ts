import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ScreenAIResponse {
  text: string
  boxes: Array<{
    bbox: [number, number, number, number]
    label?: string
  }>
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
}

// Custom APIs for renderer
const api = {
  ai: {
    ask: (prompt: string, imageUrl?: string): Promise<string> =>
      ipcRenderer.invoke('ai:ask', { prompt, imageUrl }),
    askScreen: (prompt: string): Promise<ScreenAIResponse> =>
      ipcRenderer.invoke('ai:ask-screen', prompt)
  },
  overlay: {
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
    onEvent: (callback: (event: VoiceEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: VoiceEvent): void => callback(data)
      ipcRenderer.on('voice:event', listener)
      return () => ipcRenderer.removeListener('voice:event', listener)
    }
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
