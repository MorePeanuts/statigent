from statigent.errors import (
    StatigentError,
    StatigentExplorationError,
    StatigentInputError,
    StatigentModelError,
    StatigentNotebookError,
    StatigentOutputError,
)


def test_statigent_error_is_exception():
    assert issubclass(StatigentError, Exception)


def test_statigent_model_error_is_statigent_error():
    assert issubclass(StatigentModelError, StatigentError)


def test_statigent_model_error_message():
    err = StatigentModelError("test message")
    assert str(err) == "test message"


def test_layer_errors_inherit_from_statigent_error() -> None:
    errors = [
        StatigentInputError("bad input"),
        StatigentNotebookError("bad notebook"),
        StatigentExplorationError("bad exploration"),
        StatigentOutputError("bad output"),
    ]

    assert all(isinstance(err, StatigentError) for err in errors)
