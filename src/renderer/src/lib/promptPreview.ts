// Mirrors the main-process composition in src/main/prompts.ts so the settings
// editor can show the exact prompt the model will receive without a round-trip
// on every keystroke. This is presentation only; the main process is the source
// of truth for what is actually sent.

export function buildPromptSchemaPreview(preset: PromptPresetFields): string {
  return `{
  "boxes": [
    {
      "label": ${JSON.stringify(preset.labelDescription.trim())},
      "copy": ${JSON.stringify(preset.copyDescription.trim())},
      "bbox": [xmin, ymin, xmax, ymax]
    }
  ],
  "text": ${JSON.stringify(preset.textDescription.trim())}
}`
}

export function buildScreenSystemPromptPreview(preset: PromptPresetFields): string {
  const examplesBlock = preset.examples
    .map((example) => ({ name: example.name.trim(), body: example.body.trim() }))
    .filter((example) => example.name.length > 0 && example.body.length > 0)
    .map((example) => `Example Output (${example.name}):\n${example.body}`)
    .join('\n\n')

  const sections = [
    preset.intro.trim(),
    `CRITICAL INSTRUCTIONS:
1. VOICE & PERSONALITY ("text"):
${preset.textRules.trim()}

2. VISUAL GROUNDING ("boxes") - STRICT MANDATE:
${preset.boxesRules.trim()}`,
    `JSON Schema:\n${buildPromptSchemaPreview(preset)}`
  ]

  if (examplesBlock) sections.push(examplesBlock)
  sections.push(preset.closingRules.trim())

  return `\n${sections.join('\n\n')}\n`
}
