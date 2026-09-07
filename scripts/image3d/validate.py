"""Validate the portable GLB artifact before recording a usable candidate."""
import json
from pathlib import Path
import struct
import math
import mmap


def glb(path, require_texture=False, triangle_limit=150_000):
    path = Path(path)
    size = path.stat().st_size
    if not 20 <= size <= 1024**3:
        raise ValueError('GLB 文件大小无效')
    with path.open('rb') as f:
        magic, version, length = struct.unpack('<4sII', f.read(12))
        if (magic, version, length) != (b'glTF', 2, size):
            raise ValueError('GLB 文件头或长度无效')
        n, kind = struct.unpack('<I4s', f.read(8))
        if kind != b'JSON' or n % 4 or n > min(size-20, 16*1024*1024):
            raise ValueError('GLB JSON 区块无效')
        document = json.loads(f.read(n))
        binary_size = 0
        binary_offset = f.tell()
        if f.tell() < size:
            binary_size, kind = struct.unpack('<I4s', f.read(8))
            if kind != b'BIN\0' or f.tell()+binary_size != size:
                raise ValueError('GLB 二进制区块无效')
            binary_offset = f.tell()
    for buffer in document.get('buffers', []):
        if 'uri' in buffer or buffer.get('byteLength', binary_size+1) > binary_size:
            raise ValueError('GLB 缓冲区不是完整的内嵌数据')
    views = document.get('bufferViews', [])
    for view in views:
        if view.get('buffer',0) != 0 or view.get('byteOffset',0) < 0 or view.get('byteLength',0) <= 0 or view.get('byteOffset',0)+view['byteLength'] > binary_size:
            raise ValueError('GLB 缓冲区范围无效')
    accessors = document.get('accessors', [])
    widths={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}
    components={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT2':4,'MAT3':9,'MAT4':16}
    for accessor in accessors:
        if 'sparse' in accessor or not 0 <= accessor.get('bufferView',-1) < len(views):
            raise ValueError('不支持或无效的网格数据访问器')
        count=accessor.get('count',0)
        if not isinstance(count,int) or not 0 < count <= 6_000_000:
            raise ValueError('网格数据数量无效')
        item=widths.get(accessor.get('componentType'),0)*components.get(accessor.get('type'),0)
        view=views[accessor['bufferView']]
        stride=view.get('byteStride',item)
        offset=accessor.get('byteOffset',0)
        if not item or stride<item or offset<0 or offset+(count-1)*stride+item>view['byteLength']:
            raise ValueError('网格访问器超出数据范围')
        if any(not math.isfinite(v) for key in ['min','max'] for v in accessor.get(key,[])):
            raise ValueError('网格边界存在非有限数值')
    def at(items,index):
        if not isinstance(index,int) or not 0 <= index < len(items):raise ValueError('GLB 数据引用无效')
        return items[index]
    triangles = 0
    mesh_triangles=[]
    for mesh in document.get('meshes', []):
        current=0
        for primitive in mesh.get('primitives', []):
            if primitive.get('mode',4) != 4:
                raise ValueError('预览只接受三角面网格')
            position = at(accessors,primitive['attributes']['POSITION'])
            count = at(accessors,primitive['indices'])['count'] if 'indices' in primitive else position['count']
            if count % 3:
                raise ValueError('三角面索引数量无效')
            current += count//3
        mesh_triangles.append(current)
    nodes=document.get('nodes',[])
    for node in nodes:
        for key, width in [('matrix',16),('translation',3),('rotation',4),('scale',3)]:
            if key in node and (len(node[key])!=width or any(not math.isfinite(v) for v in node[key])):
                raise ValueError('GLB 对象变换无效')
    if len(nodes)>1500:raise ValueError('GLB 对象超过场景安全上限')
    triangles=sum(at(mesh_triangles,node['mesh']) for node in nodes if 'mesh' in node)
    if not 0 < triangles <= triangle_limit:
        raise ValueError(f'预览三角面数量不合格：{triangles}')
    # Bounds in JSON are not sufficient: inspect the actual vertex and index
    # payload before handing it to Blender or the browser's GPU.
    with path.open('rb') as file, mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as data:
        def values(accessor, fmt):
            view = views[accessor['bufferView']]
            start = binary_offset+view.get('byteOffset',0)+accessor.get('byteOffset',0)
            stride = view.get('byteStride',struct.calcsize(fmt))
            for index in range(accessor['count']):
                yield struct.unpack_from(fmt,data,start+index*stride)
        checked=set()
        for mesh in document.get('meshes',[]):
            for primitive in mesh.get('primitives',[]):
                position_id=primitive['attributes']['POSITION']
                position=at(accessors,position_id)
                if position.get('type')!='VEC3' or position.get('componentType')!=5126:
                    raise ValueError('位置数据必须为三维浮点坐标')
                if position_id not in checked:
                    if any(not all(math.isfinite(v) for v in xyz) for xyz in values(position,'<3f')):
                        raise ValueError('网格顶点存在非有限数值')
                    checked.add(position_id)
                if 'indices' in primitive:
                    indices=at(accessors,primitive['indices'])
                    fmt={5121:'<B',5123:'<H',5125:'<I'}.get(indices.get('componentType'))
                    if indices.get('type')!='SCALAR' or fmt is None:
                        raise ValueError('网格索引类型无效')
                    if any(value[0]>=position['count'] for value in values(indices,fmt)):
                        raise ValueError('网格索引超出顶点数量')
    images = document.get('images', [])
    for image in images:
        if 'uri' in image or not 0 <= image.get('bufferView',-1) < len(views):
            raise ValueError('贴图未完整嵌入 GLB')
        if image.get('mimeType') not in ['image/png','image/jpeg']:
            raise ValueError('预览纹理格式不受支持')
    textured = sum('baseColorTexture' in m.get('pbrMetallicRoughness',{}) for m in document.get('materials',[]))
    for material in document.get('materials',[]):
        info=material.get('pbrMetallicRoughness',{}).get('baseColorTexture')
        if info:
            texture=at(document.get('textures',[]),info['index'])
            at(images,texture.get('source'))
    if require_texture and (not images or not textured):
        raise ValueError('导出缺少基础颜色图片纹理')
    return {'bytes':size,'triangles':triangles,'embeddedImages':len(images),'texturedMaterials':textured}
