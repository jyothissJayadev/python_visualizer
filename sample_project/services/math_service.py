def calculate_total(items: list[float]) -> float:
    return sum(items)


def classify_number(value: float) -> str:
    if value > 0:
        return "positive"
    if value < 0:
        return "negative"
    return "zero"


async def calculate_total_async(items: list[float], delay: float = 0.0) -> float:
    import asyncio

    if delay:
        await asyncio.sleep(delay)
    return sum(items)


def divide(a: float, b: float) -> float:
    return a / b


class MathHelper:
    def __init__(self):
        self.history: list[float] = []

    def add_and_track(self, a: float, b: float) -> float:
        result = a + b
        self.history.append(result)
        return result
