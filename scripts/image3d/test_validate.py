import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest
from validate import glb


class GlbTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)/'scene.glb'
        self.doc={'asset':{'version':'2.0'},'buffers':[{'byteLength':64}],
                  'bufferViews':[{'buffer':0,'byteOffset':0,'byteLength':36}],
                  'accessors':[{'bufferView':0,'componentType':5126,'type':'VEC3','count':3}],
                  'meshes':[{'primitives':[{'attributes':{'POSITION':0}}]}], 'nodes':[{'mesh':0}]}
    def tearDown(self):self.temp.cleanup()
    def write(self):
        data=json.dumps(self.doc).encode();data+=b' '*((-len(data))%4)
        self.path.write_bytes(struct.pack('<4sII',b'glTF',2,28+len(data)+64)+struct.pack('<I4s',len(data),b'JSON')+data+struct.pack('<I4s',64,b'BIN\0')+bytes(64))
    def test_valid_small_mesh(self):
        self.write();self.assertEqual(glb(self.path)['triangles'],1)
    def test_external_buffer_rejected(self):
        self.doc['buffers'][0]['uri']='https://example.invalid/model.bin';self.write()
        with self.assertRaises(ValueError):glb(self.path)
    def test_truncated_file_rejected(self):
        self.write();self.path.write_bytes(self.path.read_bytes()[:-1])
        with self.assertRaises(ValueError):glb(self.path)
    def test_accessor_cannot_exceed_buffer(self):
        self.doc['accessors'][0]['count']=9;self.write()
        with self.assertRaises(ValueError):glb(self.path)
    def test_instanced_triangles_counted(self):
        self.doc['nodes']=[{'mesh':0}]*10;self.write()
        with self.assertRaises(ValueError):glb(self.path,triangle_limit=9)
    def test_missing_texture_rejected(self):
        self.write()
        with self.assertRaises(ValueError):glb(self.path,require_texture=True)
    def test_nonfinite_vertex_rejected(self):
        self.write()
        data=bytearray(self.path.read_bytes())
        struct.pack_into('<f',data,len(data)-64,float('nan'))
        self.path.write_bytes(data)
        with self.assertRaises(ValueError):glb(self.path)
    def test_out_of_range_index_rejected(self):
        self.doc['bufferViews'].append({'buffer':0,'byteOffset':36,'byteLength':6})
        self.doc['accessors'].append({'bufferView':1,'componentType':5123,'type':'SCALAR','count':3})
        self.doc['meshes'][0]['primitives'][0]['indices']=1
        self.write()
        data=bytearray(self.path.read_bytes())
        struct.pack_into('<3H',data,len(data)-64+36,0,1,3)
        self.path.write_bytes(data)
        with self.assertRaises(ValueError):glb(self.path)
    def test_nonfinite_transform_rejected(self):
        self.doc['nodes'][0]['scale']=[1,float('inf'),1];self.write()
        with self.assertRaises(ValueError):glb(self.path)


if __name__=='__main__':unittest.main()
