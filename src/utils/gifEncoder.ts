import GIF from 'gif.js';
import type { Frame, Caption, CropConfig, ExportConfig } from '@/types';
import { processAllFrames } from './frameProcessor';
import { sampleProcessedFrames } from './frameSampler';
import { quantizePalette, applyDithering, findClosestColor } from './colorQuantizer';

export interface ExportProgress {
  current: number;
  total: number;
  percent: number;
}

let workerAvailabilityCache: boolean | null = null;

async function checkWorkerAvailability(workerScript: string): Promise<boolean> {
  if (workerAvailabilityCache !== null) {
    return workerAvailabilityCache;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(workerScript);
      const timeoutId = setTimeout(() => {
        worker.terminate();
        reject(new Error('Worker load timeout'));
      }, 3000);

      worker.onmessage = () => {
        clearTimeout(timeoutId);
        worker.terminate();
        resolve();
      };

      worker.onerror = () => {
        clearTimeout(timeoutId);
        worker.terminate();
        reject(new Error('Worker load error'));
      };

      worker.postMessage({});
    });
    workerAvailabilityCache = true;
    return true;
  } catch {
    workerAvailabilityCache = false;
    return false;
  }
}

function applyPaletteQuantization(
  frames: { imageData: ImageData; delay: number }[],
  colors: number,
  dither: boolean
): { imageData: ImageData; delay: number }[] {
  if (colors >= 256) return frames;

  const imageDataList = frames.map((f) => f.imageData);
  const palette = quantizePalette(imageDataList, colors);

  return frames.map((f) => {
    let quantizedData: ImageData;

    if (dither) {
      quantizedData = applyDithering(f.imageData, palette);
    } else {
      quantizedData = new ImageData(f.imageData.width, f.imageData.height);
      for (let i = 0; i < f.imageData.data.length; i += 4) {
        if (f.imageData.data[i + 3] > 0) {
          const idx = findClosestColor(
            palette,
            f.imageData.data[i],
            f.imageData.data[i + 1],
            f.imageData.data[i + 2]
          );
          quantizedData.data[i] = palette[idx].r;
          quantizedData.data[i + 1] = palette[idx].g;
          quantizedData.data[i + 2] = palette[idx].b;
          quantizedData.data[i + 3] = f.imageData.data[i + 3];
        }
      }
    }

    return { imageData: quantizedData, delay: f.delay };
  });
}

export async function exportGif(
  frames: Frame[],
  captions: Caption[],
  crop: CropConfig,
  exportConfig: ExportConfig,
  onProgress?: (progress: ExportProgress) => void
): Promise<Blob> {
  const processedFrames = processAllFrames(
    frames,
    captions,
    crop,
    exportConfig.width,
    exportConfig.height
  );

  if (processedFrames.length === 0) {
    throw new Error('没有可用帧');
  }

  const sampledFrames = sampleProcessedFrames(processedFrames, exportConfig.fps);

  if (sampledFrames.length === 0) {
    throw new Error('帧采样失败');
  }

  const finalFrames = applyPaletteQuantization(
    sampledFrames,
    exportConfig.colors,
    exportConfig.dither
  );

  const canvas = document.createElement('canvas');
  const width = finalFrames[0].imageData.width;
  const height = finalFrames[0].imageData.height;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context not available');
  }

  const workerScript = '/gif.worker.js';
  const workerAvailable = await checkWorkerAvailability(workerScript);

  const gif = new GIF({
    workers: workerAvailable ? 2 : 0,
    quality: Math.max(1, 11 - Math.round(exportConfig.quality / 10)),
    width,
    height,
    repeat: exportConfig.repeat,
    workerScript,
  });

  return new Promise<Blob>((resolve, reject) => {
    for (const frame of finalFrames) {
      ctx.putImageData(frame.imageData, 0, 0);
      gif.addFrame(ctx, { copy: true, delay: frame.delay });
    }

    gif.on('progress', (p: number) => {
      if (onProgress) {
        onProgress({
          current: Math.round(p * finalFrames.length),
          total: finalFrames.length,
          percent: Math.round(p * 100),
        });
      }
    });

    gif.on('finished', (blob: Blob) => {
      resolve(blob);
    });

    (gif as unknown as { on: (event: string, listener: (err: Error) => void) => void }).on(
      'error',
      (err: Error) => {
        reject(err);
      }
    );

    try {
      gif.render();
    } catch (err) {
      reject(err);
    }
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function resetWorkerAvailabilityCache(): void {
  workerAvailabilityCache = null;
}
