import { app } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// How a custom prompt's spoken answer is derived from the model output.
// - 'field'    uses the raw value of a single schema field
// - 'fixed'    always speaks the same constant sentence
// - 'template' fills {field} placeholders from the model output
export type SpeechMode = 'field' | 'fixed' | 'template'

// How an indicator label is derived. 'template' fills {field} placeholders.
export type LabelMode = 'fixed' | 'template'

export interface SpeechMapping {
  mode: SpeechMode
  value: string
}

export interface LabelMapping {
  mode: LabelMode
  value: string
}

// Maps the free-form model result onto the app's fixed { text, boxes } contract
// so the overlay, TTS, and copy buttons work unchanged.
export interface CustomPromptFields {
  speech: SpeechMapping
  /** Schema field whose value becomes the copy button content, if any. */
  copy?: string
  /** Indicator label; defaults to the prompt name when omitted with a copy field. */
  label?: LabelMapping
}

// A user-authored prompt preset: it replaces the built-in system prompt and
// output schema, and controls where each result field ends up.
export interface CustomPrompt {
  id: string
  name: string
  /** Optional voice/text prefix (e.g. "translate") that activates this prompt. */
  trigger?: string
  systemPrompt: string
  schema: Record<string, unknown>
  fields: CustomPromptFields
  /** true = send the screenshot/region (vision); false = general model only. */
  useScreen: boolean
  /** Default question text offered when this prompt is selected. */
  prefill?: string
}

function getCustomPromptsPath(): string {
  return join(app.getPath('userData'), 'custom-prompts.json')
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

// Top-level property names of a JSON schema, used to validate mappings.
function schemaPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return []
  }
  return Object.keys(properties)
}

function extractTemplateFields(template: string): string[] {
  const fields: string[] = []
  const pattern = /\{([a-zA-Z0-9_]+)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template)) !== null) {
    fields.push(match[1])
  }
  return fields
}

// Validates and normalizes an untrusted prompt object coming from the renderer.
// Throws a human-readable error describing the first problem it finds.
export function normalizeCustomPrompt(input: unknown): CustomPrompt {
  const record = asRecord(input, 'Custom prompt')
  const schema = asRecord(record.schema, 'Custom prompt schema')

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) {
    throw new Error('Custom prompt requires a name')
  }

  const systemPrompt = typeof record.systemPrompt === 'string' ? record.systemPrompt : ''
  if (!systemPrompt.trim()) {
    throw new Error(`Custom prompt "${name}" requires a system prompt`)
  }

  const fields = asRecord(record.fields, 'Custom prompt fields')
  const speech = asRecord(fields.speech, 'Custom prompt speech mapping')
  const speechMode = speech.mode
  if (speechMode !== 'field' && speechMode !== 'fixed' && speechMode !== 'template') {
    throw new Error(`Custom prompt "${name}" has an invalid speech mode`)
  }
  const speechValue = typeof speech.value === 'string' ? speech.value.trim() : ''
  if (!speechValue) {
    throw new Error(`Custom prompt "${name}" requires a value for its speech mapping`)
  }

  const copy = normalizeOptionalString(fields.copy)

  let label: LabelMapping | undefined
  if (fields.label !== undefined && fields.label !== null) {
    const labelRecord = asRecord(fields.label, 'Custom prompt label mapping')
    const labelMode = labelRecord.mode
    if (labelMode !== 'fixed' && labelMode !== 'template') {
      throw new Error(`Custom prompt "${name}" has an invalid label mode`)
    }
    const labelValue = typeof labelRecord.value === 'string' ? labelRecord.value.trim() : ''
    if (!labelValue) {
      throw new Error(`Custom prompt "${name}" requires a value for its label mapping`)
    }
    label = { mode: labelMode, value: labelValue }
  }

  // Field references are only checked when the schema exposes top-level
  // properties; schemas built with $ref/allOf are left to the model.
  const propertyNames = schemaPropertyNames(schema)
  if (propertyNames.length > 0) {
    const referenced = new Set<string>()
    if (speechMode === 'field') referenced.add(speechValue)
    if (speechMode === 'template') {
      for (const field of extractTemplateFields(speechValue)) referenced.add(field)
    }
    if (copy) referenced.add(copy)
    if (label?.mode === 'template') {
      for (const field of extractTemplateFields(label.value)) referenced.add(field)
    }
    for (const field of referenced) {
      if (!propertyNames.includes(field)) {
        throw new Error(`Custom prompt "${name}" references unknown field "${field}"`)
      }
    }
  }

  const id = normalizeOptionalString(record.id) ?? randomUUID()
  const trigger = normalizeOptionalString(record.trigger)

  return {
    id,
    name,
    ...(trigger ? { trigger } : {}),
    systemPrompt,
    schema,
    fields: {
      speech: { mode: speechMode, value: speechValue },
      ...(copy ? { copy } : {}),
      ...(label ? { label } : {})
    },
    useScreen: record.useScreen !== false,
    ...(normalizeOptionalString(record.prefill)
      ? { prefill: normalizeOptionalString(record.prefill) }
      : {})
  }
}

function writeCustomPrompts(prompts: CustomPrompt[]): void {
  writeFileSync(getCustomPromptsPath(), `${JSON.stringify(prompts, null, 2)}\n`, 'utf8')
}

// Reads every stored prompt, silently skipping any entry that no longer parses
// so one malformed record cannot hide the rest.
export function listCustomPrompts(): CustomPrompt[] {
  try {
    const parsed = JSON.parse(readFileSync(getCustomPromptsPath(), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    const prompts: CustomPrompt[] = []
    for (const entry of parsed) {
      try {
        prompts.push(normalizeCustomPrompt(entry))
      } catch (error) {
        console.error('Skipping malformed custom prompt:', error)
      }
    }
    return prompts
  } catch {
    // No or unreadable file; start empty.
    return []
  }
}

export function getCustomPrompt(id: string): CustomPrompt | undefined {
  return listCustomPrompts().find((prompt) => prompt.id === id)
}

// Creates or updates a prompt (matched by id) and returns the full list.
export function saveCustomPrompt(input: unknown): CustomPrompt[] {
  const prompt = normalizeCustomPrompt(input)
  const prompts = listCustomPrompts()
  const index = prompts.findIndex((candidate) => candidate.id === prompt.id)
  if (index >= 0) {
    prompts[index] = prompt
  } else {
    prompts.push(prompt)
  }
  writeCustomPrompts(prompts)
  return prompts
}

export function deleteCustomPrompt(id: string): CustomPrompt[] {
  const prompts = listCustomPrompts().filter((prompt) => prompt.id !== id)
  writeCustomPrompts(prompts)
  return prompts
}
