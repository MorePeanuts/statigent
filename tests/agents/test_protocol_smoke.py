from typing import TYPE_CHECKING

from statigent import StatigentDataScienceAgent

if TYPE_CHECKING:
    from statigent.benchmarks.base import DataScienceAgent


def test_public_agent_export_exists() -> None:
    agent = StatigentDataScienceAgent(model_name="fake")

    assert agent.name == "statigent-data-science"


def test_agent_has_data_science_protocol_methods() -> None:
    agent: DataScienceAgent = StatigentDataScienceAgent(model_name="fake")

    assert hasattr(agent, "run_analysis_for_eval")
    assert hasattr(agent, "run_modeling_for_eval")
