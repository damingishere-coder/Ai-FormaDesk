"""Trusted video worker. All paths are fixed within the assigned job directory."""
import bpy, sys, os, json, math, time
from mathutils import Vector, Matrix
sys.path.insert(0,os.path.dirname(__file__))
from appearance import ensure_render_lighting
mode, root = sys.argv[sys.argv.index('--')+1:]
def file(name): return os.path.join(root,name)
def read(name):
    with open(file(name)) as f: return json.load(f)
def emit(value):
    target=file('progress.json')
    with open(target+'.tmp','w') as f: json.dump(value,f)
    os.replace(target+'.tmp',target)
if mode=='inspect':
    scene=bpy.context.scene
    editor=scene.sequence_editor_create()
    strip=editor.strips.new_movie('Validation',file('upload.video'),channel=1,frame_start=1)
    element=strip.elements[0]
    data={'width':element.orig_width,'height':element.orig_height,'fps':strip.fps,'duration':strip.frame_duration/max(strip.fps,1)}
    if data['width']<256 or data['height']<256 or data['width']>1920 or data['height']>1920 or data['duration']>61 or data['duration']<=0: raise ValueError('视频尺寸或时长不合法')
    with open(file('metadata.json'),'w') as f:json.dump(data,f)
else:
    trajectory=read('trajectory.json');settings=trajectory['settings'];samples=trajectory['samples'];fps=30
    bpy.ops.wm.open_mainfile(filepath=file('base.blend'),load_ui=False,use_scripts=False)
    scene=bpy.context.scene;scene.render.engine='BLENDER_EEVEE_NEXT';scene.render.resolution_x=settings['width'];scene.render.resolution_y=settings['height'];scene.render.resolution_percentage=100
    scene.render.film_transparent=False;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGB'
    ensure_render_lighting(scene)
    data=bpy.data.cameras.new('FormaVideoCamera');cam=bpy.data.objects.new('FormaVideoCamera',data);scene.collection.objects.link(cam);scene.camera=cam;data.sensor_fit='VERTICAL';data.sensor_height=24
    def cv(v):return Vector((v[0],-v[2],v[1]))
    def pose(c):
        pos=cv(c['position']);back=(pos-cv(c['target'])).normalized();right=cv(c['up']).normalized().cross(back).normalized();up=back.cross(right).normalized()
        return pos,Matrix(((right.x,up.x,back.x),(right.y,up.y,back.y),(right.z,up.z,back.z))).to_quaternion()
    poses=[pose(s['camera']) for s in samples];count=max(1,math.ceil(samples[-1]['time']*fps));os.makedirs(file('frames'),exist_ok=True);cursor=0;durations=[];reused=0
    for i in range(count):
        framefile=file('frames/%06d.png'%i)
        if not os.path.isfile(framefile):
            t=i/fps
            while cursor+1<len(samples)-1 and samples[cursor+1]['time']<t:cursor+=1
            a,b=samples[cursor],samples[cursor+1];f=max(0,min(1,(t-a['time'])/(b['time']-a['time'])))
            pos=poses[cursor][0].lerp(poses[cursor+1][0],f);q=poses[cursor][1].slerp(poses[cursor+1][1],f);cam.matrix_world=Matrix.LocRotScale(pos,q,Vector((1,1,1)))
            fov=a['camera']['fov']+(b['camera']['fov']-a['camera']['fov'])*f;data.lens=12/math.tan(math.radians(fov)/2)
            scene.render.filepath=framefile+'.partial';begin=time.monotonic();bpy.ops.render.render(write_still=True);os.replace(framefile+'.partial.png',framefile);durations.append(time.monotonic()-begin)
        else:reused+=1
        emit({'completed':i+1,'total':count,'remainingSeconds':(sum(durations[-10:])/len(durations[-10:])*(count-i-1)) if durations else 0})
    print("FORMA_VIDEO_REUSED_FRAMES",reused,flush=True)
    # Encode existing frames in a separate scene so sequencing does not alter the saved model.
    output=bpy.data.scenes.new('FormaVideoOutput');bpy.context.window.scene=output
    output.render.resolution_x=settings['width'];output.render.resolution_y=settings['height'];output.render.resolution_percentage=100;output.render.fps=fps
    output.view_settings.view_transform='Standard';output.view_settings.look='None'
    editor=output.sequence_editor_create();strip=editor.strips.new_image('Frames',file('frames/000000.png'),channel=1,frame_start=1)
    for i in range(1,count):strip.elements.append('%06d.png'%i)
    output.frame_start=1;output.frame_end=count;output.render.image_settings.file_format='FFMPEG';output.render.ffmpeg.format='MPEG4';output.render.ffmpeg.codec='H264';output.render.ffmpeg.constant_rate_factor='HIGH';output.render.ffmpeg.audio_codec='NONE';output.render.filepath=file('video.mp4')
    bpy.ops.render.render(animation=True)
print('FORMA_VIDEO_OK')
