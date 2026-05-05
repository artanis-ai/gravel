"""FastAPI + Gravel example."""
import os

# Boots Gravel's tracing on import (auto-patches OpenAI etc. when implemented).
import artanis_gravel.auto  # noqa: F401

from fastapi import FastAPI
from openai import OpenAI

from artanis_gravel.fastapi import create_gravel_router
from gravel_config import config

app = FastAPI(title="Gravel FastAPI example")

# Mount Gravel's dashboard
app.include_router(create_gravel_router(config=config), prefix=config.mount_path)


@app.get("/")
async def root():
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    reply = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a brief, friendly assistant."},
            {"role": "user", "content": "Say hi to a Gravel user."},
        ],
    )
    return {
        "message": reply.choices[0].message.content,
        "dashboard": f"{config.mount_path}/",
    }
