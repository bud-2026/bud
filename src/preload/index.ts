import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ScreenAIResponse {
  text: string
  boxes: Array<{
    topLeft: { x: number; y: number }
    bottomRight: { x: number; y: number }
    label?: string
  }>
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
    onFocusChanged: (callback: (focused: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, focused: boolean): void => {
        callback(focused)
      }
      ipcRenderer.on('overlay:focus-changed', listener)
      return () => ipcRenderer.removeListener('overlay:focus-changed', listener)
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
