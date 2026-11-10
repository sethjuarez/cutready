/**
 * Azure AI Speech synthesis with word boundaries, via the official
 * microsoft-cognitiveservices-speech-sdk.
 *
 * Unlike the Rust REST adapter (`tts/cognitiveservices/v1`, audio only), the
 * SDK's websocket protocol streams WordBoundary events, which are what the
 * live recorder needs to schedule actions on cue words.
 *
 * Auth mirrors CutReady: a keyless Entra access token scoped to
 * https://cognitiveservices.azure.com against the resource's custom-domain
 * endpoint. A subscription key + region is accepted only as a fallback.
 */

import * as fs from "fs";
import * as path from "path";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { ticksToMs } from "./timing.js";

/** Formats we know how to label; PCM WAV is the default (no codec delay). */
const FORMATS = {
  wav: { id: sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm, ext: "wav", mime: "audio/wav" },
  mp3: { id: sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3, ext: "mp3", mime: "audio/mpeg" },
};

/**
 * Map a CutReady/Foundry resource endpoint (e.g.
 * https://name.services.ai.azure.com/api/projects/x) to the Speech
 * custom-domain host https://name.cognitiveservices.azure.com, matching
 * `infer_speech_endpoint` in src-tauri/src/engine/speech/azure_speech.rs.
 */
export function inferSpeechEndpoint(endpoint) {
  const url = new URL(endpoint);
  const resource = url.hostname.split(".")[0];
  if (!resource) throw new Error(`Could not infer Azure AI resource name from ${endpoint}`);
  return `${url.protocol}//${resource}.cognitiveservices.azure.com`;
}

export function escapeSsml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildPlainSsml(text, voice) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='${voice}'>${escapeSsml(text)}</voice></speak>`;
}

/**
 * WordBoundary textOffset indexes the SSML document, not the narration text.
 * Re-anchor each boundary to the plain text by sequential search so cue
 * words can be addressed by character offset in the script. Boundaries whose
 * text can't be found (e.g. SSML-only content) get plainOffset = null.
 */
export function alignWordsToText(words, text) {
  let cursor = 0;
  return words.map((w) => {
    const idx = w.text ? text.indexOf(w.text, cursor) : -1;
    if (idx < 0) return { ...w, plainOffset: null };
    cursor = idx + w.text.length;
    return { ...w, plainOffset: idx };
  });
}

function speechConfigFor({ endpoint, region, auth }) {
  if (!auth) throw new Error("auth is required ({ type: 'bearer', token } or { type: 'key', key })");
  if (auth.type === "bearer") {
    if (!endpoint) throw new Error("endpoint is required for Entra (bearer) auth");
    const credential = {
      getToken: async () => ({ token: auth.token, expiresOnTimestamp: Date.now() + 10 * 60_000 }),
    };
    return sdk.SpeechConfig.fromEndpoint(new URL(inferSpeechEndpoint(endpoint)), credential);
  }
  if (auth.type === "key") {
    if (endpoint) return sdk.SpeechConfig.fromEndpoint(new URL(inferSpeechEndpoint(endpoint)), auth.key);
    if (region) return sdk.SpeechConfig.fromSubscription(auth.key, region);
    throw new Error("endpoint or region is required for key auth");
  }
  throw new Error(`Unsupported auth type: ${auth.type}`);
}

/**
 * Synthesize text (or SSML) and write the audio to `outPath`.
 *
 * Returns { audioPath, format, mime, audioDurationMs, words: [{ text,
 * textOffset, wordLength, audioOffsetTicks, durationTicks, audioOffsetMs,
 * durationMs, boundaryType }] }.
 */
export async function synthesize({ text, ssml, voice, endpoint, region, auth, format = "wav", outPath }) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`Unsupported format '${format}' (use wav or mp3)`);
  if (!outPath) throw new Error("outPath is required");
  const config = speechConfigFor({ endpoint, region, auth });
  config.speechSynthesisVoiceName = voice;
  config.speechSynthesisOutputFormat = fmt.id;
  // Request punctuation boundaries too so pauses are visible in the event stream.
  config.setProperty("SpeechServiceResponse_RequestPunctuationBoundary", "true");
  config.setProperty("SpeechServiceResponse_RequestSentenceBoundary", "true");

  // null audio config: keep audio in memory, no speaker output.
  const synthesizer = new sdk.SpeechSynthesizer(config, null);
  const words = [];
  synthesizer.wordBoundary = (_s, e) => {
    words.push({
      text: e.text,
      textOffset: e.textOffset,
      wordLength: e.wordLength,
      audioOffsetTicks: e.audioOffset,
      durationTicks: e.duration,
      audioOffsetMs: ticksToMs(e.audioOffset),
      durationMs: ticksToMs(e.duration),
      boundaryType: sdk.SpeechSynthesisBoundaryType[e.boundaryType] ?? e.boundaryType,
    });
  };

  const markup = ssml && ssml.trim() ? ssml : buildPlainSsml(text, voice);
  const result = await new Promise((resolve, reject) => {
    synthesizer.speakSsmlAsync(
      markup,
      (r) => resolve(r),
      (err) => reject(new Error(String(err))),
    );
  }).finally(() => synthesizer.close());

  if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
    const details = sdk.CancellationDetails.fromResult(result);
    throw new Error(`Speech synthesis failed: ${details.errorDetails || sdk.ResultReason[result.reason]}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(result.audioData));
  return {
    audioPath: outPath,
    format: fmt.ext,
    mime: fmt.mime,
    voice,
    audioDurationMs: ticksToMs(result.audioDuration),
    resultId: result.resultId,
    words: text ? alignWordsToText(words, text) : words,
  };
}
