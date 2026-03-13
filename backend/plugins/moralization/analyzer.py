"""
Moralization Detection Plugin

LLM-based plugin for detecting moralizing speech acts using Moral Foundations Theory.
Based on "The Moralization Corpus" (LREC 2026 - arXiv:2512.15248v1)

Key Features:
- Supports German (de) and English (en) prompts
- German prompt (cot_json_0shot) is the paper's best-performing configuration
- Extracts moral values, demands, and protagonists
- Maps to MFT categories: Care/Harm, Fairness/Cheating, Loyalty/Betrayal, etc.

Target Performance (paper):
- Binary F1: 0.772 (Cohere), 0.689 (LLaMA), 0.741 (GPT-5-mini) — macro F1, cot_json_0shot
- Target threshold: F1 >= 0.75
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from models import Finding, FindingMetadata, Severity
from plugins.base import AnalyzerPlugin, PluginMetadata
from plugins.registry import PluginRegistry
from .config import (
    MFT_CATEGORIES_DE,
    MFT_CATEGORIES_EN,
    MFT_DE_TO_EN,
    MFT_EN_TO_DE,
    PROTAGONIST_CATEGORIES_EN,
    PROTAGONIST_ROLES_EN,
    SUPPORTED_LABELS,
    SUPPORTED_LANGUAGES,
    normalize_output_to_de,
)
from .output_formats import output_json_no_explain, output_json_no_explain_en

logger = logging.getLogger(__name__)

PLUGIN_ID = "moralization-llm"
PLUGIN_VERSION = "1.1.0"

_PROMPTS_DIR = Path(__file__).parent / "prompts"

# Prompt files per language
_PROMPT_FILES = {
    "de": _PROMPTS_DIR / "cot_json_0shot.yaml",
    "en": _PROMPTS_DIR / "cot_json_0shot_en.yaml",
}

# JSON schemas per language
_JSON_SCHEMAS = {
    "de": output_json_no_explain,
    "en": output_json_no_explain_en,
}


def _load_prompt(language: str = "en") -> Tuple[str, str]:
    """Load system and user prompts from YAML file.
    
    Args:
        language: Prompt language ("de" or "en")
    
    Returns:
        Tuple of (system_prompt, user_prompt_template)
    """
    prompt_file = _PROMPT_FILES.get(language)
    if prompt_file is None or not prompt_file.exists():
        raise FileNotFoundError(f"Prompt file not found for language '{language}': {prompt_file}")
    
    with prompt_file.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    
    fallback = "Du bist ein Experte der Linguistik." if language == "de" else "You are an expert linguist."
    system_prompt = data.get("system", fallback)
    user_prompt = data.get("user", "{text}")
    
    return system_prompt, user_prompt


def _parse_llm_response(raw_response: str) -> Dict[str, Any]:
    """Parse LLM JSON response, handling markdown code blocks and explanatory text.
    
    Args:
        raw_response: Raw LLM output (may contain markdown or explanation before JSON)
    
    Returns:
        Parsed JSON dictionary
    """
    cleaned = raw_response.strip()
    
    # Remove markdown code blocks
    if "```" in cleaned:
        # Find content between ``` markers
        parts = cleaned.split("```")
        for part in parts[1:]:  # Skip first part (before any ```)
            # Remove language identifier (e.g., "json")
            lines = part.split("\n", 1)
            if len(lines) > 1:
                potential_json = lines[1].strip()
            else:
                potential_json = lines[0].strip()
            
            if potential_json.startswith("{"):
                cleaned = potential_json
                break
    
    # Try direct parse first
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    
    # Try to find JSON object in the response (handles explanatory text before JSON)
    # Look for the last occurrence of a JSON object (Claude often puts JSON at the end)
    start_idx = cleaned.rfind("{")
    if start_idx >= 0:
        # Find matching closing brace
        brace_count = 0
        end_idx = start_idx
        for i, char in enumerate(cleaned[start_idx:], start_idx):
            if char == "{":
                brace_count += 1
            elif char == "}":
                brace_count -= 1
                if brace_count == 0:
                    end_idx = i + 1
                    break
        
        json_str = cleaned[start_idx:end_idx]
        try:
            return json.loads(json_str)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse extracted JSON: {e}")
    
    logger.warning(f"Failed to parse LLM response, returning default")
    return {
        "moralisierung": {
            "moral_werte": [],
            "forderung": "",
            "enthaelt_moralisierung": False,
        },
        "protagonisten": [],
    }


def _map_mft_category_to_english(de_category: str) -> str:
    """Map German MFT category to English.
    
    Args:
        de_category: German category name (e.g., "Fürsorge")
    
    Returns:
        English category name (e.g., "Care")
    """
    return MFT_DE_TO_EN.get(de_category, de_category)


def _determine_severity(moral_values: List[Dict], has_demand: bool) -> Severity:
    """Determine severity based on moralization components.
    
    Args:
        moral_values: List of extracted moral values
        has_demand: Whether an explicit demand was found
    
    Returns:
        Severity level
    """
    # More moral values and explicit demand = higher severity
    n_values = len(moral_values)
    
    if n_values >= 3 and has_demand:
        return Severity.high
    elif n_values >= 2 or has_demand:
        return Severity.medium
    else:
        return Severity.low


def _convert_to_findings(
    parsed: Any,
    original_text: str,
) -> Tuple[List[Finding], List[str]]:
    """Convert parsed LLM output to Vigil finding objects.
    
    Args:
        parsed: Parsed LLM response (dict or list)
        original_text: Original input text
    
    Returns:
        Tuple of (findings list, tips list)
    """
    findings: List[Finding] = []
    tips: List[str] = []
    
    # Handle case where LLM returns a list instead of dict
    if isinstance(parsed, list):
        if len(parsed) > 0:
            parsed = parsed[0]
        else:
            parsed = {}
    
    if not isinstance(parsed, dict):
        logger.warning(f"Unexpected parsed response type: {type(parsed)}")
        return findings, tips
    
    moralisierung = parsed.get("moralisierung", {})
    protagonisten = parsed.get("protagonisten", [])
    
    # Check if this is a moralization
    is_moralization = moralisierung.get("enthaelt_moralisierung", False)
    
    if not is_moralization:
        # No moralization detected
        tips.append(
            "No moralization detected in this text. "
            "The text may contain neutral references to moral concepts."
        )
        return findings, tips
    
    # Extract moral values
    moral_values = moralisierung.get("moral_werte", [])
    demand = moralisierung.get("forderung", "")
    explanation_de = moralisierung.get("begruendung", "")
    
    # Determine if demand is explicit
    has_explicit_demand = bool(demand) and len(demand) > 10
    
    # Determine severity
    severity = _determine_severity(moral_values, has_explicit_demand)
    
    # Create findings for each moral value
    for mv in moral_values:
        term = mv.get("text", "")[:80]  # Limit term length
        mft_categories_de = mv.get("moral_foundations_theory_kategorien", [])
        
        if not term:
            continue
        
        # Map categories to English
        mft_categories_en = [
            _map_mft_category_to_english(cat) for cat in mft_categories_de
        ]
        
        # Create label
        if mft_categories_en:
            primary_category = mft_categories_en[0]
            label = f"Moralization ({primary_category})"
        else:
            label = "Moralization"
        
        # Build explanation
        explanation_parts = [
            f"This text contains a moralizing speech act using '{term}'."
        ]
        if mft_categories_en:
            explanation_parts.append(
                f"Moral foundation(s): {', '.join(mft_categories_en)}."
            )
        if demand:
            demand_type = "explicit" if has_explicit_demand else "implicit"
            explanation_parts.append(f"Contains an {demand_type} demand.")
        
        explanation = " ".join(explanation_parts)[:400]
        
        # Build metadata
        protagonist_roles = []
        for prot in protagonisten:
            roles = prot.get("rollen", [])
            for role in roles:
                role_en = PROTAGONIST_ROLES_EN.get(role, role)
                if role_en not in ["None", "Unclear"]:
                    protagonist_roles.append(role_en)
        
        metadata = FindingMetadata(
            moral_foundation=primary_category if mft_categories_en else None,
            demand_type="explicit" if has_explicit_demand else "implicit",
            demand_text=demand[:200] if demand else None,
            protagonist_roles=list(set(protagonist_roles)) if protagonist_roles else None,
            extra={
                "mft_categories_de": mft_categories_de,
                "mft_categories_en": mft_categories_en,
                "protagonists": [
                    {
                        "text": p.get("text", ""),
                        "category": PROTAGONIST_CATEGORIES_EN.get(p.get("kategorie", "OTHER"), "Other"),
                        "roles": [PROTAGONIST_ROLES_EN.get(r, r) for r in p.get("rollen", [])],
                    }
                    for p in protagonisten
                ],
            },
        )
        
        # Try to find term position in text
        span_start = None
        span_end = None
        term_lower = term.lower()
        text_lower = original_text.lower()
        pos = text_lower.find(term_lower)
        if pos >= 0:
            span_start = pos
            span_end = pos + len(term)
        
        finding = Finding(
            term=term,
            label=label,
            severity=severity,
            explanation=explanation,
            plugin_id=PLUGIN_ID,
            category=primary_category if mft_categories_en else "Moralization",
            confidence=0.8 if is_moralization else 0.5,
            span_start=span_start,
            span_end=span_end,
            metadata=metadata,
        )
        findings.append(finding)
    
    # If no moral values but is_moralization, create a general finding
    if not findings and is_moralization:
        finding = Finding(
            term=original_text[:50] + "..." if len(original_text) > 50 else original_text,
            label="Moralization",
            severity=severity,
            explanation=(
                "This text contains a moralizing speech act that invokes moral values "
                "to justify a demand or position."
            ),
            plugin_id=PLUGIN_ID,
            category="Moralization",
            confidence=0.7,
            metadata=FindingMetadata(
                demand_type="explicit" if has_explicit_demand else "implicit",
                demand_text=demand[:200] if demand else None,
            ),
        )
        findings.append(finding)
    
    # Generate tips
    if findings:
        tips.append(
            "Moralizations use moral values to persuade. Consider whether the "
            "moral framing is appropriate for the context."
        )
        
        if has_explicit_demand:
            tips.append(
                "An explicit demand was detected. Consider if the demand is "
                "supported by facts rather than just moral appeals."
            )
        
        # Tip based on protagonist roles
        if any(f.metadata and f.metadata.protagonist_roles for f in findings):
            tips.append(
                "The text identifies specific groups as beneficiaries or targets. "
                "Consider multiple perspectives."
            )
    
    return findings, tips


@PluginRegistry.register_analyzer
class MoralizationPlugin(AnalyzerPlugin):
    """LLM-based moralization detector using Moral Foundations Theory.
    
    This plugin detects moralizing speech acts - persuasive strategies where
    moral values are invoked to justify demands or stances. It extracts:
    - Moral values mapped to MFT categories
    - Explicit and implicit demands
    - Protagonists with roles (demander, addressee, beneficiary, etc.)
    
    Based on "The Moralization Corpus" (LREC 2026).
    
    Features:
        - German (de) and English (en) prompt variants
        - German cot_json_0shot prompt is the paper's best-performing config
        - Multi-provider LLM support via LiteLLM
        - Rich metadata extraction
        - Protagonist role analysis
    
    Requirements:
        - LiteLLM with configured provider (OpenAI, Anthropic, Cohere, etc.)
        - Set appropriate API key environment variables
    
    Example:
        >>> plugin = MoralizationPlugin()
        >>> findings, tips = plugin.analyze(
        ...     "Wir müssen die Umwelt schützen, weil es um die Zukunft unserer Kinder geht."
        ... )
    """
    
    def __init__(
        self,
        llm_client: Any = None,
        model: Optional[str] = None,
        temperature: float = 0.2,
        language: str = "en",
    ) -> None:
        """Initialize the plugin.
        
        Args:
            llm_client: Optional pre-configured LLM client (for testing)
            model: LLM model to use (default: from environment)
            temperature: Sampling temperature (default: 0.2 for consistency)
            language: Prompt/output language – "en" (English) or "de" (German)
        """
        if language not in SUPPORTED_LANGUAGES:
            raise ValueError(f"Unsupported language '{language}'. Choose from {SUPPORTED_LANGUAGES}")
        self._client = llm_client  # May be None; created lazily
        self._model = model
        self._temperature = temperature
        self._language = language
        self._system_prompt: Optional[str] = None
        self._user_prompt_template: Optional[str] = None
    
    def _get_client(self):
        """Get or create the LLM client (lazy initialization)."""
        if self._client is None:
            from llm.client import create_client
            self._client = create_client(
                model=self._model,
                temperature=self._temperature,
            )
        return self._client
    
    @property
    def language(self) -> str:
        """Active prompt language."""
        return self._language

    def _load_prompts(self) -> Tuple[str, str]:
        """Load prompts (cached per language)."""
        if self._system_prompt is None or self._user_prompt_template is None:
            self._system_prompt, self._user_prompt_template = _load_prompt(self._language)
        return self._system_prompt, self._user_prompt_template

    def _json_schema(self) -> dict:
        """Return the JSON schema that matches the current language."""
        return _JSON_SCHEMAS[self._language]
    
    @classmethod
    def get_metadata(cls) -> PluginMetadata:
        """Return plugin metadata."""
        return PluginMetadata(
            id=PLUGIN_ID,
            name="Moralization Detector (LLM)",
            version=PLUGIN_VERSION,
            description=(
                "Detects moralizing speech acts using Moral Foundations Theory. "
                "Extracts moral values, demands, and protagonist roles from text. "
                "Based on arxiv:2512.15248v1"
            ),
            author="Vigil Team",
            supported_labels=SUPPORTED_LABELS,
            requires_llm=True,
            config_schema={
                "type": "object",
                "properties": {
                    "model": {
                        "type": "string",
                        "description": "LLM model to use (e.g., gpt-4o, claude-3-haiku)",
                    },
                    "temperature": {
                        "type": "number",
                        "minimum": 0.0,
                        "maximum": 2.0,
                        "default": 0.2,
                        "description": "Sampling temperature",
                    },
                    "language": {
                        "type": "string",
                        "enum": list(SUPPORTED_LANGUAGES),
                        "default": "en",
                        "description": "Prompt and output language (en=English, de=German)",
                    },
                },
            },
        )
    
    def analyze(
        self,
        text: str,
        sensitivity: int = 2,
        config: Optional[Dict[str, Any]] = None,
    ) -> Tuple[List[Finding], List[str]]:
        """Analyze text for moralizing speech acts.
        
        Args:
            text: Input text to analyze (German or other language)
            sensitivity: Detection sensitivity (1=strict, 2=medium, 3=lenient)
            config: Optional configuration (model, temperature)
        
        Returns:
            Tuple of (findings list, tips list)
        
        Raises:
            RuntimeError: If LLM client is not configured
        """
        config = config or {}
        
        # Get client
        client = self._get_client()
        
        # Load prompts
        system_prompt, user_prompt_template = self._load_prompts()
        
        # Prepare user prompt with text
        user_prompt = user_prompt_template.replace("{text}", text[:8000])
        
        # Call LLM
        try:
            # Log request
            logger.info("=== Moralization LLM Request ===")
            logger.info("System prompt length: %d chars", len(system_prompt))
            logger.info("User prompt (first 500 chars): %s", user_prompt[:500])
            
            raw_response = client.complete_json(
                system=system_prompt,
                user=user_prompt,
                json_schema=self._json_schema(),
            )
            
            # Log response
            logger.info("=== Moralization LLM Response ===")
            logger.info("Raw response: %s", raw_response)
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            raise RuntimeError(f"Moralization analysis failed: {e}")
        
        # Parse response
        parsed = _parse_llm_response(raw_response)
        logger.info("Parsed response: %s", parsed)

        # Normalize English output to German keys for _convert_to_findings
        if self._language == "en":
            parsed = normalize_output_to_de(parsed)
        
        # Convert to findings
        findings, tips = _convert_to_findings(parsed, text)
        
        # Apply sensitivity filter
        if sensitivity == 1:
            # Strict: only high severity
            findings = [f for f in findings if f.severity == Severity.high]
        elif sensitivity == 2:
            # Medium: medium and high severity
            findings = [f for f in findings if f.severity in (Severity.medium, Severity.high)]
        # sensitivity == 3: all findings
        
        return findings, tips
    
    def analyze_raw(
        self,
        text: str,
        config: Optional[Dict[str, Any]] = None,
        normalize_to_de: bool = False,
    ) -> Dict[str, Any]:
        """Analyze text and return raw LLM output.
        
        This method is useful for evaluation and debugging.
        
        Args:
            text: Input text to analyze
            config: Optional configuration
            normalize_to_de: If True and language is "en", convert the
                output to the canonical German-keyed format so the evaluation
                pipeline can compare against German gold annotations.
        
        Returns:
            Parsed LLM response (language-native keys, or German if normalized)
        """
        config = config or {}
        
        # Get client
        client = self._get_client()
        
        # Load prompts
        system_prompt, user_prompt_template = self._load_prompts()
        
        # Prepare user prompt
        user_prompt = user_prompt_template.replace("{text}", text[:8000])
        
        # Call LLM
        raw_response = client.complete_json(
            system=system_prompt,
            user=user_prompt,
            json_schema=self._json_schema(),
        )
        
        parsed = _parse_llm_response(raw_response)

        if normalize_to_de and self._language == "en":
            parsed = normalize_output_to_de(parsed)

        return parsed
    
    def validate_config(self, config: Dict[str, Any]) -> bool:
        """Validate plugin configuration."""
        if "temperature" in config:
            temp = config["temperature"]
            if not isinstance(temp, (int, float)) or temp < 0 or temp > 2:
                return False
        
        return True
    
    def get_active_model(self) -> Optional[str]:
        """Get the active LLM model for this plugin.
        
        Returns:
            The model identifier string being used by this plugin
        """
        client = self._get_client()
        return client.model


# Convenience function for direct usage
def analyze_moralization(
    text: str,
    model: Optional[str] = None,
    sensitivity: int = 2,
    language: str = "en",
) -> Tuple[List[Finding], List[str]]:
    """Analyze text for moralizations.
    
    Convenience function for quick analysis without creating a plugin instance.
    
    Args:
        text: Input text to analyze
        model: Optional LLM model override
        sensitivity: Detection sensitivity (1-3)
        language: Prompt/output language ("en" or "de")
    
    Returns:
        Tuple of (findings, tips)
    
    Example:
        >>> findings, tips = analyze_moralization(
        ...     "We must protect the environment for our children's future.",
        ...     language="en",
        ... )
    """
    plugin = MoralizationPlugin(model=model, language=language)
    return plugin.analyze(text, sensitivity=sensitivity)
