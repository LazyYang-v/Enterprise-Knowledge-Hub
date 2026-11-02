import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_TOOLS, fileToolDescriptors, getFileTool } from '../../server/tools/file-tools.js';
import { normalizeToolDescriptor } from '../../server/tools/contract.js';
import { BUILTIN_TOOLS, getBuiltinTool } from '../../server/tools/builtins.js';

const EXPECTED = [
  'artifact.create', 'document.read', 'document.write', 'spreadsheet.read',
  'spreadsheet.write', 'archive.read', 'archive.create',
];

test('P0-5 文件工具契约：名称、版本、副作用与幂等', () => {
  const descriptors = fileToolDescriptors();
  assert.deepEqual(descriptors.map(d => d.name).sort(), [...EXPECTED].sort());
  assert.equal(new Set(descriptors.map(d => d.name)).size, descriptors.length);

  for (const raw of descriptors){
    const d = normalizeToolDescriptor(raw);
    assert.equal(d.version, '1.0.0');
    assert.equal(d.source, 'builtin');
    assert.equal(d.resource_scope, 'task');
    if (d.side_effect === 'read'){
      assert.equal(d.approval_policy, 'never');
      assert.equal(d.idempotency, 'none');
      assert.equal(d.sandbox_profile, 'read_only');
    } else {
      assert.equal(d.side_effect, 'write_workspace');
      assert.equal(d.approval_policy, 'risk_based');
      assert.equal(d.idempotency, 'required');
      assert.equal(d.sandbox_profile, 'workspace_write');
    }
  }

  for (const name of EXPECTED){
    assert.ok(getFileTool(name), `缺少工具 ${name}`);
    assert.ok(getBuiltinTool(name), `内置注册表缺少工具 ${name}`);
  }
  assert.equal(BUILTIN_TOOLS.filter(t => EXPECTED.includes(t.name)).length, EXPECTED.length);
});
