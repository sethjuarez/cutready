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

export async function synthesizeSpeechAudio({
  accessToken,
  speechEndpoint,
  ssml,
  outputFormat,
}: {
  accessToken: string;
  speechEndpoint: string;
  ssml: string;
  outputFormat: string;
}): Promise<{ audioData: ArrayBuffer; mimeType: string }> {
  const response = await fetch(`${speechEndpoint}/tts/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": outputFormat,
      "User-Agent": "cutready",
    },
    body: ssml,
  });
  const audioData = await response.arrayBuffer();
  if (!response.ok) {
    const details = new TextDecoder().decode(audioData.slice(0, 500));
    throw new Error(details || `Azure Speech returned ${response.status}`);
  }
  return {
    audioData,
    mimeType: response.headers.get("content-type") || "audio/x-wav",
  };
}
