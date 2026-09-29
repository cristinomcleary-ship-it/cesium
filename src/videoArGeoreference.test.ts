import assert from "node:assert/strict";
import test from "node:test";

import {
  matchGeoFootprint,
  matchGeoProjectionMesh,
  parseGeoFootprint,
  parseGeoFootprintCollection,
  parseGeoProjectionMeshCollection,
} from "./videoArGeoreference.ts";

const rectangle = {
  top_left: { longitude: 108, latitude: 34.001 },
  top_right: { longitude: 108.001, latitude: 34.001 },
  bottom_right: { longitude: 108.001, latitude: 34 },
  bottom_left: { longitude: 108, latitude: 34 },
};

test("parses an atomically bound WGS84 footprint in image-corner order", () => {
  const footprint = parseGeoFootprint({
    video_frame: "video_frames/frame-001.jpg",
    video_frame_timestamp_ms: 1_754_179_632_318,
    source_crs: "EPSG:4979",
    ground_footprint_wgs84: rectangle,
  });
  assert.ok(footprint);
  assert.equal(footprint.crs, "EPSG:4979");
  assert.equal(footprint.videoFrame, "video_frames/frame-001.jpg");
  assert.deepEqual(footprint.topLeft, rectangle.top_left);
  assert.deepEqual(footprint.bottomRight, rectangle.bottom_right);
});

test("matches by exact frame name or by a nearby timestamp, never a stale timestamp", () => {
  const collection = parseGeoFootprintCollection({
    source_crs: "EPSG:4326",
    frame_footprints: [
      { video_frame: "nested/FRAME-001.JPG", footprint_timestamp_ms: 10_000, ground_footprint: rectangle },
      { video_frame: "frame-002.jpg", footprint_timestamp_ms: 12_000, ground_footprint: rectangle },
    ],
  });
  assert.equal(matchGeoFootprint(collection, "frame-001.jpg", 10_200, 1_500)?.videoFrame, "nested/FRAME-001.JPG");
  assert.equal(matchGeoFootprint(collection, undefined, 11_800, 1_500)?.videoFrame, "frame-002.jpg");
  assert.equal(matchGeoFootprint(collection, "frame-001.jpg", 30_000, 1_500), undefined);
});

test("supports dictionaries keyed by video frame without guessing the corner order", () => {
  const collection = parseGeoFootprintCollection({
    source_crs: "WGS84",
    by_frame: {
      "frame-a.jpg": { footprint_timestamp_ms: 20_000, projection_corners: rectangle },
    },
  });
  assert.equal(collection.items.length, 1);
  assert.equal(collection.items[0].videoFrame, "frame-a.jpg");
});

test("rejects unbound static canvas extents, non-WGS84 CRS, and self-intersecting corners", () => {
  assert.throws(() => parseGeoFootprintCollection({ source_crs: "EPSG:4326", ...rectangle }), /必须与 video_frame/);
  assert.throws(() => parseGeoFootprint({ source_crs: "GCJ-02", ground_footprint: rectangle }), /不是 WGS84/);
  assert.throws(() => parseGeoFootprint({
    source_crs: "EPSG:4326",
    ground_footprint: {
      ...rectangle,
      bottom_right: rectangle.bottom_left,
      bottom_left: rectangle.bottom_right,
    },
  }), /非自交凸四边形/);
});

const meshVertices = [
  [0, 0, 108, 34.001, 42],
  [1, 0, 108.001, 34.001, 44],
  [0, 1, 108, 34, 30],
  [1, 1, 108.001, 34, 31],
];

test("parses an EPSG:4979 visible-surface mesh with exact sample binding", () => {
  const collection = parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    frame_meshes: [{
      video_sample_index: 120,
      video_time_ms: 4_000,
      projection_mesh_wgs84: {
        uv_origin: "top_left",
        uv_units: "normalized",
        visibility: "first_surface_hit",
        image_width_px: 3_840,
        image_height_px: 2_160,
        vertices: meshVertices,
        triangles: [0, 2, 1, 1, 2, 3],
        quality: { valid: true, method: "sfm_mvs", reprojection_rmse_px: 1.2 },
      },
    }],
  });
  assert.equal(collection.items.length, 1);
  assert.ok(collection.items[0].positionsWgs84 instanceof Float64Array);
  assert.ok(collection.items[0].indices instanceof Uint16Array);
  assert.equal(matchGeoProjectionMesh(collection, 120, undefined, 4_020, undefined, 50), collection.items[0]);
  assert.equal(matchGeoProjectionMesh(collection, 121, undefined, 4_100, undefined, 50), undefined);
});

