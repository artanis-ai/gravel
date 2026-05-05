"""Manifest tooling. Parity with packages/sdk-ts/src/manifest/."""
from .types import Manifest, ManifestPrompt, MANIFEST_VERSION, MANIFEST_PATH, empty_manifest
from .io import read_manifest, write_manifest
from .hash import normalize, hash_prompt, generate_prompt_id
from .scan import fast_scan, FastScanResult, diff_manifests
from .hook import install_hook

__all__ = [
    "Manifest",
    "ManifestPrompt",
    "MANIFEST_VERSION",
    "MANIFEST_PATH",
    "empty_manifest",
    "read_manifest",
    "write_manifest",
    "normalize",
    "hash_prompt",
    "generate_prompt_id",
    "fast_scan",
    "FastScanResult",
    "diff_manifests",
    "install_hook",
]
