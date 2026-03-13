from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from config import Settings
from models import (
    AnalyzeResponse,
    Finding,
    PluginInfo,
    PluginsResponse,
    ReformulateRequest,
    ReformulationResult,
)
from plugins.registry import PluginRegistry

logger = logging.getLogger("vigil")


class PrivateNetworkAccessMiddleware:
    """Handle Chrome Private Network Access preflight headers."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_pna(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"access-control-allow-private-network", b"true"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_pna)


def create_app(settings: Settings | None = None) -> FastAPI:
    from config import get_settings

    settings = settings or get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))

    # Trigger plugin registration
    import plugins  # noqa: F401

    app = FastAPI(title=settings.app_name)
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allow_origins,
        allow_credentials=settings.allow_credentials,
        allow_methods=settings.allow_methods,
        allow_headers=settings.allow_headers,
    )
    app.add_middleware(PrivateNetworkAccessMiddleware)

    # ── Endpoints ──

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/plugins", response_model=PluginsResponse)
    async def list_plugins(request: Request):
        cfg: Settings = request.app.state.settings
        analyzers: list[PluginInfo] = []

        for plugin_id in PluginRegistry.available_analyzer_ids():
            meta = PluginRegistry.get_analyzer_metadata(plugin_id)
            if meta is None:
                continue

            active_model = None
            can_reformulate = False
            if meta.requires_llm:
                try:
                    plugin = PluginRegistry.get_analyzer(plugin_id)
                    if plugin:
                        active_model = plugin.get_active_model()
                        can_reformulate = plugin.can_reformulate
                except Exception:
                    active_model = "(not configured)"

            analyzers.append(
                PluginInfo(
                    id=meta.id,
                    name=meta.name,
                    version=meta.version,
                    description=meta.description,
                    requires_llm=meta.requires_llm,
                    can_reformulate=can_reformulate,
                    supported_labels=meta.supported_labels,
                    active_model=active_model,
                )
            )

        return PluginsResponse(analyzers=analyzers, default_analyzer=cfg.default_plugin)

    @app.post("/analyze", response_model=AnalyzeResponse)
    async def analyze(req: Request):
        cfg: Settings = req.app.state.settings
        try:
            payload = await req.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")

        text = payload.get("text")
        if not text or not isinstance(text, str) or not text.strip():
            raise HTTPException(status_code=422, detail="Missing or empty 'text' field.")

        sensitivity = int(payload.get("sensitivity", 2))
        plugin_ids: list[str] = payload.get("plugins") or [cfg.default_plugin]

        all_findings: list[Finding] = []
        all_tips: list[str] = []

        for pid in plugin_ids:
            plugin = PluginRegistry.get_analyzer(pid)
            if plugin is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Plugin '{pid}' not found. Available: {PluginRegistry.available_analyzer_ids()}",
                )
            try:
                findings, tips = plugin.analyze(text=text, sensitivity=sensitivity)
                all_findings.extend(findings)
                all_tips.extend(tips)
            except RuntimeError as e:
                raise HTTPException(status_code=503, detail=f"Plugin '{pid}' unavailable: {e}")
            except Exception as e:
                logger.error("Plugin '%s' error: %s", pid, e)
                raise HTTPException(status_code=500, detail=f"Plugin '{pid}' error: {e}")

        unique_tips = list(dict.fromkeys(all_tips))
        return AnalyzeResponse(findings=all_findings, tips=unique_tips)

    @app.post("/reformulate", response_model=ReformulationResult)
    async def reformulate(req: Request, request: ReformulateRequest):
        plugin = PluginRegistry.get_analyzer(request.plugin_id)
        if plugin is None:
            raise HTTPException(status_code=400, detail=f"Plugin '{request.plugin_id}' not found.")
        if not plugin.can_reformulate:
            raise HTTPException(status_code=400, detail=f"Plugin '{request.plugin_id}' does not support reformulation.")

        try:
            result = plugin.reformulate(request.text, request.findings)
            if result is None:
                raise HTTPException(status_code=500, detail="Reformulation returned no result.")
            return result
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=f"Reformulation unavailable: {e}")
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Reformulation error: %s", e)
            raise HTTPException(status_code=500, detail=f"Reformulation failed: {e}")

    return app
