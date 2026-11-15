import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import classNames from '../core/yamnet-classes.json';
import type { AudioModel } from '../core/types';

/** YAMNet (521 AudioSet sound classes) on ONNX Runtime. Takes 16 kHz mono float PCM. */
export class Yamnet implements AudioModel {
  private session?: Promise<ort.InferenceSession>;
  private path(): string {
    const candidates = [process.env.MODEL_PATH, join(__dirname, 'yamnet.onnx'), join(process.cwd(), 'models', 'yamnet.onnx')].filter(Boolean) as string[];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error('yamnet.onnx not found. Run: node scripts/fetch-model.mjs');
    return found;
  }
  async classify(pcm: Float32Array): Promise<Record<string, number>> {
    this.session ??= ort.InferenceSession.create(this.path());
    const session = await this.session;
    // The model needs at least one 0.975 s window.
    const input = pcm.length >= 15600 ? pcm : Float32Array.from({ length: 15600 }, (_, i) => pcm[i] ?? 0);
    const out = await session.run({ waveform: new ort.Tensor('float32', input, [input.length]) });
    const scores = out[session.outputNames[0]];
    const data = scores.data as Float32Array, n = classNames.length, frames = scores.dims[0] as number;
    const result: Record<string, number> = {};
    for (let c = 0; c < n; c++) {
      let best = 0;
      for (let f = 0; f < frames; f++) best = Math.max(best, data[f * n + c]);
      result[classNames[c]] = best;
    }
    return result;
  }
}
