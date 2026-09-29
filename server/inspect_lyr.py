# -*- coding: utf-8 -*-
from __future__ import print_function

import json
import os
import sys

import arcpy


def emit(payload):
    text = json.dumps(payload, ensure_ascii=False)
    if isinstance(text, unicode):
        text = text.encode("utf-8")
    sys.stdout.write(text)


try:
    input_path = sys.argv[1].decode("mbcs") if not isinstance(sys.argv[1], unicode) else sys.argv[1]
    root_layer = arcpy.mapping.Layer(input_path)
    layers = arcpy.mapping.ListLayers(root_layer) if root_layer.isGroupLayer else [root_layer]
    raster_layers = [item for item in layers if item.isRasterLayer]
    service_layers = []
    for item in layers:
        try:
            properties = item.serviceProperties if item.isServiceLayer else {}
            service_type = properties.get("ServiceType", "") if properties else ""
            if service_type in ("TiledInternetLayer", "WMTS", "MapServer", "ImageServer"):
                service_layers.append({
                    "name": item.name,
                    "serviceType": service_type,
                    "url": properties.get("URL", ""),
                    "server": properties.get("Server", ""),
                })
        except Exception:
            pass
    if not raster_layers:
        if service_layers:
            emit({"ok": True, "kind": "service", "name": root_layer.name, "services": service_layers})
            sys.exit(0)
        raise RuntimeError(u"LYR 中没有可作为卫星底图的栅格或瓦片服务图层")
    layer = raster_layers[0]
    source = layer.dataSource
    if not source or not arcpy.Exists(source):
        raise RuntimeError(u"LYR 引用的原始影像不存在或已被移动：%s" % (source or u"未记录路径"))
    extension = os.path.splitext(source)[1].lower()
    if extension not in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"):
        raise RuntimeError(u"LYR 引用的是 %s，当前请先转为 GeoTIFF、PNG 或 JPG" % (extension or u"未知格式"))
    spatial_reference = arcpy.Describe(layer).spatialReference
    if not spatial_reference or spatial_reference.name == "Unknown":
        raise RuntimeError(u"LYR 引用的影像没有可识别坐标系")
    extent = layer.getExtent()
    wgs84 = arcpy.SpatialReference(4326)
    projected = extent.projectAs(wgs84)
    emit({
        "ok": True,
        "name": layer.name,
        "source": source,
        "extension": extension,
        "spatialReference": spatial_reference.name,
        "bounds": {
            "west": projected.XMin,
            "south": projected.YMin,
            "east": projected.XMax,
            "north": projected.YMax,
        },
    })
except Exception as error:
    emit({"ok": False, "error": unicode(error)})
    sys.exit(1)
