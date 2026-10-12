"""Bounded scene-tree traversal, independent of Blender and scene mutation."""

MAX_SCENE_OBJECTS = 1500


def descendants(obj):
    """Return parent-first preorder; reject cycles/oversize before any mutation.

    An explicit stack supports every legal scene depth without Python recursion.
    Blender's stable object pointer identifies repeated nodes without touching
    the user-facing forma_id. Reversing children preserves their existing order.
    """
    result = []
    pending = [obj]
    seen = set()
    while pending:
        current = pending.pop()
        pointer = getattr(current, "as_pointer", None)
        key = pointer() if callable(pointer) else id(current)
        if key in seen:
            raise ValueError("对象父子关系包含循环或重复引用")
        seen.add(key)
        result.append(current)
        children = []
        for child in current.children:
            children.append(child)
            if len(result) + len(pending) + len(children) > MAX_SCENE_OBJECTS:
                raise ValueError("V1 场景最多允许 1500 个对象")
        pending.extend(reversed(children))
    return result
