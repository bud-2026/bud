import {
  app,
  shell,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen
} from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

dotenv.config({ path: join(app.getAppPath(), '.env') })

const ttsPort = 8765
const ttsBaseUrl = `http://127.0.0.1:${ttsPort}`
const screenCaptureMaxDimension = 1920
const packagedBackendDirectory = join(process.resourcesPath, 'python')
let ttsProcess: ChildProcess | undefined
let voiceProcess: ChildProcess | undefined

function getAISettingsPath(): string {
  return join(app.getPath('userData'), 'ai-settings.json')
}

function getAISettings(): AISettings {
  const defaults: AISettings = {
    baseUrl: process.env.AI_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
    apiKey: process.env.API_KEY ?? '',
    modelId: process.env.MODEL_ID ?? '',
    classificationBaseUrl:
      process.env.CLASSIFICATION_BASE_URL ??
      process.env.AI_BASE_URL ??
      'https://api.tokenfactory.nebius.com/v1/',
    classificationApiKey: process.env.CLASSIFICATION_API_KEY ?? '',
    classificationModelId: process.env.CLASSIFICATION_MODEL_ID ?? '',
    generalBaseUrl:
      process.env.GENERAL_BASE_URL ??
      process.env.AI_BASE_URL ??
      'https://api.tokenfactory.nebius.com/v1/',
    generalApiKey: process.env.GENERAL_API_KEY ?? '',
    generalModelId: process.env.GENERAL_MODEL_ID ?? ''
  }

  try {
    const stored = JSON.parse(readFileSync(getAISettingsPath(), 'utf8')) as Partial<AISettings>
    return {
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : defaults.baseUrl,
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : defaults.apiKey,
      modelId: typeof stored.modelId === 'string' ? stored.modelId : defaults.modelId,
      classificationBaseUrl:
        typeof stored.classificationBaseUrl === 'string'
          ? stored.classificationBaseUrl
          : defaults.classificationBaseUrl,
      classificationApiKey:
        typeof stored.classificationApiKey === 'string'
          ? stored.classificationApiKey
          : defaults.classificationApiKey,
      classificationModelId:
        typeof stored.classificationModelId === 'string'
          ? stored.classificationModelId
          : defaults.classificationModelId,
      generalBaseUrl:
        typeof stored.generalBaseUrl === 'string' ? stored.generalBaseUrl : defaults.generalBaseUrl,
      generalApiKey:
        typeof stored.generalApiKey === 'string' ? stored.generalApiKey : defaults.generalApiKey,
      generalModelId:
        typeof stored.generalModelId === 'string' ? stored.generalModelId : defaults.generalModelId
    }
  } catch {
    return defaults
  }
}

