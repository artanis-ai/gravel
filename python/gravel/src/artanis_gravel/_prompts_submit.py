"""Submit-drafts pipeline: turn DE drafts into one PR.

Port of `packages/sdk-ts/src/prompts/submit.ts`. Same invariants:

  * All drafts must reference manifest entries.
  * Per-file: file-type drafts replace whole content; embedded drafts
    apply in DESCENDING char_start order so earlier offsets aren't
    shifted by later edits.
  * The updated manifest (with new char/line offsets and prompt hashes)
    is included in the same PR so a merged repo isn't left with a
    stale manifest pointing at the wrong byte ranges.

Spec: gravel-cloud/docs/spec/prompts.md §2 + §6.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date as _date
from pathlib import Path
from typing import Iterable

from ._github_api import (
    CreatePullRequestResult,
    GitHubAPIError,
    PromptChange,
    create_pull_request,
    github_api,
)
from .manifest.hash import hash_prompt
from .manifest.io import _prompt_to_dict, read_manifest
from .manifest.types import (
    MANIFEST_PATH,
    Manifest,
    ManifestPrompt,
    ManifestPromptEmbedded,
)


@dataclass
class DraftInput:
    """A single draft passed in from the dashboard's localStorage."""
    prompt_id: str
    new_text: str


class SubmitError(Exception):
    """Structured failure. `code` is one of the SubmitError codes the
    TS handler uses; the dashboard renders specific copy per code."""

    def __init__(self, code: str, message: str, details: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def draft_branch_for(user_id: str, *, today: _date | None = None) -> str:
    """Idempotent within a day: same user + same date → same branch
    so re-submits update the existing PR instead of opening a new one."""
    d = today or _date.today()
    sanitized = re.sub(r"[^A-Za-z0-9._-]", "-", user_id)
    return f"gravel/draft-{d.isoformat()}-{sanitized}"


@dataclass
class SubmitArgs:
    repo_root: str | Path
    drafts: list[DraftInput]
    draft_branch: str
    access_token: str
    repo_owner: str
    repo_name: str
    title: str | None = None
    description: str | None = None
    de_first_name: str | None = None


def _char_offset_to_line(text: str, offset: int) -> int:
    """1-indexed line number for the line containing the char at `offset`.
    Matches packages/sdk-ts/src/prompts/submit.ts."""
    limit = min(offset, len(text))
    return 1 + text.count("\n", 0, limit)


def _serialize_manifest(manifest: Manifest) -> str:
    payload = {
        "version": manifest.version,
        "lastFullScanCommit": manifest.last_full_scan_commit,
        "lastFullScanAt": manifest.last_full_scan_at,
        "prompts": [_prompt_to_dict(p) for p in manifest.prompts],
    }
    return json.dumps(payload, indent=2) + "\n"


def _decode_base64_utf8(content: str, encoding: str) -> str:
    if encoding != "base64":
        raise SubmitError(
            "github_failed",
            f"Unexpected GitHub contents encoding: {encoding}",
        )
    import base64

    cleaned = re.sub(r"\s+", "", content)
    return base64.b64decode(cleaned).decode("utf-8")


def _group_by_path(items: Iterable) -> dict[str, list]:
    """Small generic helper: `items` of objects with `.entry.path`."""
    out: dict[str, list] = {}
    for r in items:
        out.setdefault(r.entry.path, []).append(r)
    return out


@dataclass
class _Resolved:
    draft: DraftInput
    entry: ManifestPrompt


def submit_drafts(args: SubmitArgs) -> CreatePullRequestResult:
    """Drive the full submit pipeline. Raises SubmitError with a
    structured `code` on user-facing failures; bubbles up other
    exceptions for the caller to log.
    """
    if not args.drafts:
        raise SubmitError("no_drafts", "No drafts to submit")

    manifest = read_manifest(args.repo_root)
    if not manifest.prompts:
        raise SubmitError(
            "manifest_missing",
            "Manifest is empty: the dashboard expected at least one prompt",
        )
    prompt_index: dict[str, ManifestPrompt] = {p.id: p for p in manifest.prompts}

    resolved: list[_Resolved] = []
    missing: list[str] = []
    for draft in args.drafts:
        entry = prompt_index.get(draft.prompt_id)
        if entry is None:
            missing.append(draft.prompt_id)
            continue
        resolved.append(_Resolved(draft=draft, entry=entry))
    if missing:
        raise SubmitError(
            "unknown_prompt",
            "One or more drafts refer to unknown prompts",
            {"missing": missing},
        )

    by_path = _group_by_path(resolved)
    changes: list[PromptChange] = []
    new_content_by_path: dict[str, str] = {}

    for path, items in by_path.items():
        files = [i for i in items if i.entry.type == "file"]
        embeddeds = [i for i in items if i.entry.type == "embedded"]
        if files and embeddeds:
            raise SubmitError(
                "unknown_prompt",
                f"Path {path} has both file-type and embedded-type prompts in the same submit (ambiguous).",
            )
        if len(files) > 1:
            raise SubmitError(
                "unknown_prompt",
                f"Path {path} has multiple file-type prompt drafts in this submit",
            )
        if files:
            new_text = files[0].draft.new_text
            changes.append(PromptChange(path=path, content=new_text))
            new_content_by_path[path] = new_text
            continue

        try:
            file = github_api(
                f"/repos/{args.repo_owner}/{args.repo_name}/contents/{path}",
                args.access_token,
            )
            current = _decode_base64_utf8(file["content"], file["encoding"])
        except GitHubAPIError as e:
            raise SubmitError(
                "github_failed",
                f"Could not read {path} from {args.repo_owner}/{args.repo_name}",
                str(e),
            ) from e
        except (KeyError, TypeError) as e:
            raise SubmitError(
                "github_failed",
                f"Unexpected GitHub contents shape for {path}",
            ) from e

        # Sort descending so earlier offsets aren't shifted as we apply.
        sorted_items = sorted(
            embeddeds,
            key=lambda i: i.entry.char_start,
            reverse=True,
        )
        next_text = current
        for item in sorted_items:
            e: ManifestPromptEmbedded = item.entry  # type: ignore[assignment]
            next_text = next_text[: e.char_start] + item.draft.new_text + next_text[e.char_end :]
        changes.append(PromptChange(path=path, content=next_text))
        new_content_by_path[path] = next_text

    # Manifest rewrite: every edit shifts subsequent embedded prompts'
    # offsets, and every edited prompt needs a new hash. Without this
    # rewrite, a merged repo has a stale manifest and `gravel manifest
    # --check` fails.
    edited_ids = {r.entry.id for r in resolved}
    edits_by_path: dict[str, dict[int, str]] = {}
    for r in resolved:
        if r.entry.type != "embedded":
            continue
        e: ManifestPromptEmbedded = r.entry  # type: ignore[assignment]
        edits_by_path.setdefault(r.entry.path, {})[e.char_start] = r.draft.new_text

    prompts_by_path: dict[str, list[ManifestPrompt]] = {}
    for p in manifest.prompts:
        prompts_by_path.setdefault(p.path, []).append(p)

    updated_prompts: list[ManifestPrompt] = []
    for entry in manifest.prompts:
        new_content = new_content_by_path.get(entry.path)
        if new_content is None:
            updated_prompts.append(entry)
            continue
        if entry.type == "file":
            updated_prompts.append(
                type(entry)(
                    id=entry.id,
                    path=entry.path,
                    hash=hash_prompt(new_content),
                )
            )
            continue

        e: ManifestPromptEmbedded = entry  # type: ignore[assignment]
        edits = edits_by_path.get(entry.path, {})
        same_file = [
            p for p in prompts_by_path.get(entry.path, []) if p.type == "embedded"
        ]
        delta = 0
        for other in same_file:
            o: ManifestPromptEmbedded = other  # type: ignore[assignment]
            if o.char_start < e.char_start and o.char_start in edits:
                new_text = edits[o.char_start]
                delta += len(new_text) - (o.char_end - o.char_start)
        new_char_start = e.char_start + delta
        if entry.id in edited_ids:
            new_text = edits[e.char_start]
            new_char_end = new_char_start + len(new_text)
            new_hash = hash_prompt(new_text)
        else:
            new_char_end = e.char_end + delta
            new_hash = entry.hash
        updated_prompts.append(
            ManifestPromptEmbedded(
                id=entry.id,
                path=entry.path,
                hash=new_hash,
                line_start=_char_offset_to_line(new_content, new_char_start),
                line_end=_char_offset_to_line(
                    new_content, max(new_char_start, new_char_end - 1)
                ),
                char_start=new_char_start,
                char_end=new_char_end,
                var_name=e.var_name,
            )
        )

    updated_manifest = Manifest(
        version=manifest.version,
        last_full_scan_commit=manifest.last_full_scan_commit,
        last_full_scan_at=manifest.last_full_scan_at,
        prompts=updated_prompts,
    )
    changes.append(PromptChange(path=MANIFEST_PATH, content=_serialize_manifest(updated_manifest)))

    try:
        return create_pull_request(
            access_token=args.access_token,
            repo_owner=args.repo_owner,
            repo_name=args.repo_name,
            changes=changes,
            title=args.title or f"[Gravel] Update {len(resolved)} prompt(s)",
            description=args.description,
            de_first_name=args.de_first_name,
            branch_name=args.draft_branch,
        )
    except GitHubAPIError as e:
        raise SubmitError("github_failed", "Failed to open PR", str(e)) from e
