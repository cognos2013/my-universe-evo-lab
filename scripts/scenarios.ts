import { readFile, writeFile, stat } from 'node:fs/promises';
import { scenarioIds, getScenario } from '../src/scenarios/catalog.ts';
import { serializeScenario, deserializeScenario } from '../src/persistence/codec.ts';
import { sha256 } from '../src/simulation/core/canonical.ts';

const [command = 'list', arg, destination] = process.argv.slice(2);
try {
  if (command === 'list') {
    console.log('我的宇宙 · 场景配置（本命令不推进演化）');
    for (const id of scenarioIds) {
      const s = getScenario(id);
      console.log(`${s.id} | ${s.title} | ${s.planet.cellCount} 单元 | ${s.populations.reduce((n, p) => n + p.count, 0)} 初始个体`);
    }
  } else if (command === 'show' && arg) {
    console.log(JSON.stringify(getScenario(arg), null, 2));
  } else if (command === 'export' && arg && destination) {
    // Never overwrite an existing user export silently.
    await writeFile(destination, await serializeScenario(getScenario(arg)), { flag: 'wx' });
    console.log(`已导出 ${arg} → ${destination}`);
  } else if (command === 'validate' && arg) {
    if ((await stat(arg)).size > 1_000_000) throw new Error('场景文件超过 1 MB 上限');
    const scenario = await deserializeScenario(await readFile(arg, 'utf8'));
    console.log(`有效场景：${scenario.id}；规则 SHA-256：${await sha256(scenario.rules)}`);
  } else if (command === 'validate') {
    for (const id of scenarioIds) {
      const scenario = getScenario(id);
      const restored = await deserializeScenario(await serializeScenario(scenario));
      console.log(`PASS ${restored.id} · schema / 模型卡 / 序列化 · ${await sha256(restored.rules)}`);
    }
  } else {
    throw new Error('用法：npm run scenarios -- [list | show <id> | export <id> <新文件路径> | validate [文件路径]]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
