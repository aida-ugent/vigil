"""Fixed-destination Ollama relay for extension clients using the SSH tunnel."""
from __future__ import annotations

import os
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(max_length=100_000)


class ResponseFormat(BaseModel):
    type: Literal["json_object"]


class ChatRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    messages: list[ChatMessage] = Field(min_length=1, max_length=32)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=2048, ge=1, le=16384)
    response_format: ResponseFormat | None = None
    stream: Literal[False] = False


@router.post("/v1/chat/completions")
async def chat_completions(payload: ChatRequest) -> Response:
    base = os.getenv("OLLAMA_BASE_URL")
    model = os.getenv("OLLAMA_MODEL")
    if not base or not model:
        raise HTTPException(503, "Server-side Ollama is not configured.")
    if payload.model != model:
        raise HTTPException(400, f"Use the configured model: {model}")
    # The destination is server configuration, never a client-supplied URL.
    # Construct fresh headers: do not forward the browser Origin or credentials.
    try:
        async with httpx.AsyncClient(timeout=180.0, trust_env=False) as client:
            upstream = await client.post(
                f"{base.rstrip('/')}/v1/chat/completions",
                json=payload.model_dump(exclude_none=True),
                headers={"Content-Type": "application/json"},
            )
    except httpx.TimeoutException:
        raise HTTPException(504, "Ollama timed out. Retry after the model loads.") from None
    except httpx.RequestError:
        raise HTTPException(502, "Cannot reach the server's Ollama service.") from None
    return Response(content=upstream.content, status_code=upstream.status_code, media_type="application/json")
