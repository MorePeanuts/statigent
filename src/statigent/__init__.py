"""A data science agent for automated analysis, feature engineering, model
building, and insight generation."""

from statigent.agents import StatigentDataScienceAgent
from statigent.models import get_model, list_models, load_registry

__version__ = "0.1.0"

__all__ = ["StatigentDataScienceAgent", "get_model", "list_models", "load_registry"]
