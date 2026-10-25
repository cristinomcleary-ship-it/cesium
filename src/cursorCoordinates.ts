export type CursorPosition = { x: number; y: number };
type CursorCoordinateOptions = {
  /** Keep the host's real terrain intersection; this only schedules it. */
  sample(position: CursorPosition): string | undefined;
  publish(text: string): void;
};

/** Coalesce the status-bar terrain readout without delaying explicit tool picks. */
export class CursorCoordinates {
  private position?: CursorPosition;
  private timer?: ReturnType<typeof setTimeout>;
  private moving = false;
  private disposed = false;
  private previousText?: string;

  constructor(private readonly options: CursorCoordinateOptions) {}

  move(position: CursorPosition): void {
    if (this.disposed) return;
    // Cesium reuses event positions; retain the latest values, not that object.
    this.position = { x: position.x, y: position.y };
    this.schedule();
  }

  setCameraMoving(moving: boolean): void {
    if (this.disposed || this.moving === moving) return;
    this.moving = moving;
    if (moving) this.cancel();
    else this.schedule(); // Refresh under the final camera even without a new mouse event.
  }

  private schedule(): void {
    if (this.disposed || this.moving || !this.position || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.moving || !this.position) return;
      const text = this.options.sample(this.position);
      if (text !== undefined && text !== this.previousText) {
        this.previousText = text;
        this.options.publish(text);
      }
    }, 100);
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.position = undefined;
  }
}
