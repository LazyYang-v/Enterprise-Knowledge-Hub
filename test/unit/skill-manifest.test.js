import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSkillManifest, discoverSkillDirs, SkillManifestError,
} from '../../server/skills/manifest.js';
import { safeResolve, SkillPathError } from '../../server/skills/paths.js';
import { parseSkillRef, skillAvailability } from '../../server/skills/registry.js';

const ROOT = path.resolve(import.meta.dirname, '../../skills');

function copySkill(name){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ekh-skill-${name}-`));
  fs.cpSync(path.join(ROOT, name), dir, { recursive: true });
  return dir;
}

test('内置 Skill 通过 manifest 校验且哈希稳定', () => {
  const dirs = discoverSkillDirs(ROOT);
  assert.equal(dirs.length, 2);
  const names = dirs.map(d => loadSkillManifest(d).name).sort();
  assert.deepEqual(names, ['knowledge-research', 'spreadsheet-audit']);
  const dir = path.join(ROOT, 'knowledge-research');
  assert.equal(loadSkillManifest(dir).contentHash, loadSkillManifest(dir).contentHash);
});

test('内容变化会改变哈希；同版本内容变化由仓储拒绝（此处只验证哈希）', () => {
  const dir = copySkill('knowledge-research');
  const before = loadSkillManifest(dir);
  fs.appendFileSync(path.join(dir, 'SKILL.md'), '\n补充一行。\n');
  const after = loadSkillManifest(dir);
  assert.notEqual(before.contentHash, after.contentHash);
});

test('路径遍历、绝对路径与越界引用被拒绝', () => {
  const dir = copySkill('knowledge-research');
  assert.throws(() => safeResolve(dir, '../outside.md'), SkillPathError);
  assert.throws(() => safeResolve(dir, '/etc/passwd'), SkillPathError);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
  manifest.references = ['../secret.md'];
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(manifest));
  assert.throws(() => loadSkillManifest(dir), SkillPathError);
});

test('疑似密钥内容被拒绝，错误不包含密钥原文', () => {
  const dir = copySkill('knowledge-research');
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  fs.appendFileSync(path.join(dir, 'SKILL.md'), `\napi_key = "${secret}"\n`);
  assert.throws(
    () => loadSkillManifest(dir),
    e => /疑似包含密钥/.test(e.message) && !e.message.includes(secret),
  );
});

test('评测用例必须覆盖 normal/boundary/failure', () => {
  const dir = copySkill('knowledge-research');
  fs.writeFileSync(path.join(dir, 'evals/cases.json'), JSON.stringify([
    { id: 'a', kind: 'normal' }, { id: 'b', kind: 'normal' }, { id: 'c', kind: 'boundary' },
  ]));
  assert.throws(() => loadSkillManifest(dir), e => e instanceof SkillManifestError && /failure/.test(e.message));
});

test('skill ref 解析与可用性判断', () => {
  assert.deepEqual(parseSkillRef('knowledge-research@1.0.0'), { name: 'knowledge-research', version: '1.0.0' });
  assert.deepEqual(parseSkillRef('knowledge-research'), { name: 'knowledge-research' });
  assert.deepEqual(parseSkillRef({ id: 'x' }), { id: 'x' });

  const row = {
    status: 'active', risk_level: 'low',
    manifest_json: { required_tools: ['knowledge.search'] },
  };
  assert.equal(skillAvailability(row, ['knowledge.search']), null);
  assert.match(skillAvailability(row, []), /missing_tools/);
  assert.equal(skillAvailability({ ...row, risk_level: 'high' }, ['knowledge.search']), 'skill_high_risk');
  assert.equal(skillAvailability({ ...row, status: 'draft' }, ['knowledge.search']), 'skill_inactive');
});
