from statigent.errors import StatigentError, StatigentModelError


def test_statigent_error_is_exception():
    assert issubclass(StatigentError, Exception)


def test_statigent_model_error_is_statigent_error():
    assert issubclass(StatigentModelError, StatigentError)


def test_statigent_model_error_message():
    err = StatigentModelError('test message')
    assert str(err) == 'test message'