function saveAISettings(settings: AISettings): void {
  writeFileSync(getAISettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function startTTSBackend(): void {
  const isPackaged = app.isPackaged
  const backendDirectory = isPackaged
    ? join(packagedBackendDirectory, 'tts')
    : join(app.getAppPath(), 'backend', 'tts')
  const pythonExecutable = isPackaged
    ? join(backendDirectory, 'bud-tts-backend', 'bud-tts-backend.exe')
    : join(backendDirectory, '.venv', 'Scripts', 'python.exe')
  const backendScript = join(backendDirectory, 'main.py')

  if (!existsSync(pythonExecutable) || (!isPackaged && !existsSync(backendScript))) {
    console.error(`TTS backend is not prepared: ${pythonExecutable}`)
    return
  }

  ttsProcess = spawn(
    pythonExecutable,
    isPackaged ? ['--port', String(ttsPort)] : [backendScript, '--port', String(ttsPort)],
    {
      cwd: backendDirectory,
      env: {
        ...process.env,
        ...(isPackaged ? { HF_HOME: join(packagedBackendDirectory, 'model-cache') } : {})
      },
      stdio: 'inherit',
      windowsHide: true
    }
  )
  ttsProcess.on('error', (error) => console.error('TTS backend failed to start:', error))
  ttsProcess.on('exit', (code, signal) => {
    console.log(`TTS backend exited (code=${code}, signal=${signal ?? 'none'})`)
    ttsProcess = undefined
  })
}

function stopTTSBackend(): void {
  if (ttsProcess && !ttsProcess.killed) {
    ttsProcess.kill()
    ttsProcess = undefined
  }
}

function startVoiceBackend(mainWindow: BrowserWindow): void {
  const isPackaged = app.isPackaged
  const backendDirectory = isPackaged
    ? join(packagedBackendDirectory, 'stt')
    : join(app.getAppPath(), 'backend', 'stt')
  const pythonExecutable = isPackaged
    ? join(backendDirectory, 'bud-stt-backend', 'bud-stt-backend.exe')
    : join(backendDirectory, '.venv', 'Scripts', 'python.exe')
  const backendScript = join(backendDirectory, 'main.py')

  if (!existsSync(pythonExecutable) || (!isPackaged && !existsSync(backendScript))) {
    console.error(`Voice backend is not prepared: ${pythonExecutable}`)
    return
  }

  voiceProcess = spawn(pythonExecutable, [backendScript], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      ...(isPackaged ? { HF_HOME: join(packagedBackendDirectory, 'model-cache') } : {})
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  })

  let pending = ''
  voiceProcess.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        mainWindow.webContents.send('voice:event', JSON.parse(line))
      } catch {
        console.error('Voice backend returned invalid event:', line)
      }
    }
  })
  voiceProcess.on('error', (error) => {
    console.error('Voice backend failed to start:', error)
    mainWindow.webContents.send('voice:event', {
      event: 'error',
      message: error.message
    })
  })
  voiceProcess.on('exit', (code, signal) => {
    console.log(`Voice backend exited (code=${code}, signal=${signal ?? 'none'})`)
    voiceProcess = undefined
  })
}

function stopVoiceBackend(): void {
  if (voiceProcess && !voiceProcess.killed) {
    voiceProcess.kill()
    voiceProcess = undefined
  }
}

function stopVoiceSession(): void {
  if (voiceProcess?.stdin?.writable) {
    voiceProcess.stdin.write('{"command":"stop_session"}\n')
  }
}

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

  // Keep the overlay visible locally without including it in supported screen captures.
  mainWindow.setContentProtection(true)

  // Use the highest Electron stacking level so the overlay remains above
  // fullscreen applications and regular always-on-top windows.
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  let debugVisible = false
  const setDebugVisible = (visible: boolean): void => {
    debugVisible = visible
    mainWindow.setIgnoreMouseEvents(!visible, { forward: true })

    if (visible) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      mainWindow.blur()
    }

    mainWindow.webContents.send('overlay:debug-visibility-changed', visible)
  }

  ipcMain.on('overlay:set-interactive', (event, interactive: unknown) => {
    if (
      event.sender !== mainWindow.webContents ||
      debugVisible ||
      typeof interactive !== 'boolean'
    ) {
      return
    }
    mainWindow.setIgnoreMouseEvents(!interactive, { forward: true })
  })

  mainWindow.on('ready-to-show', () => {
    setDebugVisible(false)
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

  let isDebugVisible = false
  const toggleDebugVisibility = (): void => {
    isDebugVisible = !isDebugVisible
    setDebugVisible(isDebugVisible)
  }

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleDebugVisibility)) {
    console.error('Could not register debug visibility shortcut: Ctrl+Shift+Space')
  }

  mainWindow.on('closed', () => {
    globalShortcut.unregister('CommandOrControl+Shift+Space')
  })
}

interface AIRequest {
  prompt: string
  imageUrl?: string
}

interface AISettings {
  baseUrl: string
  apiKey: string
  modelId: string
  classificationBaseUrl: string
  classificationApiKey: string
  classificationModelId: string
  generalBaseUrl: string
  generalApiKey: string
  generalModelId: string
}

