"""Benchmark-compatible agent wrapper satisfying the DataScienceAgent protocol.

Wires the full pipeline: InputProfiler -> TaskBriefPlanner ->
ExplorationOrchestrator -> OutputRenderer. Supports dependency injection
of every component for testing.

The analysis benchmark entrypoint coerces non-analysis task classifications
back to DATA_ANALYSIS because that entrypoint is already selected by the
benchmark harness.
"""

from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory, mkdtemp
from typing import Protocol, runtime_checkable

from statigent.benchmarks.base import AgentTrace
from statigent.exploration import (
    Coder,
    Debugger,
    ExplorationOrchestrator,
    Inspector,
    Reviewer,
)
from statigent.input import InputProfiler, TaskBriefPlanner
from statigent.models import get_model
from statigent.notebook import DockerNotebookKernel, NotebookContext
from statigent.output import OutputRenderer
from statigent.schemas import (
    DatasetProfile,
    ExplorationReport,
    TaskBrief,
    TaskType,
    TraceEvent,
)


class _Profiler(Protocol):
    def profile_paths(self, paths: list[Path] | None) -> DatasetProfile: ...


class _Planner(Protocol):
    def create_brief(
        self,
        *,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief: ...


class _Orchestrator(Protocol):
    def run(self, brief: TaskBrief, profile: DatasetProfile) -> ExplorationReport: ...


@runtime_checkable
class _Closable(Protocol):
    def close(self) -> None: ...


OrchestratorFactory = Callable[[TaskBrief, DatasetProfile, Path], _Orchestrator]


class StatigentDataScienceAgent:
    """Top-level agent implementing the DataScienceAgent benchmark protocol.

    Construct with model_name only for production use; inject profiler,
    planner, orchestrator_factory, or renderer for testing.
    """

    name = "statigent"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        *,
        profiler: _Profiler | None = None,
        planner: _Planner | None = None,
        orchestrator_factory: OrchestratorFactory | None = None,
        renderer: OutputRenderer | None = None,
    ) -> None:
        self.model_name = model_name
        self.profiler = profiler
        self.planner = planner
        self.orchestrator_factory = orchestrator_factory
        self.renderer = renderer or OutputRenderer()

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        """Run the full analysis pipeline and return (answer, trace).

        Creates a temporary runtime directory for profiler scratch files,
        notebook workspace files, and artifacts. The directory is cleaned after
        rendering because benchmark callers consume the returned answer and
        trace directly.
        Non-analysis task classifications are treated as planning errors for
        this entrypoint. They are traced, added to output warnings, and coerced
        to DATA_ANALYSIS before exploration runs.
        """
        with TemporaryDirectory(prefix="statigent-") as tmpdir:
            work_dir = Path(tmpdir)
            profile = self._profiler(work_dir).profile_paths(files)
            brief = self._planner().create_brief(
                prompt=prompt,
                task_instructions=task_instructions,
                profile=profile,
            )
            trace_events = [
                TraceEvent(
                    role="system",
                    content=profile.compact_summary(),
                    name="input",
                    agent="input_profiler",
                ),
                TraceEvent(
                    role="assistant",
                    content=brief.model_dump_json(),
                    name="task_brief",
                    agent="task_brief_planner",
                ),
            ]
            planner_warnings: list[str] = []

            if brief.task_type is not TaskType.DATA_ANALYSIS:
                original_task_type = brief.task_type
                warning = (
                    f"run_analysis_for_eval received {original_task_type}; "
                    "coerced to data_analysis."
                )
                planner_warnings.append(warning)
                brief = brief.model_copy(
                    update={
                        "task_type": TaskType.DATA_ANALYSIS,
                    }
                )
                trace_events.append(
                    TraceEvent(
                        role="assistant",
                        content=warning,
                        name="task_type_coercion",
                        agent="data_science_agent",
                        metadata={"original_task_type": original_task_type.value},
                    )
                )

            orchestrator = self._orchestrator(brief, profile, work_dir)
            try:
                report = orchestrator.run(brief, profile)
            finally:
                if isinstance(orchestrator, _Closable):
                    orchestrator.close()
            trace_events.extend(self._orchestrator_trace_events(report))
            if planner_warnings:
                report = report.model_copy(
                    update={"warnings": [*planner_warnings, *report.warnings]}
                )
            bundle = self.renderer.render(brief, report)
            trace_events.append(
                TraceEvent(
                    role="assistant",
                    content=bundle.model_dump_json(),
                    name="output",
                    agent="output_renderer",
                )
            )
            trace: AgentTrace = [event.model_dump() for event in trace_events]
            return bundle.content, trace

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
        work_dir: Path | None = None,
    ) -> tuple[Path, AgentTrace]:
        """Placeholder for modeling tasks — returns an unsupported submission path.

        The returned submission.csv path does not exist on disk.
        """
        target_dir = work_dir or Path(mkdtemp(prefix="statigent-modeling-"))
        content = (
            "Modeling submission generation is not implemented. "
            f"Received prompt: {prompt}"
        )
        trace_events = [
            TraceEvent(
                role="system",
                content=(
                    "Modeling evaluation placeholder received train, test, "
                    "and sample submission paths."
                ),
                name="modeling_input",
                agent="data_science_agent",
                metadata={
                    "train_path": str(train_path),
                    "test_path": str(test_path),
                    "sample_submission_path": str(sample_submission_path),
                    "task_instructions": task_instructions,
                },
            ),
            TraceEvent(
                role="assistant",
                content=content,
                name="modeling_placeholder",
                agent="data_science_agent",
            ),
        ]
        trace: AgentTrace = [event.model_dump() for event in trace_events]
        return target_dir / "submission.csv", trace

    def _profiler(self, work_dir: Path) -> _Profiler:
        if self.profiler is not None:
            return self.profiler
        # The profiler work directory is scratch space for archive extraction
        # and relative-path bookkeeping, not the location of source data files.
        return InputProfiler(work_dir=work_dir)

    def _planner(self) -> _Planner:
        if self.planner is not None:
            return self.planner
        return TaskBriefPlanner(model=get_model(self.model_name))

    def _orchestrator(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        work_dir: Path,
    ) -> _Orchestrator:
        if self.orchestrator_factory is not None:
            return self.orchestrator_factory(brief, profile, work_dir)
        model = get_model(self.model_name)
        kernel = DockerNotebookKernel()
        kernel.start(
            NotebookContext(
                input_paths=[file.path for file in profile.files],
                work_dir=work_dir,
                timeout_seconds=brief.budgets.timeout_seconds,
            )
        )
        return ExplorationOrchestrator(
            inspector=Inspector(model),
            reviewer=Reviewer(model),
            coder=Coder(model),
            debugger=Debugger(model),
            kernel=kernel,
        )

    @staticmethod
    def _orchestrator_trace_events(report: ExplorationReport) -> list[TraceEvent]:
        return list(report.trace_events)
