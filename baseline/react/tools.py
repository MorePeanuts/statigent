"""Tools for the react baseline agent."""

from pathlib import Path

from langchain.tools import tool
from langchain_experimental.utilities import PythonREPL

_python_repl = PythonREPL()


@tool
def python_repl(code: str) -> str:
    """Execute Python code and return the output.

    Use this to run data analysis code (pandas, numpy, etc.).
    If you want to see the output of a value, use print(...) in your code.
    The current working directory and any provided files are accessible.
    """
    return _python_repl.run(code)


@tool
def read_file(file_path: str) -> str:
    """Read the contents of a file.

    Use this to read CSV data files, task descriptions, or other text files.
    """
    return Path(file_path).read_text()
