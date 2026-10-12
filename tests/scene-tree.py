"""No AI/Blender/scene access: exercise the worker's imported tree traversal."""
import ast
import pathlib
import sys
import unittest
import uuid
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "blender"))
from scene_tree import descendants, MAX_SCENE_OBJECTS


class Object:
    def __init__(self, name, children=()):
        self.name = name
        self.children = list(children)
        self.forma_id = "stable-" + name
        self.parent = None
        self.data = None
        self.location = SimpleNamespace(x=0)
        self.hide_render = False
        self.hide_viewport = False
        for child in self.children:
            child.parent = self

    def __setitem__(self, key, value):
        setattr(self, key, value)

    def copy(self):
        duplicate = Object(self.name)
        duplicate.parent = self.parent
        duplicate.forma_id = self.forma_id
        duplicate.location.x = self.location.x
        return duplicate


def chain(size):
    objects = [Object(str(i)) for i in range(size)]
    for parent, child in zip(objects, objects[1:]):
        parent.children = [child]
        child.parent = parent
    return objects


def run_worker_command(root, operation, **options):
    # Execute the actual command branch with in-memory bpy substitutes. No
    # Blender import/file/process happens; save/link/remove calls are recorded.
    tree = ast.parse((ROOT / "blender" / "worker.py").read_text())
    branch = next(n for n in ast.walk(tree) if isinstance(n, ast.If)
                  and isinstance(n.test, ast.Compare)
                  and isinstance(n.test.left, ast.Name)
                  and n.test.left.id == "mode"
                  and isinstance(n.test.comparators[0], ast.Constant)
                  and n.test.comparators[0].value == "command")
    removed, linked, saved = [], [], []
    bpy = SimpleNamespace(
        data=SimpleNamespace(objects=SimpleNamespace(remove=lambda obj, **_: removed.append(obj))),
        context=SimpleNamespace(collection=SimpleNamespace(objects=SimpleNamespace(link=linked.append))),
        ops=SimpleNamespace(wm=SimpleNamespace(save_as_mainfile=lambda **kwargs: saved.append(kwargs))),
    )
    command = {"objectId": root.forma_id, "operation": operation, **options}
    bindings = {"bpy": bpy, "uuid": uuid, "descendants": descendants,
                "open_scene": lambda _: None, "file": lambda _: "test-raw.blend",
                "read": lambda _: command, "find": lambda _: root}
    exec(compile(ast.Module(body=branch.body, type_ignores=[]), "worker.py", "exec"), bindings)
    return removed, linked, saved


