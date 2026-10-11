/** Keyframe thumbnails, packed by ingest into sprite sheets of `columns` × `rows` tiles. */
import type { ThumbnailInfo } from '../core/api-types.ts';

export interface ThumbnailTile {
  readonly sheetUrl: string;
  /** The tile's top-left corner in its sheet, in pixels. */
  readonly x: number;
  readonly y: number;
}

/** The thumbnail of the last keyframe at or before `frame`; null before the first keyframe. */
export function thumbnailAt(thumbnails: ThumbnailInfo, frame: number): ThumbnailTile | null {
  const index = thumbnails.frames.findLastIndex((f) => f <= frame);
  const perSheet = thumbnails.columns * thumbnails.rows;
  const sheetUrl = thumbnails.sheetUrls[Math.floor(index / perSheet)];
  if (index < 0 || sheetUrl === undefined) return null;
  const cell = index % perSheet;
  return {
    sheetUrl,
    x: (cell % thumbnails.columns) * thumbnails.tileWidth,
    y: Math.floor(cell / thumbnails.columns) * thumbnails.tileHeight,
  };
}
