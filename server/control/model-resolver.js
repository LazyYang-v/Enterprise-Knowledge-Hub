// 任务模型解析：优先 preset.model_profile_id + credential_ref，缺失时回退环境变量。
import { getPreset } from './preset-repo.js';
import { getModelProfile, modelFromProfile } from './model-profile-repo.js';
import { resolveCredentialRef } from './credentials.js';

export function modelFromEnv(env = process.env){
  const baseUrl = env.EKH_AGENT_MODEL_BASE_URL;
  const modelName = env.EKH_AGENT_MODEL_NAME;
  if (!baseUrl || !modelName) return null;
  return {
    base_url: baseUrl,
    model_name: modelName,
    api_key: env.EKH_AGENT_MODEL_API_KEY || '',
  };
}

export async function resolveTaskModel(task, { env = process.env } = {}){
  if (task?.preset_id){
    const preset = await getPreset({ tenantId: task.tenant_id, presetId: task.preset_id });
    const profileId = preset?.model_profile_id;
    if (profileId){
      const profile = await getModelProfile({ tenantId: task.tenant_id, id: profileId });
      if (profile && profile.enabled && profile.base_url && profile.model_name){
        const credential = resolveCredentialRef(profile.credential_ref);
        return modelFromProfile(profile, credential);
      }
    }
  }
  return modelFromEnv(env);
}
