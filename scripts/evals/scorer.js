// 评测评分：只计算可自动验证的结构指标；语义指标保持 null，不伪造。
export function scoreTask({
  task, status, calls = [], artifacts = [], artifactChecks = [],
  citationTotal = 0, citationValid = 0, expectedTools = null, extras = {},
} = {}){
  const expected = expectedTools || task?.expected_tools || [];
  const executed = new Set(calls.filter(c => c.status === 'succeeded').map(c => c.tool_name));
  const toolHits = expected.filter(name => executed.has(name));
  const expectedArtifacts = task?.expected_artifacts || [];
  const present = new Set(artifacts.map(a => a.name));
  const artifactHits = expectedArtifacts.filter(name => present.has(name));
  const checks = Array.isArray(artifactChecks) ? artifactChecks : [];
  const openable = checks.filter(c => c.openable);
  const hashOk = checks.filter(c => c.hash_match);

  return {
    id: task?.id || null,
    title: task?.title || '',
    category: task?.category || '',
    scenario: task?.scenario || 'generic',
    status: status || 'unknown',
    success: extras.success_ok != null ? !!extras.success_ok : status === 'completed',
    tool_match_rate: expected.length ? toolHits.length / expected.length : null,
    expected_tools: expected,
    executed_tools: [...executed],
    artifact_present_rate: expectedArtifacts.length ? artifactHits.length / expectedArtifacts.length : null,
    artifacts_expected: expectedArtifacts,
    artifacts_present: artifacts.map(a => a.name),
    artifact_openable_rate: checks.length ? openable.length / checks.length : null,
    hash_match_rate: checks.length ? hashOk.length / checks.length : null,
    citation_validity_rate: citationTotal > 0 ? citationValid / citationTotal : null,
    semantic_citation_accuracy: null,
    unsupported_assertion_rate: null,
    cross_tenant_leaks: Number(extras.cross_tenant_leaks || 0),
    idempotency_effects: extras.idempotency_effects ?? null,
    budget_report_present: extras.budget_report_present ?? null,
    rate_limit_429: Number(extras.rate_limit_429 || 0),
    input_tokens: Number(extras.input_tokens || 0),
    output_tokens: Number(extras.output_tokens || 0),
    token_estimated: !!extras.token_estimated,
    model_calls: Number(extras.model_calls || 0),
    tool_calls: Number(extras.tool_calls || 0),
    duration_ms: Number(extras.duration_ms || 0),
    notes: Array.isArray(extras.notes) ? extras.notes : [],
  };
}

function mean(values){
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function percentile(values, p){
  const nums = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

export function aggregate(results = []){
  const total = results.length;
  const completed = results.filter(r => r.success).length;
  const byCategory = {};
  for (const r of results){
    const c = r.category || 'unknown';
    byCategory[c] = byCategory[c] || { total: 0, completed: 0 };
    byCategory[c].total += 1;
    if (r.success) byCategory[c].completed += 1;
  }
  for (const v of Object.values(byCategory)) v.success_rate = v.total ? v.completed / v.total : null;

  const openable = results.flatMap(r => (r.artifact_openable_rate == null ? [] : [r.artifact_openable_rate]));
  const hash = results.flatMap(r => (r.hash_match_rate == null ? [] : [r.hash_match_rate]));
  const citations = results.flatMap(r => (r.citation_validity_rate == null ? [] : [r.citation_validity_rate]));
  return {
    total,
    completed,
    success_rate: total ? completed / total : null,
    by_category: byCategory,
    tool_match_rate: mean(results.map(r => r.tool_match_rate)),
    citation_validity_rate: mean(citations),
    semantic_citation_accuracy: null,
    unsupported_assertion_rate: null,
    artifact_openable_rate: mean(openable),
    hash_match_rate: mean(hash),
    cross_tenant_leaks: results.reduce((n, r) => n + Number(r.cross_tenant_leaks || 0), 0),
    idempotency_effects: results.filter(r => r.idempotency_effects != null)
      .map(r => ({ id: r.id, effects: r.idempotency_effects })),
    budget_reports: results.filter(r => r.budget_report_present === true).map(r => r.id),
    rate_limit_429: results.reduce((n, r) => n + Number(r.rate_limit_429 || 0), 0),
    tokens: {
      input: results.reduce((n, r) => n + Number(r.input_tokens || 0), 0),
      output: results.reduce((n, r) => n + Number(r.output_tokens || 0), 0),
      estimated_tasks: results.filter(r => r.token_estimated).map(r => r.id),
    },
    latency_ms: {
      avg: mean(results.map(r => r.duration_ms)),
      p95: percentile(results.map(r => r.duration_ms), 95),
      max: results.length ? Math.max(...results.map(r => Number(r.duration_ms || 0))) : null,
    },
    metric_notes: [
      'semantic_citation_accuracy 与 unsupported_assertion_rate 未自动测量，保持 null；需人工复核 citation-review.csv 或接入裁判模型。',
      '结构有效不等于语义正确；token 在 provider 未返回 usage 时为字符估算并标记。',
    ],
  };
}

export function renderMarkdown({ run, results, summary }){
  const lines = [];
  lines.push(`# P0 评测报告（${run.suite}）`);
  lines.push('');
  lines.push(`- run_id: \`${run.run_id}\``);
  lines.push(`- 开始: ${run.started_at}`);
  lines.push(`- 模型: ${run.model_name || 'n/a'} (${run.base_url_host || 'n/a'})`);
  lines.push(`- 任务数: ${summary.total}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  const pct = v => (v == null ? 'null' : `${(v * 100).toFixed(1)}%`);
  lines.push(`| 成功率 | ${pct(summary.success_rate)} |`);
  lines.push(`| 工具匹配率 | ${pct(summary.tool_match_rate)} |`);
  lines.push(`| 引用结构有效率 | ${pct(summary.citation_validity_rate)} |`);
  lines.push(`| 语义引用准确率 | null（未测量） |`);
  lines.push(`| 无依据断言率 | null（未测量） |`);
  lines.push(`| 成果可打开率 | ${pct(summary.artifact_openable_rate)} |`);
  lines.push(`| 哈希一致率 | ${pct(summary.hash_match_rate)} |`);
  lines.push(`| 跨租户泄漏 | ${summary.cross_tenant_leaks} |`);
  lines.push(`| 限流 429 | ${summary.rate_limit_429} |`);
  lines.push('');
  lines.push('## 任务');
  lines.push('');
  lines.push('| ID | 场景 | 状态 | 成功 | 工具匹配 | 成果 | 备注 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results){
    lines.push(`| ${r.id} | ${r.scenario} | ${r.status} | ${r.success ? '✅' : '❌'} | ${r.tool_match_rate == null ? '-' : pct(r.tool_match_rate)} | ${r.artifacts_present.join(', ') || '-'} | ${r.notes.join('; ') || ''} |`);
  }
  lines.push('');
  lines.push('> 语义指标未自动测量：结构有效 ≠ 语义正确。');
  return lines.join('\n');
}

export function citationReviewCsv(results = []){
  const rows = [['task_id', 'citation_validity_rate', 'review_status', 'reviewer_note']];
  for (const r of results){
    rows.push([
      r.id,
      r.citation_validity_rate == null ? 'no_citations' : r.citation_validity_rate.toFixed(4),
      'pending_manual_review',
      '',
    ]);
  }
  return rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
}
