def normalize_name(name: str) -> str:
    return name.strip().lower().replace(" ", "_")


def format_response(status: str, data: dict | None = None) -> dict:
    return {"status": status, "data": data or {}}
