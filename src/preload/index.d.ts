import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface BoundingBox {
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
  }

  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
