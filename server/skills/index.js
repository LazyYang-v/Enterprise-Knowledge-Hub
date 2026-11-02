// Skill 模块对外接口（惰性单例；Worker 只在有 Skill 的任务中动态加载）。
import path from 'node:path';
import { config } from '../config.js';
import { createSkillRegistry, P0_3_AVAILABLE_TOOLS, SkillSelectionError } from './registry.js';

let registry = null;

export function getSkillRegistry(){
  if (!registry){
    registry = createSkillRegistry({
      skillsDir: config.skills.dir || path.resolve(process.cwd(), 'skills'),
      instructionMaxChars: config.skills.instructionMaxChars,
    });
  }
  return registry;
}

export function resetSkillRegistry(){
  registry = null;
}

export async function selectTaskSkill(opts){
  return getSkillRegistry().select(opts);
}

export async function loadSkillInstructions(opts){
  return getSkillRegistry().loadInstructions(opts);
}

export async function bootstrapSkills(){
  return getSkillRegistry().reload();
}

export { P0_3_AVAILABLE_TOOLS, SkillSelectionError };
