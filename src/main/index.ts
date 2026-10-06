import {
  app,
  shell,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen
} from 'electron'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

dotenv.config({ path: join(app.getAppPath(), '.env') })

function createWindow(): void {
  // Create a transparent overlay that covers the current display.
  const mainWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Use the highest Electron stacking level so the overlay remains above
  // fullscreen applications and regular always-on-top windows.
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  const setOverlayFocused = (focused: boolean): void => {
    mainWindow.setIgnoreMouseEvents(!focused, { forward: true })

    if (focused) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      mainWindow.blur()
    }

    mainWindow.webContents.send('overlay:focus-changed', focused)
  }

  mainWindow.on('ready-to-show', () => {
    setOverlayFocused(true)
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const toggleOverlayFocus = (): void => {
    setOverlayFocused(mainWindow.isFocused() === false)
  }

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlayFocus)) {
    console.error('Could not register overlay focus shortcut: Ctrl+Shift+Space')
  }

  mainWindow.on('closed', () => {
    globalShortcut.unregister('CommandOrControl+Shift+Space')
  })
}

interface AIRequest {
  prompt: string
  imageUrl?: string
}

interface BoundingBox {
  topLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
  label?: string
}

interface ScreenAIResponse {
  text: string
  boxes: BoundingBox[]
}

const screenResponseSchema = `{
  "text": "brief answer to the user",
  "boxes": [
    {
      "topLeft": { "x": 0, "y": 0 },
      "bottomRight": { "x": 0, "y": 0 },
      "label": "optional label"
    }
  ]
}`

function parseScreenResponse(content: string): ScreenAIResponse {
  const jsonContent = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonContent)
  } catch {
    console.error('Failed to parse AI response as JSON:', jsonContent)
    throw new Error('The AI returned an invalid screen analysis response')
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('text' in parsed) ||
    typeof parsed.text !== 'string' ||
    !('boxes' in parsed) ||
    !Array.isArray(parsed.boxes)
  ) {
    throw new Error('The AI returned an invalid screen analysis shape')
  }

  const boxes = parsed.boxes.filter((box): box is BoundingBox => {
    if (typeof box !== 'object' || box === null || !('topLeft' in box) || !('bottomRight' in box)) {
      return false
    }

    const points = [box.topLeft, box.bottomRight]
    return points.every(
      (point) =>
        typeof point === 'object' &&
        point !== null &&
        'x' in point &&
        'y' in point &&
        typeof point.x === 'number' &&
        typeof point.y === 'number' &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= 100 &&
        point.y >= 0 &&
        point.y <= 100
    )
  })

  if (boxes.length !== parsed.boxes.length) {
    throw new Error('The AI returned an invalid bounding box')
  }

  return { text: parsed.text, boxes }
}

async function askAI({ prompt, imageUrl }: AIRequest): Promise<string> {
  const apiKey = process.env.NEBIUS_API_KEY
  const model = process.env.NEBIUS_MODEL_ID

  if (!apiKey) {
    throw new Error('NEBIUS_API_KEY is not configured')
  }

  if (!model) {
    throw new Error('NEBIUS_MODEL_ID is not configured')
  }

  const client = new OpenAI({
    baseURL: 'https://api.tokenfactory.nebius.com/v1/',
    apiKey
  })
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: process.env.NEBIUS_SYSTEM_PROMPT ?? 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          },
          ...(imageUrl
            ? [
                {
                  type: 'image_url' as const,
                  image_url: {
                    url: imageUrl
                  }
                }
              ]
            : [])
        ]
      }
    ]
  })

  const content = response.choices[0]?.message.content
  if (!content) {
    throw new Error('The AI returned an empty response')
  }

  return content
}

async function capturePrimaryScreen(): Promise<string> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: display.size.width,
      height: display.size.height
    },
    fetchWindowIcons: false
  })
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]

  if (!source) {
    throw new Error('Could not capture the primary screen')
  }

  return source.thumbnail.toDataURL()
}

async function askAboutScreen(prompt: string): Promise<ScreenAIResponse> {
  const imageUrl = await capturePrimaryScreen()
  const apiKey = process.env.NEBIUS_API_KEY
  const model = process.env.NEBIUS_MODEL_ID

  if (!apiKey || !model) {
    throw new Error('NEBIUS_API_KEY and NEBIUS_MODEL_ID must be configured')
  }

  const client = new OpenAI({
    baseURL: 'https://api.tokenfactory.nebius.com/v1/',
    apiKey
  })
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'Analyze the screenshot. Return only valid JSON matching this schema. Coordinates must be percentages from 0 to 100 relative to the screenshot dimensions, where (0, 0) is the top-left and (100, 100) is the bottom-right. Use an empty boxes array when there are no matching objects. ' +
          screenResponseSchema
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ]
  })
  const content = response.choices[0]?.message.content

  if (!content || typeof content !== 'string') {
    throw new Error('The AI returned an empty screen analysis response')
  }

  return parseScreenResponse(content)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('ai:ask', async (_event, request: unknown) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      !('prompt' in request) ||
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0
    ) {
      throw new Error('AI prompt must be a non-empty string')
    }

    const imageUrl = 'imageUrl' in request ? request.imageUrl : undefined
    if (imageUrl !== undefined && typeof imageUrl !== 'string') {
      throw new Error('AI imageUrl must be a string')
    }

    if (
      imageUrl !== undefined &&
      !imageUrl.startsWith('data:image/') &&
      !imageUrl.startsWith('https://')
    ) {
      throw new Error('AI imageUrl must be an image data URL or an HTTPS URL')
    }

    return askAI({
      prompt: request.prompt,
      imageUrl
    })
  })

  ipcMain.handle('ai:ask-screen', async (_event, prompt: unknown) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('Screen analysis prompt must be a non-empty string')
    }

    return askAboutScreen(prompt)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
