"""Merge the pinned UNet-only LoRA one parameter at a time in a private model."""
import folder_paths
import nodes
import comfy.model_management as memory
import comfy.utils


class FormaMergedLoRA:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'model': ('MODEL',),
            'lora_name': (folder_paths.get_filename_list('loras'),),
            'strength_model': ('FLOAT', {'default': 1.0, 'min': 0.0, 'max': 1.0})}}
    RETURN_TYPES = ('MODEL',)
    FUNCTION = 'merge'
    CATEGORY = 'FormaDesk/local'

    def merge(self, model, lora_name, strength_model):
        # This graph owns a freshly loaded model, with no branch that needs the
        # original weights. Never retain full backup tensors just to undo LoRA.
        patched = nodes.LoraLoaderModelOnly().load_lora_model_only(model, lora_name, strength_model)[0]
        keys = list(patched.patches)
        if not keys: raise ValueError('固定 Lightning LoRA 没有可应用的 UNet 权重')
        if patched.backup: raise ValueError('LoRA 合并需要尚未修改的独占模型')
        for key in keys:
            weight = patched.patch_weight_to_device(key, device_to=memory.get_torch_device(), return_weight=True)
            comfy.utils.set_attr_param(patched.model, key, weight)
        patched.patches.clear()
        print(f'FORMA_LORA_MERGED {len(keys)} parameters; no original-weight backup', flush=True)
        memory.soft_empty_cache()
        return (patched,)
