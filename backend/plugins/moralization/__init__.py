"""
Moralization Detection Plugin

Detects moralizing speech acts using Moral Foundations Theory (MFT) framework.
Based on "The Moralization Corpus" (LREC 2026 - arXiv:2512.15248v1)

Key Features:
- Uses German cot_json_0shot prompt (best-performing configuration)
- Extracts moral values, demands, and protagonists
- Maps to MFT categories: Care/Harm, Fairness/Cheating, Loyalty/Betrayal, etc.

Usage:
    >>> from biascheck_api.plugins.moralization import MoralizationPlugin
    >>> plugin = MoralizationPlugin()
    >>> findings, tips = plugin.analyze("Text to analyze...")

Or use the convenience function:
    >>> from biascheck_api.plugins.moralization import analyze_moralization
    >>> findings, tips = analyze_moralization("Text to analyze...")
"""

from .config import (
    MFT_CATEGORIES_DE,
    MFT_CATEGORIES_EN,
    MFT_DE_TO_EN,
    MFT_PAIRS,
    MFT_VICES,
    MFT_VIRTUES,
    PROTAGONIST_CATEGORIES_DE,
    PROTAGONIST_CATEGORIES_EN,
    PROTAGONIST_ROLES_DE,
    PROTAGONIST_ROLES_EN,
    SUPPORTED_LABELS,
)

from .analyzer import (
    MoralizationPlugin,
    analyze_moralization,
    PLUGIN_ID,
    PLUGIN_VERSION,
)

from .output_formats import (
    Moralwert,
    Moralisierung,
    MoralisierungOutput,
    Protagonist,
    output_json_explain,
    output_json_no_explain,
)

__all__ = [
    # Plugin
    "MoralizationPlugin",
    "analyze_moralization",
    "PLUGIN_ID",
    "PLUGIN_VERSION",
    # MFT Categories
    "MFT_CATEGORIES_DE",
    "MFT_CATEGORIES_EN",
    "MFT_DE_TO_EN",
    "MFT_PAIRS",
    "MFT_VICES",
    "MFT_VIRTUES",
    # Protagonist Categories
    "PROTAGONIST_CATEGORIES_DE",
    "PROTAGONIST_CATEGORIES_EN",
    "PROTAGONIST_ROLES_DE",
    "PROTAGONIST_ROLES_EN",
    # Labels
    "SUPPORTED_LABELS",
    # Output Formats
    "Moralwert",
    "Moralisierung",
    "MoralisierungOutput",
    "Protagonist",
    "output_json_explain",
    "output_json_no_explain",
]
