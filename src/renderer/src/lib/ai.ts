export function askAI(prompt: string, imageUrl?: string): Promise<string> {
  return window.api.ai.ask(prompt, imageUrl)
}

export function askScreen(
  prompt: string,
  history?: ScreenConversationMessage[]
): Promise<ScreenAIResponse> {
  return window.api.ai.askScreen(prompt, history)
}

export function askQuestion(
  prompt: string,
  history?: ScreenConversationMessage[]
): Promise<ScreenAIResponse> {
  return window.api.ai.askQuestion(prompt, history)
}
