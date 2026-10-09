import fs from 'node:fs/promises';
import { api, REPO, redact } from './lib.mjs';

const sha = process.env.UPSTREAM_SHA || 'unresolved';
const key = `<!-- stronghold-upstream:${sha} -->`;
const succeeded = process.env.RUN_SUCCEEDED === 'true';
const dryRun = process.env.DRY_RUN === 'true';
const issues = [];
for (let page=1;;page++) {
  const rows=await api(`/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
  issues.push(...rows.filter(r=>!r.pull_request)); if(rows.length<100)break;
}
const existing=issues.find(r=>r.body?.includes(key));
if (succeeded) {
  if (existing?.state === 'open' && !dryRun) await api(`/repos/${REPO}/issues/${existing.number}`,{method:'PATCH',body:{state:'closed',state_reason:'completed'}});
  console.log(dryRun ? 'Dry run completed; no Release published' : 'Published successfully');
} else {
  let report;
  for (const candidate of ['outputs/automation-failure.json','outputs/failure-report.json']) {
    try { report=JSON.parse(await fs.readFile(candidate,'utf8')); break; } catch { /* absent artifact */ }
  }
  const code=report?.code || process.env.FAILURE_STAGE || 'toolchain/runtime-failure';
  const breaking=code==='overlay-contract-break';
  const run=`https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const title=`[自动 APK] ${breaking?'破坏性更新':'构建/发布阻断'} ${sha.slice(0,8)} · ${code}`;
  const body=`${key}\n\n- 上游 SHA：\`${sha}\`\n- 类型：${breaking?'覆盖层契约不兼容（破坏性更新）':'测试、资源或基础设施故障；不判定为破坏性更新'}\n- 失败阶段：\`${report?.stage || code}\`\n- 分类：\`${code}\`\n- 运行：[Actions 日志与诊断产物](${run})\n\n\`\`\`text\n${redact(report?.message || '查看 Actions 失败步骤和诊断产物。').slice(0,4000).replace(/```/g,'') }\n\`\`\`\n\n未发布 APK，已有成功 Release 保留。重复监测仅更新本 Issue。`;
  if(existing) await api(`/repos/${REPO}/issues/${existing.number}`,{method:'PATCH',body:{title,body,state:'open'}});
  else await api(`/repos/${REPO}/issues`,{method:'POST',body:{title,body}});
  console.log(`${code}: Issue reported`);
}
