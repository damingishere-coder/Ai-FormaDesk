from pathlib import Path
import tempfile
import unittest

from health import inspect


class HealthTest(unittest.TestCase):
    def test_missing_runtime_is_unavailable_not_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            result=inspect(Path(folder)/'not-installed')
            self.assertFalse(result['shape']['installationReady'])
            self.assertFalse(result['texture']['installationReady'])
            self.assertFalse(result['completePipeline'])

    def test_invalid_model_and_symlink_are_reported_separately(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve()
            model=root/'models/shape-small/config.yaml'
            model.parent.mkdir(parents=True)
            model.write_bytes(b'bad')
            result=inspect(root,verify=True)
            self.assertEqual(result['weights'][0]['status'],'invalid-size')
            model.unlink()
            fixture=root/'outside.txt';fixture.write_text('synthetic fixture')
            model.symlink_to(fixture)
            self.assertEqual(inspect(root,verify=True)['weights'][0]['status'],'invalid-path')


if __name__=='__main__':unittest.main()
