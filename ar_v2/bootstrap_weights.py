"""Explicit one-time official model weight installation with recorded SHA256."""
from __future__ import annotations
import os
from pathlib import Path
from .config import load_config
from .io import file_hash, write_json, load_json


def bootstrap(config):
    os.environ['TORCH_HOME'] = str(Path(config['output_dir']) / 'weights')
    import torch
    from lightglue import ALIKED, LightGlue
    print('Downloading/loading the pinned official ALIKED and LightGlue model weights', flush=True)
    ALIKED(model_name='aliked-n16').eval()
    LightGlue(features='aliked').eval()
    folder = Path(torch.hub.get_dir()) / 'checkpoints'
    files = [folder / 'aliked-n16.pth', folder / f"aliked_lightglue_{LightGlue.version.replace('.', '-')}.pth"]
    report = {'schema_version': 'ar-v2-model-weights/v1', 'torch': torch.__version__,
              'cuda_available': torch.cuda.is_available(),
              'devices': [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],
              'weight_sha256': {path.name: file_hash(path) for path in files},
              'source_urls': {'aliked': ALIKED.checkpoint_url.format('aliked-n16'),
                              'lightglue': LightGlue.url.format(LightGlue.version, 'aliked_lightglue') if hasattr(LightGlue, 'url') else 'https://github.com/cvg/LightGlue/releases'}}
    lock = Path(__file__).with_name('weights.lock.json')
    if lock.exists() and load_json(lock)['weight_sha256'] != report['weight_sha256']:
        raise ValueError('Official downloaded weights differ from the committed weight lock')
    write_json(Path(config['output_dir']) / 'environment/model-weights.json', report)
    print(report, flush=True)
    return report


if __name__ == '__main__':
    bootstrap(load_config())
