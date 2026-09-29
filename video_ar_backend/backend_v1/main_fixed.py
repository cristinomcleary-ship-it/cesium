"""Compatibility wrapper.

The reference archive's ``main_fixed.py`` accessed a non-existent
``DroneStatus.attitude`` field. Keep this filename for existing launch scripts,
but delegate to the maintained entry point.
"""
from __future__ import annotations

import asyncio

from .main import DroneBackendService, main

__all__ = ["DroneBackendService", "main"]


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
