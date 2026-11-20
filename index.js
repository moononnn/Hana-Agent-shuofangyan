// index.js — 「说方言」应用入口
//
// 负责四件事：
//   1. 把宿主给的数据目录交给 lib 层（SFY_DATA_DIR）
//   2. 把宿主的 resources 通道注入人格文件读写层（盘外读写的正门）
//   3. 拉一次宿主伙伴名单（带显示名）
//   4. 注册路由层与给模型查方言的工具
//
// ⚠ 不要在文件顶部静态 import lib/ 下的模块。
// lib/app-paths.js 在模块加载时就把 DATA_DIR 定死了，而顶部 import 在 apply 之前执行——
// 那时 SFY_DATA_DIR 还没设，它只能自己拼 homedir 路径，
// 拼出来可能是目录联接路径，宿主通道按真实路径判定会直接拒。
// 需要的模块都在 apply 里、设好 SFY_DATA_DIR 之后动态 import。

import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "shuo-fangyan";

export default defineApp(async (sdk) => {
  // ── 数据目录交接 ──
  process.env.SFY_DATA_DIR = sdk.dataDir;

  // ── 人格文件读写层注入宿主通道 ──
  // 人格文件在 <hana 主目录>/agents/<id>/AGENTS.md，App 沙箱读不到，
  // 正门是 ctx.resources（需要 app/resources.read 与 app/resources.write）。
  const { setPersonaResources } = await import("./lib/persona-io.js");
  setPersonaResources(sdk.resources || null);

  // ── 伙伴名单 ──
  // 宿主有现成名单（agent:list 带显示名），拉一次存着；
  // 没拉到时界面上的名字会退化成 id。
  // agent:list 默认只给「本 App 自己创建的伙伴」，那个分区是空的。
  // 必须显式要 scope: 'all' 才能看到用户的伙伴（见 lib/agents.js 的注释）。
  const { setHostAgentSource, refreshAgentsFromHost } = await import("./lib/agents.js");
  setHostAgentSource(sdk.agents?.list ? (req) => sdk.agents.list(req) : null);
  const cachedCount = await refreshAgentsFromHost();
  if (cachedCount) {
    await sdk.logger?.info?.(`说方言已启动，伙伴名单 ${cachedCount} 位`);
  } else {
    // 名单空不是致命错，但要在日志里留痕：页面那边会再试一次，最后退回列目录。
    await sdk.logger?.warn?.("说方言：开机没拉到伙伴名单（页面加载时会重试，仍为空则列目录兜底）");
  }

  // ── 模型目录 ──
  // 「学我说话」要调模型做总结。宿主给的 ctx 是冻结的，模型目录只能存在
  // lib/model-host.js 里；这里开机灌一次，页面真要用时如果还是空，那边会现拉一次。
  try {
    const { setHostModelCatalog } = await import("./lib/model-host.js");
    const catalog = await sdk.models?.list?.();
    const count = setHostModelCatalog(catalog?.models);
    await sdk.logger?.info?.(`说方言：模型目录 ${count} 个可用`);
  } catch (e) {
    await sdk.logger?.warn?.(`说方言：开机没拉到模型目录（${e?.message || e}）`);
  }

  // ── 路由层 ──
  const registerApi = (await import("./server/api.js")).default;
  await sdk.routes.register((app) => {
    registerApi(app, sdk);
  });

  // ── 开机对账 ──
  // 配置说开了、人格文件里却没有方言（或反过来），就是漂移。
  // 开机时按配置重写一遍，配置文件与伙伴人格永远对得上。
  // 注意：只处理配置里有的伙伴，不去动配置外的——
  // 过渡期里表情包应用还开着，它的方言块不该被这边抹掉。
  try {
    const { readDialectConfig } = await import("./lib/dialect-config.js");
    const { syncDialectToPersona } = await import("./lib/dialect-persona.js");
    const { currentTemplateText } = await import("./lib/style-template.js");
    const config = readDialectConfig();
    if (Object.keys(config.agents || {}).length) {
      const results = await syncDialectToPersona(config, { templateResolver: currentTemplateText });
      const failed = Object.entries(results).filter(([, r]) => !r?.ok);
      await sdk.logger?.info?.(
        `说方言：开机对账 ${Object.keys(results).length} 位，失败 ${failed.length} 位`
        + (failed.length ? `（${failed.map(([id, r]) => `${id}:${r?.error || '未知'}`).join('；')}）` : ''),
      );
    }
  } catch (e) {
    await sdk.logger?.warn?.(`说方言：开机对账失败（${e?.message || e}）`);
  }

  // ── 给别的应用查方言气质（跨应用服务）──
  // 表情包按方言气质给候选图重新打分用。走 bus 而不是 HTTP：
  // 宿主会给每次调用盖章 callerAppId，对方拿到的是「谁在问」，不是自己填的名字。
  // 只读，不改配置、不碰人格。
  const { resolveDialectBias } = await import("./lib/dialect-bias.js");
  try {
    await sdk.bus?.handle?.("dialect-bias", async (payload) => {
      return { ok: true, data: resolveDialectBias(payload?.agentId) };
    }, { allowCrossApp: true });
    await sdk.logger?.info?.("说方言：已开放 dialect-bias 给其他应用");
  } catch (e) {
    await sdk.logger?.warn?.(`说方言：开放 dialect-bias 失败（${e?.message || e}）`);
  }

  // ── 给模型查方言的工具 ──
  // 模型偶尔会问「我现在是什么口音」，这个工具让它自己查得到，
  // 不用猜、也不用用户去翻设置页。
  await sdk.tools.register({
    name: "shuo_fangyan_state",
    description: "查询当前伙伴的方言设置：现在带哪种口音、浓度如何。",
    parameters: { type: "object", properties: {} },
    execute: async (args) => {
      try {
        const agentId = String(args?.context?.agentId || '').trim();
        const setting = agentId ? getAgentDialectSetting(agentId) : null;
        if (!setting) {
          return {
            content: [{ type: "text", text: "当前伙伴没有配置方言，按普通话说话。" }],
          };
        }
        const d = getDialect(setting.dialect);
        return {
          content: [{
            type: "text",
            text: `当前伙伴的方言：${d?.name || setting.dialect}。`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `查方言失败：${e?.message || e}` }],
          isError: true,
        };
      }
    },
  });
});
