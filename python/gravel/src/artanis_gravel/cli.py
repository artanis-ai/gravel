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
@click.option("--local", is_flag=True, help="Local-only install: skip cloud sign-in.")
@click.option("--ci", is_flag=True, help="Non-interactive mode (dev placeholders).")
@click.option("--api-key", help="Skip OAuth; use this project key.")
@click.option("--project", help="Specify project ID.")
@click.option("--mount-path", default="/admin/ai")
@click.option("--no-migrate", is_flag=True)
@click.option("--no-hook", is_flag=True)
@click.option("--no-deep-scan", is_flag=True)
@click.option("--no-test-trace", is_flag=True)
@click.option("--no-browser", is_flag=True, help="Don't auto-open the browser during OAuth.")
def init(no_browser: bool, **kwargs) -> None:
    """Run the install wizard.

    By default an interactive ``init`` prompts the user to choose between
    local-only mode (the default) and signing in. Pass ``--local`` to skip
    the prompt and run a fully local install; pass ``--ci`` for the
    non-interactive CI behaviour (writes dev placeholder credentials and
    surfaces a blocker). After ``init --local``, run ``gravel login`` to
    enable cloud features (judge, analyze, evals).
    """
    from .wizard import run_wizard
    run_wizard(open_browser=not no_browser, **kwargs)


@cli.command()
@click.option("--no-browser", is_flag=True, help="Don't auto-open the browser.")
def login(no_browser: bool) -> None:
    """Sign in and write GRAVEL_PROJECT_ID + GRAVEL_API_KEY to .env.

    Use this after ``gravel init --local`` (or to switch projects). Runs the
    same OAuth handshake as the wizard's sign-in step and appends the two
    cloud-cred env vars to ``.env.local`` (or ``.env`` if ``.env.local`` is
    absent). Short-circuits with a friendly message if both keys are
    already set.
    """
    from .login import run_login
    run_login(open_browser=not no_browser)


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
