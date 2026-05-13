class StatigentError(Exception):
    """Base exception for all statigent errors."""


class StatigentModelError(StatigentError):
    """Error raised by the model registry."""
