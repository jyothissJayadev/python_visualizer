from pydantic import BaseModel

from services.math_service import calculate_total, classify_number


class WorkflowConfig(BaseModel):
    mode: str = "residential"
    strict: bool = False


def generate_workflow(items: list[float], config: WorkflowConfig) -> dict:
    total = calculate_total(items)
    classification = classify_number(total)

    return {
        "total": total,
        "classification": classification,
        "mode": config.mode,
    }
