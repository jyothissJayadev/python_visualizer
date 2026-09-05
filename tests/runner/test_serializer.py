from backend.runner.serializer import safe_serialize


def test_primitives_pass_through():
    assert safe_serialize(1) == 1
    assert safe_serialize(1.5) == 1.5
    assert safe_serialize(True) is True
    assert safe_serialize(None) is None
    assert safe_serialize("hello") == "hello"


def test_dict_and_list_recurse():
    assert safe_serialize({"a": [1, 2, {"b": 3}]}) == {"a": [1, 2, {"b": 3}]}


def test_max_items_truncates_list():
    result = safe_serialize(list(range(10)), max_items=3)
    assert result[:3] == [0, 1, 2]
    assert "more item(s)" in result[3]


def test_max_string_length_truncates():
    result = safe_serialize("x" * 100, max_string_length=10)
    assert result.startswith("xxxxxxxxxx")
    assert "truncated" in result


def test_max_depth_stops_recursion():
    nested = {"a": {"b": {"c": {"d": "too deep"}}}}
    result = safe_serialize(nested, max_depth=2)
    assert "max depth" in result["a"]["b"]


def test_custom_object_falls_back_to_type_repr_attributes():
    class Custom:
        def __init__(self):
            self.x = 1
            self._hidden = "not shown"

    result = safe_serialize(Custom())
    assert result["type"] == "Custom"
    assert result["attributes"] == {"x": 1}
    assert "_hidden" not in result["attributes"]


def test_expand_objects_false_summarizes_unknown_objects():
    from pydantic import BaseModel

    class Custom:
        def __init__(self):
            self.x = 1
            self.big = list(range(1000))

    result = safe_serialize(Custom(), expand_objects=False)
    assert result["type"] == "Custom"
    assert "repr" in result
    assert "attributes" not in result

    class Point(BaseModel):
        x: int
        y: int

    # pydantic models and plain containers still expand
    assert safe_serialize(Point(x=1, y=2), expand_objects=False) == {"x": 1, "y": 2}
    assert safe_serialize({"a": [1, 2]}, expand_objects=False) == {"a": [1, 2]}


def test_pydantic_model_serializes_via_model_dump():
    from pydantic import BaseModel

    class Point(BaseModel):
        x: int
        y: int

    assert safe_serialize(Point(x=1, y=2)) == {"x": 1, "y": 2}
