"""
Shared LLM Client using LiteLLM

Provides a unified interface for multiple LLM providers.

Environment Variables:
    LLM_MODEL: Default model to use (default: gpt-4o)
    OPENAI_API_KEY: OpenAI API key
    OPENAI_MODEL: OpenAI model override
    ANTHROPIC_API_KEY: Anthropic API key
    ANTHROPIC_MODEL: Anthropic model override
    COHERE_API_KEY: Cohere API key
    MISTRAL_API_KEY: Mistral API key
    GOOGLE_API_KEY: Google AI API key
    GOOGLE_MODEL: Google/Gemini model override
    OLLAMA_BASE_URL: Ollama base URL for local models
    OLLAMA_MODEL: Ollama model override
    AZURE_API_KEY, AZURE_API_BASE, AZURE_API_VERSION: Azure OpenAI config

Model naming conventions:
    - OpenAI: gpt-4o, gpt-4o-mini, gpt-3.5-turbo
    - Anthropic: claude-3-5-sonnet-20241022, claude-3-haiku-20240307
    - Cohere: command-a-03-2025, command-r-plus
    - Mistral: mistral/mistral-small-latest, mistral/mistral-large-latest
    - Google: gemini/gemini-pro, gemini/gemini-3-flash-preview
    - Ollama: ollama/llama3.1, ollama/mistral
    - Azure: azure/gpt-4o, azure/gpt-35-turbo
"""

from __future__ import annotations

import json
import os
import logging
from typing import Any, Dict, List, Optional, Union

from dotenv import load_dotenv
from pathlib import Path

_env = Path(__file__).resolve().parent.parent / ".env"
if _env.exists():
    load_dotenv(dotenv_path=_env, override=False)

logger = logging.getLogger(__name__)


