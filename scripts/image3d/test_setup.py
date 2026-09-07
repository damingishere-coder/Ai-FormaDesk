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

    def test_timeout_resumes_inside_a_partial_chunk(self):
        (self.chunks/'0.part').write_bytes(b'g')
        requested=[]
        class Curl:
            def __init__(self,command,**kwargs):
                bounds=command[command.index('--range')+1]
                requested.append(bounds)
                Path(command[command.index('--dump-header')+1]).write_text(
                    f'HTTP/1.1 206 Partial Content\nContent-Range: bytes {bounds}/4\n\n')
                Path(command[command.index('--output')+1]).write_bytes(b'o' if bounds=='1-3' else b'od')
                self.returncode=28 if bounds=='1-3' else 0
            def communicate(self):return None,b''
        with patch('setup.space'),patch('setup.subprocess.Popen',Curl):
            parallel_download(self.root,'https://example.invalid/',self.part,4,2,
                              hashlib.sha256(b'good').hexdigest())
        self.assertEqual(requested,['1-3','2-3'])
        self.assertEqual(self.part.read_bytes(),b'good')


if __name__=='__main__':unittest.main()
