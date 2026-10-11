/** Times on screen: m:ss.s, or h:mm:ss.s for long recordings. */
export function clock(seconds: number): string {
  const tenths = Math.max(Math.floor(seconds * 10), 0);
  const s = Math.floor(tenths / 10) % 60;
  const m = Math.floor(tenths / 600) % 60;
  const h = Math.floor(tenths / 36_000);
  const ss = `${String(s).padStart(2, '0')}.${tenths % 10}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
