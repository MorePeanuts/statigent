"""Conservative source witnesses for the fixed smoke; never executes code."""

import ast
import json
import sys


def witnesses(cells):
    bindings = {}
    found = []
    for cell in cells:
        for statement in ast.parse(cell["code"]).body:
            nodes = list(ast.walk(statement))
            # Exclude control flow, local scopes and comprehensions.
            supported = isinstance(statement, (ast.Assign, ast.AnnAssign, ast.Expr))
            supported &= not any(
                isinstance(
                    node,
                    (
                        ast.Lambda,
                        ast.ListComp,
                        ast.SetComp,
                        ast.DictComp,
                        ast.GeneratorExp,
                        ast.NamedExpr,
                    ),
                )
                for node in nodes
            )
            if supported:
                for node in nodes:
                    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                        prior = bindings.get(node.id)
                        if prior and prior["subtask_id"] != cell["subtask_id"]:
                            found.append(
                                {
                                    "name": node.id,
                                    "from_cell": prior["cell_id"],
                                    "to_cell": cell["cell_id"],
                                    "from_subtask": prior["subtask_id"],
                                    "to_subtask": cell["subtask_id"],
                                }
                            )
            for node in nodes:
                if isinstance(node, ast.Name) and isinstance(
                    node.ctx, (ast.Store, ast.Del)
                ):
                    bindings.pop(node.id, None)
                    if supported and isinstance(node.ctx, ast.Store):
                        bindings[node.id] = cell
            # Imports/definitions can shadow data but are not data witnesses.
            if isinstance(statement, (ast.Import, ast.ImportFrom)):
                for alias in statement.names:
                    bindings.pop(alias.asname or alias.name.split(".")[0], None)
            if isinstance(
                statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                bindings.pop(statement.name, None)
    return found


if __name__ == "__main__":
    json.dump(witnesses(json.load(sys.stdin)), sys.stdout)
