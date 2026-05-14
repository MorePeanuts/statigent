"""Minimal DABench validation: run baseline agent on a few questions."""

from loguru import logger
from rich.console import Console
from rich.table import Table

from statigent.benchmarks.dabench import DABenchAdapter
from baseline.react.agent import ReactBaselineAgent


def main() -> None:
    console = Console()
    console.print('[bold]DABench Minimal Validation[/bold]')

    # Setup
    adapter = DABenchAdapter()
    agent = ReactBaselineAgent(model_name='deepseek-v4-flash')

    # Prepare
    console.print('\n[blue]Step 1: Preparing DABench data...[/blue]')
    adapter.prepare()
    console.print(f'  Loaded {len(adapter._questions)} questions')

    # Run on a few questions
    console.print('\n[blue]Step 2: Running baseline agent (3 questions)...[/blue]')
    predictions = adapter.run(agent, limit=3)
    console.print(f'  Got {len(predictions)} predictions')

    for pred in predictions:
        console.print(f"  id={pred['id']}: {pred['response'][:80]}...")

    # Evaluate
    console.print('\n[blue]Step 3: Evaluating predictions...[/blue]')
    result = adapter.evaluate(
        predictions,
        agent_name=agent.name,
        model_name=agent.model_name,
    )

    # Display results
    table = Table(title='Evaluation Results')
    table.add_column('Metric', style='cyan')
    table.add_column('Value', style='green')
    table.add_row('ABQ', f"{result.details.get('abq', 'N/A')}")
    table.add_row('PSAQ', f"{result.details.get('psaq', 'N/A')}")
    table.add_row('UASQ', f"{result.details.get('uasq', 'N/A')}")
    table.add_row('Agent', result.agent_name)
    table.add_row('Model', result.model_name)
    console.print(table)

    console.print('\n[bold green]Validation complete![/bold green]')


if __name__ == '__main__':
    main()
