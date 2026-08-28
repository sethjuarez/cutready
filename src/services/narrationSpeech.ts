export const SPEECH_TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default";

function escapeSsmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function inferSpeechEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  const resourceName = parsed.hostname.split(".")[0];
  if (!resourceName) throw new Error("Could not infer Azure AI resource name from endpoint.");
  return `${parsed.protocol}//${resourceName}.cognitiveservices.azure.com`;
}

export function buildPlainSsml(text: string, voiceName: string): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='${voiceName}'>${escapeSsmlText(text)}</voice></speak>`;
}
