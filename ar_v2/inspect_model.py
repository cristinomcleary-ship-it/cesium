import json
import struct
from pathlib import Path
from .config import load_config

if __name__ == '__main__':
    config = load_config()
    root = Path(config['tileset_path']).parent
    path = next(root.rglob('*.b3dm'))
    data = path.read_bytes()
    header = struct.unpack_from('<4s6I', data)
    offset = 28 + sum(header[3:])
    feature = json.loads(data[28:28+header[3]])
    glb = data[offset:]
    length, kind = struct.unpack_from('<II', glb, 12)
    document = json.loads(glb[20:20+length])
    print(json.dumps({'path':str(path),'b3dm_header':list(header[1:]),'feature_table':feature,
        'glb_version':struct.unpack_from('<I',glb,4)[0], 'asset':document.get('asset'),
        'extensions':document.get('extensionsUsed'),'extensions_object':document.get('extensions'),
        'mesh':document.get('meshes',[None])[0], 'nodes':document.get('nodes',[])[:3],
        'materials':document.get('materials',[])[:1], 'images':document.get('images',[])[:1],
        'accessors':document.get('accessors',[])[:3]},ensure_ascii=False,indent=2))
