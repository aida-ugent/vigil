from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Severity(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class FindingMetadata(BaseModel):
    moral_foundation: str | None = None
    demand_type: str | None = None
    demand_text: str | None = None
    protagonist_roles: list[str] | None = None
    extra: dict[str, Any] | None = None


class Finding(BaseModel):
    term: str
    label: str
    severity: Severity = Severity.medium
    explanation: str
    plugin_id: str = "unknown"
    category: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    span_start: int | None = Field(default=None, ge=0)
    span_end: int | None = Field(default=None, ge=0)
    metadata: FindingMetadata | None = None


class AnalyzeRequest(BaseModel):
    text: str
    sensitivity: int = 2
    plugins: list[str] | None = None


class AnalyzeResponse(BaseModel):
    findings: list[Finding]
    tips: list[str]


class ReformulateRequest(BaseModel):
    text: str
    findings: list[Finding]
    plugin_id: str


class ReformulationResult(BaseModel):
    original_text: str
    reformulated_text: str
    changes: list[str]


class PluginInfo(BaseModel):
    id: str
    name: str
    version: str
    description: str
    requires_llm: bool = False
    can_reformulate: bool = False
    supported_labels: list[str] = Field(default_factory=list)
    active_model: str | None = None


class PluginsResponse(BaseModel):
    analyzers: list[PluginInfo]
    default_analyzer: str
