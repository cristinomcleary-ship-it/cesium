from pathlib import Path
from functools import lru_cache
from fractions import Fraction
import math
import numpy as np
from .io import load_json


@lru_cache(maxsize=1)
def _pose_validator():
    from jsonschema import Draft202012Validator
    return Draft202012Validator(load_json(Path(__file__).parent / 'schemas/pose.schema.json'))


def validate_pose_record(pose):
    """Reject incomplete identities, invalid cameras and unsupported acceptance claims."""
    errors = sorted(_pose_validator().iter_errors(pose), key=lambda error: str(error.path))
    if errors:
        raise ValueError('Invalid pose contract: ' + '; '.join(f'{list(error.path)}: {error.message}' for error in errors[:5]))
    K = np.asarray(pose['K'], dtype=float).reshape(3, 3)
    if not np.isfinite(K).all() or K[0, 0] <= 0 or K[1, 1] <= 0 or not np.allclose(K[2], [0, 0, 1]):
        raise ValueError('Invalid pose contract: camera intrinsics must be finite and valid.')
    transform = pose['T_camera_from_scene']
    if transform is not None:
        T = np.asarray(transform, dtype=float).reshape(4, 4)
        if (not np.isfinite(T).all() or not np.allclose(T[3], [0, 0, 0, 1], atol=1e-8)
                or not np.allclose(T[:3, :3].T @ T[:3, :3], np.eye(3), atol=1e-5)
                or not np.isclose(np.linalg.det(T[:3, :3]), 1., atol=1e-5)):
            raise ValueError('Invalid pose contract: camera transform must be a finite rigid transform.')
    timestamp = float(Fraction(pose['time_base']) * pose['original_pts'])
    if not math.isfinite(pose['time_seconds']) or abs(pose['time_seconds'] - timestamp) > 1e-6:
        raise ValueError('Invalid pose contract: time_seconds does not match original_pts/time_base.')
    if pose['accepted']:
        from .validation import checkpoint_acceptance
        report = pose['metrics']['independent_checkpoints']
        try:
            passing = checkpoint_acceptance(report)
        except (KeyError, TypeError, ValueError):
            passing = False
        if pose['status'] not in ('LOCALIZED', 'TRACKED') or not passing:
            raise ValueError('Invalid pose contract: acceptance requires a valid pose and passing independent checkpoints.')
    return pose
