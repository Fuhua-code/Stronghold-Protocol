"""Create/update the FastRTC credential broker Space without exposing secrets."""

from __future__ import annotations

import os
import sys
from pathlib import Path


SPACE_ID = os.environ.get("TURN_SPACE_ID", "Fuhuaaaa/stronghold-turn-credentials")
ROOT = Path(__file__).resolve().parents[1]
SPACE_DIR = ROOT / "turn-space"


def main() -> int:
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        print("HF_TOKEN is missing", file=sys.stderr)
        return 2
    try:
        from huggingface_hub import HfApi
    except ImportError:
        print("Install huggingface_hub in the Python 3.12 environment first", file=sys.stderr)
        return 2
    api = HfApi(token=token)
    try:
        who = api.whoami()
        role = ((who.get("auth") or {}).get("accessToken") or {}).get("role")
        if role not in {"write", "fineGrained"}:
            print(f"HF_TOKEN role is {role or 'unknown'}; a write-capable token is required", file=sys.stderr)
            return 3
        api.create_repo(repo_id=SPACE_ID, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
        api.upload_folder(repo_id=SPACE_ID, repo_type="space", folder_path=str(SPACE_DIR), path_in_repo=None, commit_message="Deploy TURN credential broker")
        api.add_space_secret(repo_id=SPACE_ID, key="HF_TOKEN", value=token, description="FastRTC credential broker token")
    except Exception as error:
        if "402" in str(error) and "PRO" in str(error):
            print("Hugging Face rejected the Space because Docker/Gradio CPU hosting requires an HF PRO subscription", file=sys.stderr)
            return 5
        print(f"Hugging Face deployment failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 4
    print(f"Space deployed: https://huggingface.co/spaces/{SPACE_ID}")
    print(f"Credential endpoint: https://{SPACE_ID.split('/', 1)[0].lower()}-{SPACE_ID.split('/', 1)[1]}.hf.space/credentials")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
