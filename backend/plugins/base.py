"""Plugin base classes with unified analyze + optional reformulate interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from models import Finding, ReformulationResult


class PluginMetadata(BaseModel):
    id: str = Field(..., min_length=1, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    name: str = Field(..., min_length=1)
    version: str = Field(..., pattern=r"^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$")
    description: str
    supported_labels: list[str] = Field(default_factory=list)
    requires_llm: bool = False

    model_config = ConfigDict(frozen=True)


class AnalyzerPlugin(ABC):
    """Base class for analyzer plugins.

    Subclasses must implement ``get_metadata`` and ``analyze``.
    Override ``reformulate`` to add reformulation support.
    """

    @classmethod
    @abstractmethod
    def get_metadata(cls) -> PluginMetadata: ...

    @abstractmethod
    def analyze(
        self,
        text: str,
        sensitivity: int = 2,
        config: dict[str, Any] | None = None,
    ) -> tuple[list["Finding"], list[str]]: ...

    def reformulate(
        self,
        text: str,
        findings: list["Finding"],
        config: dict[str, Any] | None = None,
    ) -> "ReformulationResult | None":
        """Override to support reformulation. Returns None by default."""
        return None

    @property
    def can_reformulate(self) -> bool:
        return type(self).reformulate is not AnalyzerPlugin.reformulate

    def get_plugin_id(self) -> str:
        return self.get_metadata().id

    def get_active_model(self) -> str | None:
        return None
