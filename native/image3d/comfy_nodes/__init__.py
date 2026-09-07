"""Trusted, job-local ComfyUI adapters for sequential unified-memory loading.

Uses pinned upstream functions; no network, arbitrary paths, or generated code.
"""
import gc
import json
import folder_paths
import nodes
import torch
import comfy.clip_vision
import comfy.model_management as memory
import comfy.sd


def release_models():
    memory.unload_all_models()
    gc.collect()
    memory.soft_empty_cache()


def trim_cache(phase):
    gc.collect()
    memory.soft_empty_cache()
    print('FORMA_MEMORY '+json.dumps({'phase':phase,
        'activeBytes':torch.mps.current_allocated_memory(),
        'driverBytes':torch.mps.driver_allocated_memory(),
        'recommendedMaxBytes':torch.mps.recommended_max_memory()}),flush=True)


class FormaConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{
            'checkpoint':(folder_paths.get_filename_list('checkpoints'),),
            'clip_vision':(folder_paths.get_filename_list('clip_vision'),),
            'ipadapter':(folder_paths.get_filename_list('ipadapter'),),
            'positive':('STRING',{'multiline':True}),
            'negative':('STRING',{'multiline':True}),
            'image':('IMAGE',),
        }}
    RETURN_TYPES=('CONDITIONING','CONDITIONING','EMBEDS','EMBEDS','FORMA_READY')
    FUNCTION='encode'
    CATEGORY='FormaDesk/local'

    def encode(self,checkpoint,clip_vision,ipadapter,positive,negative,image):
        path=folder_paths.get_full_path_or_raise('checkpoints',checkpoint)
        _,clip,_,_=comfy.sd.load_checkpoint_guess_config(
            path,output_model=False,output_clip=True,output_vae=False,output_clipvision=False)
        clip.clip_layer(-1)
        conditions=[]
        for text in [positive,negative]:
            cond,pooled=clip.encode_from_tokens(clip.tokenize(text),return_pooled=True)
            conditions.append([[cond.detach().cpu(),{'pooled_output':pooled.detach().cpu()}]])
        del clip,cond,pooled
        release_models()
        trim_cache('text-encoded')
        print('FORMA_TEXTURE_STAGE text-encoded-model-unloaded',flush=True)
        vision=comfy.clip_vision.load(folder_paths.get_full_path_or_raise('clip_vision',clip_vision))
        adapter=nodes.NODE_CLASS_MAPPINGS['IPAdapterModelLoader']().load_ipadapter_model(ipadapter)[0]
        pos,neg=nodes.NODE_CLASS_MAPPINGS['IPAdapterEncoder']().encode(adapter,image,1.0,clip_vision=vision)
        embeddings=(pos.detach().cpu(),neg.detach().cpu())
        del vision,adapter,pos,neg
        release_models()
        trim_cache('reference-encoded')
        print('FORMA_TEXTURE_STAGE reference-encoded-model-unloaded',flush=True)
        return (*conditions,*embeddings,True)


class FormaDiffusionModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'checkpoint':(folder_paths.get_filename_list('checkpoints'),),
                            'ready':('FORMA_READY',)}}
    RETURN_TYPES=('MODEL',)
    FUNCTION='load'
    CATEGORY='FormaDesk/local'

    def load(self,checkpoint,ready):
        if ready is not True:raise ValueError('Conditioning must finish before loading diffusion weights')
        path=folder_paths.get_full_path_or_raise('checkpoints',checkpoint)
        model,_,_,_=comfy.sd.load_checkpoint_guess_config(
            path,output_model=True,output_clip=False,output_vae=False,output_clipvision=False)
        trim_cache('diffusion-loaded')
        return (model,)


class FormaDecodeVAE:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'checkpoint':(folder_paths.get_filename_list('checkpoints'),),
                            'samples':('LATENT',)}}
    RETURN_TYPES=('VAE',)
    FUNCTION='load'
    CATEGORY='FormaDesk/local'

    def load(self,checkpoint,samples):
        release_models()
        path=folder_paths.get_full_path_or_raise('checkpoints',checkpoint)
        _,_,vae,_=comfy.sd.load_checkpoint_guess_config(
            path,output_model=False,output_clip=False,output_vae=True,output_clipvision=False)
        return (vae,)


class FormaIPModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'ipadapter':(folder_paths.get_filename_list('ipadapter'),),
                            'model':('MODEL',)}}
    RETURN_TYPES=('IPADAPTER',)
    FUNCTION='load'
    CATEGORY='FormaDesk/local'
    def load(self,ipadapter,model):
        result=nodes.NODE_CLASS_MAPPINGS['IPAdapterModelLoader']().load_ipadapter_model(ipadapter)
        trim_cache('ipadapter-loaded')
        return result


class FormaDepthModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'controlnet':(folder_paths.get_filename_list('controlnet'),),
                            'model':('MODEL',)}}
    RETURN_TYPES=('CONTROL_NET',)
    FUNCTION='load'
    CATEGORY='FormaDesk/local'
    def load(self,controlnet,model):
        original=nodes.NODE_CLASS_MAPPINGS['ControlNetLoader']().load_controlnet(controlnet)[0]
        # Core ModelPatcher._load_list keeps all original CPU Parameters alive
        # while moving modules. Move first with torch's recursive Module.to,
        # which releases old parameter storage as each layer is replaced.
        trim_cache('depth-before-transfer')
        original.control_model.to(memory.get_torch_device())
        result=(original,)
        trim_cache('depth-loaded')
        return result


NODE_CLASS_MAPPINGS={'FormaConditioning':FormaConditioning,
                     'FormaDiffusionModel':FormaDiffusionModel,'FormaDecodeVAE':FormaDecodeVAE,
                     'FormaIPModel':FormaIPModel,'FormaDepthModel':FormaDepthModel}
