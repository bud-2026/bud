import { app } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_PROMPT_PRESET,
  DEFAULT_PROMPT_PRESET_ID,
  type PromptExample,
  type PromptPreset,
  type PromptPresetInput
} from './prompts'

// Snapshot returned to the renderer: the full preset list (built-in first) plus
// which preset is currently active.
export interface PromptStoreSnapshot {
  presets: PromptPreset[]
  activePresetId: string
}

// Save responses include the id the preset was stored under so the renderer can
// keep editing a newly-created preset without guessing its identity.
export interface PromptSaveResult extends PromptStoreSnapshot {
  savedPresetId: string
}

interface StoredPrompts {
  activePresetId: string
  presets: PromptPreset[]
}

function getPromptsPath(): string {
  return join(app.getPath('userData'), 'prompts.json')
}

// A fresh copy of the built-in default, safe to hand out or mutate without
// touching the shared constant (its examples array is deep-cloned).
function cloneDefaultPreset(): PromptPreset {
  return structuredClone(DEFAULT_PROMPT_PRESET)
}

function readStoredPrompts(): StoredPrompts {
  try {
    const parsed = JSON.parse(readFileSync(getPromptsPath(), 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const presets: PromptPreset[] = []
      const seen = new Set<string>([DEFAULT_PROMPT_PRESET_ID])

      if (Array.isArray(record.presets)) {
        for (const candidate of record.presets) {
          const preset = parseStoredPreset(candidate)
          // Skip malformed entries and any that collide with the reserved
          // built-in id or an earlier user preset.
          if (!preset || seen.has(preset.id)) continue
          seen.add(preset.id)
          presets.push(preset)
        }
      }

      const activePresetId =
        typeof record.activePresetId === 'string' &&
        (record.activePresetId === DEFAULT_PROMPT_PRESET_ID ||
          presets.some((preset) => preset.id === record.activePresetId))
          ? record.activePresetId
          : DEFAULT_PROMPT_PRESET_ID

      return { activePresetId, presets }
    }
  } catch {
    // No or malformed prompts file; start from defaults.
  }
  return { activePresetId: DEFAULT_PROMPT_PRESET_ID, presets: [] }
}

function writeStoredPrompts(store: StoredPrompts): void {
  writeFileSync(getPromptsPath(), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

// The built-in default is virtual: it is never written to disk so it always
// reflects the prompt the app shipped with.
function allPresets(stored: StoredPrompts): PromptPreset[] {
  return [cloneDefaultPreset(), ...stored.presets]
}

export function listPromptPresets(): PromptPreset[] {
  return allPresets(readStoredPrompts())
}

export function getPromptStoreSnapshot(): PromptStoreSnapshot {
  const stored = readStoredPrompts()
  return { presets: allPresets(stored), activePresetId: stored.activePresetId }
}

export function getActivePromptPreset(): PromptPreset {
  const stored = readStoredPrompts()
  return (
    stored.presets.find((preset) => preset.id === stored.activePresetId) ?? cloneDefaultPreset()
  )
}

export function savePromptPreset(input: unknown): PromptSaveResult {
  const preset = parsePresetInput(input)
  const stored = readStoredPrompts()

  if (preset.id === DEFAULT_PROMPT_PRESET_ID) {
    throw new Error('The built-in default preset cannot be overwritten')
  }

  const id = preset.id && preset.id.length > 0 ? preset.id : randomUUID()
  const saved: PromptPreset = { ...preset, id, builtin: false }
  const index = stored.presets.findIndex((existing) => existing.id === id)
  const presets =
    index >= 0
      ? stored.presets.map((existing) => (existing.id === id ? saved : existing))
      : [...stored.presets, saved]

  const next: StoredPrompts = { ...stored, presets }
  writeStoredPrompts(next)
  return { presets: allPresets(next), activePresetId: next.activePresetId, savedPresetId: id }
}

export function deletePromptPreset(id: string): PromptStoreSnapshot {
  if (id === DEFAULT_PROMPT_PRESET_ID) {
    throw new Error('The built-in default preset cannot be deleted')
  }

  const stored = readStoredPrompts()
  const presets = stored.presets.filter((preset) => preset.id !== id)

  // Deleting the active preset falls back to the built-in default so a question
  // can always be answered.
  const activePresetId =
    stored.activePresetId === id ? DEFAULT_PROMPT_PRESET_ID : stored.activePresetId

  const next: StoredPrompts = { presets, activePresetId }
  writeStoredPrompts(next)
  return { presets: allPresets(next), activePresetId }
}

export function setActivePromptPreset(id: string): PromptStoreSnapshot {
  const stored = readStoredPrompts()
  const exists =
    id === DEFAULT_PROMPT_PRESET_ID || stored.presets.some((preset) => preset.id === id)
  if (!exists) {
    throw new Error('Cannot activate an unknown prompt preset')
  }

  const next: StoredPrompts = { ...stored, activePresetId: id }
  writeStoredPrompts(next)
  return { presets: allPresets(next), activePresetId: id }
}

function parseExamples(value: unknown): PromptExample[] {
  if (!Array.isArray(value)) return []
  const examples: PromptExample[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.body !== 'string') continue
    examples.push({ name: record.name, body: record.body })
  }
  return examples
}

// Lenient parse used when reading the stored file: returns null for malformed
// entries so they can be skipped rather than blocking every preset.
function parseStoredPreset(value: unknown): PromptPreset | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!id || !name) return null

  const fields = readTextFields(record)
  if (!fields) return null

  return {
    id,
    name,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    builtin: false,
    ...fields,
    examples: parseExamples(record.examples)
  }
}

// Strict parse used for incoming save requests: throws on the first missing or
// mistyped field so the renderer can surface a clear message.
function parsePresetInput(value: unknown): PromptPresetInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Prompt preset must be an object')
  }
  const record = value as Record<string, unknown>

  const name = requireText(record, 'name', 'name')
  const fields = readTextFields(record, true)
  if (!fields) {
    throw new Error('Prompt preset is missing required text fields')
  }

  const examples = Array.isArray(record.examples) ? record.examples : []
  for (const candidate of examples) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof (candidate as Record<string, unknown>).name !== 'string' ||
      typeof (candidate as Record<string, unknown>).body !== 'string'
    ) {
      throw new Error('Prompt preset examples must each have a name and body string')
    }
  }

  const id =
    typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : undefined

  return {
    ...(id ? { id } : {}),
    name,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    ...fields,
    examples: parseExamples(examples)
  }
}

interface PromptTextFields {
  intro: string
  textRules: string
  boxesRules: string
  closingRules: string
  textDescription: string
  boxesDescription: string
  labelDescription: string
  copyDescription: string
  bboxDescription: string
}

// Reads the string-only prompt fields. In strict mode every field must be a
// non-empty string; otherwise the entry is treated as malformed (null).
function readTextFields(record: Record<string, unknown>, strict = false): PromptTextFields | null {
  const keys: Array<keyof PromptTextFields> = [
    'intro',
    'textRules',
    'boxesRules',
    'closingRules',
    'textDescription',
    'boxesDescription',
    'labelDescription',
    'copyDescription',
    'bboxDescription'
  ]

  const result = {} as PromptTextFields
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw !== 'string') {
      if (strict) throw new Error(`Prompt preset ${key} must be a string`)
      return null
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      if (strict) {
        throw new Error(`Prompt preset ${key} must be a non-empty string`)
      }
      return null
    }
    result[key] = trimmed
  }
  return result
}

function requireText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Prompt preset ${label} must be a non-empty string`)
  }
  return value.trim()
}
