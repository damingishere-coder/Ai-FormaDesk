"""Blender-first project library. Open validated local sources using native file handling."""
bl_info = {'name':'FormaDesk 我的作品','author':'FormaDesk','version':(1,1,0),'blender':(4,5,0),'location':'顶部栏 > 我的作品','description':'在 Blender 中直接打开本机作品源文件和动画工程','category':'System'}
import bpy
import bpy.utils.previews
import json, sys, threading, queue, time, subprocess, urllib.request, urllib.error, urllib.parse, http.cookiejar
from pathlib import Path
from bpy.props import StringProperty, BoolProperty
_state={'projects':[], 'busy':False, 'online':False, 'message':'', 'generation':0, 'data_root':None}
_results=queue.Queue()
_icons=None
_registered=False
_config={}
_original_splash=None
_draw_regions={}

def _read_config():
    global _config
    if isinstance(_config.get('cache'),str):return
    candidates=[Path(__file__).with_name('config.json'),Path(__file__).resolve().parents[2]/'data/project-library/config.json']
    for p in candidates:
        try:
            value=json.loads(p.read_text())
            if isinstance(value,dict) and isinstance(value.get('cache'),str):
                _config=value;return
        except (OSError,ValueError):pass
    _state['message']='请先安装工作台作品入口配置。'

def _project_list(data):
    if not isinstance(data,dict) or not isinstance(data.get('projects'),list):raise ValueError('作品缓存格式无效')
    projects=[]
    for p in data['projects']:
        if not isinstance(p,dict) or not all(isinstance(p.get(k),str) for k in ('id','name')):continue
        value=dict(p)
        for k in ('coverPath','updatedAt','createdAt'):
            if not isinstance(value.get(k),str):value[k]=''
        files=p.get('files',[])
        value['files']=[f for f in files if isinstance(f,dict) and all(isinstance(f.get(k),str) for k in ('id','name','format','kind'))] if isinstance(files,list) else []
        projects.append(value)
    return projects

def _read_cache():
    try:
        p=Path(_config['cache']);data=json.loads(p.read_text())
        _state['projects']=_project_list(data)
        _state['data_root']=data.get('dataRoot')
    except (OSError,ValueError,KeyError):pass

def _connection():
    try:
        value=json.loads(Path(_config['cache']).with_name('connection.json').read_text())
        return value if isinstance(value,dict) else {}
    except (KeyError,OSError,ValueError):return {}

def _base():
    value=_connection().get('baseUrl',_config.get('baseUrl','http://127.0.0.1:8765'))
    parsed=urllib.parse.urlparse(value)
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost') or parsed.username or parsed.password:raise ValueError('只允许连接本机工作台')
    return value.rstrip('/')

def _client():
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    headers={'X-Forma-Library':_connection().get('token','')}
    with opener.open(urllib.request.Request(_base()+'/api/session',headers=headers),timeout=4) as r:token=json.load(r)['token']
    def call(route,body=None):
        req=urllib.request.Request(_base()+'/api'+route,data=None if body is None else json.dumps(body).encode(),headers={**headers,'Content-Type':'application/json','X-Forma-Session':token})
        try:
            with opener.open(req,timeout=45) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            try:message=json.load(e).get('error','工作台操作失败')
            except Exception:message='工作台操作失败'
            raise RuntimeError(message) from None
    return call

