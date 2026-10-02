/** Identity of pixels actually decoded for one source session, independent of the playback slider. */
export type TextureFrameIdentity = Readonly<{
  sourceSession: string | number;
  kind: "video" | "bitmap";
  frameKey: string;
  mediaTimeMs: number;
}>;

export function videoMediaTimeMs(decodedSeconds: number, elementSeconds: number) {
  const seconds = Number.isFinite(decodedSeconds) ? decodedSeconds : elementSeconds;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Video media time must be finite and non-negative");
  return seconds * 1000;
}

export function textureFrameIdentity(sourceSession: string | number, kind: TextureFrameIdentity["kind"], frameKey: string, mediaTimeMs: number): TextureFrameIdentity {
  if (!Number.isFinite(mediaTimeMs) || mediaTimeMs < 0 || !frameKey) throw new Error("Decoded texture identity requires a key and finite non-negative media time");
  return Object.freeze({ sourceSession, kind, frameKey, mediaTimeMs });
}

export function sameTextureFrame(left: TextureFrameIdentity | undefined, right: TextureFrameIdentity | undefined) {
  return Boolean(left && right && left.sourceSession === right.sourceSession && left.kind === right.kind
    && left.frameKey === right.frameKey && Math.abs(left.mediaTimeMs - right.mediaTimeMs) < 0.1);
}
