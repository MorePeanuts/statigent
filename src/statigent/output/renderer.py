from statigent.schemas import (
    ExplorationReport,
    OutputBundle,
    OutputStatus,
    OutputType,
    TaskBrief,
)


class OutputRenderer:
    def render(
        self,
        brief: TaskBrief,
        report: ExplorationReport,
    ) -> OutputBundle:
        status = (
            OutputStatus.SUCCESS if report.status == "success" else OutputStatus.PARTIAL
        )
        content = report.final_draft.content
        if brief.output_type is OutputType.FILE and report.artifacts:
            artifact_lines = "\n".join(
                f"- {a.name}: {a.path}" for a in report.artifacts
            )
            content = f"{content}\n\nGenerated files:\n{artifact_lines}"
        return OutputBundle(
            status=status,
            output_type=brief.output_type,
            content=content,
            artifacts=report.artifacts,
            warnings=report.warnings,
            trace_summary=f"{len(report.steps)} exploration step(s)",
        )

    def render_unsupported(self, brief: TaskBrief) -> OutputBundle:
        return OutputBundle(
            status=OutputStatus.UNSUPPORTED,
            output_type=brief.output_type,
            content=(
                f"Task type '{brief.task_type.value}' is recognized but is not "
                "implemented in this architecture phase."
            ),
            artifacts=[],
            warnings=[
                f"{brief.task_type.value} routing is present; execution is not "
                "implemented."
            ],
            trace_summary="Unsupported task route",
        )
