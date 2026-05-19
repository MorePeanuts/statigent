class StatigentError(Exception):
    """Base exception for all statigent errors."""


class StatigentModelError(StatigentError):
    """Error raised by the model registry."""


class StatigentInputError(StatigentError):
    """Error raised by the input profiling and task brief layer."""


class StatigentNotebookError(StatigentError):
    """Error raised by notebook kernel execution."""


class StatigentExplorationError(StatigentError):
    """Error raised by the exploration orchestrator."""


class StatigentOutputError(StatigentError):
    """Error raised by output rendering."""


class StatigentBenchmarkError(StatigentError):
    """Error raised by the benchmark adapter layer."""


class StatigentSandboxError(StatigentError):
    """Error raised by the Docker sandbox."""


class StatigentParseError(StatigentError):
    """Error raised when structured output parsing fails."""
