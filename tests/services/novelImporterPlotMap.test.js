import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// core.js 和 plotMap.js 都是浏览器端 IIFE，直接 eval 后取全局对象
function load(file) {
    const src = readFileSync(new URL(`../../novelImporter/${file}`, import.meta.url), 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(src);
}
load('core.js');
load('plotMap.js');
const C = globalThis.NovelImporterCore;
const M = globalThis.NovelImporterPlotMap;

function reply({ title = '标题', summary = '摘要', patches = '', judge, rewritten }) {
    const parts = [`<bt>${title}</bt>`, `<摘要>${summary}</摘要>`];
    if (rewritten !== undefined) parts.push(`<改写正文>${rewritten}</改写正文>`);
    else parts.push(`<补丁>\n${patches}\n</补丁>`);
    parts.push(`<改写判定>${JSON.stringify(judge || { 触发: false, 规则: '', 说明: '', 回归原文: false })}</改写判定>`);
    parts.push('<称呼></称呼>', '<世界书>{}</世界书>', '<表格>{}</表格>');
    return parts.join('\n');
}

const fill = (w) => `${w}。`.repeat(200);
const NOVEL = [
    '第一章 雨夜',
    '“你来了。”裘月寒笑道。',
    '路长远推门而入，裘月寒点了点头。',
    fill('雨声'),
    '第二章 同行',
    '“走吧。”长安道人笑道。',
    '路长远把玉佩送给了长安道人。',
    fill('风声'),
    '第三章 分别',
    '“再会。”裘月寒说道。',
    '路长远拔剑出手，一剑斩下，血光四溅。',
    fill('剑'),
].join('\n');

function makeEngine(responder, plan = {}, extra = {}) {
    const calls = [];
    const engine = C.createEngine({
        settings: { layerChars: 500, protagonistName: '路长远', reviewMode: 'off', retries: 1, aliasReplaceBy: 'text', tablesEnabled: false, ...extra },
        planFor: (i) => plan[i] || null,
        callModel: async (messages, info) => {
            calls.push({ messages, info });
            return responder(info.layer, messages[messages.length - 1].content, calls.length);
        },
    });
    engine.prepare(NOVEL);
    return { engine, calls };
}

describe('剧情地图：免费统计', () => {
    const { engine } = makeEngine(() => reply({}));
    const isTitle = (t) => C.isChapterTitle(t, C.safeRegex(C.DEFAULT_CHAPTER_REGEX));

    it('从「XX道」「XX点了点头」猜出人名', () => {
        const names = M.guessNames(engine.layers, { minCount: 1 }).map((x) => x.name);
        expect(names).toContain('裘月寒');
    });

    it('目录、出场、关键词、共现、新角色、节奏、长度', () => {
        const names = M.parseNameList('裘月寒 / 月寒\n路长远\n长安道人');
        const a = M.analyze(engine.layers, { names, keywords: ['送给'], isChapterTitle: isTitle });
        expect(a.rows.length).toBe(3);
        expect(a.rows[0].chapters).toEqual(['第一章 雨夜']);
        expect(a.rows[0].names['裘月寒']).toBe(2);
        expect(a.rows[1].keywords['送给']).toBe(1);
        expect(a.rows[0].pairs['裘月寒|路长远']).toBe(1);
        expect(a.rows[1].newNames).toEqual([]);
        expect(a.rows[2].pace).toBe('战斗');
        expect(a.chapters.length).toBe(3);
    });

    it('别名合计时不重复数（「月寒」不会把「裘月寒」再数一遍）', () => {
        const names = M.parseNameList('裘月寒/月寒');
        expect(M.nameCounts('裘月寒和月寒', names)).toEqual({ 裘月寒: 2 });
    });

    it('E2：账本事实里的人后面又大量出场，标出来', () => {
        const names = M.parseNameList('裘月寒');
        const a = M.analyze(engine.layers, { names, isChapterTitle: isTitle });
        const hints = M.conflictHints(a.rows, [{ text: '裘月寒没有被送走', layer: 0 }], names);
        expect(Object.keys(hints).map(Number)).toEqual([]);
        const hints2 = M.conflictHints(a.rows, [{ text: '裘月寒没有被送走', layer: -1 }], names);
        expect(hints2[0][0].names).toEqual(['裘月寒']);
    });
});

describe('剧情地图：规划数据', () => {
    it('setLayerPlan 清掉空字段，layerPlan 补默认值', () => {
        let p = M.normalizePlan(null);
        p = M.setLayerPlan(p, 3, { instruction: '改掉', bookmark: true });
        expect(p.layers[3]).toEqual({ instruction: '改掉', bookmark: true });
        p = M.setLayerPlan(p, 3, { instruction: '', bookmark: false });
        expect(p.layers[3]).toBeUndefined();
        expect(M.layerPlan(p, 3).instruction).toBe('');
    });

    it('预扫描回复解析', () => {
        const s = M.parseScanResponse('好的\n{"一句话":"送玉佩","摘要":"路长远送出玉佩","人物":["路长远"],"关系":[{"甲":"路长远","乙":"长安道人","变化":"结拜"}],"毒点":[{"雷点":"送女","证据":"送给了"}],"标签":["转折"]}', C.parseLooseJson);
        expect(s.oneLine).toBe('送玉佩');
        expect(s.relations[0]).toEqual({ a: '路长远', b: '长安道人', change: '结拜' });
        expect(s.toxic[0].rule).toBe('送女');
    });

    it('花费预估按字数算', () => {
        const est = M.estimateScanCost([{ paras: [{ text: '字'.repeat(1000) }] }], { estimateTokens: C.estimateTokens, inPrice: 1, outPrice: 2, outTokens: 100, overhead: 0 });
        expect(est.input).toBe(1100);
        expect(est.cost).toBe((1100 * 1 + 100 * 2) / 1e6);
    });

    it('并发池最多同时跑 n 个，全部跑完', async () => {
        let live = 0;
        let peak = 0;
        const done = [];
        await M.runPool([1, 2, 3, 4, 5], 2, async (x) => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            done.push(x);
            live--;
        });
        expect(peak).toBe(2);
        expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('AI 提议和新大纲的解析', () => {
        const sg = M.parseSuggestResponse('[{"层": 2, "接回": 3, "原因": "送女", "改法": "没送"}]', C.parseLooseJson);
        expect(sg).toEqual([{ layer: 1, resume: 2, reason: '送女', change: '没送' }]);
        const ol = M.parseOutlineResponse('{"方案":[{"名称":"A","各层":{"2":"新的第二层"}},{"名称":"B","各层":{}}]}', C.parseLooseJson);
        expect(ol).toEqual([{ name: 'A', layers: { 1: '新的第二层' } }]);
    });
});

describe('剧情地图：改写安排进引擎', () => {
    it('D1/D5：有指令和新大纲的层，提示词带上，并按剧情改写整层改写', async () => {
        const { engine, calls } = makeEngine(
            (layer) => (layer === 1 ? reply({ title: '改', rewritten: '新的第二层正文', judge: { 触发: true, 规则: '用户指令', 说明: '没送' } }) : reply({})),
            { 1: { instruction: '玉佩没有送出去', outline: '路长远收起玉佩' } },
        );
        await engine.run();
        const prompt = calls[1].messages[calls[1].messages.length - 1].content;
        expect(prompt).toContain('用户给这一层的改写安排');
        expect(prompt).toContain('玉佩没有送出去');
        expect(prompt).toContain('路长远收起玉佩');
        const floors = engine.renderFloors();
        expect(floors[1].body).toContain('新的第二层正文');
        expect(floors[1].divergenceStart).toBe(true);
    });

    it('D6：标了接回点的层写完就接回原文', async () => {
        const { engine } = makeEngine(
            (layer) => (layer === 0 ? reply({ rewritten: 'x', judge: { 触发: true, 规则: '送女', 说明: '改' } }) : layer === 1 ? reply({ rewritten: 'y', judge: { 触发: false } }) : reply({})),
            { 1: { resume: true } },
        );
        await engine.run();
        expect(engine.finalState().divergence.active).toBe(false);
        const floors = engine.renderFloors();
        expect(floors[2].divergence).toBeFalsy();
    });

    it('D11：跳过的层不调 AI、不出楼层', async () => {
        const { engine, calls } = makeEngine(() => reply({}), { 1: { skip: true } });
        await engine.run();
        expect(calls.map((c) => c.info.layer)).toEqual([0, 2]);
        expect(engine.renderFloors().map((f) => f.layer)).toEqual([0, 2]);
    });

    it('H3：审阅设成剧情改写时，有改写安排的层停下来', async () => {
        const { engine } = makeEngine(() => reply({ rewritten: 'z', judge: { 触发: true, 规则: '用户指令' } }), { 0: { instruction: '改' } }, { reviewMode: 'divergence' });
        await engine.run();
        expect(engine.reviewing).toBe(0);
    });

    it('E6：剧情改写中，前情提要带上改写起点以来的层', async () => {
        const { engine } = makeEngine((layer) => (layer === 0 ? reply({ summary: '第一层摘要', rewritten: 'x', judge: { 触发: true, 规则: '送女' } }) : reply({ summary: `摘要${layer + 1}`, rewritten: 'y' })));
        await engine.run();
        const p = engine.buildRequestFor(2).prompt;
        expect(p).toContain('第一层摘要');
        expect(p).toContain('前情提要');
    });
});

describe('剧情地图：搜原文和空章', () => {
    const { engine } = makeEngine(() => reply({}));
    const isTitle = (t) => C.isChapterTitle(t, C.safeRegex(C.DEFAULT_CHAPTER_REGEX));

    it('全书搜：命中数、层号、所在章节、前后文', () => {
        const r = M.searchLayers(engine.layers, '玉佩', { isChapterTitle: isTitle });
        expect(r.total).toBe(1);
        expect(r.hits[0].layer).toBe(1);
        expect(r.hits[0].chapter).toBe('第二章 同行');
        expect(r.hits[0].before).toBe('路长远把');
        expect(r.hits[0].after.startsWith('送给了')).toBe(true);
    });

    it('/正则/ 也能搜，坏正则不报错', () => {
        expect(M.searchLayers(engine.layers, '/裘.寒/').total).toBe(3);
        expect(M.searchLayers(engine.layers, '/(/').bad).toBe(true);
    });

    it('空章回原文找到位置和所在层', () => {
        const raw = '第一章 雨夜\n正文\n第二章 坏章\n本章未完，请到某某网站阅读\n第三章 分别\n正文';
        const layers = [{ index: 0, chapters: ['第一章 雨夜'] }, { index: 1, chapters: ['第三章 分别'] }];
        const r = M.locateEmptyChapters(raw, ['第二章 坏章'], layers, isTitle);
        expect(r[0]).toEqual({ title: '第二章 坏章', layer: 1, before: '第一章 雨夜\n正文', after: '本章未完，请到某某网站阅读', next: '第三章 分别' });
    });
});

describe('剧情地图：雷点判断', () => {
    it('提示词带主角和判断标准；涉及主角自己的毒点丢掉', () => {
        const p = M.buildScanPrompt({ index: 0, paras: [{ text: '正文' }] }, { protagonist: '祁铭', judgeNotes: C.TOXIC_JUDGE_NOTES });
        expect(p).toContain('本书主角是「祁铭」');
        expect(p).toContain('主角本人和她亲热');
        const r = M.parseScanResponse('{"毒点":[{"雷点":"NTR","涉及":"祁铭","证据":"x"},{"雷点":"NTR","涉及":"王二","证据":"y"}]}', C.parseLooseJson, { protagonist: '祁铭' });
        expect(r.toxic.map((t) => t.who)).toEqual(['王二']);
    });

    it('剧情改写规则也带判断标准', () => {
        const { engine } = makeEngine(() => reply({}), {}, { divergenceEnabled: true, protagonistName: '路长远' });
        const p = engine.buildRequestFor(0).prompt;
        expect(p).toContain('主角本人和她亲热');
        expect(p).toContain('本书主角是「路长远」');
    });
});
