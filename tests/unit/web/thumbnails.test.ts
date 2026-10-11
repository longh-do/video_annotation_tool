import { describe, expect, test } from 'vitest';
import type { ThumbnailInfo } from '../../../src/core/api-types.ts';
import { thumbnailAt } from '../../../src/web/thumbnails.ts';

const thumbnails: ThumbnailInfo = {
  tileWidth: 96,
  tileHeight: 72,
  columns: 2,
  rows: 2,
  sheetUrls: ['/media/r/thumbs-0.jpg', '/media/r/thumbs-1.jpg'],
  frames: [5, 65, 125, 185, 245, 305],
};

describe('thumbnails', () => {
  test('the keyframe at or before a frame, found in its sheet row by row', () => {
    expect(thumbnailAt(thumbnails, 5)).toEqual({ sheetUrl: '/media/r/thumbs-0.jpg', x: 0, y: 0 });
    expect(thumbnailAt(thumbnails, 64)).toEqual({ sheetUrl: '/media/r/thumbs-0.jpg', x: 0, y: 0 });
    expect(thumbnailAt(thumbnails, 65)).toEqual({ sheetUrl: '/media/r/thumbs-0.jpg', x: 96, y: 0 });
    expect(thumbnailAt(thumbnails, 200)).toEqual({
      sheetUrl: '/media/r/thumbs-0.jpg',
      x: 96,
      y: 72,
    });
    expect(thumbnailAt(thumbnails, 9999)).toEqual({
      sheetUrl: '/media/r/thumbs-1.jpg',
      x: 96,
      y: 0,
    });
  });

  test('none before the first keyframe', () => {
    expect(thumbnailAt(thumbnails, 4)).toBeNull();
  });
});
