/**
 * Marking needs Chrome or Edge. Seeking is frame-exact in every engine, but during playback Firefox
 * and Safari show frames ahead of what their frame callbacks report, so a live mark would not land
 * on the frame the annotator saw. Other browsers get a read-only view.
 */
export function canAnnotate(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
    .userAgentData?.brands;
  const chromium = brands?.some((b) => b.brand === 'Chromium') ?? false;
  const frameCallbacks = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.64001E"');
  return chromium && frameCallbacks && h264 === 'probably';
}
