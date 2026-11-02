// Skill 内容密钥扫描：只报告规则名，不返回命中内容。
const PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['assigned_secret', /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

export function scanSecrets(text, label = 'skill'){
  const src = String(text ?? '');
  const hits = [];
  for (const [name, re] of PATTERNS){
    if (re.test(src)) hits.push({ rule: name, file: label });
  }
  return hits;
}

export function assertNoSecrets(entries){
  const hits = [];
  for (const entry of entries){
    hits.push(...scanSecrets(entry.text, entry.label));
  }
  if (hits.length){
    const err = new Error(`Skill 内容疑似包含密钥（${hits.map(h => `${h.file}:${h.rule}`).join(', ')}）`);
    err.name = 'SkillSecretError';
    err.code = 'skill_secret_detected';
    err.hits = hits;
    throw err;
  }
}
