import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
const host = document.getElementById("viewer");
if (host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xe9e8e3);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xa2a19b, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-2, 3, 4);
  scene.add(sun);
  let model: THREE.Group | undefined,
    serial = 0;
  const status = document.getElementById("viewer-status")!,
    select = document.getElementById("viewer-select") as HTMLSelectElement;
  const dispose = (root: THREE.Object3D) => {
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>(),
      textures = new Set<THREE.Texture>();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          materials.add(m);
          for (const value of Object.values(m))
            if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
  };
  const load = async (url: string) => {
    const ticket = ++serial;
    status.textContent = "加载候选…";
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      if (ticket !== serial) {
        dispose(gltf.scene);
        return;
      }
      if (model) {
        scene.remove(model);
        dispose(model);
      }
      model = gltf.scene;
      scene.add(model);
      const box = new THREE.Box3().setFromObject(model),
        size = box.getSize(new THREE.Vector3()),
        center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      const extent = Math.max(size.x, size.y, size.z, 0.1);
      camera.position.set(extent * 0.3, extent * 0.25, extent * 2.2);
      controls.target.set(0, 0, 0);
      controls.update();
      let triangles = 0;
      model.traverse((o) => {
        if (o instanceof THREE.Mesh)
          triangles +=
            (o.geometry.index?.count ?? o.geometry.attributes.position.count) /
            3;
      });
      status.textContent = `${Math.round(triangles).toLocaleString()} 三角面 · 拖动旋转，滚轮缩放`;
    } catch (e) {
      status.textContent = "候选加载失败：" + String(e);
    }
  };
  fetch("summary.json")
    .then((r) => r.json())
    .then((rows: any[]) => {
      for (const row of rows.filter((r) => r.glb)) {
        const option = document.createElement("option");
        option.value = row.glb;
        option.textContent = row.sample;
        select.appendChild(option);
      }
      select.onchange = () => void load(select.value);
      if (select.value) void load(select.value);
    });
  const resize = new ResizeObserver(() => {
    const w = host.clientWidth,
      h = host.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  addEventListener(
    "pagehide",
    () => {
      serial++;
      resize.disconnect();
      controls.dispose();
      renderer.setAnimationLoop(null);
      if (model) dispose(model);
      renderer.dispose();
    },
    { once: true },
  );
}
