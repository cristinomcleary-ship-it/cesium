import {
  parseGeoFootprintCollection,
  parseGeoProjectionMeshCollection,
} from "./videoArGeoreference";

type WorkerRequest = { buffer: ArrayBuffer };

type WorkerScope = {
  addEventListener: (type: "message", listener: (event: MessageEvent<WorkerRequest>) => void) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (event) => {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(event.data.buffer)) as unknown;
    const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const footprints = parseGeoFootprintCollection(parsed);
    const meshes = parseGeoProjectionMeshCollection(parsed);
    const transfer: Transferable[] = [];
    for (const mesh of meshes.items) {
      transfer.push(
        mesh.positionsWgs84.buffer,
        mesh.textureCoordinates.buffer,
        mesh.indices.buffer,
      );
    }
    workerScope.postMessage({
      ok: true,
      footprints,
      meshes,
      kind: {
        schemaVersion: typeof root.schema_version === "string" ? root.schema_version : "",
        hasTelemetry: Array.isArray(root.telemetry),
        hasTrajectoryPoints: Array.isArray(root.trajectory_points),
      },
    }, transfer);
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
