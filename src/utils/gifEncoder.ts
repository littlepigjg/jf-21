import GIF from 'gif.js';
import type { Frame, Caption, CropConfig, ExportConfig } from '@/types';
import { processAllFrames } from './frameProcessor';
import { quantizePalette, applyDithering, findClosestColor } from './colorQuantizer';

export interface ExportProgress {
  current: number;
  total: number;
  percent: number;
}

export function exportGif(
  frames: Frame[],
  captions: Caption[],
  crop: CropConfig,
  exportConfig: ExportConfig,
  onProgress?: (progress: ExportProgress) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      const targetFps = exportConfig.fps;
      const minDelay = Math.round(1000 / targetFps);

      const processedFrames = processAllFrames(
        frames,
        captions,
        crop,
        exportConfig.width,
        exportConfig.height
      );

      const selectedFrames: { imageData: ImageData; delay: number }[] = [];
      let accumulatedDelay = 0;

      for (const frame of processedFrames) {
        accumulatedDelay += frame.delay;
        if (accumulatedDelay >= minDelay) {
          selectedFrames.push({
            imageData: frame.imageData,
            delay: accumulatedDelay,
          });
          accumulatedDelay = 0;
        }
      }

      if (selectedFrames.length === 0 && processedFrames.length > 0) {
        selectedFrames.push(processedFrames[0]);
      }

      let finalFrames = selectedFrames;

      if (exportConfig.colors < 256) {
        const imageDataList = selectedFrames.map((f) => f.imageData);
        const palette = quantizePalette(imageDataList, exportConfig.colors);

        finalFrames = selectedFrames.map((f) => {
          let quantizedData: ImageData;

          if (exportConfig.dither) {
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

      const canvas = document.createElement('canvas');
      const width = finalFrames[0]?.imageData.width || exportConfig.width;
      const height = finalFrames[0]?.imageData.height || exportConfig.height;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context not available'));
        return;
      }

      const gif = new GIF({
        workers: 2,
        quality: 11 - Math.round(exportConfig.quality / 10),
        width,
        height,
        repeat: exportConfig.repeat,
        workerScript: 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js',
      });

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
