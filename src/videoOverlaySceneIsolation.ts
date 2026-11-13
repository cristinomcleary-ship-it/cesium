/** A shared lease keeps optional map-only effects out of every AR scene reader.
 * The host restores its current authorized state, never a stale visibility snapshot.
 */
export class VideoOverlaySceneIsolation {
  private owners = 0;
  private restore?: () => void;

  constructor(
    private readonly suspend?: () => void | (() => void),
    private readonly onRestoreError?: (error: unknown) => void,
  ) {}

  acquire(): () => void {
    if (this.owners === 0) {
      const restore = this.suspend?.();
      this.restore = typeof restore === 'function' ? restore : undefined;
    }
    this.owners++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.owners !== 0) return;
      const restore = this.restore;
      this.restore = undefined;
      try { restore?.(); }
      catch (error) {
        // A failed host restore must not hide a decoder/rendering error or
        // prevent the remaining AR resource owners from cleaning up.
        try { this.onRestoreError?.(error); } catch { /* Best-effort reporting. */ }
      }
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.acquire();
    try { return await operation(); }
    finally { release(); }
  }
}
