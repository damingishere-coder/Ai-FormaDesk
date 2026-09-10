import * as THREE from "three";

// Frame only visible subject meshes. Keep scenery in the rendered scene.
export function subjectBounds(root: THREE.Object3D, corners?: THREE.Vector3[]) {
  if (corners) corners.length = 0;
  const allCorners: THREE.Vector3[] = [];
  const subject = new THREE.Box3(),
    all = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverseVisible((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.computeBoundingBox();
    const box = node.geometry.boundingBox
      ?.clone()
      .applyMatrix4(node.matrixWorld);
    if (!box || box.isEmpty()) return;
    all.union(box);
    let background = false;
    for (
      let parent: THREE.Object3D | null = node;
      parent && parent !== root;
      parent = parent.parent
    )
      background ||= /地面|地板|背景|floor|ground|backdrop|background/i.test(
        parent.name,
      );
    if (!background) subject.union(box);
    if (corners && node.geometry.boundingBox) {
      const local = node.geometry.boundingBox;
      for (const x of [local.min.x, local.max.x])
        for (const y of [local.min.y, local.max.y])
          for (const z of [local.min.z, local.max.z]) {
            const point = new THREE.Vector3(x, y, z).applyMatrix4(
              node.matrixWorld,
            );
            allCorners.push(point);
            if (!background) corners.push(point);
          }
    }
  });
  if (subject.isEmpty() && corners) corners.push(...allCorners);
  return subject.isEmpty() ? all : subject;
}

export function frameThumbnail(
  box: THREE.Box3,
  camera: THREE.PerspectiveCamera,
  subjectCorners?: THREE.Vector3[],
) {
  if (box.isEmpty()) return null;
  const target = box.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(1, 0.7, 1).normalize();
  const right = new THREE.Vector3()
    .crossVectors(new THREE.Vector3(0, 1, 0), direction)
    .normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  // Reserve 8% on each edge, fit both axes including each corner's depth.
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.84;
  const horizontal = vertical * camera.aspect;
  let distance = 0;
  const points = subjectCorners?.length ? subjectCorners : [];
  if (!points.length)
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z])
          points.push(new THREE.Vector3(x, y, z));
  for (const point of points) {
    const offset = point.clone().sub(target);
    distance = Math.max(
      distance,
      offset.dot(direction) +
        Math.max(
          Math.abs(offset.dot(right)) / horizontal,
          Math.abs(offset.dot(up)) / vertical,
        ),
    );
  }
  const radius = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6);
  distance = Math.max(distance, radius * 0.01);
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.up.set(0, 1, 0);
  camera.near = Math.max(radius / 10000, 1e-8);
  camera.far = Math.max(distance + radius * 100, camera.near * 1000);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return target;
}
