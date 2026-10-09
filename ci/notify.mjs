import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { api, REPO, redact } from './lib.mjs';

export async function reportIssue({sha='unresolved',succeeded=false,dryRun=false,report,runId=process.env.GITHUB_RUN_ID,fallback='toolchain/runtime-failure'},client=api) {
  const key=`<!-- stronghold-upstream:${sha} -->`;
  const issues=[];
  for(let page=1;;page++) {
    const rows=await client(`/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
    issues.push(...rows.filter(r=>!r.pull_request)); if(rows.length<100)break;
  }
  const existing=issues.find(r=>r.body?.includes(key));
  if(succeeded) {
    if(existing?.state==='open' && !dryRun) await client(`/repos/${REPO}/issues/${existing.number}`,{method:'PATCH',body:{state:'closed',state_reason:'completed'}});
    return dryRun?'dry-run':'success';
  }
  const code=report?.code || fallback;
  const breaking=code==='overlay-contract-break';
  const run=`https://github.com/${REPO}/actions/runs/${runId}`;
  const title=`[自动 APK] ${breaking?'破坏性更新':'构建/发布阻断'} ${sha.slice(0,8)} · ${code}`;
  const body=`${key}\n\n- 上游 SHA：\`${sha}\`\n- 类型：${breaking?'覆盖层契约不兼容（破坏性更新）':'测试、资源或基础设施故障；不判定为破坏性更新'}\n- 失败阶段：\`${report?.stage || code}\`\n- 分类：\`${code}\`\n- 运行：[Actions 日志与诊断产物](${run})\n\n\`\`\`text\n${redact(report?.message || '查看 Actions 失败步骤和诊断产物。').slice(0,4000).replace(/```/g,'') }\n\`\`\`\n\n未发布 APK，已有成功 Release 保留。重复监测仅更新本 Issue。`;
  if(existing) await client(`/repos/${REPO}/issues/${existing.number}`,{method:'PATCH',body:{title,body,state:'open'}});
  else await client(`/repos/${REPO}/issues`,{method:'POST',body:{title,body}});
  return code;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let report;
  for(const candidate of ['outputs/automation-failure.json','outputs/failure-report.json']) {
    try { report=JSON.parse(await fs.readFile(candidate,'utf8'));break; }catch { /* absent artifact */ }
  }
  const result=await reportIssue({sha:process.env.UPSTREAM_SHA || 'unresolved',succeeded:process.env.RUN_SUCCEEDED==='true',dryRun:process.env.DRY_RUN==='true',report,fallback:process.env.FAILURE_STAGE});
  console.log(`${result}: Issue notification completed`);
}
