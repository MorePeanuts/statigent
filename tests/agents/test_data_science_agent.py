from pathlib import Path
from typing import TYPE_CHECKING

from statigent.agents import StatigentDataScienceAgent
from statigent.schemas import (
    Budget,
    Complexity,
    DatasetProfile,
    ExplorationReport,
    FinalDraft,
    InputFileInfo,
    OutputType,
    TableProfile,
    TaskBrief,
    TaskType,
    TraceEvent,
)

if TYPE_CHECKING:
    from statigent.benchmarks.base import DataScienceAgent


class FakeProfiler:
    def __init__(self, profile: DatasetProfile) -> None:
        self.profile = profile

    def profile_paths(self, _paths: list[Path] | None) -> DatasetProfile:
        return self.profile


class FakePlanner:
    def __init__(self, brief: TaskBrief) -> None:
        self.brief = brief

    def create_brief(
        self,
        *,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief:
        return self.brief


class FakeOrchestrator:
    def run(
        self,
        _brief: TaskBrief,
        _profile: DatasetProfile,
    ) -> ExplorationReport:
        return ExplorationReport(
            status="success",
            final_draft=FinalDraft(content="Answer is 42", evidence=["computed"]),
            steps=[],
            artifacts=[],
            warnings=[],
        )


class TracedFakeOrchestrator:
    def run(
        self,
        _brief: TaskBrief,
        _profile: DatasetProfile,
    ) -> ExplorationReport:
        return ExplorationReport(
            status="success",
            final_draft=FinalDraft(content="Answer is 42", evidence=["computed"]),
            steps=[],
            artifacts=[],
            warnings=[],
            trace_events=[
                TraceEvent(
                    role="assistant",
                    content="planned",
                    name="plan",
                    agent="inspector",
                )
            ],
        )


def make_profile(tmp_path: Path) -> DatasetProfile:
    path = tmp_path / "sales.csv"
    return DatasetProfile(
        root=tmp_path,
        files=[
            InputFileInfo(
                path=path,
                relative_path="sales.csv",
                suffix=".csv",
                size_bytes=10,
                is_tabular=True,
            )
        ],
        tables=[
            TableProfile(
                path=path,
                relative_path="sales.csv",
                rows=1,
                columns=1,
                column_names=["x"],
                dtypes={"x": "int64"},
                missing_rates={"x": 0.0},
                unique_counts={"x": 1},
                numeric_summaries={"x": {"mean": 1.0}},
                likely_time_columns=[],
                likely_categorical_columns=[],
                sample_rows=[],
            )
        ],
        warnings=[],
    )


def make_brief(task_type: TaskType) -> TaskBrief:
    return TaskBrief(
        task_type=task_type,
        objective="Answer",
        output_type=OutputType.ANSWER,
        requirements=[],
        data_context="sales.csv",
        complexity=Complexity.SIMPLE,
        budgets=Budget(
            max_rounds=1,
            max_code_cells=1,
            max_debug_attempts=0,
            timeout_seconds=60,
        ),
    )


def make_agent(
    profile: DatasetProfile,
    brief: TaskBrief,
) -> StatigentDataScienceAgent:
    def factory(
        _brief: TaskBrief,
        _profile: DatasetProfile,
        _work_dir: Path,
    ) -> FakeOrchestrator:
        return FakeOrchestrator()

    return StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(brief),
        orchestrator_factory=factory,
    )


def test_agent_satisfies_protocol(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    agent: DataScienceAgent = make_agent(profile, make_brief(TaskType.DATA_ANALYSIS))

    response, trace = agent.run_analysis_for_eval("question", files=[])

    assert response == "Answer is 42"
    assert trace[-1]["role"] == "assistant"


def test_agent_keeps_work_dir_for_artifact_references(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    brief = make_brief(TaskType.DATA_ANALYSIS)
    work_dirs: list[Path] = []

    def factory(
        _brief: TaskBrief,
        _profile: DatasetProfile,
        work_dir: Path,
    ) -> FakeOrchestrator:
        work_dirs.append(work_dir)
        return FakeOrchestrator()

    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(brief),
        orchestrator_factory=factory,
    )

    agent.run_analysis_for_eval("question", files=[])

    assert work_dirs
    assert work_dirs[0].exists()


def test_analysis_eval_coerces_deep_analysis_brief(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    agent = make_agent(profile, make_brief(TaskType.DEEP_ANALYSIS))

    response, trace = agent.run_analysis_for_eval("deep report", files=[])

    assert response == "Answer is 42"
    assert any("coerced" in event["content"].casefold() for event in trace)
    assert all("agent" in event and "session" in event for event in trace)


def test_analysis_eval_coerces_non_analysis_brief(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    brief = make_brief(TaskType.DATA_MODELING)
    seen: list[TaskType] = []

    class CapturingOrchestrator:
        def run(
            self,
            run_brief: TaskBrief,
            run_profile: DatasetProfile,
        ) -> ExplorationReport:
            seen.append(run_brief.task_type)
            return FakeOrchestrator().run(run_brief, run_profile)

    def factory(
        _brief: TaskBrief,
        _profile: DatasetProfile,
        _work_dir: Path,
    ) -> CapturingOrchestrator:
        return CapturingOrchestrator()

    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(brief),
        orchestrator_factory=factory,
    )

    response, trace = agent.run_analysis_for_eval("predict", files=[])

    assert response == "Answer is 42"
    assert seen == [TaskType.DATA_ANALYSIS]
    assert any("coerced" in event["content"].casefold() for event in trace)
    assert all("agent" in event and "session" in event for event in trace)


def test_analysis_eval_appends_orchestrator_trace_events(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    brief = make_brief(TaskType.DATA_ANALYSIS)

    def factory(
        _brief: TaskBrief,
        _profile: DatasetProfile,
        _work_dir: Path,
    ) -> TracedFakeOrchestrator:
        return TracedFakeOrchestrator()

    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(brief),
        orchestrator_factory=factory,
    )

    response, trace = agent.run_analysis_for_eval("question", files=[])

    assert response == "Answer is 42"
    assert any(
        event["name"] == "plan" and event["agent"] == "inspector"
        for event in trace
    )
    assert all("agent" in event and "session" in event for event in trace)


def test_modeling_eval_returns_unsupported_submission_path(tmp_path: Path) -> None:
    profile = make_profile(tmp_path)
    orchestrator_calls: list[TaskType] = []

    def factory(
        brief: TaskBrief,
        _profile: DatasetProfile,
        _work_dir: Path,
    ) -> FakeOrchestrator:
        orchestrator_calls.append(brief.task_type)
        return FakeOrchestrator()

    agent = StatigentDataScienceAgent(
        model_name="fake",
        profiler=FakeProfiler(profile),
        planner=FakePlanner(make_brief(TaskType.DATA_MODELING)),
        orchestrator_factory=factory,
    )
    train = tmp_path / "train.csv"
    test = tmp_path / "test.csv"
    sample = tmp_path / "sample_submission.csv"
    for path in (train, test, sample):
        path.write_text("x\n1\n")

    submission_path, trace = agent.run_modeling_for_eval(
        "predict",
        train_path=train,
        test_path=test,
        sample_submission_path=sample,
        work_dir=tmp_path / "work",
    )

    assert submission_path.name == "submission.csv"
    assert not submission_path.exists()
    assert orchestrator_calls == []
    assert any("not implemented" in msg["content"] for msg in trace)
    assert all("agent" in event and "session" in event for event in trace)
