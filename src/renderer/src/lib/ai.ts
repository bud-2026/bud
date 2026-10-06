export function askAI(prompt: string, imageUrl?: string): Promise<string> {
  return window.api.ai.ask(prompt, imageUrl)
}

export function askScreen(prompt: string): Promise<ScreenAIResponse> {
  return window.api.ai.askScreen(prompt)
}
