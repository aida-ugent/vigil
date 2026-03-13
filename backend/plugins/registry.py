"""Plugin registry with decorator-based registration."""

from __future__ import annotations

import logging
from typing import Optional

from .base import AnalyzerPlugin, PluginMetadata

logger = logging.getLogger("vigil.plugins")

type AnalyzerPluginClass = type[AnalyzerPlugin]


class PluginRegistry:
    _analyzers: dict[str, AnalyzerPluginClass] = {}

    @classmethod
    def register_analyzer(cls, plugin_class: AnalyzerPluginClass) -> AnalyzerPluginClass:
        if not isinstance(plugin_class, type) or not issubclass(plugin_class, AnalyzerPlugin):
            raise TypeError(f"Expected AnalyzerPlugin subclass, got {type(plugin_class)}")

        metadata = plugin_class.get_metadata()

        if metadata.id in cls._analyzers:
            logger.warning("Replacing analyzer '%s' with %s", metadata.id, plugin_class.__name__)

        cls._analyzers[metadata.id] = plugin_class
        logger.info("Registered analyzer: %s v%s", metadata.id, metadata.version)
        return plugin_class

    @classmethod
    def get_analyzer(cls, plugin_id: str) -> Optional[AnalyzerPlugin]:
        plugin_class = cls._analyzers.get(plugin_id)
        return plugin_class() if plugin_class else None

    @classmethod
    def get_analyzer_metadata(cls, plugin_id: str) -> Optional[PluginMetadata]:
        plugin_class = cls._analyzers.get(plugin_id)
        return plugin_class.get_metadata() if plugin_class else None

    @classmethod
    def list_analyzers(cls) -> list[PluginMetadata]:
        return [p.get_metadata() for p in cls._analyzers.values()]

    @classmethod
    def available_analyzer_ids(cls) -> list[str]:
        return list(cls._analyzers.keys())

    @classmethod
    def clear(cls) -> None:
        cls._analyzers.clear()
