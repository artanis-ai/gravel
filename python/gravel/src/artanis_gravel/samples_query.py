"""Read-side queries for /api/samples* — Python port of
packages/sdk-ts/src/samples/query.ts. Output shape mirrors the TS
version exactly so the dashboard SPA renders against either backend.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import (
    Engine,
    and_,
    desc,
    func,
    or_,
    select,
)

from .schema import gravel_feedback, gravel_samples

DEFAULT_PAGE_SIZE = 20


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _coerce_metadata(meta: Any) -> dict:
    if meta is None:
        return {}
    if isinstance(meta, dict):
        return meta
    if isinstance(meta, str):
        try:
            parsed = json.loads(meta)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _tokens_from(meta: Any) -> tuple[int | None, int | None]:
    m = _coerce_metadata(meta)
    ti = m.get("tokens_input")
    to = m.get("tokens_output")
    return (ti if isinstance(ti, int) else None, to if isinstance(to, int) else None)


def _roll_up_feedback(scores: list[str | None]) -> str | None:
    valid = {s for s in scores if s in {"positive", "negative", "neutral"}}
    if not valid:
        return None
    if "positive" in valid and "negative" in valid:
        return "mixed"
    if "positive" in valid:
        return "positive"
    if "negative" in valid:
        return "negative"
    return None


def list_samples(
    engine: Engine,
    *,
    env: str | None = None,
    model: str | None = None,
    status: str | None = None,
    q: str | None = None,
    from_: str | None = None,
    to: str | None = None,
    page: int = 1,
    page_size: int | None = None,
) -> dict:
    page = max(1, page)
    pz = max(1, min(page_size or DEFAULT_PAGE_SIZE, 100))
    offset = (page - 1) * pz

    conds = []
    if env:
        conds.append(gravel_samples.c.environment == env)
    if model:
        conds.append(gravel_samples.c.model == model)
    if status:
        conds.append(gravel_samples.c.status == status)
    if q:
        like = f"%{q}%"
        conds.append(
            or_(
                gravel_samples.c.name.like(like),
                gravel_samples.c.model.like(like),
            )
        )
    if from_:
        conds.append(gravel_samples.c.timestamp >= from_)
    if to:
        conds.append(gravel_samples.c.timestamp <= to)

    where_clause = and_(*conds) if conds else None

    with engine.connect() as conn:
        # Total count
        count_q = select(func.count()).select_from(gravel_samples)
        if where_clause is not None:
            count_q = count_q.where(where_clause)
        total = conn.execute(count_q).scalar() or 0

        # Page rows
        rows_q = select(gravel_samples).order_by(desc(gravel_samples.c.timestamp))
        if where_clause is not None:
            rows_q = rows_q.where(where_clause)
        rows_q = rows_q.limit(pz).offset(offset)
        rows = list(conn.execute(rows_q).mappings())

        # Feedback rollup for the page
        ids = [r["id"] for r in rows]
        feedback_by_sample: dict[str, list[str | None]] = {sid: [] for sid in ids}
        if ids:
            fb_rows = conn.execute(
                select(gravel_feedback.c.sample_id, gravel_feedback.c.score).where(
                    gravel_feedback.c.sample_id.in_(ids)
                )
            ).all()
            for sample_id, score in fb_rows:
                feedback_by_sample.setdefault(sample_id, []).append(score)

    samples = []
    for r in rows:
        ti, to_ = _tokens_from(r["metadata"])
        meta = _coerce_metadata(r["metadata"])
        scores = feedback_by_sample.get(r["id"], [])
        samples.append(
            {
                "id": r["id"],
                "name": r["name"],
                "model": r["model"],
                "environment": r["environment"],
                "status": r["status"],
                "group_id": r["group_id"],
                "started_at": _iso(r["started_at"]),
                "completed_at": _iso(r["completed_at"]),
                "duration_ms": r["duration_ms"],
                "tokens_in": ti,
                "tokens_out": to_,
                "feedback_count": len(scores),
                "feedback_score": _roll_up_feedback(scores),
                "metadata": meta,
            }
        )

    return {"samples": samples, "total": total, "page": page, "page_size": pz}


def _summarize_row(row: Any, scores: list[Any]) -> dict:
    """Build a SampleListItem-shaped object from a row + its feedback
    scores. Matches `packages/sdk-ts/src/samples/query.ts` summary.

    Centralised so list_samples and get_sample_detail emit identical
    summary fields. Pre-v0.5.24 the detail handler had its own ad-hoc
    shape that diverged from the list shape, which is what crashed
    `SampleReviewDialog`'s `const { sample } = data` destructure."""
    ti, to_ = _tokens_from(row["metadata"])
    return {
        "id": row["id"],
        "name": row["name"],
        "model": row["model"],
        "environment": row["environment"],
        "status": row["status"],
        "group_id": row["group_id"],
        "started_at": _iso(row["started_at"]),
        "completed_at": _iso(row["completed_at"]),
        "duration_ms": row["duration_ms"],
        "tokens_in": ti,
        "tokens_out": to_,
        "feedback_count": len(scores),
        "feedback_score": _roll_up_feedback(scores),
    }


