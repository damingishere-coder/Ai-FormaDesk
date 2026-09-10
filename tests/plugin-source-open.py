"""Offline source opening and native unsaved-change handoff, without a GUI."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

bpy = types.ModuleType('bpy')
bpy.utils = types.ModuleType('bpy.utils')
bpy.utils.previews = types.ModuleType('bpy.utils.previews')
bpy.props = types.ModuleType('bpy.props')
for name in ('StringProperty', 'BoolProperty', 'IntProperty'):
    setattr(bpy.props, name, lambda **kw: None)
bpy.types = types.SimpleNamespace(Operator=object, Panel=object)
for module in (bpy, bpy.utils, bpy.utils.previews, bpy.props):
    sys.modules[module.__name__] = module
spec = importlib.util.spec_from_file_location('library', Path(__file__).resolve().parents[1] / 'blender/forma_project_library/__init__.py')
library = importlib.util.module_from_spec(spec)
spec.loader.exec_module(library)


class SourceOpenTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cache = self.root / 'project-library/index.json'
        self.cache.parent.mkdir()
        self.source = self.root / 'source.blend'
        self.source.write_bytes(b'untouched')
        self.file = dict(id='file', name='source', format='BLEND', kind='model', current=True, available=True, localPath=str(self.source))
        self.project = dict(id='project', name='project', currentRevisionId='r1', files=[self.file])
        library._config = {'cache': str(self.cache)}
        library._redraw = lambda: None
        library._request = lambda *a, **kw: self.fail('Opening must not launch/contact the workbench')
        self.write_cache()

    def tearDown(self):
        self.temp.cleanup()

    def write_cache(self):
        self.cache.write_text(json.dumps(dict(dataRoot=str(self.root), projects=[self.project])))

    def test_offline_open_defers_to_native_save_cancel_dialog(self):
        callbacks, calls = [], []
        bpy.app = types.SimpleNamespace(timers=types.SimpleNamespace(register=lambda cb, **kw: callbacks.append(cb)))
        bpy.context = types.SimpleNamespace(temp_override=lambda **kw: contextlib.nullcontext())
        bpy.ops = types.SimpleNamespace(wm=types.SimpleNamespace(open_mainfile=lambda *a, **kw: calls.append((a, kw))))
        library._state['online'] = False
        op = library.FORMA_OT_open()
        op.project_id, op.file_id = 'project', ''
        self.assertEqual(op.execute(types.SimpleNamespace(window=object())), {'FINISHED'})
        self.assertEqual(calls, [])
        callbacks.pop()()
        self.assertEqual(calls, [(('INVOKE_DEFAULT',), dict(filepath=str(self.source), display_file_selector=False, load_ui=False, use_scripts=False))])
        self.assertEqual(self.source.read_bytes(), b'untouched')

    def test_latest_cache_not_stale_selection(self):
        library._read_cache()
        newer = self.root / 'newer.blend'
        newer.write_bytes(b'new source')
        self.file['localPath'] = str(newer)
        self.write_cache()
        self.assertEqual(library._local_file('project')[1], newer)

    def test_missing_busy_and_escaped_sources_rejected(self):
        self.project['activeJob'] = {'status': 'running'}
        self.write_cache()
        with self.assertRaisesRegex(RuntimeError, '正在处理'):
            library._local_file('project')
        self.project.pop('activeJob')
        self.source.unlink()
        self.write_cache()
        with self.assertRaisesRegex(RuntimeError, '缺失'):
            library._local_file('project')
        self.source.symlink_to('/etc/hosts')
        with self.assertRaisesRegex(RuntimeError, '不在作品目录'):
            library._local_file('project')


if __name__ == '__main__':
    unittest.main()