def _launch():
    launcher=Path(_connection().get('launcher',_config.get('launcher','')))
    if not ((launcher.is_file() and launcher.suffix=='.command') or (launcher.is_dir() and launcher.suffix=='.app')):raise RuntimeError('找不到工作台启动器，请检查插件配置')
    subprocess.Popen(['/usr/bin/open',str(launcher)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def _request(route='/library',body=None,start=False,after=None):
    if _state['busy']:return
    _state['busy']=True;_state['message']='正在启动工作台…' if start else '正在刷新作品列表…'
    generation=_state['generation']
    def work():
        connected=False
        try:
            if start:
                _launch();deadline=time.monotonic()+40
                while True:
                    try:call=_client();break
                    except Exception:
                        if time.monotonic()>=deadline:raise RuntimeError('工作台尚未启动，请查看启动窗口后点击刷新')
                        time.sleep(1)
            else:call=_client()
            connected=True
            value=call(route,body)
            if after:call(after,{})
            data=value if route=='/library' and not after else call('/library')
            _results.put((generation,True,data,'作品列表已更新' if route=='/library' and not after else '已打开，请查看 Blender 或访达窗口'))
        except Exception as e:
            _results.put((generation,connected,None,str(e) if isinstance(e,RuntimeError) else '服务未连接，可直接打开本地缓存中的源文件。'))
    threading.Thread(target=work,daemon=True).start()

def _remember_region(context):
    region=context.region
    if region:
        _draw_regions[region.as_pointer()]=region

def _redraw():
    for key,region in list(_draw_regions.items()):
        try:region.tag_redraw()
        except ReferenceError:_draw_regions.pop(key,None)
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:area.tag_redraw()

def _tick():
    if not _registered:return None
    changed=False
    while not _results.empty():
        gen,ok,data,msg=_results.get()
        if gen!=_state['generation']:continue
        _state.update(busy=False,online=ok,message=msg)
        if data is not None:
            try:
                _state['projects']=_project_list(data)
                _state['data_root']=data.get('dataRoot')
            except ValueError:_state['message']='作品列表格式无效，请刷新工作台后重试。'
        changed=True
    if changed:_redraw()
    return .3

def _icon(p):
    name=p.get('coverPath')
    if not name or _icons is None or not Path(name).is_file():return 0
    try:
        if name not in _icons:_icons.load(name,name,'IMAGE')
        return _icons[name].icon_id
    except Exception:return 0

def _projects(context):
    wm=context.window_manager;term=wm.forma_library_search.strip().casefold()
    return [p for p in _state['projects'] if term in p.get('name','').casefold() and (not wm.forma_library_favorites or p.get('favorite'))]

def _draw_home(layout,context):
    _remember_region(context)
    wm=context.window_manager
    row=layout.row(align=True);row.prop(wm,'forma_library_search',text='',icon='VIEWZOOM');row.prop(wm,'forma_library_favorites',text='收藏',icon='HEART')
    row.operator('forma.library_refresh',text='刷新',icon='FILE_REFRESH')
    if not _state['online']:row.operator('forma.library_start',text='打开辅助工作台',icon='PLAY')
    if _state['message']:
        line=layout.row();line.alert=not _state['online'] and not _state['busy'];line.label(text=_state['message'][:100],icon='INFO')
    ps=_projects(context)
    layout.label(text='我的作品 · %d'%len(ps))
    page=max(0,min(wm.forma_library_page,max(0,(len(ps)-1)//6)))
    grid=layout.grid_flow(row_major=True,columns=3,even_columns=True,even_rows=True)
    for p in ps[page*6:(page+1)*6]:
        col=grid.box().column(align=True);icon=_icon(p)
        if icon:col.template_icon(icon_value=icon,scale=7)
        else:col.label(text='尚未建模' if not p.get('currentRevisionId') else '暂无封面',icon='MESH_CUBE')
        col.label(text=p['name'][:32]);col.label(text=(p.get('updatedAt') or p.get('createdAt',''))[:10])
        row=col.row(align=True)
        op=row.operator('forma.library_open',text='打开源文件',icon='FILE_BLEND');op.project_id=p['id']
        op=row.operator('forma.library_files',text='文件',icon='FILE_FOLDER');op.project_id=p['id']
    if not ps:layout.label(text='没有匹配作品。可在工作台中新建作品。',icon='INFO')
    if len(ps)>6:
        row=layout.row(align=True);row.operator('forma.library_page',text='上一页').direction=-1
        row.label(text='%d / %d'%(page+1,(len(ps)+5)//6));row.operator('forma.library_page',text='下一页').direction=1
    layout.separator();layout.label(text='直接在 Blender 中打开源文件；未保存修改由 Blender 提示处理。',icon='BLENDER')

class FORMA_OT_home(bpy.types.Operator):
    bl_idname='forma.library_home';bl_label='FormaDesk · 我的作品'
    def invoke(self,context,event):
        _read_cache();_request()
        return context.window_manager.invoke_props_dialog(self,width=850,confirm_text='关闭')
    def draw(self,context):_draw_home(self.layout,context)
    def execute(self,context):return {'FINISHED'}

class FORMA_OT_refresh(bpy.types.Operator):
    bl_idname='forma.library_refresh';bl_label='刷新作品列表';bl_options={'INTERNAL'}
    def execute(self,context):_read_cache();_request();return {'FINISHED'}

class FORMA_OT_start(bpy.types.Operator):
    bl_idname='forma.library_start';bl_label='打开辅助工作台';bl_options={'INTERNAL'}
    def execute(self,context):_request(start=True);return {'FINISHED'}

class FORMA_OT_page(bpy.types.Operator):
    bl_idname='forma.library_page';bl_label='切换作品页';bl_options={'INTERNAL'}
    direction:bpy.props.IntProperty(default=1)
    def execute(self,context):
        wm=context.window_manager;wm.forma_library_page=max(0,min(wm.forma_library_page+self.direction,max(0,(len(_projects(context))-1)//6)))
        return {'FINISHED'}

def _local_file(project_id,file_id=''):
    # Re-read the latest atomic cache so removed works and changed versions are respected.
    _read_cache()
    p=next((p for p in _state['projects'] if p['id']==project_id),None)
    if not p:raise RuntimeError('作品已移除，请刷新列表')
    if p.get('activeJob'):raise RuntimeError('作品正在处理，请等待当前任务完成')
    f=next((f for f in p['files'] if f['id']==file_id),None) if file_id else next((f for f in p['files'] if f['kind']=='model' and f['format']=='BLEND' and f.get('current')),None)
    if not f:raise RuntimeError('此作品还没有可打开的源文件，请先完成建模')
    name=f.get('localPath');root=_state.get('data_root')
    if not name or not root:raise RuntimeError('作品缓存需要更新，请刷新列表后重试')
    target=Path(name).resolve();data_root=Path(root).resolve()
    configured_root=Path(_config['cache']).resolve().parent.parent
    if data_root!=configured_root or not target.is_relative_to(data_root):raise RuntimeError('源文件不在作品目录内')
    if not f.get('available') or not target.is_file():raise RuntimeError('源文件已移动或缺失，请恢复文件后重试')
    return f,target

class FORMA_OT_open(bpy.types.Operator):
    bl_idname='forma.library_open';bl_label='在 Blender 中打开源文件';bl_options={'INTERNAL'}
    project_id:StringProperty();file_id:StringProperty()
    def execute(self,context):
        try:
            f,target=_local_file(self.project_id,self.file_id)
            if f['format']!='BLEND' or target.suffix.lower()!='.blend':raise RuntimeError('请选择 Blender 源文件')
        except RuntimeError as e:
            self.report({'ERROR'},str(e));_state['message']=str(e);return {'CANCELLED'}
        # Leave the library popup first. INVOKE_DEFAULT retains Blender's native
        # save/discard/cancel handling; EXEC_DEFAULT would lose unsaved edits.
        window=context.window
        def open_source():
            try:
                with bpy.context.temp_override(window=window):
                    bpy.ops.wm.open_mainfile('INVOKE_DEFAULT',filepath=str(target),display_file_selector=False,load_ui=False,use_scripts=False)
                _state['message']='已请求打开源文件，请完成 Blender 的保存提示（如有）。'
            except Exception as e:_state['message']='打开源文件失败：'+str(e)
            _redraw()
            return None
        bpy.app.timers.register(open_source,first_interval=.1)
        return {'FINISHED'}

class FORMA_OT_reveal(bpy.types.Operator):
    bl_idname='forma.library_reveal';bl_label='在访达中显示';bl_options={'INTERNAL'}
    project_id:StringProperty();file_id:StringProperty()
    def execute(self,context):
        try:
            _,target=_local_file(self.project_id,self.file_id)
            subprocess.Popen(['/usr/bin/open','-R',str(target)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        except (RuntimeError,OSError) as e:
            self.report({'ERROR'},str(e));return {'CANCELLED'}
        return {'FINISHED'}

class FORMA_OT_files(bpy.types.Operator):
    bl_idname='forma.library_files';bl_label='作品文件';bl_options={'INTERNAL'}
    project_id:StringProperty()
    def invoke(self,context,event):return context.window_manager.invoke_props_dialog(self,width=660,confirm_text='关闭')
    def draw(self,context):
        _remember_region(context)
        p=next((p for p in _state['projects'] if p['id']==self.project_id),None)
        if not p:self.layout.label(text='作品已移除');return
        self.layout.label(text=p['name']);files=p.get('files',[])
        if not files:self.layout.label(text='还没有生成文件')
        for kind,label in [('model','模型'),('animation','动画工程'),('image','图片'),('video','视频')]:
            group=[f for f in files if f['kind']==kind]
            if not group:continue
            self.layout.label(text=label)
            for f in group:
                col=self.layout.box().column();col.label(text=f['name']+' · '+f['format'])
                if not f['available']:col.label(text='文件已移动或缺失',icon='ERROR');continue
                row=col.row(align=True)
                if f['format']=='BLEND':
                    op=row.operator('forma.library_open',text='打开');op.project_id=self.project_id;op.file_id=f['id']
                op=row.operator('forma.library_reveal',text='在访达中显示');op.project_id=self.project_id;op.file_id=f['id']
        if _state['message']:self.layout.label(text=_state['message'][:100],icon='INFO')
    def execute(self,context):return {'FINISHED'}

class FORMA_PT_library(bpy.types.Panel):
    bl_label='我的作品';bl_idname='FORMA_PT_project_library';bl_space_type='VIEW_3D';bl_region_type='UI';bl_category='作品'
    def draw(self,context):
        self.layout.operator('forma.library_home',text='打开作品库',icon='FILE_FOLDER')
        self.layout.operator('forma.library_start',text='打开辅助工作台',icon='PLAY')
        if _state['message']:self.layout.label(text=_state['message'][:35])

classes=(FORMA_OT_home,FORMA_OT_refresh,FORMA_OT_start,FORMA_OT_page,FORMA_OT_open,FORMA_OT_reveal,FORMA_OT_files,FORMA_PT_library)
def _menu(self,context):self.layout.operator('forma.library_home',text='我的作品',icon='FILE_FOLDER')
def _welcome():
    global _original_splash
    if _original_splash is not None:
        bpy.context.preferences.view.show_splash=_original_splash
        _original_splash=None
    if not _registered:return None
    if bpy.app.background or bpy.data.filepath or any(str(a).lower().endswith(('.blend','.blend1')) for a in sys.argv):return None
    # Suppress the built-in splash for this launch without persisting a preference change.
    windows=bpy.context.window_manager.windows
    if not windows:return .5
    window=windows[0]
    with bpy.context.temp_override(window=window):bpy.ops.forma.library_home('INVOKE_DEFAULT')
    return None

def register():
    global _registered,_icons,_original_splash
    if _registered:return
    for cls in classes:bpy.utils.register_class(cls)
    bpy.types.WindowManager.forma_library_search=StringProperty(name='搜索作品')
    bpy.types.WindowManager.forma_library_favorites=BoolProperty(name='只看收藏')
    bpy.types.WindowManager.forma_library_page=bpy.props.IntProperty(default=0,min=0)
    bpy.types.TOPBAR_MT_editor_menus.append(_menu)
    _icons=bpy.utils.previews.new();_registered=True;_state['generation']+=1
    _read_config();_read_cache()
    bpy.app.timers.register(_tick,first_interval=.5,persistent=True)
    if not bpy.app.background:
        if not any(str(a).lower().endswith(('.blend','.blend1')) for a in sys.argv):
            _original_splash=bpy.context.preferences.view.show_splash
            bpy.context.preferences.view.show_splash=False
        bpy.app.timers.register(_welcome,first_interval=2.5,persistent=True)

def unregister():
    global _registered,_icons,_original_splash
    if _original_splash is not None:
        bpy.context.preferences.view.show_splash=_original_splash
        _original_splash=None
    _draw_regions.clear()
    _registered=False;_state['generation']+=1
    for callback in (_tick,_welcome):
        if bpy.app.timers.is_registered(callback):bpy.app.timers.unregister(callback)
    bpy.types.TOPBAR_MT_editor_menus.remove(_menu)
    for name in ('forma_library_search','forma_library_favorites','forma_library_page'):
        if hasattr(bpy.types.WindowManager,name):delattr(bpy.types.WindowManager,name)
    for cls in reversed(classes):bpy.utils.unregister_class(cls)
    if _icons is not None:bpy.utils.previews.remove(_icons);_icons=None
