"""
Moralization Detection Plugin Configuration

Constants for Moral Foundations Theory (MFT) categories and protagonist roles.
Based on "The Moralization Corpus" (LREC 2026 - arXiv:2512.15248v1)
"""

from typing import Dict, List, Tuple

# =============================================================================
# Moral Foundations Theory (MFT) Categories
# =============================================================================

# Positive (Virtue) - Negative (Vice) pairs
MFT_PAIRS: List[Tuple[str, str]] = [
    ("Fürsorge", "Schaden"),          # Care / Harm
    ("Fairness", "Betrug"),            # Fairness / Cheating
    ("Loyalität", "Verrat"),           # Loyalty / Betrayal
    ("Autorität", "Untergrabung von Autorität"),  # Authority / Subversion
    ("Reinheit", "Verfall"),           # Purity / Degradation
    ("Freiheit", "Unterdrückung"),     # Liberty / Oppression
]

# All MFT categories (German)
MFT_CATEGORIES_DE: List[str] = [
    "Fürsorge",
    "Schaden",
    "Fairness",
    "Betrug",
    "Loyalität",
    "Verrat",
    "Autorität",
    "Untergrabung von Autorität",
    "Reinheit",
    "Verfall",
    "Freiheit",
    "Unterdrückung",
]

# German to English mapping
MFT_DE_TO_EN: Dict[str, str] = {
    "Fürsorge": "Care",
    "Schaden": "Harm",
    "Fairness": "Fairness",
    "Betrug": "Cheating",
    "Loyalität": "Loyalty",
    "Verrat": "Betrayal",
    "Autorität": "Authority",
    "Untergrabung von Autorität": "Subversion",
    "Reinheit": "Purity",
    "Verfall": "Degradation",
    "Freiheit": "Liberty",
    "Unterdrückung": "Oppression",
}

# All MFT categories (English)
MFT_CATEGORIES_EN: List[str] = list(MFT_DE_TO_EN.values())

# Virtue vs Vice classification
MFT_VIRTUES: List[str] = ["Fürsorge", "Fairness", "Loyalität", "Autorität", "Reinheit", "Freiheit"]
MFT_VICES: List[str] = ["Schaden", "Betrug", "Verrat", "Untergrabung von Autorität", "Verfall", "Unterdrückung"]

# =============================================================================
# Protagonist Categories
# =============================================================================

PROTAGONIST_CATEGORIES_DE: List[str] = [
    "Individuum",       # Named individuals (e.g., "Angela Merkel")
    "Menschen",         # Generic humans (e.g., "das Volk", "die Bürger")
    "Institution",      # Organizations, parties, countries (e.g., "WHO", "SPD")
    "Soziale Gruppe",   # Social groups (e.g., "die Arbeitslosen", "Studierende")
    "OTHER",            # None of the above
]

PROTAGONIST_CATEGORIES_EN: Dict[str, str] = {
    "Individuum": "Individual",
    "Menschen": "Generic Human",
    "Institution": "Institution",
    "Soziale Gruppe": "Social Group",
    "OTHER": "Other",
}

# =============================================================================
# Protagonist Roles
# =============================================================================

PROTAGONIST_ROLES_DE: List[str] = [
    "Forderer:in",      # Person making the demand (Demander)
    "Adressat:in",      # Target of the demand (Addressee)
    "Benefizient:in",   # Beneficiary of the demand
    "Malefizient:in",   # Negatively affected by the demand
    "Bezug unklar",     # Unclear relation
    "NONE",             # No relation to moralization
]

PROTAGONIST_ROLES_EN: Dict[str, str] = {
    "Forderer:in": "Demander",
    "Adressat:in": "Addressee",
    "Benefizient:in": "Beneficiary",
    "Malefizient:in": "Maleficiary",
    "Bezug unklar": "Unclear",
    "NONE": "None",
}

# =============================================================================
# Supported labels for Vigil plugin
# =============================================================================

# Labels that this plugin can detect (English names for API)
SUPPORTED_LABELS: List[str] = [
    "Moralization",
    *MFT_CATEGORIES_EN,  # Care, Harm, Fairness, etc.
]

# =============================================================================
# Reverse Mappings (English → German) for evaluation normalization
# =============================================================================

MFT_EN_TO_DE: Dict[str, str] = {v: k for k, v in MFT_DE_TO_EN.items()}

PROTAGONIST_CATEGORIES_EN_TO_DE: Dict[str, str] = {v: k for k, v in PROTAGONIST_CATEGORIES_EN.items()}

PROTAGONIST_ROLES_EN_TO_DE: Dict[str, str] = {v: k for k, v in PROTAGONIST_ROLES_EN.items()}

# Supported languages
SUPPORTED_LANGUAGES = ("de", "en")


def normalize_output_to_de(output: dict) -> dict:
    """Normalize English-keyed plugin output to the canonical German format.
    
    If the output already uses German keys it is returned unchanged.
    This allows the evaluation to treat both languages identically.
    """
    # Detect language by checking for English top-level key
    if "moralization" not in output:
        return output  # already German-keyed or unknown

    moralization = output["moralization"]
    protagonists = output.get("protagonists", [])

    moral_werte = []
    for mv in moralization.get("moral_values", []):
        moral_werte.append({
            "text": mv["text"],
            "moral_foundations_theory_kategorien": [
                MFT_EN_TO_DE.get(c, c) for c in mv.get("moral_foundations_theory_categories", [])
            ],
        })

    de_protagonisten = []
    for p in protagonists:
        de_protagonisten.append({
            "text": p["text"],
            "kategorie": PROTAGONIST_CATEGORIES_EN_TO_DE.get(p.get("category", ""), p.get("category", "")),
            "rollen": [
                PROTAGONIST_ROLES_EN_TO_DE.get(r, r) for r in p.get("roles", [])
            ],
        })

    return {
        "moralisierung": {
            "moral_werte": moral_werte,
            "forderung": moralization.get("demand", ""),
            "enthaelt_moralisierung": moralization.get("contains_moralization", False),
        },
        "protagonisten": de_protagonisten,
    }
