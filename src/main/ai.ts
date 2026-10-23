import { desktopCapturer, type Display } from 'electron'
import OpenAI from 'openai'
import { VL_MODEL_ALIAS, ensureLocalVlmReady, getLocalVlmBaseUrl } from './localVlm'
import { getTargetDisplay } from './overlay'
import { generalSystemPrompt, questionClassificationSystemPrompt, systemPrompt } from './prompts'
import { getAISettings, type AISettings } from './settings'

// Placeholder the OpenAI client requires; the bundled llama-server ignores it.
const LOCAL_VLM_API_KEY = 'local'
const screenCaptureMaxDimension = 1920

export interface AIRequest {
  prompt: string
  imageUrl?: string
}

export interface BoundingBox {
  bbox: [number, number, number, number]
  label?: string
  copy?: string
}

/** Normalized screen region on the 1000x1000 display grid. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenAIResponse {
  text: string
  boxes: BoundingBox[]
}

export interface ScreenConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export type QuestionType = 'screen' | 'general'

// The bundled Qwen3-VL server always uses a fixed alias and placeholder key;
// only its base URL varies (the free port chosen at launch).
function createLocalVlmClient(): { client: OpenAI; model: string } {
  return {
    client: new OpenAI({ baseURL: getLocalVlmBaseUrl(), apiKey: LOCAL_VLM_API_KEY }),
    model: VL_MODEL_ALIAS
  }
}

// Each configurable service (general answers, phonetic formatting) runs either
// against the external endpoint the user configured or the bundled local server.
export function createGeneralClient(settings: AISettings): { client: OpenAI; model: string } {
  if (settings.generalUseLocal) return createLocalVlmClient()
  if (!settings.generalApiKey) throw new Error('general API key is not configured')
  if (!settings.generalModelId) throw new Error('general model ID is not configured')
  return {
    client: new OpenAI({ baseURL: settings.generalBaseUrl, apiKey: settings.generalApiKey }),
    model: settings.generalModelId
  }
}

export function createPhoneticClient(settings: AISettings): { client: OpenAI; model: string } {
  if (settings.phoneticUseLocal) return createLocalVlmClient()
  if (!settings.phoneticBaseUrl) throw new Error('phonetic base URL is not configured')
  if (!settings.phoneticApiKey) throw new Error('phonetic API key is not configured')
  if (!settings.phoneticModelId) throw new Error('phonetic model ID is not configured')
  return {
    client: new OpenAI({ baseURL: settings.phoneticBaseUrl, apiKey: settings.phoneticApiKey }),
    model: settings.phoneticModelId
  }
}

export function parseScreenResponse(content: string): ScreenAIResponse {
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
    text: parsed.text.trim(),
    boxes: validatedBoxes
  }
}

// Validates an optional screen region from the renderer. Regions use the same
// 0-1000 normalized grid as bounding boxes, relative to the full display.
export function parseRegion(value: unknown): Region | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'object') {
    throw new Error('Screen region must be an object')
  }

  const record = value as Record<string, unknown>
  const coordinates: Array<keyof Region> = ['x', 'y', 'width', 'height']

  for (const key of coordinates) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
      throw new Error(`Screen region ${key} must be a finite number`)
    }
  }

  const region: Region = {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number
  }

  if (
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1000 ||
    region.y + region.height > 1000
  ) {
    throw new Error('Screen region must be within the 0-1000 display grid')
  }

  return region
}

async function classifyQuestion(
  prompt: string,
  history: ScreenConversationMessage[]
): Promise<QuestionType> {
  await ensureLocalVlmReady()
  const { client, model } = createLocalVlmClient()

  const response = await client.chat.completions.create({
    model,
    temperature: 0.0,
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

export async function askAI({ prompt, imageUrl }: AIRequest): Promise<string> {
  await ensureLocalVlmReady()
  const { client, model } = createLocalVlmClient()

  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
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
  const settings = getAISettings()
  if (settings.generalUseLocal) await ensureLocalVlmReady()
  const { client, model } = createGeneralClient(settings)

  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
    ...(settings.generalUseLocal ? {} : { reasoning_effort: 'none' as const }),
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
              description: 'A concise spoken answer in natural written form.'
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

  return { text: parsed.text.trim(), boxes: [] }
}

export async function askQuestion(
  prompt: string,
  history: ScreenConversationMessage[] = [],
  region?: Region,
  display?: Display
): Promise<ScreenAIResponse> {
  const questionType = await classifyQuestion(prompt, history)
  return questionType === 'screen'
    ? askAboutScreen(prompt, history, region, display)
    : askGeneral(prompt, history)
}

async function captureDisplay(display: Display, region?: Region): Promise<string> {
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
    throw new Error('Could not capture the requested screen')
  }

  if (!region) {
    return source.thumbnail.toDataURL()
  }

  const { width: imageWidth, height: imageHeight } = source.thumbnail.getSize()
  const rawX = Math.round((region.x / 1000) * imageWidth)
  const rawY = Math.round((region.y / 1000) * imageHeight)
  const cropX = Math.max(0, Math.min(rawX, imageWidth - 1))
  const cropY = Math.max(0, Math.min(rawY, imageHeight - 1))
  const cropWidth = Math.max(
    1,
    Math.min(Math.round((region.width / 1000) * imageWidth), imageWidth - cropX)
  )
  const cropHeight = Math.max(
    1,
    Math.min(Math.round((region.height / 1000) * imageHeight), imageHeight - cropY)
  )

  return source.thumbnail
    .crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight })
    .toDataURL()
}

// The vision model returns boxes relative to the cropped image it was given.
// Translate them back onto the full-screen 0-1000 grid so the overlay lands
// the indicators in the right place.
function remapBoxesToScreen(boxes: BoundingBox[], region: Region): BoundingBox[] {
  const mapX = (value: number): number =>
    Math.min(1000, Math.max(0, Math.round(region.x + (value / 1000) * region.width)))
  const mapY = (value: number): number =>
    Math.min(1000, Math.max(0, Math.round(region.y + (value / 1000) * region.height)))

  return boxes.map((box) => {
    const [xmin, ymin, xmax, ymax] = box.bbox
    return { ...box, bbox: [mapX(xmin), mapY(ymin), mapX(xmax), mapY(ymax)] }
  })
}

export async function askAboutScreen(
  prompt: string,
  history: ScreenConversationMessage[] = [],
  region?: Region,
  display?: Display
): Promise<ScreenAIResponse> {
  await ensureLocalVlmReady()
  const imageUrl = await captureDisplay(display ?? getTargetDisplay(), region)
  const { client, model } = createLocalVlmClient()

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
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

  const result = parseScreenResponse(content)
  return region ? { ...result, boxes: remapBoxesToScreen(result.boxes, region) } : result
}
