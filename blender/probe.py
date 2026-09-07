import os,json,socket,bpy
# Paths are harmless canaries created by the host, never actual private files.
directory=os.getcwd()
with open(os.path.join(directory,'probe-input.json')) as f:p=json.load(f)
r={}
for key,action in [('read',lambda:open(p['read']).read()),('write',lambda:open(p['write'],'w').write('escape')),('network',lambda:socket.create_connection(('127.0.0.1',p['port']),timeout=2)),('externalNetwork',lambda:socket.create_connection(('1.1.1.1',443),timeout=2))]:
    try:action();r[key]={'blocked':False}
    except PermissionError as e:r[key]={'blocked':True,'errno':e.errno}
    except OSError as e:r[key]={'blocked':e.errno in (1,13),'errno':e.errno,'detail':str(e)}
r['credentialsAbsent']=not any(k in os.environ for k in ['OPENAI_API_KEY','CODEX_HOME','HTTP_PROXY','HTTPS_PROXY'])
with open(os.path.join(directory,'probe-result.json'),'w') as f:json.dump(r,f)
print('FORMA_SANDBOX_PROBE',json.dumps(r))
