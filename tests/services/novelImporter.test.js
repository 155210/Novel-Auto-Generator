import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as TXT from '../../txtToWorldbook/services/presetImportService.js';

// novelImporter/core.js 是浏览器端 IIFE，不碰 DOM，直接 eval 后取全局对象
function loadCore() {
    const src = readFileSync(new URL('../../novelImporter/core.js', import.meta.url), 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    return globalThis.NovelImporterCore;
}

const C = loadCore();

// 和用户的记忆表格模板同结构（精简了列）
const TEMPLATE = C.parseTableTemplate({
    tableStructure: [
        { tableName: '时空表格', enable: true, columns: ['日期', '时间', '地点（当前描写）', '此地角色'] },
        { tableName: '角色特征表格', enable: true, columns: ['角色名', '身体特征', '性格', '职业'] },
        { tableName: '角色与<user>社交表格', enable: true, columns: ['角色名', '对<user>关系', '对<user>态度'] },
        { tableName: '事件历史', enable: true, columns: ['事件', '日期', '地点', '情绪'] },
        { tableName: '大总结', enable: true, columns: ['内容'] },
        { tableName: '新模板_w7Xf', enable: false, columns: [null] },
    ],
});

function reply({ title = '标题', summary = '摘要', patches = '', judge, alias = '', wb = {}, tb = {}, rewritten, big }) {
    const parts = [`<bt>${title}</bt>`, `<摘要>${summary}</摘要>`];
    if (rewritten !== undefined) parts.push(`<改写正文>${rewritten}</改写正文>`);
    else parts.push(`<补丁>\n${patches}\n</补丁>`);
    parts.push(`<改写判定>${JSON.stringify(judge || { 触发: false, 规则: '', 说明: '', 回归原文: false })}</改写判定>`);
    parts.push(`<称呼>${alias}</称呼>`);
    parts.push(`<世界书>${JSON.stringify(wb)}</世界书>`);
    parts.push(`<表格>${JSON.stringify(tb)}</表格>`);
    if (big !== undefined) parts.push(`<大总结>${big}</大总结>`);
    return parts.join('\n');
}

describe('清洗与分层', () => {
    it('去掉广告行和紧挨着的广告标题', () => {
        const raw = '正文一。\n修仙界只有妖女了是吗\n请收藏：\nwww.example.com\n正文二。';
        const r = C.cleanText(raw, C.DEFAULT_AD_PATTERNS, true);
        expect(r.text.split('\n').filter(Boolean)).toEqual(['正文一。', '正文二。']);
    });

    it('夹在分隔线中间的章节标题不会被当成广告标题删掉', () => {
        const body = '路长远推门走进古庙，雨水顺着伞骨往下滴，庙里的火堆早就灭了，只剩一点青烟。';
        const raw = `正文。\n====\n2.识时务的仙子\n====\n${body}`;
        const r = C.cleanText(raw, C.DEFAULT_AD_PATTERNS, true, C.DEFAULT_CHAPTER_REGEX);
        expect(r.text.split('\n').filter(Boolean)).toEqual(['正文。', '2.识时务的仙子', body]);
    });

    it('盗版源整章换成的重复垃圾段、行内水印、空章都能清掉', () => {
        const junk = (w) => `我今年２２岁，是一个大学的学生，全班一共３０人${w}\n她矜持了一下就同意了，我们沿著小路边走边聊${w}`;
        const raw = [
            '第一卷 山村',
            '1.雨夜',
            '路长远走进古庙。bg90○ cc',
            '“嗯。”',
            '“嗯。”',
            '“嗯。”',
            '2.垃圾一',
            junk('lysh8○ cc'),
            '3.垃圾二',
            junk('xunbeiyi8点cc'),
            '4.垃圾三',
            junk('bq46♟cc'),
            '偶尔混进来的一行别的话也一起删',
            '5.正文',
            '夏怜雪回头看他。',
        ].join('\n');
        const s = C.DEFAULT_SETTINGS;
        const r = C.cleanText(raw, s.adPatterns, true, s.chapterRegex, {
            inlinePatterns: s.inlineAdPatterns,
            repeatLimit: s.repeatParaLimit,
            repeatMinChars: s.repeatParaMinChars,
        });
        expect(r.text.split('\n').filter(Boolean)).toEqual(['第一卷 山村', '1.雨夜', '路长远走进古庙。', '“嗯。”', '“嗯。”', '“嗯。”', '5.正文', '夏怜雪回头看他。']);
        expect(r.emptyChapters).toEqual(['2.垃圾一', '3.垃圾二', '4.垃圾三']);
        expect(r.inlineRemoved).toBe(7);
    });

    it('按字数切层并对齐到章节标题', () => {
        const paras = ['第一章 开始', 'a'.repeat(600), 'b'.repeat(300), '第二章 继续', 'c'.repeat(600)];
        const layers = C.splitLayers(paras, { layerChars: 500, chapterRegex: C.DEFAULT_CHAPTER_REGEX });
        expect(layers.length).toBe(2);
        expect(layers[1].paras[0].text).toBe('第二章 继续');
        expect(layers[0].chapters).toEqual(['第一章 开始']);
        // 段号全书连续
        expect(layers[1].paras[0].id).toBe(4);
    });

    it('章节太长时到 1.5 倍字数强制切开', () => {
        const paras = Array.from({ length: 10 }, () => 'x'.repeat(200));
        const layers = C.splitLayers(paras, { layerChars: 500, chapterRegex: C.DEFAULT_CHAPTER_REGEX });
        expect(layers.length).toBeGreaterThan(1);
        expect(Math.max(...layers.map((l) => l.chars))).toBeLessThanOrEqual(800);
    });
});

describe('补丁', () => {
    const paras = [
        { id: 1, text: '“你来了。”她轻声说道。' },
        { id: 2, text: '“嗯。”' },
    ];

    it('解析四种补丁格式', () => {
        const { patches, bad } = C.parsePatchLines('P1 | 你来了。” | +少女抬眸\nP2 |  | +路长远点头。\nP2 |  | ++窗外下起了雨。\nP1 | 轻声 | =低声\n乱写的一行');
        expect(patches.map((p) => p.op)).toEqual(['after', 'after', 'para', 'replace']);
        expect(bad).toEqual(['乱写的一行']);
    });

    it('应用补丁：插入、追加、另起段落、替换', () => {
        const { patches } = C.parsePatchLines('P1 | 你来了。” | +少女抬眸，\nP1 | 轻声 | =低声\nP2 |  | +路长远点头道。\nP2 |  | ++窗外下起了雨。');
        const r = C.applyPatches(paras, patches);
        expect(r.failed).toEqual([]);
        expect(r.paras).toEqual(['“你来了。”少女抬眸，她低声说道。', '“嗯。”路长远点头道。', '窗外下起了雨。']);
    });

    it('引号写法不一致也能定位锚点', () => {
        const r = C.applyPatches(paras, [{ pid: 1, anchor: '"你来了。"', op: 'after', text: 'X' }]);
        expect(r.failed).toEqual([]);
        expect(r.paras[0]).toBe('“你来了。”X她轻声说道。');
    });

    it('锚点不唯一、段号不在本层、超长时拒绝并记录原因', () => {
        const r = C.applyPatches(
            [{ id: 1, text: '嗯，嗯。' }],
            [
                { pid: 1, anchor: '嗯', op: 'after', text: 'a' },
                { pid: 9, anchor: '', op: 'after', text: 'b' },
                { pid: 1, anchor: '', op: 'after', text: 'c'.repeat(500) },
            ],
        );
        expect(r.failed.map((f) => f.reason)).toEqual(['锚点在该段出现多次', '段号不在本层', '补充内容超过 120 字']);
        expect(r.paras).toEqual(['嗯，嗯。']);
    });
});

describe('称呼替换', () => {
    it('长的称呼先替换', () => {
        const t = C.applyAliases('长安道人路长远，路公子。', ['路长远', '长安道人', '路公子'], 'fary');
        expect(t).toBe('faryfary，fary。');
    });

    it('默认替换成 {{user}}，可切换成酒馆 user 名或自定义', () => {
        expect(C.aliasTargetOf(C.DEFAULT_SETTINGS)).toBe('{{user}}');
        expect(C.aliasTargetOf({ aliasMode: 'persona', personaName: 'fary' })).toBe('fary');
        expect(C.aliasTargetOf({ aliasMode: 'custom', aliasTarget: '阿远' })).toBe('阿远');
    });

    it('黑名单和过长的称呼不收', () => {
        const a = C.mergeAliases(['路长远'], ['师兄', '长安道人', '一个特别特别特别特别长的称呼'], { blacklist: ['师兄'], protagonistName: '路长远' });
        expect(a).toEqual(['路长远', '长安道人']);
    });
});

describe('世界书', () => {
    // 「TXT转世界书」导出的角色条目
    const txtWb = {
        entries: {
            0: { uid: 0, key: ['裘月寒', '裘姑娘'], comment: '角色 - 裘月寒', content: '**名称**：裘月寒\n**身份**：魔门圣女' },
            1: { uid: 1, key: ['太华山'], comment: '地点 - 太华山', content: '**名称**：太华山' },
        },
    };

    it('能读入「TXT转世界书」的角色条目', () => {
        const wb = C.importWorldbook(txtWb);
        expect(Object.keys(wb.角色)).toEqual(['裘月寒']);
        expect(wb.角色.裘月寒.关键词).toEqual(['裘月寒', '裘姑娘']);
    });

    it('看过的条目整体替换，没看过的条目只追加，按关键词认出别名', () => {
        const wb = C.importWorldbook(txtWb);
        const r = C.mergeWorldbook(
            wb,
            {
                角色: {
                    裘姑娘: { 关键词: ['月寒'], 定位: '女主', 内容: '**名称**：裘月寒\n**身份**：魔门圣女\n**与主角关系**：同行' },
                    苏青绮: { 关键词: ['苏师姐'], 内容: '**名称**：苏青绮' },
                },
                地点: { 太华山: { 关键词: [], 内容: '山上有剑宗。' } },
                道具: { 剑: { 关键词: [], 内容: '未启用的分类' } },
            },
            { providedNames: new Set(['角色/裘月寒']), categories: ['角色', '地点'] },
        );
        expect(r.worldbook.角色.裘月寒.内容).toContain('与主角关系');
        expect(r.worldbook.角色.裘月寒.内容.match(/魔门圣女/g).length).toBe(1);
        expect(r.worldbook.角色.裘月寒.关键词).toEqual(['裘月寒', '裘姑娘', '月寒']);
        expect(r.worldbook.角色.裘月寒.定位).toBe('女主');
        expect(r.worldbook.地点.太华山.内容).toBe('**名称**：太华山\n\n山上有剑宗。');
        expect(r.worldbook.角色.苏青绮).toBeTruthy();
        expect(r.worldbook.道具).toBeUndefined();
    });

    it('导出成酒馆格式，注释沿用「分类 - 名称」，称呼一起替换', () => {
        const st = C.worldbookToST(
            { 角色: { 路长远: { 关键词: ['路长远', '长安道人'], 内容: '路长远是主角' } } },
            { aliases: ['路长远', '长安道人'], target: 'fary' },
        );
        const e = st.entries[0];
        expect(e.comment).toBe('角色 - fary');
        expect(e.key).toEqual(['fary']);
        expect(e.content).toBe('fary是主角');
        // 再读回来还是同一个条目
        expect(Object.keys(C.importWorldbook(st).角色)).toEqual(['fary']);
    });
});

describe('记忆表格', () => {
    it('只保留启用的表并按插件规则编号', () => {
        expect(TEMPLATE.tables.map((t) => `${t.index}:${t.name}`)).toEqual(['0:时空表格', '1:角色特征表格', '2:角色与<user>社交表格', '3:事件历史', '4:大总结']);
    });

    it('主键换算成行号：已有的更新，没有的插入', () => {
        let st = { tables: C.createTableState(TEMPLATE) };
        st.tables.rows[1] = [['裘月寒', '', '冷淡', '']];
        const plan = C.planTableActions(st, {
            角色特征表格: [
                { 操作: '更新或插入', 主键: '裘月寒', 数据: { 职业: '魔门圣女' } },
                { 操作: '更新或插入', 主键: '苏青绮', 数据: { 角色名: '苏青绮', 性格: '温柔, 稳重' } },
            ],
        });
        expect(plan.actions).toEqual([
            { type: 'update', tableIndex: 1, rowIndex: 0, data: { 3: '魔门圣女' } },
            { type: 'insert', tableIndex: 1, data: { 0: '苏青绮', 1: '', 2: '温柔， 稳重', 3: '' } },
        ]);
        const next = C.simulateTableActions(st, plan.actions);
        expect(next.rows[1]).toEqual([
            ['裘月寒', '', '冷淡', '魔门圣女'],
            ['苏青绮', '', '温柔， 稳重', ''],
        ]);
    });

    it('单行表只保留一行，追加表只能插入', () => {
        let st = { tables: C.createTableState(TEMPLATE) };
        st.tables.rows[0] = [['第一天', '夜', '破庙', '路长远']];
        st.tables.rows[3] = [['旧事件', '', '', '']];
        const plan = C.planTableActions(st, {
            时空表格: [{ 操作: '插入', 数据: { 地点: '客栈' } }],
            事件历史: [{ 操作: '删除', 主键: '旧事件' }, { 操作: '插入', 数据: { 事件: '路长远遇见裘月寒' } }],
        });
        const next = C.simulateTableActions(st, plan.actions);
        expect(next.rows[0]).toEqual([['第一天', '夜', '客栈', '路长远']]);
        expect(next.rows[3].map((r) => r[0])).toEqual(['旧事件', '路长远遇见裘月寒']);
        expect(plan.log.some((l) => l.includes('只能插入'))).toBe(true);
    });

    it('大总结：插入总结并清空本层之前的事件', () => {
        let st = { tables: C.createTableState(TEMPLATE) };
        st.tables.rows[3] = [['a', '', '', ''], ['b', '', '', '']];
        const plan = C.planTableActions(st, { 事件历史: [{ 操作: '插入', 数据: { 事件: 'c' } }] }, { bigSummary: '总结' });
        const next = C.simulateTableActions(st, plan.actions);
        expect(next.rows[4]).toEqual([['总结']]);
        expect(next.rows[3]).toEqual([['c', '', '', '']]);
    });

    it('渲染成插件能执行的 tableEdit，列号按顺序，逗号引号已清理', () => {
        const s = C.renderTableEdit(
            [
                { type: 'insert', tableIndex: 1, data: { 1: 'a,"b"', 0: '路长远' } },
                { type: 'delete', tableIndex: 3, rowIndex: 2 },
            ],
            (x) => x.replace('路长远', 'fary'),
        );
        expect(s).toBe('<tableEdit>\n<!--\ninsertRow(1, {"0":"fary", "1":"a，b"})\ndeleteRow(3, 2)\n-->\n</tableEdit>');
    });
});

describe('解析回复', () => {
    it('缺标签或截断时报错', () => {
        expect(C.parseLayerResponse('<bt>x</bt>').ok).toBe(false);
        const r = C.parseLayerResponse(reply({}).replace('</表格>', ''));
        expect(r.errors).toContain('<表格> 被截断');
    });

    it('JSON 带代码块和尾逗号也能读', () => {
        const r = C.parseLayerResponse(reply({}).replace('<世界书>{}</世界书>', '<世界书>```json\n{"角色": {"a": {"内容": "b",},},}\n```</世界书>'));
        expect(r.ok).toBe(true);
        expect(r.worldbook.角色.a.内容).toBe('b');
    });
});

describe('运行引擎', () => {
    // 每章补一段 600 字的雨声，让三章正好切成三层
    // 每章的填充段各不相同，免得被当成重复垃圾段删掉
    const fill = (w) => `${w}。`.repeat(200);
    const NOVEL = ['第一章 雨夜', '“你来了。”', '路长远推门而入。', fill('雨声'), '第二章 同行', '“走吧。”', '长安道人笑了笑。', fill('风声'), '第三章 分别', '“再会。”', '路长远离开了。', fill('水声')].join('\n');

    function makeEngine(responder, extra = {}) {
        const calls = [];
        const engine = C.createEngine({
            settings: { layerChars: 500, protagonistName: '路长远', reviewMode: 'off', retries: 1, ...extra },
            tableTemplate: TEMPLATE,
            callModel: async (messages, info) => {
                calls.push({ messages, info });
                return responder(info.layer, messages[messages.length - 1].content, calls.length);
            },
        });
        engine.prepare(NOVEL);
        return { engine, calls };
    }

    const normal = (layer) =>
        reply({
            title: `第${layer + 1}段`,
            summary: `摘要${layer + 1}`,
            patches: layer === 0 ? 'P2 | 你来了。” | +裘月寒抬眸道。' : '',
            alias: layer === 1 ? '长安道人' : '',
            wb: { 角色: { 路长远: { 关键词: ['路长远'], 定位: '主角', 内容: `路长远第${layer + 1}层` } } },
            tb: {
                时空表格: [{ 操作: '更新或插入', 数据: { 日期: `第${layer + 1}天`, '地点（当前描写）': '雨夜' } }],
                事件历史: [{ 操作: '插入', 数据: { 事件: `事件${layer + 1}` } }],
            },
        });

    it('中间层重跑后，后面的状态按新结果重新算（不用旧缓存）', async () => {
        let round = 1;
        const responder = (layer) =>
            reply({
                title: `第${layer + 1}段`,
                tb: { 事件历史: [{ 操作: '插入', 数据: { 事件: `第${round}轮事件${layer + 1}` } }] },
            });
        const { engine } = makeEngine(responder);
        await engine.run();
        expect(engine.exportTables().find((t) => t.name === '事件历史').data.slice(1).map((r) => r[0])).toEqual(['第1轮事件1', '第1轮事件2', '第1轮事件3']);
        round = 2;
        engine.resetFrom(1);
        await engine.run();
        expect(engine.exportTables().find((t) => t.name === '事件历史').data.slice(1).map((r) => r[0])).toEqual(['第1轮事件1', '第2轮事件2', '第2轮事件3']);
        // 和从头跑一遍的新引擎结果一致
        const fresh = makeEngine((layer) => (layer === 0 ? (round = 1, responder(0)) : (round = 2, responder(layer)))).engine;
        await fresh.run();
        expect(fresh.exportTables()).toEqual(engine.exportTables());
        expect(fresh.renderFloors().map((f) => f.mes)).toEqual(engine.renderFloors().map((f) => f.mes));
    });

    it('逐层跑完：补丁、称呼、表格、世界书都进楼层', async () => {
        const { engine } = makeEngine(normal);
        expect(engine.layers.length).toBe(3);
        await engine.run();
        const floors = engine.renderFloors();
        expect(floors.length).toBe(3);
        expect(floors[0].mes).toContain('<bt>\n#第1章：第1段\n</bt>');
        expect(floors[0].mes).toContain('“你来了。”裘月寒抬眸道。');
        // 第二层才学到的称呼，第一层也替换
        expect(floors[0].mes).toContain('{{user}}推门而入');
        expect(floors[1].mes).toContain('{{user}}笑了笑');
        expect(floors[0].mes).not.toContain('路长远');
        // 每层都有表格指令，最终表格与逐层模拟一致
        for (const f of floors) expect(f.mes).toContain('<tableEdit>');
        const tables = engine.exportTables();
        expect(tables.find((t) => t.name === '时空表格').data.slice(1)).toEqual([['第3天', '', '雨夜', '']]);
        expect(tables.find((t) => t.name === '事件历史').data.slice(1).map((r) => r[0])).toEqual(['事件1', '事件2', '事件3']);
        // 世界书：主角条目 + 剧情条目，主角人设可单独导出
        const wb = engine.exportWorldbook();
        expect(Object.values(wb.entries).map((e) => e.comment)).toContain('角色 - {{user}}');
        expect(engine.exportPersona().description).toBe('{{user}}第3层');
    });

    it('格式错误会重试', async () => {
        const { engine, calls } = makeEngine((layer, _p, n) => (n === 1 ? '<bt>坏' : normal(layer)));
        await engine.run();
        expect(calls.length).toBe(4);
        expect(engine.renderFloors().length).toBe(3);
    });

    it('剧情改写：从触发层开始整层改写，标出起点，直到回归原文', async () => {
        const { engine } = makeEngine((layer) => {
            if (layer === 0) return normal(0);
            if (layer === 1)
                return reply({
                    title: '同行',
                    rewritten: '“走吧。”\n路长远牵起她的手。',
                    judge: { 触发: true, 规则: 'NTR', 说明: '裘月寒没有离开', 回归原文: false },
                });
            return reply({ title: '分别', rewritten: '“再会。”\n路长远和她一起离开。', judge: { 触发: false, 说明: '接回原文', 回归原文: true } });
        });
        await engine.run();
        const floors = engine.renderFloors();
        expect(floors[1].mes).toContain('<bt>\n#第2章：【改写起点】同行\n</bt>');
        expect(floors[1].mes).toContain('{{user}}牵起她的手');
        expect(floors[2].mes).toContain('<bt>\n#第3章：【改写中】分别\n</bt>');
        expect(engine.finalState().divergence.active).toBe(false);
    });

    it('改写中的下一层提示词带上之前的改动记录', async () => {
        const { engine } = makeEngine((layer) =>
            layer === 0 ? reply({ title: 'a', rewritten: 'x', judge: { 触发: true, 规则: '送女', 说明: '没有送出去' } }) : normal(layer),
        );
        await engine.run();
        const req = engine.buildRequestFor(1);
        expect(req.prompt).toContain('当前处于剧情改写状态');
        expect(req.prompt).toContain('没有送出去');
    });

    it('审阅：停在这一层，不通过就带意见重做', async () => {
        const { engine, calls } = makeEngine((layer, prompt) => {
            if (prompt.includes('修改意见')) return reply({ title: '重做', summary: '按意见改了' });
            return normal(layer);
        });
        engine.pauseAfterCurrentLayer();
        await engine.run();
        expect(engine.reviewing).toBe(0);
        expect(engine.renderFloors().length).toBe(1);
        await engine.reject('标题要更具体');
        expect(calls[calls.length - 1].messages[0].content).toContain('标题要更具体');
        expect(engine.renderFloors()[0].title).toBe('重做');
        engine.accept();
        await engine.run();
        expect(engine.renderFloors().length).toBe(3);
    });

    it('事件满了自动要求大总结', async () => {
        const { engine } = makeEngine(
            (layer, prompt) => {
                const r = normal(layer);
                return prompt.includes('大总结任务') ? r + '\n<大总结>前两层的总结</大总结>' : r;
            },
            { tableRoles: { summaryThreshold: 2 } },
        );
        await engine.run();
        const t = engine.exportTables();
        expect(t.find((x) => x.name === '大总结').data.slice(1)).toEqual([['前两层的总结']]);
        expect(t.find((x) => x.name === '事件历史').data.slice(1).map((r) => r[0])).toEqual(['事件3']);
    });

    it('序列化后恢复，能接着跑', async () => {
        const { engine } = makeEngine(normal);
        engine.pauseAfterCurrentLayer();
        await engine.run();
        engine.accept();
        const saved = JSON.parse(JSON.stringify(engine.serialize()));
        const { engine: e2 } = makeEngine(normal);
        e2.restore(saved);
        await e2.run();
        expect(e2.renderFloors().length).toBe(3);
    });

    it('聊天文件和角色卡', async () => {
        const { engine } = makeEngine(normal);
        await engine.run();
        const chat = C.buildChatArray(engine.renderFloors(), { charName: '修仙界', userName: 'fary' });
        expect(chat[0].character_name).toBe('修仙界');
        expect(chat.slice(1).every((m) => m.is_user === false && m.swipes[0] === m.mes)).toBe(true);
        const card = C.buildCharacterCard({ name: '修仙界', worldName: '修仙界', worldbook: engine.exportWorldbook() });
        expect(card.data.extensions.world).toBe('修仙界');
        expect(card.data.character_book.entries.length).toBeGreaterThan(0);
    });
});

describe('标题格式', () => {
    const L = (index, chapters, translate = false) => ({ index, chapters, translate });
    it('拆章节标题：中文数字、话/章、日文、英文、韩文', () => {
        expect(C.parseChapterTitle('第一百二十三章 雨夜')).toEqual({ num: 123, unit: '章', title: '雨夜' });
        expect(C.parseChapterTitle('第12話　出会い')).toEqual({ num: 12, unit: '话', title: '出会い' });
        expect(C.parseChapterTitle('Chapter 7: The Rain')).toEqual({ num: 7, unit: '', title: 'The Rain' });
        expect(C.parseChapterTitle('제3화 만남')).toEqual({ num: 3, unit: '话', title: '만남' });
        expect(C.parseChapterTitle('普通的一句话')).toBe(null);
        expect(C.detectChapterUnit(['第1话 a', '第2话 b', '第3章 c'])).toBe('话');
    });
    it('AI 标题用层号，原文标题用原文的章号和标题', () => {
        expect(C.formatHeading(L(4, ['第9章 雨夜']), '古庙', {}, '章')).toBe('#第5章：古庙');
        expect(C.formatHeading(L(4, ['第9话 雨夜']), '古庙', { titleMode: 'original' }, '话')).toBe('#第9话：雨夜');
        expect(C.formatHeading(L(0, ['第9话 雨夜']), '', { titleMode: 'original', chapterUnit: '章' }, '话')).toBe('#第9章：雨夜');
        // 翻译时：章号取原文，标题用 AI 给的译名
        expect(C.formatHeading(L(0, ['第3話 出会い'], true), '第3话 相遇', { titleMode: 'original' }, '话')).toBe('#第3话：相遇');
        expect(C.formatHeading(L(0, ['序章'], false), '', { titleMode: 'original' }, '章')).toBe('#序章');
        expect(C.formatHeading(L(0, []), '', {}, '章')).toBe('#第1章');
    });
});

describe('翻译模式', () => {
    const fill = (w) => `${w}。`.repeat(200);
    const JP = ['第1話 雨の夜', '「来たか」と月寒は言った。', '路長遠は扉を押して入った。', fill('雨の音がする'), '第2話 旅立ち', '「行こう」', '長安道人は笑った。', fill('風の音がする')].join('\n');
    const tr = (layer, prompt) => {
        const terms = layer === 0 ? '路長遠 → 路长远\n月寒 → 月寒（女主）' : '長安道人 → 长安道人';
        const body = layer === 0 ? '第1话 雨夜\n“来了啊。”月寒说道。\n路长远推门而入。\n〔插图1〕' : '第2话 启程\n“走吧。”\n长安道人笑了。';
        return [`<bt>${layer === 0 ? '雨夜' : '启程'}</bt>`, `<摘要>摘要${layer}</摘要>`, `<正文>\n${body}\n</正文>`, '<改写判定>{"触发":false}</改写判定>', '<称呼></称呼>', '<世界书>{}</世界书>', '<表格>{}</表格>', `<新术语>\n${terms}\n</新术语>`].join('\n');
    };

    it('认出外文，整层翻译成中文，术语表逐层积累并只带本层出现的', async () => {
        expect(C.detectForeign(JP)).toBe(true);
        expect(C.detectForeign('第一章 雨夜\n“你来了。”路长远推门而入。'.repeat(20))).toBe(false);
        const prompts = [];
        const engine = C.createEngine({
            settings: { layerChars: 500, protagonistName: '路长远', reviewMode: 'off', retries: 0, titleMode: 'original', tablesEnabled: false },
            seedGlossary: [{ source: '雨の夜', target: '雨夜' }],
            callModel: async (messages, info) => {
                const p = messages[messages.length - 1].content;
                prompts.push(p);
                return tr(info.layer, p);
            },
        });
        engine.prepare(JP + '\n〔插图1〕');
        expect(engine.stats.translate).toBe(true);
        expect(engine.layers.length).toBe(2);
        await engine.run();
        expect(prompts[0]).toContain('完整翻译');
        expect(prompts[0]).not.toContain('<补丁>');
        expect(prompts[0]).toContain('雨の夜 → 雨夜');
        // 第二层原文里有「長安道人」但没有「路長遠」：只带出现了的术语
        expect(prompts[1]).not.toContain('路長遠 → 路长远');
        expect(prompts[1]).not.toContain('雨の夜 → 雨夜');
        expect(engine.finalState().glossary.map((g) => g.source)).toEqual(['雨の夜', '路長遠', '月寒', '長安道人']);
        const floors = engine.renderFloors();
        expect(floors[0].mes).toContain('<bt>\n#第1话：雨夜\n</bt>');
        expect(floors[0].mes).toContain('{{user}}推门而入。');
        expect(floors[0].mes).not.toContain('新术语');
        expect(floors[1].mes).toContain('#第2话：启程');
    });

    it('整层重写时漏掉的插图占位行按位置补回', () => {
        const src = [{ text: 'a' }, { text: '〔插图1〕' }, { text: 'b' }, { text: 'c' }, { text: '〔插图2〕' }];
        expect(C.ensureImageMarkers(src, ['A', 'B', 'C', '〔插图2〕'])).toEqual(['A', '〔插图1〕', 'B', 'C', '〔插图2〕']);
    });

    it('术语表合并：已有的原文不覆盖', () => {
        const g = C.mergeGlossary([{ source: 'A', target: '甲', note: '' }], C.parseGlossaryLines('A → 乙\nB -> 丙（地名）\n无'));
        expect(g).toEqual([{ source: 'A', target: '甲', note: '' }, { source: 'B', target: '丙', note: '地名' }]);
    });
});

describe('酒馆预设条目', () => {
    const PRESET = {
        squash_system_messages: true,
        temperature: 0.9,
        prompts: [
            { identifier: 'main', name: '主提示', role: 'system', content: '你是作家 {{char}}' },
            { identifier: 'nsfw', name: '尺度', role: 'system', content: '可以写成人内容' },
            { identifier: 'charDescription', marker: true },
            { identifier: 'chatHistory', marker: true },
            { identifier: 'jb', name: '破限', role: 'user', content: '继续' },
            { identifier: 'deep', name: '深度提醒', role: 'system', content: '记住规则', injection_position: 1, injection_depth: 0 },
            { identifier: 'quiet', name: '后台用', role: 'system', content: '只在后台', injection_trigger: ['quiet'] },
            { identifier: 'orphan', name: '没放进顺序', role: 'system', content: '孤儿' },
        ],
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'nsfw', enabled: false },
                    { identifier: 'charDescription', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                    { identifier: 'jb', enabled: true },
                    { identifier: 'deep', enabled: true },
                    { identifier: 'quiet', enabled: false },
                ],
            },
        ],
    };

    it('按酒馆的顺序和开关导入，聊天记录换成本层提示词，没放进列表的不导入', () => {
        const r = C.parseSTPreset(PRESET);
        expect(r.entries.map((e) => e.id)).toEqual(['main', 'nsfw', C.PRESET_SLOT_ID, 'jb', 'deep', 'quiet']);
        expect(r.entries.map((e) => e.enabled)).toEqual([true, false, true, true, true, false]);
        expect(r.extras).toBeUndefined();
        expect(r.skipped).toBe(1);
        expect(r.droppedMarkers).toBe(1);
        expect(r.squash).toBe(true);
        expect(r.params.temperature).toBe(0.9);
    });

    it('和 TXT转世界书 一样：没有 100001 取最后一份列表，开关照酒馆里的（不看触发方式），没有列表按 prompts 原顺序', () => {
        const prompts = [
            { identifier: 'a', name: 'A', content: 'a' },
            { identifier: 'b', name: 'B', content: 'b', injection_trigger: ['continue'] },
            { identifier: 'c', name: 'C', content: 'c' },
        ];
        const prompt_order = [
            { character_id: 7, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }, { identifier: 'c', enabled: true }] },
            { character_id: 8, order: [{ identifier: 'c', enabled: true }, { identifier: 'b', enabled: true }] },
        ];
        const r = C.parseSTPreset({ prompts, prompt_order });
        expect(r.entries.map((e) => [e.id, e.enabled])).toEqual([['c', true], ['b', true], [C.PRESET_SLOT_ID, true]]);
        expect(r.skipped).toBe(1);
        const t = TXT.parseTavernPreset({ prompts, prompt_order });
        expect(t.chain.map((m) => m.content)).toEqual(['c', 'b', '{PROMPT}']);
        expect(C.parseSTPreset({ prompts }).entries.map((e) => e.id)).toEqual(['a', 'b', 'c', C.PRESET_SLOT_ID]);
    });

    it('拼消息：关掉的不发，相对按顺序，深度 0 放在本层提示词后面，宏交给酒馆展开，相邻 system 合并', () => {
        const r = C.parseSTPreset(PRESET);
        const msgs = C.assemblePresetMessages({ entries: r.entries, squash: r.squash }, 'P', (t) => t.replace('{{char}}', '小说'));
        expect(msgs).toEqual([
            { role: 'system', content: '你是作家 小说' },
            { role: 'user', content: 'P' },
            { role: 'system', content: '记住规则' },
            { role: 'user', content: '继续' },
        ]);
        // 换个顺序、打开尺度条目
        const entries = r.entries.slice();
        entries[1] = { ...entries[1], enabled: true };
        entries.push(entries.shift());
        const m2 = C.assemblePresetMessages({ entries, squash: false }, 'P');
        expect(m2.map((m) => m.content)).toEqual(['可以写成人内容', 'P', '记住规则', '继续', '你是作家 {{char}}']);
    });

    it('旧的消息链转成条目，引擎按条目发', async () => {
        const preset = C.presetFromMessageChain([{ role: 'system', content: '系统', enabled: true }, { role: 'user', content: '前缀\n{PROMPT}', enabled: true }]);
        expect(C.assemblePresetMessages(preset, 'P')).toEqual([
            { role: 'system', content: '系统' },
            { role: 'user', content: '前缀' },
            { role: 'user', content: 'P' },
        ]);
        let seen;
        const engine = C.createEngine({
            settings: { layerChars: 500, reviewMode: 'off', tablesEnabled: false },
            preset,
            callModel: async (messages) => {
                seen = messages;
                return reply({});
            },
        });
        engine.prepare('第一章 开始\n' + '正文。'.repeat(50));
        await engine.run();
        expect(seen[0]).toEqual({ role: 'system', content: '系统' });
        expect(seen[2].content).toContain('## 本层正文');
    });
});

