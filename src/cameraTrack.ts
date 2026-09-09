import {Matrix4,Quaternion,Vector3} from 'three';
import type {CameraSpec,Trajectory} from './types';
export function cameraAt(samples:Trajectory['samples'],time:number):CameraSpec {
 let index=0;while(index<samples.length-2&&samples[index+1].time<time)index++;
 const a=samples[index],b=samples[index+1],t=Math.min(1,Math.max(0,(time-a.time)/(b.time-a.time)));
 const position=new Vector3().fromArray(a.camera.position).lerp(new Vector3().fromArray(b.camera.position),t);
 const rotation=(c:CameraSpec)=>new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3().fromArray(c.position),new Vector3().fromArray(c.target),new Vector3().fromArray(c.up)));
 const q=rotation(a.camera).slerp(rotation(b.camera),t),distance=new Vector3().fromArray(a.camera.position).distanceTo(new Vector3().fromArray(a.camera.target))*(1-t)+new Vector3().fromArray(b.camera.position).distanceTo(new Vector3().fromArray(b.camera.target))*t;
 return {position:position.toArray(),target:position.clone().add(new Vector3(0,0,-distance).applyQuaternion(q)).toArray(),up:new Vector3(0,1,0).applyQuaternion(q).toArray(),fov:a.camera.fov+(b.camera.fov-a.camera.fov)*t,aspect:a.camera.aspect};
}