interface BoundingBox {
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

const systemPrompt = `
You are Bud, a friendly, intelligent, and direct voice assistant. You assist users with general information and help them read, analyze, or locate items on their screen.

CRITICAL INSTRUCTIONS:
1. VOICE & PERSONALITY ("text"):
   - Speak as Bud: warm, direct, helpful, and natural.
   - Limit answers strictly to what was asked without volunteer trivia or unnecessary details.
   - For capability/permission questions (e.g., "Can you..."), vary your starting response naturally using context-neutral openers (e.g., "Yes,", "Sure,", "I've got it,", "Absolutely,"). Never repeat the same opener consecutively.
   - For direct factual or visual-reading requests (e.g., "Bud, what time is it?", "Read the title"), state the answer directly without introductory filler.

2. TTS PHONETIC FORMATTING:
   - Convert ALL numbers, dates, times, units, currencies, and symbols into full phonetic words for the text-to-speech engine in the "text" field.
   - Examples: write "seven fifteen p m" (not "7:15 PM"), "forty-two dollars" (not "$42"), "percent" (not "%"), "twenty-twenty-six" (not "2026").

3. VISUAL GROUNDING ("boxes") - STRICT MANDATE:
   - IF YOU MENTION OR DESCRIBE ANY VISUAL ELEMENT, TEXT BLOCK, BUTTON, ICON, OR UI REGION IN YOUR "text" FIELD, YOU MUST INCLUDE ITS BOUNDING BOX IN THE "boxes" ARRAY.
   - NEVER leave the "boxes" array empty if your spoken text answers a screen-based or visual query.
   - For each box, specify the "label" and "copy" text FIRST, then output the "bbox" coordinates.
   - Set "copy" to null UNLESS the user explicitly asks to copy, read, extract, or transcribe text. When text extraction IS requested, include the exact, raw text in "copy" (with original symbols, numbers, and formatting).
   - Bounding box coordinates MUST follow native [xmin, ymin, xmax, ymax] format normalized on a 1000x1000 grid (integers 0 to 1000).
   - Top-left is [0, 0] and bottom-right is [1000, 1000].
   - Do NOT use percentages, decimals, pixel dimensions, or [ymin, xmin, ymax, xmax] order.

JSON Schema:
{
  "boxes": [
    {
      "label": "descriptive label matching the spoken text",
      "copy": "exact raw text extracted ONLY if requested by user, otherwise null",
      "bbox": [xmin, ymin, xmax, ymax]
    }
  ],
  "text": "spoken response formatted phonetically for text-to-speech"
}

Example Output (General Localization - No copy requested):
{
  "boxes": [
    {
      "label": "submit button",
      "copy": null,
      "bbox": [800, 50, 950, 120]
    }
  ],
  "text": "There is a submit button in the top right."
}

Example Output (Text Extraction Requested):
{
  "boxes": [
    {
      "label": "meeting start time",
      "copy": "3:30 PM",
      "bbox": [145, 210, 520, 380]
    }
  ],
  "text": "The meeting starts at three thirty p m."
}

Use an empty "boxes" array ONLY when the user's question is completely unrelated to the screen image (e.g., general knowledge queries). Respond strictly with raw JSON.
`

const questionClassificationSystemPrompt = `You are a strict text classification assistant.
Analyze the user's question and determine if it pertains to the visual screen/UI display or dynamic system state, vs. a general knowledge question.

DEFAULT RULE:
If there is any ambiguity, doubt, or implicit reference to context (e.g., short queries, follow-up questions, or vague pronouns), ALWAYS default to "screen".

Classify as "screen" if:
- The question asks about visual UI elements, text, buttons, images, errors, or content on the display.
- The question relies on visual context or implicitly refers to something being viewed (e.g., "What does this mean?", "Where do I click?", "Read this label", "How do I fix this?").
- The question asks about real-time system state visible on a device status bar or widget (e.g., "What time is it?", "What is the date?", "What is my battery level?", "What network am I connected to?").
- You are unsure whether the user is referring to something on their screen versus a general concept.

Classify as "general" ONLY if:
- The question is unambiguously a self-contained factual, conceptual, or general knowledge query completely independent of the screen or current device state (e.g., "Why is the sky blue?", "How many miles is a marathon?", "Explain quantum computing").

Return JSON: {"type": "screen" | "general"}`

const generalSystemPrompt = `You are Bud, a friendly, intelligent, and direct voice assistant. You assist users with general information and help them read, analyze, or locate items on their screen.

SCOPE OF THIS MODE:
- You are handling general information and everyday queries independent of the user's screen display.
- Do not make references to visual elements or screen layouts unless explicitly brought up by the user.

CRITICAL INSTRUCTIONS:
1. VOICE & PERSONALITY ("text"):
   - Speak as Bud: warm, direct, helpful, and natural.
   - Limit answers strictly to what was asked without volunteer trivia or unnecessary details.
   - For capability/permission questions (e.g., "Can you..."), vary your starting response naturally using context-neutral openers (e.g., "Yes,", "Sure,", "I've got it,", "Absolutely,"). Never repeat the same opener consecutively.
   - For direct factual requests (e.g., "Bud, what is the capital of France?"), state the answer directly without introductory filler.

2. TTS PHONETIC FORMATTING:
   - Convert ALL numbers, dates, times, units, currencies, and symbols into full phonetic words for the text-to-speech engine in the "text" field.
  - Examples: write "seven fifteen p m" (not "7:15 PM"), "forty-two dollars" (not "$42"), "percent" (not "%"), "twenty-twenty-six" (not "2026").`

type QuestionType = 'screen' | 'general'

export function sanitizeForTTS(text: string): string {
  const preserveContractions = true
  const normalizeWhitespace = true

  if (!text || typeof text !== 'string') {
    return ''
  }

  let cleaned = text

  // 1. Remove Markdown syntax: headers (#), bold/italic (*, _), strikethrough (~), code blocks (`)
  cleaned = cleaned.replace(/[*_~#`]/g, '')

  // 2. Remove URLs and domain names
  cleaned = cleaned.replace(/https?:\/\/\S+|www\.\S+/gi, '')

  // 3. Remove standalone special symbols and bracket characters
  cleaned = cleaned.replace(/[\[\](){}<>@\/\^|\\]/g, ' ')

  // 4. Strip emojis and non-standard Unicode symbols
  // Uses Unicode property escapes (\p{Extended_Pictographic})
  cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '')

  // 5. Remove any character that is NOT a letter, number, white-space, or speech punctuation
  // Preserved punctuation: . , ! ? - and conditionally '
  const allowedCharsRegex = preserveContractions
    ? /[^a-zA-Target-zA-Z0-9\s.,!?'\-]/g
    : /[^a-zA-Target-zA-Z0-9\s.,!?\-]/g

  cleaned = cleaned.replace(allowedCharsRegex, '')

  // 6. Fix orphaned hyphens or repetitive punctuation
  cleaned = cleaned.replace(/(?<!\w)-(?!\w)/g, ' ') // remove floating dashes
  cleaned = cleaned.replace(/[-]{2,}/g, ' ') // collapse multiple dashes

  // 7. Normalize whitespaces and trim leading/trailing spaces
  if (normalizeWhitespace) {
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
  }

  return cleaned
}

function parseScreenResponse(content: string): ScreenAIResponse {
  const cleanedContent = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const firstObject = cleanedContent.indexOf('{')
  const lastObject = cleanedContent.lastIndexOf('}')
  const jsonContent =
    firstObject >= 0 && lastObject > firstObject
      ? cleanedContent.slice(firstObject, lastObject + 1)
      : cleanedContent

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

  const validatedBoxes: BoundingBox[] = []

  for (const box of parsed.boxes) {
    if (
      typeof box !== 'object' ||
      box === null ||
      !('label' in box) ||
      typeof box.label !== 'string' ||
      !('bbox' in box) ||
      !Array.isArray(box.bbox) ||
      box.bbox.length !== 4
    ) {
      throw new Error('The AI returned an invalid bounding box shape')
    }

    const isValidBbox = box.bbox.every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        coordinate >= 0 &&
        coordinate <= 1000
    )

    if (!isValidBbox) {
      throw new Error('The AI returned an invalid bounding box coordinate range')
    }

    let copy: string | undefined = undefined
    if ('copy' in box && box.copy !== null && box.copy !== undefined) {
      if (typeof box.copy !== 'string') {
        throw new Error('The AI returned an invalid copy value in bounding box')
      }
      copy = box.copy
    }

    validatedBoxes.push({
      label: box.label,
      bbox: box.bbox as [number, number, number, number],
      ...(copy !== undefined ? { copy } : {})
    })
  }

  return {
    text: sanitizeForTTS(parsed.text),
    boxes: validatedBoxes
  }
}

function getDedicatedAISettings(prefix: 'CLASSIFICATION' | 'GENERAL'): AISettings {
  const settings = getAISettings()
  const isClassification = prefix === 'CLASSIFICATION'
  return {
    baseUrl: isClassification ? settings.classificationBaseUrl : settings.generalBaseUrl,
    apiKey: isClassification ? settings.classificationApiKey : settings.generalApiKey,
    modelId: isClassification ? settings.classificationModelId : settings.generalModelId,
    classificationBaseUrl: '',
    classificationApiKey: '',
    classificationModelId: '',
    generalBaseUrl: '',
    generalApiKey: '',
    generalModelId: ''
  }
}

function createAIClient(
  settings: AISettings,
  provider: 'classification' | 'general'
): { client: OpenAI; model: string } {
  if (!settings.apiKey) throw new Error(`${provider} API key is not configured`)
  if (!settings.modelId) throw new Error(`${provider} model ID is not configured`)
  return {
    client: new OpenAI({ baseURL: settings.baseUrl, apiKey: settings.apiKey }),
    model: settings.modelId
  }
}

async function classifyQuestion(
  prompt: string,
  history: ScreenConversationMessage[]
): Promise<QuestionType> {
  const { client, model } = createAIClient(
    getDedicatedAISettings('CLASSIFICATION'),
    'classification'
  )

  const response = await client.chat.completions.create({
    model,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'question_classification',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['screen', 'general'],
              description: 'The classification category for the user prompt.'
            }
          },
          required: ['type'],
          additionalProperties: false
        }
      }
    },
    messages: [
      {
        role: 'system',
        content: `${questionClassificationSystemPrompt}

Prior messages in this conversation may or may not be related to the user's current request.
Use prior messages to resolve references (such as "that", "it", or "the previous item") and context.
Determine whether a follow-up question relies on prior screen context or previous non-screen discussions, and answer accordingly.
Regardless of context, always return the exact same JSON object structure. Never return plain conversational text.`
      },
      ...history.filter((msg) => msg.role === 'user'),
      { role: 'user', content: prompt }
    ]
  })

  const rawContent = response.choices[0]?.message.content

  if (!rawContent) {
    throw new Error('AI failed to return content for question classification')
  }

  const parsed = JSON.parse(rawContent) as { type: QuestionType }

  if (parsed.type !== 'screen' && parsed.type !== 'general') {
    throw new Error(`The AI returned an invalid question classification: ${parsed.type}`)
  }

  return parsed.type
}