test("rejects meshes without ellipsoid height or explicit depth-boundary topology", () => {
  assert.throws(() => parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4326",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    video_sample_index: 1,
    projection_mesh: { vertices: meshVertices, triangles: [0, 2, 1] },
  }), /EPSG:4979/);
  assert.throws(() => parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    video_sample_index: 1,
    projection_mesh: { vertices: meshVertices },
  }), /显式 triangles/);
  assert.throws(() => parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    video_sample_index: 1,
    projection_mesh: { vertices: meshVertices, triangles: [0, 1, 2, 0, 3, 1] },
  }), /UV 绕序不一致/);
});

test("never falls back to an adjacent PTS when an exact sample key misses", () => {
  const collection = parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    frame_meshes: [{
      video_sample_index: 120,
      video_time_ms: 4_000,
      projection_mesh: { vertices: meshVertices, triangles: [0, 2, 1, 1, 2, 3] },
    }],
  });
  assert.equal(matchGeoProjectionMesh(collection, 121, undefined, 4_020, undefined, 50), undefined);
});

test("rejects a sample hit when another declared binding conflicts", () => {
  const collection = parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    frame_meshes: [{
      video_sample_index: 120,
      video_frame: "A.jpg",
      video_time_ms: 4_000,
      timestamp_ms: 10_000,
      projection_mesh: { vertices: meshVertices, triangles: [0, 2, 1, 1, 2, 3] },
    }],
  });
  assert.equal(matchGeoProjectionMesh(collection, 120, "B.jpg", 4_020, 999_999, 50), undefined);
});

test("preserves parent frame binding and source-video identity around frame_metadata", () => {
  const collection = parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    source_video: { file_name: "DJI_TEST.mp4", size_bytes: 123_456, duration_ms: 5_000 },
    frame_meshes: [{
      video_sample_index: 7,
      video_time_ms: 233.3,
      frame_metadata: {
        projection_mesh_wgs84: { vertices: meshVertices, triangles: [0, 2, 1, 1, 2, 3] },
      },
    }],
  });
  assert.equal(collection.items[0].videoSampleIndex, 7);
  assert.equal(collection.items[0].videoTimeMs, 233.3);
  assert.deepEqual(collection.sourceVideo, {
    fileName: "DJI_TEST.mp4",
    sizeBytes: 123_456,
    durationMs: 5_000,
  });
});

test("requires the first-visible browser display-space contract", () => {
  assert.throws(() => parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_width_px: 3_840,
    image_height_px: 2_160,
    video_sample_index: 1,
    projection_mesh: { vertices: meshVertices, triangles: [0, 2, 1] },
  }), /visibility: first_surface_hit/);
});

test("rejects duplicate mesh PTS instead of choosing an ambiguous frame", () => {
  assert.throws(() => parseGeoProjectionMeshCollection({
    source_crs: "EPSG:4979",
    height_reference: "WGS84_ELLIPSOID",
    image_space: "browser_display",
    image_width_px: 3_840,
    image_height_px: 2_160,
    visibility: "first_surface_hit",
    frame_meshes: [0, 1].map((videoSampleIndex) => ({
      video_sample_index: videoSampleIndex,
      video_time_ms: 100,
      projection_mesh: { vertices: meshVertices, triangles: [0, 2, 1, 1, 2, 3] },
    })),
  }), /video_time_ms 100 重复/);
});

test("preserves source-video identity for an embedded footprint collection", () => {
  const collection = parseGeoFootprintCollection({
    source_video: { file_name: "DJI_TEST.mp4", size_bytes: 123_456, duration_ms: 5_000 },
    source_crs: "EPSG:4979",
    frame_footprints: [{ video_frame: "frame-001.jpg", ...rectangle }],
  });
  assert.deepEqual(collection.sourceVideo, {
    fileName: "DJI_TEST.mp4",
    sizeBytes: 123_456,
    durationMs: 5_000,
  });
});
