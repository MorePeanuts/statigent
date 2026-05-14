class StatigentError(Exception):
    """Base exception for all statigent errors."""


class StatigentModelError(StatigentError):
    """Error raised by the model registry."""


class StatigentBenchmarkError(StatigentError):
    """Error raised by the benchmark adapter layer."""