async function askAI({ prompt, imageUrl }: AIRequest): Promise<string> {
  const settings = getAISettings()
  const apiKey = settings.apiKey
  const model = settings.modelId

  if (!apiKey) {
    throw new Error('API_KEY is not configured')
  }

  if (!model) {
    throw new Error('MODEL_ID is not configured')
  }

  const client = new OpenAI({
    baseURL: settings.baseUrl,
    apiKey
  })
  const response = await client.chat.completions.create({
    model,
    reasoning_effort: 'none',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
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

async function askGeneral(
  prompt: string,
  history: ScreenConversationMessage[] = []
): Promise<ScreenAIResponse> {
  const { client, model } = createAIClient(getDedicatedAISettings('GENERAL'), 'general')

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: 'none',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'general_response',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: 'A concise spoken answer phonetically formatted for text-to-speech.'
            }
          },
          required: ['text']
        }
      }
    },
    messages: [
      {
        role: 'system',
        content: `${generalSystemPrompt}

Prior messages in this conversation may or may not be related to the user's current request.
Use prior messages to resolve references (such as "that", "it", or "the previous item") and context.
Determine whether a follow-up question relies on prior screen context or previous non-screen discussions, and answer accordingly.
Regardless of context, always return the exact same JSON object structure. Never return plain conversational text.`
      },
      ...history,
      { role: 'user', content: prompt }
    ]
  })

  const content = response.choices[0]?.message.content

  if (!content || typeof content !== 'string') {
    throw new Error('The AI returned an empty general response')
  }

  const parsed = JSON.parse(content) as { text: string }

  return { text: sanitizeForTTS(parsed.text), boxes: [] }
}

