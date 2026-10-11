/**
 * Gets the timeline canvas ready to draw: the backing store sized to the element (resized only when
 * the size changed, since resizing reallocates it), a context in CSS pixels, and the theme
 * colours read once per drawing.
 */
export function prepareCanvas(canvas: HTMLCanvasElement) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue(name);
  const colors = {
    muted: color('--muted'),
    text: color('--text'),
    keep: color('--keep'),
    keepStrong: color('--keep-strong'),
    onKeep: color('--on-keep'),
    cut: color('--cut'),
    cutHatch: color('--cut-hatch'),
    unchecked: color('--unchecked'),
  };
  return { g, width, height, colors };
}
