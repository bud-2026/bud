export function askAI(prompt: string, imageUrl?: string): Promise<string> {
  return window.api.ai.ask(prompt, imageUrl)
}

export function askScreen(
  prompt: string,
  history?: ScreenConversationMessage[],
  region?: Region
): Promise<ScreenAIResponse> {
  return window.api.ai.askScreen(prompt, history, region)
}

export function askQuestion(
  prompt: string,
  history?: ScreenConversationMessage[],
  region?: Region
): Promise<ScreenAIResponse> {
  return window.api.ai.askQuestion(prompt, history, region)
}
