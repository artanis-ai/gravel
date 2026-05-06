"""`gravel` CLI for Python users. Lightweight click app.

Mirrors packages/sdk-ts/src/cli/index.ts.
"""
from __future__ import annotations

import sys
from pathlib import Path

import click

from .manifest import diff_manifests, fast_scan, read_manifest, write_manifest


@click.group()
def cli() -> None:
    """gravel — embedded prompt management, tracing, and evals."""


@cli.command()
@click.option("--api-key", help="CI installs: pre-bake this project key into .env.")
@click.option("--project", help="CI installs: pre-bake this project ID into .env.")
@click.option("--mount-path", default="/admin/ai")
@click.option("--no-migrate", is_flag=True)
@click.option("--no-hook", is_flag=True)
@click.option("--no-deep-scan", is_flag=True)
@click.option("--no-test-trace", is_flag=True)
def init(**kwargs) -> None:
    """Run the install wizard.

    Always local: the CLI never phones home. Cloud features (judge,
    analyze, evals) are enabled from the dashboard's sign-in flow when the
    user clicks any of them at ``/admin/ai``. For CI / scripted installs
    that need creds in ``.env`` from the start, pass ``--api-key`` +
    ``--project`` (or set ``GRAVEL_API_KEY`` + ``GRAVEL_PROJECT_ID`` in
    the environment).
    """
    from .wizard import run_wizard
    run_wizard(**kwargs)


@cli.group("manifest")
def manifest_cmd() -> None:
    """Manifest commands."""


@manifest_cmd.command("check")
def manifest_check() -> None:
    """Verify manifest is in sync with the working tree."""
    cwd = Path.cwd()
    current = read_manifest(cwd)
    result = fast_scan(cwd, current)
    if result.added == 0 and result.removed == 0 and result.changed == 0:
        click.echo("Gravel manifest is in sync.")
        return
    diff = diff_manifests(current, result.manifest)
    click.echo("Gravel manifest is out of date:", err=True)
    click.echo(diff, err=True)
    sys.exit(1)


@manifest_cmd.command("update")
def manifest_update() -> None:
    """Regenerate manifest from working tree."""
    cwd = Path.cwd()
    current = read_manifest(cwd)
    result = fast_scan(cwd, current)
    write_manifest(cwd, result.manifest)
    click.echo(
        f"Manifest updated: +{result.added} -{result.removed} ~{result.changed} "
        f"({result.unchanged} unchanged).",
    )


@manifest_cmd.command("list")
def manifest_list() -> None:
    """Print human-readable summary of current manifest."""
    cwd = Path.cwd()
    current = read_manifest(cwd)
    click.echo(f"Manifest: {len(current.prompts)} prompts")
    for p in current.prompts:
        click.echo(f"  {p.path}")


@cli.command()
def migrate() -> None:
    """Apply pending DB migrations (uses bootstrap.py in v0)."""
    from .wizard import run_bootstrap
    run_bootstrap(Path.cwd())
    click.echo("Schema bootstrap complete.")


@cli.command()
def doctor() -> None:
    """Self-diagnostic."""
    from .wizard.doctor import run_doctor
    run_doctor()


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