async function askQuestion(
  prompt: string,
  history: ScreenConversationMessage[] = []
): Promise<ScreenAIResponse> {
  const questionType = await classifyQuestion(prompt, history)
  return questionType === 'screen' ? askAboutScreen(prompt, history) : askGeneral(prompt, history)
}

async function capturePrimaryScreen(): Promise<string> {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size
  const maxDimension =
    Number.isFinite(screenCaptureMaxDimension) && screenCaptureMaxDimension > 0
      ? screenCaptureMaxDimension
      : 1920
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
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

async function askAboutScreen(
  prompt: string,
  history: ScreenConversationMessage[] = []
): Promise<ScreenAIResponse> {
  const imageUrl = await capturePrimaryScreen()
  const settings = getAISettings()
  const apiKey = settings.apiKey
  const model = settings.modelId

  if (!apiKey || !model) {
    throw new Error('API_KEY and MODEL_ID must be configured')
  }

  const client = new OpenAI({
    baseURL: settings.baseUrl,
    apiKey
  })

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: 'none',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'screen_analysis',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: {
              type: 'string',
              description: 'A concise spoken answer for the user.'
            },
            boxes: {
              type: 'array',
              description:
                'List of visual bounding boxes matching elements mentioned in text. Must not be empty if visual elements are identified.',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: {
                    type: 'string',
                    description: 'A concise label for the highlighted region.'
                  },
                  copy: {
                    type: ['string', 'null'],
                    description:
                      'Exact raw extracted text from the region, or null if non-text object.'
                  },
                  bbox: {
                    type: 'array',
                    description:
                      'Bounding box coordinates normalized to 0-1000 grid: [xmin, ymin, xmax, ymax].',
                    items: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1000
                    },
                    minItems: 4,
                    maxItems: 4
                  }
                },
                required: ['label', 'copy', 'bbox']
              }
            }
          },
          required: ['text', 'boxes']
        }
      }
    },
    messages: [
      {
        role: 'system',
        content: `${systemPrompt}

Prior messages in this conversation may or may not be related to the user's current request.
Use prior messages to resolve references (such as "that", "it", or "the previous item") only if the request depends on them; otherwise, process the new request independently.
Regardless of context, always return the exact same JSON object structure. Never return plain conversational text.`
      },
      ...history,
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

async function streamTTS(text: string, webContents: Electron.WebContents): Promise<void> {
  const requestId = randomUUID()
  const response = await fetch(`${ttsBaseUrl}/tts-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  })

  if (!response.ok || !response.body) {
    throw new Error(`TTS backend returned HTTP ${response.status}`)
  }

  const sampleRateHeader = response.headers.get('x-sample-rate')
  const sampleRate = Number(sampleRateHeader)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('TTS backend returned an invalid sample rate')
  }

  webContents.send('tts:start', { requestId, sampleRate })
  const reader = response.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        webContents.send('tts:chunk', {
          requestId,
          chunk: Buffer.from(value)
        })
      }
    }
    webContents.send('tts:end', { requestId })
  } finally {
    reader.releaseLock()
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  startTTSBackend()
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

    const response = await askAI({
      prompt: request.prompt,
      imageUrl
    })
    void streamTTS(response, _event.sender).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return response
  })

  ipcMain.handle('ai:ask-screen', async (_event, request: unknown) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      !('prompt' in request) ||
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0
    ) {
      throw new Error('Screen analysis prompt must be a non-empty string')
    }

    const history = 'history' in request ? request.history : undefined
    if (
      history !== undefined &&
      (!Array.isArray(history) ||
        history.some(
          (message) =>
            typeof message !== 'object' ||
            message === null ||
            !('role' in message) ||
            (message.role !== 'user' && message.role !== 'assistant') ||
            !('content' in message) ||
            typeof message.content !== 'string'
        ))
    ) {
      throw new Error('Screen analysis history must contain valid messages')
    }

    const result = await askAboutScreen(request.prompt, history)
    void streamTTS(result.text, _event.sender).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return result
  })

  ipcMain.handle('ai:ask-question', async (_event, request: unknown) => {
    if (
      typeof request !== 'object' ||
      request === null ||
      !('prompt' in request) ||
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0
    ) {
      throw new Error('Question prompt must be a non-empty string')
    }

    const history = 'history' in request ? request.history : undefined
    if (
      history !== undefined &&
      (!Array.isArray(history) ||
        history.some(
          (message) =>
            typeof message !== 'object' ||
            message === null ||
            !('role' in message) ||
            (message.role !== 'user' && message.role !== 'assistant') ||
            !('content' in message) ||
            typeof message.content !== 'string'
        ))
    ) {
      throw new Error('Question history must contain valid messages')
    }

    const result = await askQuestion(request.prompt, history)
    void streamTTS(result.text, _event.sender).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
    return result
  })

  ipcMain.handle('tts:speak', async (_event, text: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('TTS text must be a non-empty string')
    }

    void streamTTS(text.trim(), _event.sender).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
  })

  ipcMain.handle('voice:stop-session', () => {
    stopVoiceSession()
  })

  ipcMain.handle('settings:get-ai', () => getAISettings())

  ipcMain.handle('settings:save-ai', (_event, settings: unknown) => {
    if (
      typeof settings !== 'object' ||
      settings === null ||
      !('baseUrl' in settings) ||
      typeof settings.baseUrl !== 'string' ||
      !settings.baseUrl.trim() ||
      !('apiKey' in settings) ||
      typeof settings.apiKey !== 'string' ||
      !settings.apiKey.trim() ||
      !('modelId' in settings) ||
      typeof settings.modelId !== 'string' ||
      !settings.modelId.trim() ||
      !('classificationBaseUrl' in settings) ||
      typeof settings.classificationBaseUrl !== 'string' ||
      !settings.classificationBaseUrl.trim() ||
      !('classificationApiKey' in settings) ||
      typeof settings.classificationApiKey !== 'string' ||
      !settings.classificationApiKey.trim() ||
      !('classificationModelId' in settings) ||
      typeof settings.classificationModelId !== 'string' ||
      !settings.classificationModelId.trim() ||
      !('generalBaseUrl' in settings) ||
      typeof settings.generalBaseUrl !== 'string' ||
      !settings.generalBaseUrl.trim() ||
      !('generalApiKey' in settings) ||
      typeof settings.generalApiKey !== 'string' ||
      !settings.generalApiKey.trim() ||
      !('generalModelId' in settings) ||
      typeof settings.generalModelId !== 'string' ||
      !settings.generalModelId.trim()
    ) {
      throw new Error('AI settings require a base URL, API key, and model ID')
    }

    for (const baseUrlValue of [
      settings.baseUrl,
      settings.classificationBaseUrl,
      settings.generalBaseUrl
    ]) {
      try {
        const baseUrl = new URL(baseUrlValue)
        if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
          throw new Error('unsupported protocol')
        }
      } catch {
        throw new Error('AI base URLs must be valid HTTP or HTTPS URLs')
      }
    }

    const savedSettings = {
      baseUrl: settings.baseUrl.trim(),
      apiKey: settings.apiKey.trim(),
      modelId: settings.modelId.trim(),
      classificationBaseUrl: settings.classificationBaseUrl.trim(),
      classificationApiKey: settings.classificationApiKey.trim(),
      classificationModelId: settings.classificationModelId.trim(),
      generalBaseUrl: settings.generalBaseUrl.trim(),
      generalApiKey: settings.generalApiKey.trim(),
      generalModelId: settings.generalModelId.trim()
    }
    saveAISettings(savedSettings)
    return savedSettings
  })

  createWindow()
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => startVoiceBackend(mainWindow))
  }

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
  stopTTSBackend()
  stopVoiceBackend()
})
