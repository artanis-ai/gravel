"""Capture real Vertex AI responses for the dashboard fixture suite.

Runs `Client(vertexai=True, ...)` against a real GCP project and dumps the
pydantic response via `model_dump()`. The shape that lands in the JSON files
is exactly what our tracer's `_safe_dump` produces — so the fixtures pin the
contract we actually have to render, not a guess at it.

Sanitises any project IDs / response IDs found in the dumped payload before
writing (small set of substitutions; pure text). Re-run with
`GRAVEL_VERTEX_PROJECT` / `GRAVEL_VERTEX_LOCATION` env to point at a
different project; defaults to my personal sandbox.

Usage:
    source /tmp/vertex-capture-venv/bin/activate
    python tools/capture-vertex/capture.py
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types

PROJECT = os.environ.get("GRAVEL_VERTEX_PROJECT", "yousef-amar")
LOCATION = os.environ.get("GRAVEL_VERTEX_LOCATION", "us-central1")
MODEL = os.environ.get("GRAVEL_VERTEX_MODEL", "gemini-2.5-flash")

FIXTURES = Path(__file__).resolve().parents[2] / "packages/dashboard/tests/fixtures/sources"


def sanitise(payload: Any) -> Any:
    text = json.dumps(payload)
    text = re.sub(r"projects/\d+/", "projects/REDACTED/", text)
    text = text.replace(PROJECT, "vertex-sandbox")
    return json.loads(text)


def write_fixture(filename: str, fixture: dict[str, Any]) -> None:
    target = FIXTURES / filename
    target.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"wrote {target.relative_to(FIXTURES.parent.parent.parent.parent)}")


def capture_plain(client: genai.Client) -> None:
    prompt = "What's the capital of Japan? One word."
    response = client.models.generate_content(model=MODEL, contents=prompt)
    fixture = {
        "name": "gemini.models.generate_content",
        "description": (
            "Vertex AI: plain turn captured from a real `Client(vertexai=True).models.generate_content` "
            f"call against `{MODEL}` via `{LOCATION}`. Proves the existing GeminiChat renderer handles "
            "Vertex-routed responses without any shape divergence. `metadata.routing` flag set by tracer."
        ),
        "source": "gemini-chat",
        "isFetch": False,
        "status": "completed",
        "input": sanitise({"model": MODEL, "contents": prompt}),
        "output": sanitise(response.model_dump(mode="json")),
        "metadata": {"routing": "vertex"},
    }
    write_fixture("gemini-chat-via-vertex.json", fixture)


def capture_stream(client: genai.Client) -> None:
    prompt = (
        "Write three short paragraphs about Tokyo, separated by blank lines. "
        "Each paragraph should be a different topic (history, food, transit)."
    )
    stream = client.models.generate_content_stream(model=MODEL, contents=prompt)
    chunks = [chunk.model_dump(mode="json") for chunk in stream]
    # The tracer's _StreamTee assembles output as {"chunks": [...]} on flush.
    fixture = {
        "name": "gemini.models.generate_content_stream",
        "description": (
            f"Vertex AI: streaming turn captured from `Client(vertexai=True).models.generate_content_stream` "
            f"against `{MODEL}` via `{LOCATION}`. Output is the tracer's tee'd `chunks[]` list, "
            "matching what _StreamTee.flush persists. Each chunk is a partial GenerateContentResponse."
        ),
        "source": "gemini-chat",
        "isFetch": False,
        "status": "completed",
        "input": sanitise({"model": MODEL, "contents": prompt}),
        "output": sanitise({"chunks": chunks}),
        "metadata": {
            "routing": "vertex",
            "states": [{"key": "stream", "data": {"chunk_count": len(chunks)}}],
        },
    }
    write_fixture("gemini-chat-via-vertex-stream.json", fixture)


def capture_tools(client: genai.Client) -> None:
    weather_tool = types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="get_current_weather",
                description="Return current weather for a city.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "city": types.Schema(type="STRING", description="City name, e.g. 'Tokyo'"),
                    },
                    required=["city"],
                ),
            )
        ]
    )
    response = client.models.generate_content(
        model=MODEL,
        contents="What's the weather in Tokyo?",
        config=types.GenerateContentConfig(tools=[weather_tool]),
    )
    fixture = {
        "name": "gemini.models.generate_content",
        "description": (
            f"Vertex AI: function-calling turn captured from a real call against `{MODEL}` via `{LOCATION}` "
            "with a single FunctionDeclaration in `config.tools`. Output candidates include a "
            "`function_call` part the renderer surfaces via the existing tool-call block. Pins the Vertex "
            "function_call shape (snake_case `args`, no JSON-encoded strings)."
        ),
        "source": "gemini-chat",
        "isFetch": False,
        "status": "completed",
        "input": sanitise(
            {
                "model": MODEL,
                "contents": "What's the weather in Tokyo?",
                "config": {
                    "tools": [
                        {
                            "function_declarations": [
                                {
                                    "name": "get_current_weather",
                                    "description": "Return current weather for a city.",
                                    "parameters": {
                                        "type": "OBJECT",
                                        "properties": {"city": {"type": "STRING"}},
                                        "required": ["city"],
                                    },
                                }
                            ]
                        }
                    ]
                },
            }
        ),
        "output": sanitise(response.model_dump(mode="json")),
        "metadata": {"routing": "vertex"},
    }
    write_fixture("gemini-chat-via-vertex-tools.json", fixture)


def main() -> None:
    print(f"Capturing against project={PROJECT}, location={LOCATION}, model={MODEL}")
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    capture_plain(client)
    capture_stream(client)
    capture_tools(client)
    print("done.")


if __name__ == "__main__":
    main()
