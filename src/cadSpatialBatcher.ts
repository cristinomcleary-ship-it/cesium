type Point3 = { x: number; y: number; z: number };

/** Fixed world cells keep nearby CAD together across every coordinate system. */
export function cadSpatialBatchKey(center: Point3, partition = ""): string {
  const size = 256;
  return `${Math.floor(center.x / size)},${Math.floor(center.y / size)},${Math.floor(center.z / size)}:${partition}`;
}

type Buffer<T> = { entries: Array<{ item: T; vertices: number }>; vertices: number; partition: string };
type Options<T> = {
  maxBatchSize: number;
  emit: (items: T[]) => void;
  maxBufferedItems?: number;
  maxBufferedVertices?: number;
  maxBufferedBuckets?: number;
  /** Per-emission limit; large indivisible items can opt into isolated emission. */
  maxBatchVertices?: number;
  allowOversizedItem?: boolean;
};

/** Stream whole entities into local batches without retaining every cell until
 * the end of a large drawing. Flushing changes grouping only, never geometry.
 */
export class CadSpatialBatcher<T> {
  private readonly buffers = new Map<string, Buffer<T>>();
  private readonly overflow = new Map<string, Buffer<T>>();
  private readonly maxItems: number;
  private readonly maxVertices: number;
  private readonly maxBuckets: number;
  private readonly maxBatchVertices: number;
  private itemCount = 0;
  private vertexCount = 0;

  constructor(private readonly options: Options<T>) {
    this.maxItems = options.maxBufferedItems ?? options.maxBatchSize * 4;
    this.maxVertices = options.maxBufferedVertices ?? 131_072;
    this.maxBuckets = options.maxBufferedBuckets ?? 128;
    this.maxBatchVertices = options.maxBatchVertices ?? Number.POSITIVE_INFINITY;
    if (![options.maxBatchSize, this.maxItems, this.maxVertices, this.maxBuckets]
      .every(value => Number.isInteger(value) && value > 0)
      || options.maxBatchVertices !== undefined && (!Number.isInteger(options.maxBatchVertices) || options.maxBatchVertices < 1)) {
      throw new RangeError("CAD batch limits must be positive integers");
    }
  }

  get bufferedItems(): number { return this.itemCount; }
  get bufferedVertices(): number { return this.vertexCount; }
  get bufferedBuckets(): number { return this.buffers.size + this.overflow.size; }

  add(key: string, item: T, vertices: number, partition = ""): void {
    if (!Number.isInteger(vertices) || vertices < 1
      || vertices > this.maxBatchVertices && !this.options.allowOversizedItem) {
      throw new RangeError("CAD item exceeds the geometry batch vertex budget");
    }
    // A large entity cannot fit the budget without changing its geometry. Submit
    // it intact and do not make unrelated local entities share its large bounds.
    if (vertices > this.maxVertices || vertices > this.maxBatchVertices) {
      this.emitBuffer(this.buffers, key);
      this.options.emit([item]);
      return;
    }
    while (this.itemCount + 1 > this.maxItems || this.vertexCount + vertices > this.maxVertices
      || (!this.buffers.has(key) && this.bufferedBuckets >= this.maxBuckets)) {
      if (this.itemCount + 1 > this.maxItems || this.vertexCount + vertices > this.maxVertices) {
        this.releaseLargest(this.vertexCount + vertices > this.maxVertices);
      } else if (this.buffers.size) {
        this.releaseCell(this.buffers.keys().next().value!);
      } else {
        // Too many incompatible partitions cannot be combined (for example,
        // distinct GroundPrimitive colors). Release one to make progress.
        this.emitBuffer(this.overflow, this.overflow.keys().next().value!);
      }
    }
    let buffer = this.buffers.get(key);
    if (buffer && buffer.vertices + vertices > this.maxBatchVertices) {
      this.emitBuffer(this.buffers, key);
      buffer = undefined;
    }
    if (!buffer) {
      buffer = { entries: [], vertices: 0, partition };
      this.buffers.set(key, buffer);
    }
    this.append(buffer, item, vertices);
    if (buffer.entries.length >= this.options.maxBatchSize) this.emitBuffer(this.buffers, key);
  }

  flush(): void {
    // At most maxBuckets local tails remain; retain their useful tight bounds.
    for (const key of this.buffers.keys()) this.emitBuffer(this.buffers, key);
    for (const key of this.overflow.keys()) this.emitBuffer(this.overflow, key);
  }

  private append(buffer: Buffer<T>, item: T, vertices: number): void {
    buffer.entries.push({ item, vertices });
    buffer.vertices += vertices;
    this.itemCount++;
    this.vertexCount += vertices;
  }

  private take(buffers: Map<string, Buffer<T>>, key: string): Buffer<T> | undefined {
    const buffer = buffers.get(key);
    if (!buffer) return undefined;
    buffers.delete(key);
    this.itemCount -= buffer.entries.length;
    this.vertexCount -= buffer.vertices;
    return buffer;
  }

  private emitBuffer(buffers: Map<string, Buffer<T>>, key: string): void {
    const buffer = this.take(buffers, key);
    if (!buffer) return;
    this.options.emit(buffer.entries.map(entry => entry.item));
  }

  private releaseCell(key: string): void {
    const buffer = this.take(this.buffers, key);
    if (!buffer) return;
    if (buffer.entries.length >= Math.max(1, Math.floor(this.options.maxBatchSize / 4))
      || buffer.vertices >= this.maxVertices / 4) {
      this.options.emit(buffer.entries.map(entry => entry.item));
      return;
    }
    // Repeatedly visiting more cells than fit in memory must not produce one
    // primitive per short line. Small evicted tails form conservative mixed-cell
    // batches with the same material partition, degrading toward source batching.
    for (const entry of buffer.entries) {
      let overflow = this.overflow.get(buffer.partition);
      if (overflow && overflow.vertices + entry.vertices > this.maxBatchVertices) {
        this.emitBuffer(this.overflow, buffer.partition);
        overflow = undefined;
      }
      if (!overflow) {
        overflow = { entries: [], vertices: 0, partition: buffer.partition };
        this.overflow.set(buffer.partition, overflow);
      }
      this.append(overflow, entry.item, entry.vertices);
      if (overflow.entries.length >= this.options.maxBatchSize) this.emitBuffer(this.overflow, buffer.partition);
    }
  }

  private releaseLargest(byVertices: boolean): void {
    let largestKey = "", largestSize = -1, fromOverflow = true;
    for (const [key, buffer] of this.overflow) {
      const size = byVertices ? buffer.vertices : buffer.entries.length;
      if (size > largestSize) { largestKey = key; largestSize = size; }
    }
    for (const [key, buffer] of this.buffers) {
      const size = byVertices ? buffer.vertices : buffer.entries.length;
      if (size > largestSize) { largestKey = key; largestSize = size; fromOverflow = false; }
    }
    if (fromOverflow) this.emitBuffer(this.overflow, largestKey);
    else this.releaseCell(largestKey);
  }
}
