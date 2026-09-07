#!/usr/bin/env python3
"""Loopback-only Stage A artifact viewer. Exposes no job logs or other files."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
from pathlib import Path
from urllib.parse import unquote, urlsplit

HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>图生建模 · 阶段 A 验证</title>
<style>body{margin:0;background:#eef0ef;color:#25352f;font:16px system-ui}header{padding:22px 30px}main{display:grid;grid-template-columns:1fr 1.6fr;gap:20px;padding:0 30px}section{background:white;border-radius:18px;padding:20px}img{width:100%;max-height:70vh;object-fit:contain}#canvas{height:70vh}p{font-size:14px;color:#65736c}canvas{display:block}#status{padding:10px}</style>
<header>图生建模 · 阶段 A 验证<p>独立验证页。模型可旋转查看；此页面不代表跨类别效果验收通过。</p></header>
<main><section>输入图片<img src="/reference.png"></section><section>导出的 GLB<div id="canvas"></div><div id="status">正在读取模型…</div></section></main>
<script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
const host=document.querySelector('#canvas');const scene=new THREE.Scene();scene.background=new THREE.Color('#f3f5f3');
const camera=new THREE.PerspectiveCamera(38,1,.01,100);const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.append(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xffffff,0x9ba9a0,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(3,5,4);scene.add(light);
window.image3dEvidence={loaded:false,errors:[]};
new GLTFLoader().load('/scene.glb',g=>{scene.add(g.scene);const box=new THREE.Box3().setFromObject(g.scene);const center=box.getCenter(new THREE.Vector3());const size=box.getSize(new THREE.Vector3()).length();controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(size*.85,size*.4,size*1.3));camera.lookAt(center);let textures=0,triangles=0;g.scene.traverse(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.map)textures++;}});window.image3dEvidence={loaded:true,textures,triangles,errors:[]};document.querySelector('#status').textContent=`已载入 · ${triangles} 个三角面 · ${textures} 个图片纹理材质`;},undefined,e=>{window.image3dEvidence.errors.push(String(e));document.querySelector('#status').textContent='模型读取失败';});
const resize=()=>{renderer.setSize(host.clientWidth,host.clientHeight);camera.aspect=host.clientWidth/host.clientHeight;camera.updateProjectionMatrix();};new ResizeObserver(resize).observe(host);renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
window.addEventListener('pagehide',()=>{renderer.setAnimationLoop(null);scene.traverse(o=>{o.geometry?.dispose();for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){m.map?.dispose();m.dispose();}});controls.dispose();renderer.dispose();});
</script></html>'''


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--job',type=Path,required=True)
    p.add_argument('--three',type=Path,required=True)
    p.add_argument('--port',type=int,default=8876)
    args=p.parse_args()
    job,three=args.job.resolve(),args.three.resolve()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path=unquote(urlsplit(self.path).path)
            if path=='/':data=HTML.encode();mime='text/html; charset=utf-8'
            else:
                targets={'/scene.glb':(job/'textured.glb','model/gltf-binary'),'/reference.png':(job/'reference.png','image/png')}
                if path.startswith('/vendor/'):
                    target=(three/path.removeprefix('/vendor/')).resolve()
                    if not target.is_relative_to(three) or target.suffix!='.js':self.send_error(404);return
                    mime='text/javascript'
                elif path in targets:target,mime=targets[path]
                else:self.send_error(404);return
                try:data=target.read_bytes()
                except OSError:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def log_message(self,*_):pass
    print(f'http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()


if __name__=='__main__':main()
