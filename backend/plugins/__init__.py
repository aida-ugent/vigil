from .base import AnalyzerPlugin, PluginMetadata
from .registry import PluginRegistry

# Import plugins to trigger registration
from . import moralization  # noqa: F401

__all__ = ["AnalyzerPlugin", "PluginMetadata", "PluginRegistry"]
