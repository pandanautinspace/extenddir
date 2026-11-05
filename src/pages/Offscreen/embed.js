// Turning texts into vectors that point the same way when the texts are about the same
// thing, with a small sentence model (all-MiniLM-L6-v2) run here rather than by a service.
// The model downloads from Hugging Face the first time (about 23 MB) and the browser
// caches it; the code that runs it comes with the extension (copied to ort/ by webpack),
// since extensions can't run code from elsewhere.

import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/");
// threads need the page to be cross-origin isolated, which this one isn't
env.backends.onnx.wasm.numThreads = 1;

let model = null;

// texts seen before, since the same tabs and items get sorted again and again
const known = new Map();

export const embed = async (texts) => {
  model ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8", device: "wasm" })
    .catch(error => {
      model = null;
      throw error;
    });
  const extractor = await model;
  const fresh = [...new Set(texts.filter(text => !known.has(text)))];
  for (let i = 0; i < fresh.length; i += 32) {
    const batch = fresh.slice(i, i + 32);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    output.tolist().forEach((vector, j) => known.set(batch[j], vector));
  }
  return texts.map(text => known.get(text));
}
