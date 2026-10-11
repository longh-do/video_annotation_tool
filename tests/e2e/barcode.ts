/**
 * The frame-index barcode on the synthetic clips: how synthetic.ts draws it, and how a test reads
 * it back from a <video> in the page.
 *
 * Each frame shows its index in its top 60 rows as 16 blocks, 40 px wide, bit 0 on the left:
 * white over black for a 1, black over white for a 0. Each block's two halves must clearly differ,
 * so a blank or blended frame reads as null rather than as a wrong index.
 */
import type { Page } from '@playwright/test';

const BITS = 16;
const BLOCK_WIDTH = 40;
const HALF_HEIGHT = 30;
const MIN_CONTRAST = 60;

/** The band at the top of each frame that holds the barcode. */
export const BARCODE_WIDTH = BITS * BLOCK_WIDTH;
export const BARCODE_HEIGHT = 2 * HALF_HEIGHT;

/** An ffmpeg filter that draws frame N's barcode on a picture the size of the band. */
export function barcodeFilter(): string {
  const isOne = `bitand(N,pow(2,floor(X/${BLOCK_WIDTH})))`;
  // 235 and 16 are white and black in video levels; neutral chroma keeps the band gray.
  const luma = `if(lt(Y,${HALF_HEIGHT}),if(${isOne},235,16),if(${isOne},16,235))`;
  return `geq=lum='${luma}':cb=128:cr=128`;
}

/** Where the barcode is read: the middle of each block's top half, then of its bottom half. */
export const BARCODE_PIXELS = Array.from({ length: BITS }, (_, bit) => {
  const x = bit * BLOCK_WIDTH + BLOCK_WIDTH / 2;
  return [
    [x, HALF_HEIGHT / 2],
    [x, HALF_HEIGHT + HALF_HEIGHT / 2],
  ] as const;
}).flat();

/** The frame index from the luma at each of BARCODE_PIXELS, or null if any block is unclear. */
export function decodeBarcode(luma: readonly number[]): number | null {
  let frame = 0;
  for (let bit = 0; bit < BITS; bit++) {
    const top = luma[2 * bit]!;
    const bottom = luma[2 * bit + 1]!;
    if (Math.abs(top - bottom) <= MIN_CONTRAST) return null;
    if (top > bottom) frame |= 1 << bit;
  }
  return frame;
}

/**
 * The frame index shown by the <video> matching `selector`, or by a <canvas> holding a scaled-down
 * copy of a frame; null if unreadable.
 */
export async function shownFrame(page: Page, selector: string): Promise<number | null> {
  // The page can't import decodeBarcode, so it only samples the pixels and Node decodes them.
  const luma = await page.evaluate(
    ([css, pixels, fullWidth]) => {
      const source = document.querySelector<HTMLVideoElement | HTMLCanvasElement>(css);
      if (!source) return null;
      const isVideo = source instanceof HTMLVideoElement;
      const width = isVideo ? source.videoWidth : source.width;
      const height = isVideo ? source.videoHeight : source.height;
      if (!width) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(source, 0, 0);
      const { data } = context.getImageData(0, 0, width, height);
      // A thumbnail is a whole frame scaled down; the barcode spans a full frame's width.
      const scale = width / fullWidth;
      return pixels.map(([x, y]) => {
        const i = 4 * (Math.floor(y * scale) * width + Math.floor(x * scale));
        return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      });
    },
    [selector, BARCODE_PIXELS, BARCODE_WIDTH] as const,
  );
  return luma === null ? null : decodeBarcode(luma);
}
