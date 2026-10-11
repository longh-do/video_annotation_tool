/**
 * How the cameras share the stage: one large, the others stacked beside it, every tile exactly
 * the shape of its video (no black bars), together as large as the stage allows.
 */
export interface Mosaic {
  readonly mainWidth: number;
  readonly mainHeight: number;
  /** Each small tile; they are stacked in one column. */
  readonly sideWidth: number;
  readonly sideHeight: number;
}

/**
 * Tile sizes for a stage of `width` × `height`, given the large camera's aspect ratio, the widest
 * small camera's, how many small cameras there are and the gap between tiles. The small tiles'
 * column is exactly as tall as the large tile.
 */
export function mosaic(
  width: number,
  height: number,
  ratios: { readonly main: number; readonly side: number },
  sides: number,
  gap: number,
): Mosaic {
  if (sides === 0) {
    const mainHeight = Math.floor(Math.max(Math.min(height, width / ratios.main), 0));
    return {
      mainWidth: Math.floor(mainHeight * ratios.main),
      mainHeight,
      sideWidth: 0,
      sideHeight: 0,
    };
  }
  // Large tile height h, small tile height (h − (n − 1)·gap) / n; their widths and one gap fill
  // the width: h·main + gap + side·(h − (n − 1)·gap) / n = width.
  const byWidth =
    (width - gap + ((sides - 1) * gap * ratios.side) / sides) / (ratios.main + ratios.side / sides);
  const mainHeight = Math.floor(Math.max(Math.min(height, byWidth), 0));
  const sideHeight = Math.floor(Math.max((mainHeight - (sides - 1) * gap) / sides, 0));
  return {
    mainWidth: Math.floor(mainHeight * ratios.main),
    mainHeight,
    sideWidth: Math.floor(sideHeight * ratios.side),
    sideHeight,
  };
}