def get_sample_detail(engine: Engine, sample_id: str) -> dict | None:
    """Returns the SampleDetailResponse shape exactly:

        { "sample": SampleListItem & { commit_sha, input, output, metadata },
          "feedback": [FeedbackItem...],
          "related": [SampleListItem...] }

    Mirrors `packages/sdk-ts/src/samples/query.ts:getSampleDetail`. The
    dashboard's `SampleReviewDialog` destructures `const { sample,
    feedback } = data` and reads `sample.input`; any drift here is a
    customer-visible crash.
    """
    with engine.connect() as conn:
        row = conn.execute(
            select(gravel_samples).where(gravel_samples.c.id == sample_id)
        ).mappings().first()
        if not row:
            return None
        # Same sample's feedback for the rollup + the FeedbackItem[] return.
        fb_rows = conn.execute(
            select(gravel_feedback).where(gravel_feedback.c.sample_id == sample_id).order_by(
                desc(gravel_feedback.c.created_at)
            )
        ).mappings().all()
        # Related: every other sample sharing this one's group_id. The
        # dashboard's trace pane lists them so the reviewer can hop
        # between steps of a multi-step trace.
        related_rows: list[Any] = []
        gid = row["group_id"]
        if gid:
            related_rows = list(
                conn.execute(
                    select(gravel_samples)
                    .where(
                        and_(
                            gravel_samples.c.group_id == gid,
                            gravel_samples.c.id != sample_id,
                        )
                    )
                    .order_by(desc(gravel_samples.c.timestamp))
                ).mappings()
            )
        # Feedback rollup for the related samples (one query, IN clause).
        related_scores: dict[str, list[Any]] = {r["id"]: [] for r in related_rows}
        if related_scores:
            for sid, score in conn.execute(
                select(gravel_feedback.c.sample_id, gravel_feedback.c.score).where(
                    gravel_feedback.c.sample_id.in_(list(related_scores))
                )
            ).all():
                related_scores.setdefault(sid, []).append(score)

    self_scores = [f["score"] for f in fb_rows]
    sample_summary = _summarize_row(row, self_scores)
    sample_full = {
        **sample_summary,
        "commit_sha": row["commit_sha"],
        "input": row["input"],
        "output": row["output"],
        "metadata": _coerce_metadata(row["metadata"]),
    }
    feedback = [
        {
            "id": f["id"],
            "sample_id": f["sample_id"],
            "comment": f["comment"],
            "correction": f["correction"],
            "score": f["score"],
            "reporter_user_id": f["reporter_user_id"],
            "created_at": _iso(f["created_at"]),
        }
        for f in fb_rows
    ]
    related = [_summarize_row(r, related_scores.get(r["id"], [])) for r in related_rows]
    return {"sample": sample_full, "feedback": feedback, "related": related}


def record_sample_feedback(
    engine: Engine,
    *,
    sample_id: str,
    score: str | None,
    comment: str | None,
    correction: str | None,
    reporter_user_id: str | None,
) -> dict:
    import datetime
    import uuid

    fid = str(uuid.uuid4())
    now = datetime.datetime.now(datetime.timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            gravel_feedback.insert().values(
                id=fid,
                sample_id=sample_id,
                score=score,
                comment=comment,
                correction=correction,
                source="ui",
                reporter_user_id=reporter_user_id,
                timestamp=now,
            )
        )
    return {"id": fid}


def gravel_tables_exist(engine: Engine | None) -> bool:
    """True when both gravel_* tables exist on the engine.

    `engine=None` is the prompts-only install case (the host hasn't
    configured a DATABASE_URL). Treat it as "no tables" so the dashboard
    routes that depend on samples/feedback degrade gracefully to empty
    pages rather than throwing.
    """
    if engine is None:
        return False
    from sqlalchemy import inspect

    insp = inspect(engine)
    return insp.has_table("gravel_samples") and insp.has_table("gravel_feedback")