class SceneTreeTests(unittest.TestCase):
    def test_worker_uses_the_tested_helper_for_all_subtree_commands(self):
        # Load only its import, not the bpy entrypoint: these are the same
        # descendants/limit bindings the real command/normalize paths use.
        tree = ast.parse((ROOT / "blender" / "worker.py").read_text())
        imports = [n for n in tree.body if isinstance(n, ast.ImportFrom)
                   and n.module == "scene_tree"]
        self.assertEqual(len(imports), 1)
        bindings = {}
        exec(compile(ast.Module(body=imports, type_ignores=[]), "worker.py", "exec"), bindings)
        self.assertIs(bindings["descendants"], descendants)
        self.assertEqual(bindings["MAX_SCENE_OBJECTS"], MAX_SCENE_OBJECTS)

    def test_leaf_and_two_levels(self):
        leaf = Object("leaf")
        parent = Object("parent", [leaf])
        self.assertEqual(descendants(leaf), [leaf])
        self.assertEqual(descendants(parent), [parent, leaf])

    def test_preorder_reverse_delete_order_and_ids_preserved(self):
        first_child = Object("first-child")
        second_child = Object("second-child")
        first = Object("first", [first_child])
        second = Object("second", [second_child])
        root = Object("root", [first, second])
        expected = [root, first, first_child, second, second_child]
        original_ids = [o.forma_id for o in expected]
        actual = descendants(root)
        self.assertEqual(actual, expected)
        self.assertEqual(list(reversed(actual)), [second_child, second, first_child, first, root])
        self.assertEqual([o.forma_id for o in actual], original_ids)

    def test_1200_and_1500_deep_tree(self):
        for size in (1200, MAX_SCENE_OBJECTS):
            with self.subTest(size=size):
                objects = chain(size)
                self.assertEqual(descendants(objects[0]), objects)

    def test_oversize_deep_and_wide_tree_rejected(self):
        objects = chain(MAX_SCENE_OBJECTS + 1)
        with self.assertRaisesRegex(ValueError, "1500"):
            descendants(objects[0])
        with self.assertRaisesRegex(ValueError, "1500"):
            descendants(Object("root", [Object(str(i)) for i in range(MAX_SCENE_OBJECTS)]))

    def test_cycles_and_duplicate_child_rejected(self):
        root, child = chain(2)
        child.children = [root]
        with self.assertRaisesRegex(ValueError, "循环或重复引用"):
            descendants(root)
        root.children = [child, child]
        child.children = []
        with self.assertRaisesRegex(ValueError, "循环或重复引用"):
            descendants(root)
        root.children = [root]
        with self.assertRaisesRegex(ValueError, "循环或重复引用"):
            descendants(root)

    def test_blender_object_pointer_identity_guard(self):
        # Distinct Python wrappers for the same Blender object still form a
        # repeated node; a Python id-only guard would miss this relation.
        root, duplicate_wrapper = Object("root"), Object("same-blender-object")
        root.as_pointer = lambda: 1234
        duplicate_wrapper.as_pointer = lambda: 1234
        root.children = [duplicate_wrapper]
        with self.assertRaisesRegex(ValueError, "循环或重复引用"):
            descendants(root)

    def test_child_enumeration_is_bounded_before_mutation(self):
        root = Object("root")
        generated = []

        def children():
            while True:
                child = Object(str(len(generated)))
                generated.append(child)
                yield child

        root.children = children()
        with self.assertRaisesRegex(ValueError, "1500"):
            descendants(root)
        self.assertEqual(len(generated), MAX_SCENE_OBJECTS)
        self.assertEqual(root.forma_id, "stable-root")

    def test_worker_visibility_and_delete_on_deep_tree(self):
        objects = chain(1200)
        original_ids = [o.forma_id for o in objects]
        removed, linked, saved = run_worker_command(objects[0], "visibility", visible=False)
        self.assertTrue(all(o.hide_render and o.hide_viewport for o in objects))
        self.assertEqual([o.forma_id for o in objects], original_ids)
        self.assertEqual((removed, linked, len(saved)), ([], [], 1))
        removed, linked, saved = run_worker_command(objects[0], "delete")
        self.assertEqual(removed, list(reversed(objects)))
        self.assertEqual((linked, len(saved)), ([], 1))

    def test_worker_duplicate_preserves_source_ids_and_parent_links(self):
        objects = chain(2)
        third = Object("second-child")
        third.parent = objects[0]
        objects[0].children.append(third)
        objects.append(third)
        original_ids = [o.forma_id for o in objects]
        removed, linked, saved = run_worker_command(objects[0], "duplicate")
        self.assertEqual([o.name for o in linked], [o.name for o in objects])
        self.assertEqual([o.forma_id for o in objects], original_ids)
        self.assertEqual(len(set(o.forma_id for o in objects + linked)), 6)
        self.assertIs(linked[1].parent, linked[0])
        self.assertIs(linked[2].parent, linked[0])
        self.assertEqual(linked[0].location.x, .25)
        self.assertEqual(objects[0].location.x, 0)
        self.assertEqual((removed, len(saved)), ([], 1))

    def test_worker_oversize_rejected_before_any_mutation(self):
        for operation in ("visibility", "delete", "duplicate"):
            objects = chain(MAX_SCENE_OBJECTS + 1)
            with self.subTest(operation=operation), self.assertRaisesRegex(ValueError, "1500"):
                run_worker_command(objects[0], operation, visible=False)
            self.assertTrue(all(not o.hide_render and not o.hide_viewport for o in objects))
            self.assertEqual([o.forma_id for o in objects], ["stable-" + str(i) for i in range(len(objects))])


if __name__ == "__main__":
    unittest.main()
