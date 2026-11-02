import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTask, aggregate, renderMarkdown, citationReviewCsv } from '../../scripts/evals/scorer.js';

const task = {
  id: 'T99', title: '演示', category: 'file-processing', scenario: 'generic',
  expected_tools: ['a', 'b'], expected_artifacts: ['报告.docx'],
};

test('scoreTask 计算结构指标，语义指标保持 null', () => {
  const score = scoreTask({
    task, status: 'completed',
    calls: [{ tool_name: 'a', status: 'succeeded' }, { tool_name: 'x', status: 'failed' }],
    artifacts: [{ name: '报告.docx' }],
    artifactChecks: [{ name: '报告.docx', openable: true, hash_match: true }],
    citationTotal: 4, citationValid: 3,
  });
  assert.equal(score.success, true);
  assert.equal(score.tool_match_rate, 0.5);
  assert.equal(score.artifact_present_rate, 1);
  assert.equal(score.artifact_openable_rate, 1);
  assert.equal(score.hash_match_rate, 1);
  assert.equal(score.citation_validity_rate, 0.75);
  assert.equal(score.semantic_citation_accuracy, null);
  assert.equal(score.unsupported_assertion_rate, null);
});

test('scoreTask 支持场景自定义成功条件', () => {
  const ok = scoreTask({
    task: { ...task, scenario: 'budget' }, status: 'failed',
    extras: { success_ok: true, budget_report_present: true },
  });
  assert.equal(ok.success, true);
  assert.equal(ok.budget_report_present, true);
});

test('aggregate 汇总成功率、分类、泄漏与 token', () => {
  const results = [
    scoreTask({ task, status: 'completed', extras: { input_tokens: 10, output_tokens: 5, duration_ms: 100 } }),
    scoreTask({ task: { ...task, id: 'T98', category: 'security' }, status: 'failed',
      extras: { success_ok: false, cross_tenant_leaks: 1, duration_ms: 300 } }),
  ];
  const summary = aggregate(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.success_rate, 0.5);
  assert.equal(summary.by_category['file-processing'].success_rate, 1);
  assert.equal(summary.by_category.security.success_rate, 0);
  assert.equal(summary.cross_tenant_leaks, 1);
  assert.equal(summary.tokens.input, 10);
  assert.equal(summary.latency_ms.max, 300);
  assert.equal(summary.semantic_citation_accuracy, null);

  const md = renderMarkdown({ run: { suite: 'fake', run_id: 'r1', started_at: 'now', model_name: 'm' }, results, summary });
  assert.match(md, /语义引用准确率 \| null/);
  assert.match(md, /T99/);
  assert.match(citationReviewCsv(results), /pending_manual_review/);
});