describe('酒馆世界书当作输出要求', () => {
    it('关掉的和空的条目不要，按顺序值排，放进每层提示词', async () => {
        const rules = C.buildOutputRules([
            { name: '文风', entries: { 0: { comment: '第二条', content: '多写心理', order: 200 }, 1: { comment: '第一条', content: '第三人称', order: 100 }, 2: { comment: '关掉的', content: 'x', disable: true }, 3: { comment: '空', content: ' ' } } },
            { name: '空书', entries: {} },
        ]);
        expect(rules).toBe('### 《文风》\n【第一条】\n第三人称\n\n【第二条】\n多写心理');
        let seen;
        const engine = C.createEngine({
            settings: { layerChars: 500, reviewMode: 'off', tablesEnabled: false },
            outputRules: rules,
            callModel: async (messages) => {
                seen = messages;
                return reply({});
            },
        });
        engine.prepare('第一章 开始\n' + '正文。'.repeat(50));
        await engine.run();
        const text = seen.map((m) => m.content).join('\n');
        expect(text).toContain('## 输出要求（来自酒馆里开着的世界书，写正文时必须遵守）\n### 《文风》');
    });
});

describe('世界书分类', () => {
    it('旧格式和 TXT转世界书 的分类都能认，导出按分类的位置、深度、顺序', () => {
        const cats = C.normalizeCategories([
            { name: '角色', enabled: true, constant: false, guide: '旧的写法' },
            { name: '地点', enabled: true, isBuiltin: true, entryExample: '地点名', keywordsExample: ['地名'], contentGuide: '写地点', defaultPosition: 4, defaultDepth: 2, defaultOrder: 200, autoIncrementOrder: true },
            { name: '地点', enabled: false },
        ]);
        expect(cats.length).toBe(2);
        expect(cats[0].contentGuide).toBe('旧的写法');
        const st = C.worldbookToST({ 地点: { 古庙: { 关键词: ['古庙'], 内容: 'a' }, 山门: { 关键词: ['山门'], 内容: 'b' } } }, { categories: cats });
        const es = Object.values(st.entries);
        expect(es.map((e) => [e.position, e.depth, e.order])).toEqual([[4, 2, 200], [4, 2, 201]]);
        const prompt = C.buildLayerPrompt({ index: 0, paras: [{ id: 1, text: 'x' }], chars: 1, chapters: [] }, { worldbookCategories: cats, tablesEnabled: false }, { worldbook: {}, aliases: [], divergence: {} });
        expect(prompt).toContain('地点（条目名如「地点名」，关键词如 ["地名"]）：写地点');
    });
});

describe('预设', () => {
    it('读取酒馆预设，聊天记录位置放提示词', () => {
        const r = C.parseTavernPreset({
            prompts: [
                { identifier: 'main', role: 'system', content: '你是作家' },
                { identifier: 'chatHistory', marker: true },
            ],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
            temperature: 0.8,
        });
        expect(C.applyMessageChain('P', r.chain)).toEqual([
            { role: 'system', content: '你是作家' },
            { role: 'user', content: 'P' },
        ]);
        expect(r.params.temperature).toBe(0.8);
    });
});
