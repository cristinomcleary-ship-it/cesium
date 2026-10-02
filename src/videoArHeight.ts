export type DjiHeightMode = "estimated" | "relative" | "source";

export type DjiHeightInput = {
  mode: DjiHeightMode;
  sourceAltitude: number;
  relativeAltitude: number;
  estimatedDatum?: number;
  estimatedDatumSource?: "first-frame-ground" | "user-candidate";
  takeoffEllipsoidHeight?: number;
  sourceToEllipsoidOffset?: number;
  correctionMeters: number;
};

/** An explicit vertical reference contract. Source "absolute" is not a datum. */
export function resolveDjiHeight(input: DjiHeightInput) {
  const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);
  const estimated = input.mode === "estimated";
  const datumHeight = input.mode === "source"
    ? (finite(input.sourceToEllipsoidOffset) ? input.sourceAltitude + input.sourceToEllipsoidOffset - input.relativeAltitude : undefined)
    : input.mode === "relative" ? input.takeoffEllipsoidHeight : input.estimatedDatum;
  const valid = finite(datumHeight) && finite(input.sourceAltitude) && finite(input.relativeAltitude) && finite(input.correctionMeters);
  const explanation = input.mode === "source"
    ? "源高程 + 用户指定椭球转换量（需核实源垂直基准）"
    : input.mode === "relative"
      ? "相对起飞高度 + 用户指定起飞点椭球高"
      : input.estimatedDatumSource === "user-candidate"
        ? "未知基准：用户试算值；未经独立检查点验收"
        : "未知基准：暂用首帧下方地面；并非已知起飞点，未验收";
  return {
    mode: input.mode, valid, estimated,
    datumHeight: finite(datumHeight) ? datumHeight : undefined,
    ellipsoidHeight: valid ? datumHeight! + input.relativeAltitude + input.correctionMeters : undefined,
    sourceAltitude: input.sourceAltitude,
    relativeAltitude: input.relativeAltitude,
    sourceToEllipsoidOffset: input.sourceToEllipsoidOffset,
    correctionMeters: input.correctionMeters,
    explanation,
    blockReason: valid ? undefined : "高程基准不完整：请填写起飞点椭球高或源高程转换量；已是椭球高时转换量填 0",
  };
}

export type ResolvedDjiHeight = ReturnType<typeof resolveDjiHeight>;