class LiteLLMClient:
    """Unified LLM client using LiteLLM.
    
    This client wraps LiteLLM to provide a consistent interface across
    100+ LLM providers including OpenAI, Anthropic, Cohere, Mistral, etc.
    
    Example:
        >>> client = LiteLLMClient(model="gpt-4o")
        >>> response = client.complete_json(
        ...     system="You are a helpful assistant.",
        ...     user="What is 2+2?"
        ... )
    """
    
    def __init__(
        self,
        model: str = "gpt-4o",
        temperature: float = 0.2,
        timeout: int = 120,
        max_retries: int = 2,
    ):
        """Initialize the LiteLLM client.
        
        Args:
            model: Model identifier (e.g., "gpt-4o", "claude-3-haiku", "ollama/llama3.1")
            temperature: Sampling temperature (0.0-2.0)
            timeout: Request timeout in seconds
            max_retries: Number of retries on failure
        """
        self.model = model
        self.temperature = temperature
        self.timeout = timeout
        self.max_retries = max_retries
        
        # Lazy import litellm to avoid import errors if not installed
        self._litellm = None
        
    def _get_litellm(self):
        """Lazy import of litellm."""
        if self._litellm is None:
            try:
                import litellm
                # Configure LiteLLM settings - MUST be set before any completion calls
                litellm.drop_params = True  # Drop unsupported params gracefully
                litellm.set_verbose = os.getenv("LLM_VERBOSE", "").lower() == "true"
                self._litellm = litellm
            except ImportError:
                raise ImportError(
                    "litellm is required for LLM support. "
                    "Install with: pip install litellm"
                )
        return self._litellm
    
    def _requires_temperature_one(self) -> bool:
        """Check if the model requires temperature=1.0.
        
        Some models have restrictions on temperature:
        - GPT-5 models: only support temperature=1
        - Gemini 3 models: temperature < 1.0 causes infinite loops and degraded performance
        """
        model_lower = self.model.lower()
        # GPT-5 models
        if "gpt-5" in model_lower:
            return True
        # Gemini 3 models (e.g., gemini-3-flash-preview, gemini-3-pro)
        if "gemini-3" in model_lower or "gemini/gemini-3" in model_lower:
            return True
        return False
    
    def _get_effective_temperature(self) -> float:
        """Get the effective temperature, handling model restrictions.
        
        GPT-5 and Gemini 3 models require temperature=1, so we override for those.
        """
        if self._requires_temperature_one():
            if self.temperature != 1.0:
                logger.info(f"Model {self.model} requires temperature=1.0, overriding from {self.temperature}")
            return 1.0
        return self.temperature
    
    def complete(
        self,
        messages: List[Dict[str, str]],
        response_format: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> str:
        """Send a completion request.
        
        Args:
            messages: List of message dicts with 'role' and 'content'
            response_format: Optional response format (e.g., {"type": "json_object"})
            **kwargs: Additional parameters passed to litellm.completion
        
        Returns:
            The assistant's response content as a string
        
        Raises:
            Exception: If the completion request fails after retries
        """
        litellm = self._get_litellm()
        
        # Ensure drop_params is set (GPT-5 models have restrictions)
        litellm.drop_params = True
        
        params = {
            "model": self.model,
            "messages": messages,
            "temperature": self._get_effective_temperature(),
            "timeout": self.timeout,
            "num_retries": self.max_retries,
            **kwargs,
        }
        
        # Add JSON mode if requested and supported
        if response_format:
            params["response_format"] = response_format
        
        try:
            response = litellm.completion(**params)
            content = response.choices[0].message.content
            return content or ""
        except Exception as e:
            logger.error(f"LLM completion failed: {e}")
            raise
    
    def complete_json(
        self,
        system: str,
        user: str,
        json_schema: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Send a completion request expecting JSON output.
        
        This method is optimized for JSON responses, automatically enabling
        JSON mode where supported by the provider.
        
        Args:
            system: System message content
            user: User message content
            json_schema: Optional JSON schema for structured output (OpenAI only)
        
        Returns:
            The assistant's response as a JSON string
        """
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        
        # Enable JSON mode if supported
        response_format = None
        if self._supports_json_mode():
            response_format = {"type": "json_object"}
        
        return self.complete(messages, response_format=response_format)
    
    def complete_structured(
        self,
        system: str,
        user: str,
        response_schema: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Send a completion with structured output (OpenAI only).
        
        Uses OpenAI's structured outputs feature for guaranteed schema compliance.
        Falls back to regular JSON mode for other providers.
        
        Args:
            system: System message content
            user: User message content
            response_schema: JSON schema for the expected response
        
        Returns:
            Parsed JSON response as a dictionary
        """
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        
        # Use structured outputs for OpenAI models
        if self._is_openai_model():
            response_format = {
                "type": "json_schema",
                "json_schema": response_schema,
            }
        else:
            response_format = {"type": "json_object"}
        
        response = self.complete(messages, response_format=response_format)
        
        # Parse and return JSON
        try:
            return json.loads(response)
        except json.JSONDecodeError:
            # Try to extract JSON from the response
            cleaned = self._extract_json(response)
            return json.loads(cleaned) if cleaned else {}
    
    def _supports_json_mode(self) -> bool:
        """Check if the model supports JSON mode."""
        model_lower = self.model.lower()
        json_providers = [
            "gpt-4",
            "gpt-3.5",
            "claude-",
            "command",
            "mistral",
            "gemini",
        ]
        return any(p in model_lower for p in json_providers)
    
    def _is_gemini_model(self) -> bool:
        """Check if the model is a Google Gemini model."""
        model_lower = self.model.lower()
        return "gemini" in model_lower
    
    def _is_openai_model(self) -> bool:
        """Check if the model is an OpenAI model."""
        model_lower = self.model.lower()
        return model_lower.startswith(("gpt-", "o1-")) or "azure/" in model_lower
    
    @staticmethod
    def _extract_json(text: str) -> str:
        """Extract JSON from text that may contain markdown code blocks."""
        cleaned = text.strip()
        
        # Remove markdown code blocks
        if cleaned.startswith("```"):
            lines = cleaned.split("\n")
            # Skip first line (```json or similar)
            lines = lines[1:]
            # Find closing ```
            for i, line in enumerate(lines):
                if line.strip() == "```":
                    lines = lines[:i]
                    break
            cleaned = "\n".join(lines)
        
        return cleaned.strip()


def create_client(
    model: Optional[str] = None,
    provider: Optional[str] = None,
    **kwargs: Any,
) -> LiteLLMClient:
    """Factory function to create an LLM client.
    
    This function handles provider-specific configuration and environment
    variable detection.
    
    Args:
        model: Model name (e.g., "gpt-4o", "claude-3-haiku", "ollama/llama3.1",
               "gemini/gemini-3-flash-preview")
               If None, uses LLM_MODEL env var or auto-detects from available API keys
        provider: Optional provider hint ('openai', 'anthropic', 'ollama', 'google', etc.)
                  Used for auto-detection when model doesn't include provider prefix
        **kwargs: Additional arguments passed to LiteLLMClient
    
    Returns:
        Configured LiteLLMClient instance
    
    Example:
        >>> # Auto-detect from environment
        >>> client = create_client()
        
        >>> # Explicit model
        >>> client = create_client(model="claude-3-haiku-20240307")
        
        >>> # Ollama local model
        >>> client = create_client(model="llama3.1", provider="ollama")
        
        >>> # Gemini model
        >>> client = create_client(model="gemini/gemini-3-flash-preview")
    """
    # Get model from environment if not specified
    if model is None:
        model = os.getenv("LLM_MODEL")
    
    # Auto-detect provider from environment based on available API keys and model configs
    if model is None:
        if os.getenv("GOOGLE_MODEL") and os.getenv("GOOGLE_API_KEY"):
            # Google/Gemini model explicitly configured
            model = os.getenv("GOOGLE_MODEL")
            if not model.startswith("gemini/"):
                model = f"gemini/{model}"
        elif os.getenv("OPENAI_API_KEY"):
            model = os.getenv("OPENAI_MODEL", "gpt-4o")
        elif os.getenv("ANTHROPIC_API_KEY"):
            model = os.getenv("ANTHROPIC_MODEL", "claude-3-haiku-20240307")
        elif os.getenv("COHERE_API_KEY"):
            model = "command-a-03-2025"
        elif os.getenv("GOOGLE_API_KEY"):
            model = os.getenv("GOOGLE_MODEL", "gemini/gemini-1.5-flash")
            if not model.startswith("gemini/"):
                model = f"gemini/{model}"
        elif os.getenv("OLLAMA_BASE_URL"):
            model = os.getenv("OLLAMA_MODEL", "llama3.1")
            provider = "ollama"
        else:
            # Default to gpt-4o (will fail without API key)
            model = "gpt-4o"
    
    # Handle Gemini/Google provider - prefix with gemini/ if needed
    if provider == "google" or (model and "gemini" in model.lower() and not model.startswith("gemini/")):
        model = f"gemini/{model}"
    
    # Handle Ollama provider
    if provider == "ollama" or os.getenv("OLLAMA_BASE_URL"):
        ollama_base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        os.environ["OLLAMA_API_BASE"] = ollama_base
        
        # Prefix model with ollama/ if not already prefixed
        if not model.startswith("ollama/"):
            model = f"ollama/{model}"
    
    logger.info(f"Creating LiteLLM client with model: {model}")
    return LiteLLMClient(model=model, **kwargs)


# Convenience functions for common operations

def get_available_models() -> List[str]:
    """Get a list of commonly used model identifiers.
    
    Returns:
        List of model identifier strings
    """
    return [
        # OpenAI
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-3.5-turbo",
        # Anthropic
        "claude-3-5-sonnet-20241022",
        "claude-3-haiku-20240307",
        # Cohere
        "command-a-03-2025",
        "command-r-plus",
        # Mistral
        "mistral/mistral-small-latest",
        "mistral/mistral-large-latest",
        # Google
        "gemini/gemini-pro",
        "gemini/gemini-1.5-pro",
        "gemini/gemini-3-flash-preview",
        # Ollama (local)
        "ollama/llama3.1",
        "ollama/mistral",
    ]


def check_api_keys() -> Dict[str, bool]:
    """Check which provider API keys are configured.
    
    Returns:
        Dictionary mapping provider names to availability status
    """
    return {
        "openai": bool(os.getenv("OPENAI_API_KEY")),
        "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),
        "cohere": bool(os.getenv("COHERE_API_KEY")),
        "mistral": bool(os.getenv("MISTRAL_API_KEY")),
        "google": bool(os.getenv("GOOGLE_API_KEY")),
        "azure": bool(os.getenv("AZURE_API_KEY")),
        "ollama": bool(os.getenv("OLLAMA_BASE_URL")),
    }
