#!/usr/bin/env python3
"""Read-only CC pose audit; Python standard library only.

Usage: python tools/inspect-cc-pose-consistency.py --xml BLOCK.xml \
    --diagnostic cc-registration-diagnostic.json [--output report.json]

Output contains aggregate errors/angles, never source paths or coordinates.
Metadata is a comparison reference, not established ground truth. This tool
does not alter XML, camera settings, CAD, or saved registration.
"""

import argparse
import json
import math
import re
import statistics
import xml.etree.ElementTree as ET
from pathlib import Path


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(a):
    return math.sqrt(dot(a, a))


def sub(a, b):
    return [x - y for x, y in zip(a, b)]


def transpose(a):
    return list(map(list, zip(*a)))


def mv(a, v):
    return [dot(row, v) for row in a]


def mm(a, b):
    return [[dot(row, col) for col in transpose(b)] for row in a]


def mean_vector(values):
    return [statistics.mean(col) for col in zip(*values)]


def principal_vector(matrix):
    # Positive-semidefinite 3x3/4x4 matrices: start at the largest diagonal.
    n = len(matrix)
    v = [float(i == max(range(n), key=lambda j: matrix[j][j])) for i in range(n)]
    for _ in range(200):
        w = mv(matrix, v)
        length = norm(w)
        if length == 0:
            raise ValueError("Degenerate orientation/trajectory covariance")
        w = [x / length for x in w]
        if norm(sub(w, v)) < 1e-14:
            return w
        v = w
    return v


def covariance(vectors):
    return [[sum(v[i] * v[j] for v in vectors) for j in range(len(vectors[0]))]
            for i in range(len(vectors[0]))]


def rotation(pose):
    y, p, r = (math.radians(float(pose.findtext("Rotation/" + k)))
               for k in ("Yaw", "Pitch", "Roll"))
    cy, sy, cp, sp, cr, sr = math.cos(y), math.sin(y), math.cos(p), math.sin(p), math.cos(r), math.sin(r)
    # Bentley Perspective / XRightYDown world-to-camera convention.
    return [[cr * cy - sr * sp * sy, -cr * sy - cy * sr * sp, cp * sr],
            [cy * sr + cr * sp * sy, cr * cy * sp - sr * sy, -cr * cp],
            [cp * sy, cp * cy, sp]]


def geodetic(pose):
    lon, lat, height = (float(pose.findtext("Center/" + k)) for k in ("x", "y", "z"))
    lon, lat = math.radians(lon), math.radians(lat)
    sl, cl, sp, cp = math.sin(lon), math.cos(lon), math.sin(lat), math.cos(lat)
    a, e2 = 6378137.0, 6.6943799901413165e-3
    n = a / math.sqrt(1 - e2 * sp * sp)
    return ([(n + height) * cp * cl, (n + height) * cp * sl, (n * (1 - e2) + height) * sp],
            [[-sl, -sp * cl, cp * cl], [cl, -sp * sl, cp * sl], [0, cp, sp]])


def quaternion(m):
    trace = sum(m[i][i] for i in range(3))
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        return [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s,
                (m[1][0] - m[0][1]) / s, s / 4]
    i = max(range(3), key=lambda k: m[k][k])
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(1 + m[i][i] - m[j][j] - m[k][k]) * 2
    q = [0.0] * 4
    q[i], q[j], q[k], q[3] = s / 4, (m[j][i] + m[i][j]) / s, (m[k][i] + m[i][k]) / s, (m[k][j] - m[j][k]) / s
    return q


