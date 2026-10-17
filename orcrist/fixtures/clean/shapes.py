from dataclasses import dataclass
from math import pi
from typing import Protocol


class Shape(Protocol):
    def area(self) -> float: ...


@dataclass(frozen=True)
class Circle:
    radius: float

    def area(self) -> float:
        return pi * self.radius**2


@dataclass(frozen=True)
class Rectangle:
    width: float
    height: float

    def area(self) -> float:
        return self.width * self.height


def total_area(shapes: list[Shape]) -> float:
    return sum(shape.area() for shape in shapes)


def read_widths(path: str) -> list[float]:
    try:
        with open(path) as lines:
            return [float(line) for line in lines if line.strip()]
    except FileNotFoundError:
        # A missing file holds no widths yet: the first run creates it
        return []
