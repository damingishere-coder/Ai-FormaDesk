import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from setup import parallel_download, resumed_bytes, space


class DownloadBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.part=self.root/'model.safetensors.part'
        self.chunks=self.part.with_suffix('.chunks')
        self.chunks.mkdir()

    def tearDown(self):self.temp.cleanup()

    def test_resume_does_not_double_count_prefix(self):
        size=4*1024*1024
        self.part.write_bytes(bytes(size))
        (self.chunks/'0').write_bytes(bytes(size))
        (self.chunks/str(size)).write_bytes(bytes(size))
        (self.chunks/str(size*2)).write_bytes(b'incomplete')
        self.assertEqual(resumed_bytes(self.part,size*3),size*2)

    def test_invalid_full_hash_keeps_chunks_and_never_activates(self):
        (self.chunks/'0').write_bytes(b'bad!')
        with patch('setup.space'), self.assertRaises(RuntimeError):
            parallel_download(self.root,'https://example.invalid/',self.part,4,2,
                              hashlib.sha256(b'good').hexdigest())
        self.assertTrue((self.chunks/'0').exists())
        self.assertFalse(self.part.exists())

    def test_disk_reserve_stops_assembly_before_writing(self):
        (self.chunks/'0').write_bytes(b'good')
        with patch('setup.space',side_effect=[None,None,RuntimeError('disk reserve')]), self.assertRaises(RuntimeError):
            parallel_download(self.root,'https://example.invalid/',self.part,4,2,
                              hashlib.sha256(b'good').hexdigest())
        self.assertFalse(self.part.with_suffix('.assembling').exists())
        self.assertEqual((self.chunks/'0').read_bytes(),b'good')

    def test_complete_verified_chunks_are_assembled(self):
        (self.chunks/'0').write_bytes(b'good')
        with patch('setup.space'):
            parallel_download(self.root,'https://example.invalid/',self.part,4,2,
                              hashlib.sha256(b'good').hexdigest())
        self.assertEqual(self.part.read_bytes(),b'good')
        self.assertFalse(self.chunks.exists())


if __name__=='__main__':unittest.main()
