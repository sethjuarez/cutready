import { invoke } from "./tauri";

export const SPEECH_TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default";

interface SpeechSynthesisResult {
  audio_data: number[];
  mime_type: string;
}

export interface SsmlValidationResult {
  valid: boolean;
  errors: string[];
}

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

export async function synthesizeSpeechAudio({
  accessToken,
  speechEndpoint,
  voice,
  ssml,
  outputFormat,
}: {
  accessToken: string;
  speechEndpoint: string;
  voice: string;
  ssml: string;
  outputFormat: string;
}): Promise<{ audioData: ArrayBuffer; mimeType: string }> {
  const result = await invoke<SpeechSynthesisResult>("synthesize_speech_audio", {
    accessToken,
    speechEndpoint,
    voice,
    ssml,
    outputFormat,
  });
  const bytes = Uint8Array.from(result.audio_data);
  return {
    audioData: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    mimeType: result.mime_type || "audio/x-wav",
  };
}

export async function validateNarrationSsml(ssml: string, voice: string): Promise<SsmlValidationResult> {
  return invoke<SsmlValidationResult>("validate_narration_ssml", { ssml, voice });
}