def quaternion_matrix(q):
    x, y, z, w = q
    return [[1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
            [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
            [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)]]


def angle(m):
    return math.degrees(math.acos(max(-1, min(1, (sum(m[i][i] for i in range(3)) - 1) / 2))))


def stats(values):
    return {"min": min(values), "max": max(values), "mean": statistics.mean(values),
            "rms": math.sqrt(statistics.mean(v*v for v in values))}


def vector(value):
    return [value[k] for k in ("x", "y", "z")]


def audit(xml_path, diagnostic_path):
    root = ET.parse(xml_path).getroot()
    diagnostic = json.loads(Path(diagnostic_path).read_text(encoding="utf-8"))
    definition = root.findtext("SpatialReferenceSystems/SRS/Definition", "")
    if definition not in ("EPSG:4326", "EPSG:4979"):
        raise ValueError("This audit requires geographic EPSG:4326 or EPSG:4979")
    groups = root.findall("Block/Photogroups/Photogroup")
    if len(groups) != 1 or groups[0].findtext("CameraOrientation") != "XRightYDown":
        raise ValueError("This audit requires one XRightYDown photogroup")
    photos = groups[0].findall("Photo")
    optimized, metadata, deltas, roll, metadata_roll = [], [], [], [], []
    for photo in photos:
        pose, meta = photo.find("Pose"), photo.find("Pose/Metadata")
        if meta is None:
            raise ValueError("All photos need Metadata poses for this comparison")
        center, enu = geodetic(pose)
        meta_center, meta_enu = geodetic(meta)
        camera = mm(enu, transpose(rotation(pose)))
        meta_camera = mm(meta_enu, transpose(rotation(meta)))
        optimized.append(center)
        metadata.append(meta_center)
        deltas.append(mm(meta_camera, transpose(camera)))
        roll.append(float(pose.findtext("Rotation/Roll")))
        metadata_roll.append(float(meta.findtext("Rotation/Roll")))

    average = quaternion_matrix(principal_vector(covariance([quaternion(d) for d in deltas])))
    scatter = [angle(mm(d, transpose(average))) for d in deltas]
    theta = math.radians(angle(average))
    axis = [(average[2][1] - average[1][2]), (average[0][2] - average[2][0]), (average[1][0] - average[0][1])]
    axis = [v / (2 * math.sin(theta)) for v in axis] if abs(theta) > 1e-9 else None
    _, anchor_enu = geodetic(photos[0].find("Pose"))
    center_mean = mean_vector(optimized)
    centered = [sub(p, center_mean) for p in optimized]
    flight = principal_vector(covariance(centered))
    cross_track = [norm(sub(p, [dot(p, flight) * v for v in flight])) for p in centered]
    target_mean = mean_vector(metadata)
    corrected = [[x + t for x, t in zip(mv(average, p), target_mean)] for p in centered]

    raw, live = diagnostic["rawCamera"], diagnostic["liveCamera"]
    by_id = {photo.findtext("Id"): photo for photo in photos}
    from_photo = by_id[raw["fromPhotoId"]]
    to_photo = by_id[raw["toPhotoId"]]
    alpha = raw["interpolation"]
    lat = (1 - alpha) * float(from_photo.findtext("Pose/Center/y")) + alpha * float(to_photo.findtext("Pose/Center/y"))
    position = vector(raw["position"])
    lon = math.atan2(position[1], position[0])
    lat = math.radians(lat)
    world_up = [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)]
    f, up = vector(raw["direction"]), vector(raw["up"])
    right = [f[1]*up[2] - f[2]*up[1], f[2]*up[0] - f[0]*up[2], f[0]*up[1] - f[1]*up[0]]
    horizon = math.degrees(math.atan2(dot(right, world_up), dot(up, world_up)))
    report = {
        "format": "cc-pose-consistency-audit", "version": 1,
        "scope": "Read-only comparison; Metadata is not established ground truth; no calibration changes applied.",
        "photoCount": len(photos), "optimizedRollDegrees": stats(roll),
        "metadataRollDegrees": stats(metadata_roll),
        "controlPointCount": len(root.findall(".//ControlPoints/*")),
        "positioningConstraintCount": len(root.findall(".//PositioningConstraints/*")),
        "currentFrame": {
            "timeSeconds": diagnostic["video"]["currentTime"],
            "fromPhotoId": raw["fromPhotoId"], "toPhotoId": raw["toPhotoId"], "interpolation": alpha,
            "fromPoseRollDegrees": float(from_photo.findtext("Pose/Rotation/Roll")),
            "toPoseRollDegrees": float(to_photo.findtext("Pose/Rotation/Roll")),
            "idealHorizonRightDownDegrees": horizon,
            "idealHorizonDropPer1000Pixels": math.tan(math.radians(horizon)) * 1000,
            "rawToLiveVectorErrors": {k: norm(sub(vector(raw[k]), vector(live[k]))) for k in ("position", "direction", "up")},
            "cameraRegistrationEnabled": diagnostic["cameraRegistration"]["enabled"],
            "hasSceneReference": diagnostic.get("sceneReference") is not None,
            "hasGroupAdjustment": diagnostic.get("groupAdjustment") is not None,
        },
        "optimizedToMetadataOrientationComparison": {
            "averageRotationDegrees": angle(average),
            "angularScatterDegrees": stats(scatter),
            "axisToFlightDirectionDegrees": math.degrees(math.acos(min(1, abs(dot(axis, flight))))) if axis else None,
            "axisHeadingAtFirstCameraDegrees": math.degrees(math.atan2(*mv(transpose(anchor_enu), axis)[:2])) if axis else None,
            "trajectoryEndpointDistanceMeters": norm(sub(optimized[-1], optimized[0])),
            "trajectoryDistanceToPrincipalLineMeters": stats(cross_track),
            "originalCenterToMetadataDistanceMeters": stats([norm(sub(a, b)) for a, b in zip(optimized, metadata)]),
            "wholeTrajectoryRotationWithBestTranslationToMetadataDistanceMeters": stats([norm(sub(a, b)) for a, b in zip(corrected, metadata)]),
            "interpretation": "A nearly fixed attitude difference close to the flight axis is consistent with weak corridor orientation constraints; it does not prove which attitude is correct. Applying this attitude difference as whole-trajectory registration can worsen GPS agreement.",
        },
        "pendingValidation": ["Original-frame reprojection against independently known 3D points", "Source-video/decoded-frame PTS confirmation", "Source CAD coordinate and elevation validation"],
    }

    # Report a timing hypothesis, never silently reinterpret photo timestamps.
    timing = diagnostic["timing"]
    if timing.get("mode") == "ordinal" and len(photos) > 1:
        frames = []
        for photo in photos:
            basename = photo.findtext("ImagePath", "").replace("\\", "/").rsplit("/", 1)[-1]
            match = re.search(r"(\d+)\.[^.]+$", basename)
            if not match:
                break
            frames.append(int(match.group(1)))
        if len(frames) == len(photos):
            steps = {b - a for a, b in zip(frames, frames[1:])}
            if len(steps) == 1 and next(iter(steps)) > 0:
                step = next(iter(steps))
                nominal_fps = step / timing["intervalSeconds"]
                fps = nominal_fps * 1000 / 1001
                time = diagnostic["video"]["currentTime"]
                duration = diagnostic["video"]["duration"]
                index = (time - timing["firstTimeSeconds"]) * fps / step
                from_index = photos.index(from_photo)
                index_delta = from_index + alpha - index
                report["fractionalFrameRateHypothesis"] = {
                    "confirmedFromSourceMedia": False,
                    "filenameFrameStep": step, "hypothesisFramesPerSecond": fps,
                    "currentTimeFrameGridResidualFrames": abs(time * fps - round(time * fps)),
                    "durationFrameGridResidualFrames": abs(duration * fps - round(duration * fps)),
                    "currentPhotoIndexUnderHypothesis": index,
                    "currentMappedPhotoIndex": from_index + alpha,
                    "lastPhotoTimeUnderHypothesisSeconds": timing["firstTimeSeconds"] + (frames[-1] - frames[0]) / fps,
                    "approximateCurrentPositionOveradvanceMeters": norm(sub(optimized[photos.index(to_photo)], optimized[from_index])) * index_delta,
                    "approximateCurrentRollOveradvanceDegrees": (float(to_photo.findtext("Pose/Rotation/Roll")) - float(from_photo.findtext("Pose/Rotation/Roll"))) * index_delta,
                    "interpretation": "Frame-grid agreement supports checking this frame rate against the source MP4/PTS; timestamps alone do not establish the source rate or extraction provenance.",
                }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xml", required=True)
    parser.add_argument("--diagnostic", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = json.dumps(audit(args.xml, args.diagnostic), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(result, encoding="utf-8")
    else:
        print(result, end="")


if __name__ == "__main__":
    main()
