// ============================================================
// novelImporter/ui.js - 小说导入改写：界面
//
// 依赖 core.js（window.NovelImporterCore）和 stBridge.js（window.NovelImporterST）。
// 挂到 window.NovelImporter，入口 open()。
// ============================================================

(function () {
    'use strict';

    const C = window.NovelImporterCore;
    const ST = window.NovelImporterST;
    const DB_NAME = 'NovelImporterDB';
    const STORE = 'task';
    const SETTINGS_KEY = 'novelImporterSettings';

    const API_DEFAULTS = {
        // 剧情地图：预扫描用的模型（留空用主 API）、并发、单价、雷点、指令模板
        mapScanModel: '',
        mapScanEndpoint: '',
        mapScanKey: '',
        mapConcurrency: 3,
        mapPriceIn: 0,
        mapPriceOut: 0,
        mapVariants: 2,
        mapToxic: '',
        mapTemplates: null,
        // 预设方案：存几套预设，按模型切换（[{name, preset}]，「插件默认」不存，随时能切回）
        presetLibrary: [],
        apiEndpoint: '',
        apiKey: '',
        apiModel: '',
        temperature: 0.7,
        maxTokens: 16000,
        apiTimeout: 300000,
    };

    const State = {
        settings: null, // 模块设置 + API 设置
        text: '',
        fileName: '',
        engine: null,
        tableTemplate: null,
        seedWorldbook: null,
        seedGlossary: null, // [{source, target, note}]
        glossaryRemoved: [], // 用户在术语表里删掉的原文，AI 之后再报也不收
        ledgerManual: [], // 用户手动加或改过的既成事实：[{from（从第几层起，0 开始）, text}]
        ledgerRemoved: [], // 用户删掉或改掉的 AI 事实原句，AI 之后再报也不收
        plan: window.NovelImporterPlotMap ? window.NovelImporterPlotMap.normalizePlan(null) : {}, // 剧情地图：人物名单、每层的扫描结果和改写安排
        planBook: '', // 剧情地图属于哪本书（全文哈希），导入别的书时清空地图
        stWorlds: null, // 酒馆里开着的世界书：[{name, source, count, chars, rules}]，开始处理时重读
        outputRules: '', // 勾选的那几本拼成的输出要求
        images: [], // EPUB 插图：[{id, name, mime, data(base64)}]，正文里是〔插图id〕
        imagePaths: null, // 已上传到酒馆的插图：{card, map: {id: path}}
        tab: 'file',
        meta: { cardName: '', worldName: '', avatar: '', description: '', scenario: '' },
        selected: null,
        stream: '',
        db: null,
        importing: false,
    };

    // ============================================
    // 小工具
    // ============================================

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function $(id) {
        return document.getElementById(id);
    }

    function toast(msg, type = 'info') {
        if (window.toastr && window.toastr[type]) window.toastr[type](msg);
        else console.log(`[NovelImporter] ${msg}`);
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function download(content, filename, mime = 'application/json') {
        const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 1000);
    }

    function readFileText(file) {
        return file.text();
    }

    /**
     * 认编码：能按 UTF-8 完整解码就用 UTF-8（GB18030 几乎能把任何字节解出字来，按字数比会误判）；
     * 否则在 GB18030 和 Big5 里取乱码最少的；带 UTF-16 BOM 的按 UTF-16。
     */
    async function decodeTxt(file) {
        const buf = await file.arrayBuffer();
        const b = new Uint8Array(buf.slice(0, 2));
        if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
        if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch (e) {
            /* 不是 UTF-8 */
        }
        let best = null;
        for (const enc of ['gb18030', 'big5', 'utf-8']) {
            try {
                const text = new TextDecoder(enc).decode(buf);
                const bad = (text.match(/\uFFFD/g) || []).length;
                if (!best || bad < best.bad) best = { text, bad };
            } catch (e) {
                /* 不支持的编码 */
            }
        }
        return best ? best.text : '';
    }

    function getPath(obj, path) {
        return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }

    function setPath(obj, path, val) {
        const ks = path.split('.');
        let o = obj;
        for (let i = 0; i < ks.length - 1; i++) {
            if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
            o = o[ks[i]];
        }
        o[ks[ks.length - 1]] = val;
    }

    // ============================================
    // 设置
    // ============================================

    function defaultSettings() {
        const d = JSON.parse(JSON.stringify(C.DEFAULT_SETTINGS));
        return { ...d, ...JSON.parse(JSON.stringify(API_DEFAULTS)), preset: C.presetDefaults() };
    }

    /** 补全设置；旧版的消息链转成预设条目 */
    function withDefaults(saved) {
        const d = defaultSettings();
        const out = { ...d, ...saved, tableRoles: { ...d.tableRoles, ...(saved.tableRoles || {}) } };
        out.worldbookCategories = C.normalizeCategories(saved.worldbookCategories || d.worldbookCategories);
        out.preset = saved.preset ? C.normalizePreset(saved.preset) : saved.messageChain ? C.presetFromMessageChain(saved.messageChain) : d.preset;
        delete out.messageChain;
        return out;
    }

    function loadSettings() {
        const d = defaultSettings();
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                State.settings = withDefaults(JSON.parse(raw));
                return;
            }
        } catch (e) {
            /* 用默认值 */
        }
        State.settings = d;
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(State.settings));
        } catch (e) {
            /* 存不了就算了 */
        }
    }

    // 界面字段定义：type 为 text/number/textarea/check/select/lines/json
    const POS_OPTIONS = [
        [0, '在角色定义之前'],
        [1, '在角色定义之后'],
        [2, '在作者注释之前'],
        [3, '在作者注释之后'],
        [4, '自定义深度'],
    ];

    const FIELDS = {
        layer: [
            { key: 'layerChars', label: '每层字数', type: 'number', hint: '默认 15000' },
            { key: 'alignToChapter', label: '尽量在章节标题处分层', type: 'check' },
            { key: 'chapterRegex', label: '章节标题正则', type: 'text', wide: true },
            { key: 'adPatterns', label: '广告行规则（每行一条正则，命中的行删掉）', type: 'lines' },
            { key: 'adRemovePrevLine', label: '同时删掉广告行上面那行短标题（如「书名」+「请收藏：」）', type: 'check' },
            { key: 'inlineAdPatterns', label: '行内水印规则（每行一条正则，只删命中的那段，如「bg90○ cc」）', type: 'lines' },
            { key: 'repeatParaLimit', label: '全书重复几次以上的段落当垃圾段删掉', type: 'number', hint: '盗版源常把整章换成同一段垃圾文字；0 为不删，默认 3' },
            { key: 'repeatParaMinChars', label: '参与重复检测的最短段落字数', type: 'number', hint: '默认 12，太短的句子不算；对话和分隔线不算' },
            { key: 'keepSeparatorLines', label: '保留「=====」这类分隔线', type: 'check', hint: '不勾的话，「=====」「-----」这类分隔线当垃圾行删掉（广告行规则里的 ^=+$ 等）；改了要重新选一次小说才生效' },
            { key: 'cleanKeep', label: '保留的段落（在「清掉的内容」里点保留会加到这里，每行一段，删掉一行就撤销）', type: 'lines' },
        ],
        translate: [
            {
                key: 'translateMode',
                label: '外文小说翻译成简体中文',
                type: 'select',
                options: [
                    ['auto', '自动识别（日文、英文、韩文等整本翻译）'],
                    ['on', '总是翻译'],
                    ['off', '不翻译'],
                ],
                hint: '改了要重新分层',
            },
            { key: 'glossaryEnabled', label: '翻译时用术语表统一人名地名', type: 'check', hint: '每层顺带补充新词，只发给 AI，不进正文' },
            { key: 'glossaryMax', label: '每层最多带多少条术语', type: 'number', hint: '只带本层原文里出现的，默认 300' },
            {
                key: 'titleMode',
                label: '楼层标题',
                type: 'select',
                options: [
                    ['ai', 'AI 按剧情起标题，章号用层号'],
                    ['original', '用原文章节标题和章号'],
                ],
            },
            { key: 'titleFormat', label: '标题格式（写在 <bt> 里）', type: 'text', hint: '{n} 章号，{unit} 章或话，{title} 标题' },
            {
                key: 'chapterUnit',
                label: '用「章」还是「话」',
                type: 'select',
                options: [
                    ['auto', '跟原文'],
                    ['章', '第X章'],
                    ['话', '第X话'],
                ],
            },
            {
                key: 'importHighlight',
                label: '导入酒馆时标出 AI 补充的字',
                type: 'select',
                hint: '标了的话聊天记录导出 EPUB 时也带高亮；只影响导入酒馆和导出的聊天记录，TXT 不带',
                options: [
                    ['off', '不标'],
                    ['mark', '黄色底'],
                    ['color', '橙色字'],
                ],
            },
            {
                key: 'userMacroToName',
                label: '导入酒馆时把楼层里的 {{user}} 换成酒馆当前用户名',
                type: 'check',
                hint: '酒馆显示楼层时不会替换 {{user}}；勾上就在导入和导出聊天记录时写成你现在的用户名。世界书里的不换（酒馆发给 AI 时会自己换）',
            },
            {
                key: 'imageMode',
                label: 'EPUB 插图',
                type: 'select',
                options: [
                    ['bbi', '柏宝绘格式（聊天记录导出能打包进 EPUB）'],
                    ['img', '直接插入图片'],
                    ['off', '不导入插图'],
                ],
            },
        ],
        rewrite: [
            { key: 'expansionRatio', label: '扩写比例 %', type: 'number', hint: '补充内容约占原文字数的比例，默认 10' },
            { key: 'maxPatchChars', label: '单条补丁最多字数', type: 'number' },
            { key: 'rewritePrompt', label: '改写要求', type: 'textarea', rows: 5 },
            {
                key: 'outputFormat',
                label: '输出格式',
                type: 'textarea',
                rows: 8,
                reset: true,
                hint: '放在提示词最后（原文后面）。<bt>、<摘要> 两行和 <补丁> 块别删：标题、摘要写法和翻译时的正文会自动替换进去',
            },
            { key: 'jsonReminder', label: '输出格式后面的 JSON 提醒', type: 'textarea', rows: 3, reset: true },
            { key: 'extraRules', label: '其他规则（随便写，会原样放进提示词）', type: 'textarea', rows: 3 },
            { key: 'prevTailChars', label: '带上一层正文结尾的字数', type: 'number', hint: '让本层开头和上一层接得上；0 不带。取的是上一层处理完的正文（补丁、翻译、改写后的）；翻译时还会带上一层原文结尾的同样字数，让 AI 补上漏译的最后几句' },
            { key: 'carryTags', label: '上一层回复里一起发的标签', type: 'text', hint: '逗号分隔，比如 Plotline, Calculated_data。从上一层 AI 的原始回复里取（楼层里没有也行），原样带给本层；哪层没输出就沿用最近一次的' },
            { key: 'recapLayers', label: '前情提要带几层摘要', type: 'number', hint: '每层带上最近几层改写后的摘要，新剧情接得上；剧情改写中会额外带上从改写起点开始的层（最多 10 层）。0 不带' },
            { key: 'divergenceEnabled', label: '启用剧情改写强规则', type: 'check' },
            { key: 'divergenceRules', label: '触发剧情改写的情节（每行一条，可以随意加）', type: 'textarea', rows: 4 },
            { key: 'divergenceDirection', label: '改写方向', type: 'textarea', rows: 3 },
            {
                key: 'reviewMode',
                label: '审阅',
                type: 'select',
                options: [
                    ['divergence', '剧情改写的层停下来让我看'],
                    ['every', '每层都停下来让我看'],
                    ['off', '不停'],
                ],
            },
        ],
        stwb: [
            { key: 'stWorldEnabled', label: '把酒馆里开着的世界书当作输出要求发给 AI', type: 'check', hint: '全局、当前角色、当前聊天、人设绑定的世界书；关掉的条目不发' },
        ],
        alias: [
            { key: 'protagonistName', label: '主角原名', type: 'text', hint: '例如 路长远；不知道就留空，AI 会从前面的层认出主角' },
            { key: 'protagonistAliases', label: '主角的其他称呼（每行一个，AI 也会自己补充）', type: 'lines' },
            { key: 'aliasBlacklist', label: '不要替换的称呼（每行一个）', type: 'lines' },
            {
                key: 'aliasMode',
                label: '正文里主角替换成',
                type: 'select',
                options: [
                    ['user', '{{user}}'],
                    ['persona', '酒馆当前 user 的名字'],
                    ['custom', '自定义'],
                ],
            },
            { key: 'aliasTarget', label: '自定义称呼', type: 'text' },
            {
                key: 'aliasReplaceBy',
                label: '主角替换怎么做',
                type: 'select',
                options: [
                    ['ai', 'AI 输出时按语境替换（写进每层提示词）'],
                    ['text', '导出和导入酒馆时按称呼直接替换'],
                ],
                hint: '交给 AI 时，单字称呼、带「君」「同学」的称呼也会换，别的角色同名同字不会被误换；只对之后生成或重做的层有效。已经按旧方式生成的层，切到「按称呼直接替换」导出才会换。补丁模式下 AI 要逐处写替换补丁，补丁会多一些',
            },
            { key: 'titleTag', label: '标题标签', type: 'text' },
            { key: 'bodyTag', label: '正文标签', type: 'text' },
            {
                key: 'wordReplaceMode',
                label: '词语替换怎么做',
                type: 'select',
                options: [
                    ['ai', 'AI 输出时按语境替换（写进每层提示词）'],
                    ['text', '导出和导入酒馆时按文字直接替换'],
                ],
                hint: '交给 AI 时，AI 只换真正指这个人、这个东西的地方，称呼也会按新名字改，不会把别的词里的同一个字误换；只对之后生成或重做的层有效',
            },
            {
                key: 'wordReplace',
                label: '词语替换',
                type: 'textarea',
                rows: 4,
                hint: '每行一条：原词 → 新词（也可以写 ->）；新词留空就是删掉；原词写成 /正则/ 按正则替换。「立即应用到已生成的层」是按文字直接替换已经存下来的层，会先列出每一处给你核对；已生成的层想让 AI 按语境换，就重做那几层',
                button: { id: 'nim-wr-apply', label: '立即应用到已生成的层' },
            },
            {
                key: 'floorTagsBefore',
                label: '楼层里额外放在正文前面的标签',
                type: 'text',
                hint: '逗号分隔，比如 TimeFormat。放在标题和正文之间；从 AI 原始回复里取，夹在正文里的同名标签也挪到这里',
            },
            {
                key: 'floorTags',
                label: '楼层里额外放在正文后面的标签',
                type: 'text',
                hint: '逗号分隔，比如 Calculated_data, Plotline。从这层 AI 的原始回复里取，放在正文后面、表格前面；回复里没有就不放。想让 AI 输出这些标签，在「输出格式」里加上',
            },
        ],
        worldbook: [
            { key: 'worldbookEnabled', label: '提取世界书', type: 'check' },
            { key: 'worldbookPrompt', label: '世界书额外要求', type: 'textarea', rows: 3 },
            { key: 'worldbookContextChars', label: '每层带给 AI 的已有条目字数上限', type: 'number' },
            { key: 'summaryGuide', label: '每层摘要的写法', type: 'textarea', rows: 3, hint: '摘要会导出为「剧情 - 第N层」条目，也用在下一层的前情提要和角色卡简介里' },
            { key: 'plotSummaryEntries', label: '每层摘要也导出为「剧情」条目', type: 'check' },
            { key: 'plotPosition', label: '剧情条目的位置', type: 'select', options: POS_OPTIONS },
            { key: 'plotDepth', label: '剧情条目的深度（位置选自定义深度时）', type: 'number' },
            { key: 'plotOrder', label: '剧情条目的顺序', type: 'number', hint: '默认 50' },
            { key: 'plotAutoIncrement', label: '剧情条目顺序自动递增', type: 'check', hint: '按层从上面的顺序开始 50、51、52…' },
        ],
        table: [
            { key: 'tablesEnabled', label: '每层填写记忆表格', type: 'check' },
            { key: 'useMessageTemplate', label: '提示词里带上记忆插件的「消息模板」', type: 'check', hint: '只用里面的填写规则，insertRow 写法会去掉' },
            { key: 'tableMessageTemplate', label: '消息模板（从插件读取或导入模板文件时自动填入）', type: 'textarea', rows: 6 },
            { key: 'writeTableEdit', label: '楼层里写入 <tableEdit>（导入酒馆后重建表格要用）', type: 'check' },
            { key: 'tableRoles.singleRow', label: '只保留一行的表（每行一个表名）', type: 'lines' },
            { key: 'tableRoles.appendOnly', label: '只能插入的表（每行一个表名）', type: 'lines' },
            { key: 'tableRoles.eventTable', label: '事件表', type: 'text' },
            { key: 'tableRoles.eventsPerLayer', label: '每层事件条数', type: 'text', hint: '例如 3到5' },
            { key: 'tableRoles.summaryTable', label: '大总结表', type: 'text' },
            { key: 'tableRoles.summaryThreshold', label: '事件满多少条触发大总结', type: 'number' },
            { key: 'tablePrompt', label: '表格额外要求', type: 'textarea', rows: 3 },
            { key: 'tableContextRows', label: '每张表带给 AI 的相关行数上限', type: 'number' },
            { key: 'tableContextAll', label: '每层把表格全部发给 AI', type: 'check', hint: '默认只发本层提到的角色/物品那几行（会按译名、世界书关键词、称呼去找）；勾上就每层都发整张表，更稳但更费 token' },
        ],
        api: [
            { key: 'apiEndpoint', label: 'API 地址（OpenAI 兼容）', type: 'text', hint: '例如 https://api.example.com/v1' },
            { key: 'apiKey', label: 'API Key', type: 'password' },
            { key: 'apiModel', label: '模型', type: 'text' },
            { key: 'temperature', label: '温度', type: 'number', step: 0.05 },
            { key: 'maxTokens', label: '最大输出 tokens', type: 'number' },
            { key: 'apiTimeout', label: '无响应超时（毫秒）', type: 'number' },
            { key: 'retries', label: '格式错误重试次数', type: 'number' },
        ],
    };

    function fieldHtml(f) {
        const id = `nim-f-${f.key.replace(/\./g, '-')}`;
        if (f.type === 'check') {
            const hint = f.hint ? `<span class="nim-hint">${esc(f.hint)}</span>` : '';
            return `<label class="nim-check"><input type="checkbox" id="${id}" data-key="${f.key}" data-type="check"><span class="nim-switch"></span><span>${esc(f.label)}${hint}</span></label>`;
        }
        const hint = f.hint ? ` <span class="nim-hint">· ${esc(f.hint)}</span>` : '';
        let input;
        const wide = f.type === 'textarea' || f.type === 'lines' || f.type === 'json';
        if (wide) {
            input = `<textarea id="${id}" class="nim-input nim-textarea" rows="${f.rows || 4}" data-key="${f.key}" data-type="${f.type}"></textarea>`;
        } else if (f.type === 'select') {
            input = `<select id="${id}" class="nim-input" data-key="${f.key}" data-type="select">${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
        } else {
            const t = f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text';
            input = `<input id="${id}" class="nim-input" type="${t}" ${f.step ? `step="${f.step}"` : ''} data-key="${f.key}" data-type="${f.type}">`;
        }
        const reset = f.reset ? ` <button type="button" class="nim-btn ghost sm" data-reset="${f.key}">恢复默认</button>` : '';
        const btn = f.button ? ` <button type="button" class="nim-btn ghost sm" id="${f.button.id}">${esc(f.button.label)}</button>` : '';
        return `<div class="nim-field${wide || f.wide ? ' wide' : ''}"><label for="${id}">${esc(f.label)}${hint}${reset}${btn}</label>${input}</div>`;
    }

    function fillFields() {
        document.querySelectorAll('#nim-modal [data-key]').forEach((el) => {
            const v = getPath(State.settings, el.dataset.key);
            const t = el.dataset.type;
            if (t === 'check') el.checked = !!v;
            else if (t === 'lines') el.value = (v || []).join('\n');
            else if (t === 'json') el.value = JSON.stringify(v ?? null, null, 2);
            else el.value = v ?? '';
        });
    }

    function collectFields() {
        let ok = true;
        document.querySelectorAll('#nim-modal [data-key]').forEach((el) => {
            const t = el.dataset.type;
            let v;
            if (t === 'check') v = el.checked;
            else if (t === 'number') v = el.value === '' ? 0 : Number(el.value);
            else if (t === 'lines') v = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
            else if (t === 'json') {
                try {
                    v = JSON.parse(el.value);
                    el.classList.remove('nim-bad');
                } catch (e) {
                    el.classList.add('nim-bad');
                    ok = false;
                    return;
                }
            } else v = el.value;
            setPath(State.settings, el.dataset.key, v);
        });
        if (State.settings.aliasMode === 'persona') State.settings.personaName = ST.currentUserName();
        saveSettings();
        if (State.engine) {
            // 已分好的层不变，其他设置即时生效
            const keep = { layerChars: State.engine.settings.layerChars, chapterRegex: State.engine.settings.chapterRegex, adPatterns: State.engine.settings.adPatterns };
            Object.assign(State.engine.settings, State.settings, keep);
            State.engine.settings.tableRoles = { ...C.DEFAULT_TABLE_ROLES, ...State.settings.tableRoles };
        }
        return ok;
    }

    // ============================================
    // API（OpenAI 兼容）
    // ============================================

    function chatUrl(endpoint) {
        let base = (endpoint || '').trim();
        if (!base) throw new Error('请先填写 API 地址');
        if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
        base = base.replace(/\/+$/, '');
        return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
    }

    function modelsUrl(endpoint) {
        let url = (endpoint || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, '/models');
        return /\/models$/i.test(url) ? url : url + '/models';
    }

    function headers() {
        const h = { 'Content-Type': 'application/json' };
        if (State.settings.apiKey) h.Authorization = `Bearer ${State.settings.apiKey}`;
        return h;
    }

    async function fetchModels() {
        const resp = await fetch(modelsUrl(State.settings.apiEndpoint), { headers: headers() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : data?.models || [];
        return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    }

    const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

    /** 流式调用，超时按「多久没收到新数据」算 */
    // 有的中转站不认 stream_options，报错一次后就不再带
    let usageOptOk = true;

    /** 返回回复文本；接口给了真实用量就放在 State.lastUsage */
    async function callAPI(messages, onChunk) {
        const s = State.settings;
        State.lastUsage = null;
        const timeout = Number(s.apiTimeout) || 300000;
        const body = { model: s.apiModel || 'gpt-4o', messages, temperature: Number(s.temperature), stream: true };
        if (s.maxTokens) body.max_tokens = Number(s.maxTokens);
        if (usageOptOk) body.stream_options = { include_usage: true };
        const controller = new AbortController();
        State.abort = controller;
        let timer = setTimeout(() => controller.abort(), timeout);
        let resp;
        try {
            resp = await fetch(chatUrl(s.apiEndpoint), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal });
        } catch (e) {
            clearTimeout(timer);
            const err = new Error(e.name === 'AbortError' ? '请求超时或已停止' : `网络错误：${e.message}`);
            err.retryable = e.name !== 'AbortError' || !State.stopped;
            throw err;
        }
        if (!resp.ok) {
            clearTimeout(timer);
            const t = await resp.text().catch(() => '');
            if (usageOptOk && resp.status === 400 && /stream_options|include_usage/i.test(t)) {
                usageOptOk = false;
                return callAPI(messages, onChunk);
            }
            const err = new Error(`API 返回 ${resp.status}：${t.slice(0, 300)}`);
            err.retryable = RETRYABLE.has(resp.status);
            throw err;
        }
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('event-stream') || !resp.body) {
            clearTimeout(timer);
            const data = await resp.json();
            if (data && data.usage) State.lastUsage = data.usage;
            const text = data?.choices?.[0]?.message?.content || '';
            if (onChunk) onChunk(text, text);
            return text;
        }
        try {
            return await readSSE(resp, {
                onDelta: onChunk,
                onUsage: (u) => (State.lastUsage = u),
                onTick: () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => controller.abort(), timeout);
                },
            });
        } catch (e) {
            if (e.name === 'AbortError') {
                const err = new Error('响应中断：太久没有收到新数据');
                err.retryable = !State.stopped;
                throw err;
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    /** 读 OpenAI 格式的 SSE 流：每段增量调 onDelta(delta, full)，每次收到数据先调 onTick（续超时） */
    async function readSSE(resp, { onDelta, onUsage, onTick }) {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let full = '';
        for (;;) {
            if (onTick) onTick();
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const d = t.slice(5).trim();
                if (!d || d === '[DONE]') continue;
                let j;
                try {
                    j = JSON.parse(d);
                } catch (e) {
                    continue;
                }
                if (j.error) throw new Error(`流式错误：${j.error.message || JSON.stringify(j.error)}`);
                if (j.usage && onUsage) onUsage(j.usage);
                const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
                if (delta) {
                    full += delta;
                    if (onDelta) onDelta(delta, full);
                }
            }
        }
        return full;
    }

    /** 给引擎用：网络错误自己退避重试，格式错误交给引擎重试 */
    async function callModel(messages, info) {
        let last;
        for (let k = 0; k < 4; k++) {
            if (State.stopped) throw new Error('ABORTED');
            try {
                State.stream = '';
                const text = await callAPI(messages, (_d, full) => {
                    State.stream = full;
                    renderStream(info);
                });
                return { text, usage: State.lastUsage };
            } catch (e) {
                last = e;
                if (!e.retryable || k === 3) throw e;
                log(`第 ${info.layer + 1} 层请求失败，${2 ** k * 2} 秒后重试：${e.message}`);
                await sleep(2 ** k * 2000);
            }
        }
        throw last;
    }

    // ============================================
    // 断点续传（IndexedDB）
    // ============================================

    function openDB() {
        return new Promise((resolve, reject) => {
            if (State.db) return resolve(State.db);
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE, { keyPath: 'key' });
            req.onsuccess = (e) => resolve((State.db = e.target.result));
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function dbPut(value) {
        try {
            const db = await openDB();
            await new Promise((res, rej) => {
                const tx = db.transaction([STORE], 'readwrite');
                tx.objectStore(STORE).put({ key: 'current', value, time: Date.now() });
                tx.oncomplete = res;
                tx.onerror = () => rej(tx.error);
            });
        } catch (e) {
            log(`保存进度失败：${e.message}`);
        }
    }

    async function dbGet() {
        try {
            const db = await openDB();
            return await new Promise((res) => {
                const req = db.transaction([STORE], 'readonly').objectStore(STORE).get('current');
                req.onsuccess = () => res(req.result ? req.result.value : null);
                req.onerror = () => res(null);
            });
        } catch (e) {
            return null;
        }
    }

    function snapshot() {
        return {
            text: State.text,
            fileName: State.fileName,
            tableTemplate: State.tableTemplate,
            seedWorldbook: State.seedWorldbook,
            seedGlossary: State.seedGlossary,
            glossaryRemoved: State.glossaryRemoved,
            ledgerManual: State.ledgerManual,
            ledgerRemoved: State.ledgerRemoved,
            plan: State.plan,
            planBook: State.planBook,
            images: State.images,
            imagePaths: State.imagePaths,
            meta: State.meta,
            engine: State.engine ? State.engine.serialize() : null,
        };
    }

    let saveTimer = null;
    function saveProgress() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => dbPut(snapshot()), 300);
    }

    function restoreSnapshot(snap) {
        if (!snap) return;
        State.text = snap.text || '';
        State.fileName = snap.fileName || '';
        State.tableTemplate = snap.tableTemplate || null;
        State.seedWorldbook = snap.seedWorldbook || null;
        State.seedGlossary = snap.seedGlossary || null;
        State.glossaryRemoved = Array.isArray(snap.glossaryRemoved) ? snap.glossaryRemoved : [];
        State.ledgerManual = Array.isArray(snap.ledgerManual) ? snap.ledgerManual : [];
        State.ledgerRemoved = Array.isArray(snap.ledgerRemoved) ? snap.ledgerRemoved : [];
        State.plan = window.NovelImporterPlotMap.normalizePlan(snap.plan);
        State.planBook = snap.planBook || '';
        State.images = snap.images || [];
        State.imagePaths = snap.imagePaths || null;
        State.meta = { ...State.meta, ...(snap.meta || {}) };
        if (snap.engine) {
            State.engine = makeEngine(snap.engine.settings);
            State.engine.restore(snap.engine);
        }
    }

    // ============================================
    // 引擎
    // ============================================

    function makeEngine(settingsOverride) {
        const s = { ...State.settings, ...(settingsOverride || {}) };
        return C.createEngine({
            settings: s,
            // 取最新的预设：导入、开关、排序后不用重建引擎
            get preset() {
                return State.settings.preset;
            },
            substitute: substituteMacros,
            tableTemplate: State.tableTemplate,
            seedWorldbook: State.seedWorldbook,
            // 术语表在面板里随时能改，引擎每次取最新的
            get seedGlossary() {
                return State.seedGlossary;
            },
            get glossaryRemoved() {
                return State.glossaryRemoved;
            },
            // 既成事实账本在面板里随时能改，引擎每次取最新的
            get ledgerManual() {
                return State.ledgerManual;
            },
            get ledgerRemoved() {
                return State.ledgerRemoved;
            },
            // 剧情地图里每层的改写安排（指令、新大纲、接回、跳过……），处理时每层取最新的
            planFor: (i) => window.NovelImporterPlotMap.layerPlan(State.plan, i),
            get outputRules() {
                return State.settings.stWorldEnabled ? State.outputRules : '';
            },
            callModel,
            onEvent: onEngineEvent,
        });
    }

    function onEngineEvent(type, p) {
        if (type === 'layer-start') log(`第 ${p.index + 1} 层开始`);
        else if (type === 'layer-retry') log(`第 ${p.index + 1} 层第 ${p.attempt + 1} 次结果不合格：${p.error}`);
        else if (type === 'layer-repair') log(`第 ${p.index + 1} 层正文没问题，只是 JSON 格式坏了（${p.error}），只让 AI 修格式，不重写正文`);
        else if (type === 'layer-repair-failed') log(`第 ${p.index + 1} 层修格式的请求失败：${p.error}`);
        else if (type === 'layer-warn') log(`第 ${p.index + 1} 层：${p.warnings.join('；')}`);
        else if (type === 'layer-failed') {
            const r = State.engine && State.engine.results[p.index];
            log(`第 ${p.index + 1} 层失败：${p.error}${r && r.tokens ? `；已用 ${tokenText(r.tokens)}` : ''}`);
        }
        else if (type === 'layer-done') {
            const r = p.result;
            const f = r.patchStats.failed.length;
            if (!State.settings.protagonistName && r.parsed.protagonist) {
                const hero = State.engine && State.engine.finalState().protagonist;
                if (hero && hero !== State.heroLogged) {
                    State.heroLogged = hero;
                    log(`AI 认出主角是「${hero}」，正文里会换成设置的称呼；认错了就在设置「主角与标签」里填上正确的主角原名`);
                }
            }
            log(
                `第 ${p.index + 1} 层完成：${r.parsed.title}${r.divergenceStart ? '（改写起点）' : r.inDivergence ? '（改写中）' : ''}` +
                    (r.patchStats.rewritten ? '，整层改写' : `，补丁 ${r.patchStats.applied} 条${f ? `，${f} 条没对上` : ''}`) +
                    (r.askedBigSummary ? '，已做大总结' : '') +
                    (r.tokens ? `；${tokenText(r.tokens)}` : ''),
            );
            saveProgress();
        } else if (type === 'review') {
            State.selected = p.index;
            switchTab('run');
            openDetail(true);
            saveProgress();
        } else if (type === 'error') log(`出错：${p.error}`);
        renderAll();
    }

    async function prepareLayers() {
        if (!State.text) return toast('请先选择小说文件', 'warning');
        if (State.engine && State.engine.results.some((r) => r && r.status === 'done')) {
            if (!confirm('重新分层会清空已处理的结果，确定吗？')) return;
        }
        collectFields();
        State.engine = makeEngine();
        State.engine.prepare(State.text);
        State.selected = null;
        const st = State.engine.stats;
        log(`分成 ${State.engine.layers.length} 层，去掉广告行 ${st.cleanedLines} 行，重复垃圾段 ${st.repeatedLines} 段，行内水印 ${st.inlineAds} 处`);
        log(`标题按「第X${st.chapterUnit}」${st.translate ? '，识别为外文小说，会整本翻译成简体中文' : ''}${st.images ? `，正文里有 ${st.images} 处插图` : ''}`);
        if (st.emptyChapters.length) {
            const list = st.emptyChapters.slice(0, 20).join('、') + (st.emptyChapters.length > 20 ? ` 等` : '');
            log(`⚠ 有 ${st.emptyChapters.length} 章去掉垃圾内容后没有正文，原文可能被盗版站替换了，建议换个源：${list}`);
            toast(`有 ${st.emptyChapters.length} 章没有正文，详见日志`, 'warning');
        }
        saveProgress();
        renderAll();
    }

    async function start() {
        if (!State.engine) await prepareLayers();
        if (!State.engine) return;
        if (!collectFields()) return toast('有 JSON 格式不对的设置（红框）', 'error');
        if (!State.settings.apiEndpoint || !State.settings.apiModel) return toast('请先填写 API 地址和模型', 'warning');
        if (State.settings.tablesEnabled && !State.tableTemplate) {
            if (!confirm('还没导入记忆表格模板，这次不填表格，继续吗？')) return;
        }
        if (!State.settings.protagonistName) log('没填主角原名：让 AI 从前面的层认出主角，认出来后正文里的主角会换成设置的称呼');
        if (State.settings.stWorldEnabled && !(await loadOutputRulesForRun())) return;
        if (State.engine.reviewing !== null) State.engine.accept();
        State.stopped = false;
        renderAll();
        await State.engine.run();
        renderAll();
        if (State.engine.reviewing === null && State.engine.results.every((r) => r && r.status === 'done')) {
            log('全部层已完成，可以在「导入酒馆」一键导入');
            switchTab('export');
        }
    }

    /** 开始前重读酒馆世界书；读不到就问一句要不要不带着继续 */
    async function loadOutputRulesForRun() {
        try {
            await refreshStWorlds();
        } catch (e) {
            return confirm(`读取酒馆世界书失败（${e.message}），这次不带输出要求继续吗？`);
        }
        if (!State.outputRules) return confirm('勾选的酒馆世界书里没有可用的条目，这次不带输出要求继续吗？');
        const n = (State.stWorlds || []).filter((b) => !(State.settings.stWorldExclude || []).includes(b.name) && b.rules).length;
        log(`带上酒馆世界书 ${n} 本作为输出要求，约 ${State.outputRules.length} 字`);
        return true;
    }

    function stop() {
        State.stopped = true;
        if (State.engine) State.engine.stop();
        if (State.abort) State.abort.abort();
        log('已停止');
    }

    // ============================================
    // 导出与导入酒馆
    // ============================================

    function baseName() {
        return (State.fileName || '小说').replace(/\.(txt|epub)$/i, '');
    }

    function buildOutputs() {
        const e = State.engine;
        if (!e) throw new Error('还没有处理结果');
        // 设置里刚改的（分类的位置、顺序、递增，剧情条目设置）导出时要用上
        collectFields();
        e.settings.worldbookCategories = State.settings.worldbookCategories;
        const floors = e.renderFloors({ highlight: State.settings.importHighlight });
        if (!floors.length) throw new Error('还没有处理完的层');
        const cardName = State.meta.cardName || baseName();
        const worldName = State.meta.worldName || cardName;
        const worldbook = e.exportWorldbook();
        const persona = e.exportPersona();
        const userName = ST.currentUserName() || 'User';
        const chat = C.buildChatArray(floors, { charName: cardName, userName, replaceUserMacro: State.settings.userMacroToName !== false && !!ST.currentUserName() });
        return { floors, cardName, worldName, worldbook, persona, chat, tables: e.exportTables() };
    }

    async function genCardInfo() {
        if (!State.engine) return;
        if (State.engine.running) return toast('正在处理中，先暂停再生成简介', 'warning');
        log('正在生成角色卡简介...');
        // 点过停止后这个标记还留着，不清掉请求一发就会被当成已停止
        State.stopped = false;
        try {
            const job = State.engine.generateCardInfo();
            renderButtons();
            const info = await job;
            State.meta.description = info.description;
            State.meta.scenario = info.scenario;
            saveProgress();
            renderExport();
            log('简介已生成');
        } catch (e) {
            log(e.message === 'ABORTED' || State.stopped ? '已停止生成简介' : `生成简介失败：${e.message}`);
        }
        renderButtons();
    }

    async function importToTavern() {
        if (State.importing) return;
        let out;
        try {
            readMetaInputs();
            out = buildOutputs();
        } catch (e) {
            return toast(e.message, 'warning');
        }
        const btn = $('nim-import');
        const box = $('nim-import-result');
        const showResult = (cls, text) => {
            box.className = `nim-alert ${cls}`;
            box.textContent = text;
            box.hidden = false;
        };
        btn.disabled = true;
        btn.textContent = '导入中…';
        if (!State.meta.description && State.settings.apiEndpoint) {
            toast('简介是空的，先让 AI 生成简介，再导入', 'info');
            showResult('', '简介是空的，正在让 AI 生成简介…');
            await genCardInfo();
        }
        State.importing = true;
        State.stopped = false;
        showResult('', '正在导入，请稍等…');
        try {
            const res = await ST.importAll({
                cardName: out.cardName,
                worldName: out.worldName,
                worldbook: out.worldbook,
                description: State.meta.description,
                scenario: State.meta.scenario,
                avatar: State.meta.avatar,
                chatArray: await attachImages(out.chat, out.cardName, true),
                expectedTables: State.settings.tablesEnabled && State.tableTemplate ? out.tables : null,
                onStep: (s) => {
                    log(`导入：${s}`);
                    showResult('', `正在导入：${s}`);
                },
                onProgress: (i, n) => setStatus(`重建表格 ${i}/${n}`),
                shouldStop: () => State.stopped,
            });
            State.meta.avatar = res.avatar;
            saveProgress();
            log(`已导入：角色卡 ${res.avatar}，聊天 ${res.fileName}`);
            if (res.tables) {
                if (res.tables.ok) log(`记忆表格核对通过：${res.tables.live.map((t) => `${t.name} ${t.data.length - 1} 行`).join('，')}`);
                else log(`⚠️ 记忆表格和预期不一致：${res.tables.diffs.map((d) => `${d.table}：${d.reason}`).join('；')}`);
            }
            toast('导入完成', 'success');
            const tableNote = res.tables ? (res.tables.ok ? '，记忆表格核对通过' : '，⚠️ 记忆表格和预期不一致（详情见日志）') : '';
            showResult(res.tables && !res.tables.ok ? 'warn' : 'ok', `✅ ${new Date().toLocaleTimeString()} 导入完成：角色卡「${out.cardName}」、世界书「${out.worldName}」、${out.floors.length} 层楼层${tableNote}。酒馆里已经打开这张卡的聊天`);
        } catch (e) {
            log(`导入失败：${e.message}`);
            toast(`导入失败：${e.message}`, 'error');
            showResult('danger', `❌ 导入失败：${e.message}`);
        } finally {
            State.importing = false;
            btn.disabled = false;
            btn.textContent = '一键导入酒馆';
            setStatus('');
        }
    }

    async function rebuildOnly() {
        try {
            const out = buildOutputs();
            log('开始在当前聊天重建表格...');
            const r = await ST.rebuildTables({ expected: out.tables, onProgress: (i, n) => setStatus(`重建表格 ${i}/${n}`) });
            log(r.ok ? '记忆表格核对通过' : `⚠️ 不一致：${r.diffs.map((d) => `${d.table}：${d.reason}`).join('；')}`);
        } catch (e) {
            log(`重建失败：${e.message}`);
        } finally {
            setStatus('');
        }
    }

    async function writePersona() {
        try {
            const out = buildOutputs();
            if (!out.persona.description) return toast('世界书里还没有主角条目', 'warning');
            if (!confirm('会覆盖当前用户人设的描述，确定吗？')) return;
            await ST.writePersonaDescription(out.persona.description);
            log('已写入当前用户人设');
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function exportFile(kind) {
        let out;
        try {
            readMetaInputs();
            out = buildOutputs();
        } catch (e) {
            return toast(e.message, 'warning');
        }
        const n = out.cardName;
        if (kind === 'chat') attachImages(out.chat, n, false).then((chat) => download(C.chatToJsonl(chat), `${n}.jsonl`, 'application/jsonl'));
        else if (kind === 'world') download(JSON.stringify(out.worldbook, null, 2), `${out.worldName}.json`);
        else if (kind === 'card')
            download(
                JSON.stringify(
                    C.buildCharacterCard({ name: n, description: State.meta.description, scenario: State.meta.scenario, worldName: out.worldName, worldbook: out.worldbook }),
                    null,
                    2,
                ),
                `${n}.card.json`,
            );
        else if (kind === 'persona') download(out.persona.description, `${n}-用户人设.txt`, 'text/plain');
        else if (kind === 'tables') download(JSON.stringify(out.tables, null, 2), `${n}-表格.json`);
        else if (kind === 'glossary') download(JSON.stringify(State.engine.finalState().glossary || [], null, 2), `${n}-术语表.json`);
        else if (kind === 'txt') {
            const txt = out.floors
                .map((f) => `${f.heading || f.title}\n\n${f.body.replace(C.IMAGE_MARKER_RE, '[插图$1]')}`)
                .join('\n\n');
            download(txt, `${n}-改写.txt`, 'text/plain');
        }
    }

    function exportConfig() {
        collectFields();
        const s = { ...State.settings };
        delete s.apiKey;
        download(JSON.stringify(s, null, 2), '小说导入改写-配置.json');
    }

    async function importConfig(file) {
        try {
            const j = JSON.parse(await readFileText(file));
            const key = State.settings.apiKey;
            State.settings = { ...withDefaults(j), apiKey: j.apiKey || key };
            saveSettings();
            fillFields();
            renderPreset();
            renderCategories();
            toast('配置已导入', 'success');
        } catch (e) {
            toast(`配置导入失败：${e.message}`, 'error');
        }
    }

    function exportTask() {
        download(JSON.stringify(snapshot()), `${baseName()}-任务.json`);
    }

    async function importTask(file) {
        try {
            const snap = JSON.parse(await readFileText(file));
            restoreSnapshot(snap);
            saveProgress();
            renderAll();
            toast('任务已恢复', 'success');
        } catch (e) {
            toast(`任务导入失败：${e.message}`, 'error');
        }
    }


    // ============================================
    // 插图（EPUB）
    // ============================================

    const UPLOAD_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

    /** 和柏宝绘、聊天记录导出插件同一个哈希：extra.bbiImage 按它找图 */
    function bbiPromptHash(text) {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
    }

    /** 酒馆收不了的格式（主要是 SVG）先画成 PNG */
    async function toUploadable(img) {
        const ext = (img.mime.split('/')[1] || '').replace('svg+xml', 'svg');
        if (UPLOAD_FORMATS.includes(ext)) return { data: img.data, format: ext === 'jpeg' ? 'jpg' : ext };
        const el = new Image();
        el.src = `data:${img.mime};base64,${img.data}`;
        await el.decode();
        const cv = document.createElement('canvas');
        cv.width = el.naturalWidth || 1000;
        cv.height = el.naturalHeight || 1400;
        cv.getContext('2d').drawImage(el, 0, 0, cv.width, cv.height);
        return { data: cv.toDataURL('image/png').split(',')[1], format: 'png' };
    }

    /**
     * 把楼层里的〔插图N〕换成插图。upload 为 true 时先把用到的图传到酒馆（user/images/角色卡名/）。
     * 柏宝绘格式：正文写 <bbi_image>插图N</bbi_image>，路径记在 extra.bbiImage["0"][哈希] 里，
     * 聊天记录导出插件按同样的规则找到图片打进 EPUB。
     */
    async function attachImages(chat, cardName, upload) {
        const mode = State.settings.imageMode || 'bbi';
        const re = () => new RegExp(C.IMAGE_MARKER_RE.source, 'g');
        const used = new Set();
        for (const m of chat.slice(1)) for (const x of m.mes.matchAll(re())) used.add(Number(x[1]));
        if (!used.size) return chat;
        if (!State.imagePaths || State.imagePaths.card !== cardName) State.imagePaths = { card: cardName, map: {} };
        const paths = State.imagePaths.map;
        const byId = new Map((State.images || []).map((im) => [im.id, im]));
        if (upload && mode !== 'off') {
            const todo = [...used].filter((id) => !paths[id] && byId.has(id));
            let k = 0;
            for (const id of todo) {
                setStatus(`上传插图 ${++k}/${todo.length}`);
                try {
                    const u = await toUploadable(byId.get(id));
                    paths[id] = await ST.uploadImage(cardName, `${baseName()}-插图${id}`, u.data, u.format);
                } catch (e) {
                    log(`插图 ${id} 上传失败：${e.message}`);
                }
            }
            if (todo.length) log(`已上传插图 ${Object.keys(paths).length} 张`);
            saveProgress();
        }
        return chat.map((m, i) => {
            if (i === 0 || !re().test(m.mes)) return m;
            let seq = 0;
            const bucket = {};
            const mes = m.mes
                .replace(new RegExp(`\\n?${C.IMAGE_MARKER_RE.source}\\n?`, 'g'), (all, id) => {
                    const path = paths[id];
                    if (mode === 'off' || !path) return '\n';
                    if (mode === 'img') return `\n<img src="${path}" alt="插图${id}">\n`;
                    const tag = `<bbi_image>插图${id}</bbi_image>`;
                    const h = bbiPromptHash(tag);
                    (bucket[h] = bucket[h] || []).push({ path, slotSeq: seq++, status: 'success', createdAt: Date.now() });
                    return `\n${tag}\n`;
                })
                .replace(/\n{3,}/g, '\n\n');
            const extra = { ...(m.extra || {}) };
            if (Object.keys(bucket).length) extra.bbiImage = { 0: bucket };
            return { ...m, mes, swipes: [mes], extra };
        });
    }

    /** 先用酒馆自带的 JSZip（不用联网），没有再走 CDN */
    async function loadJSZip() {
        if (window.JSZip) return window.JSZip;
        try {
            await import('/lib/jszip.min.js');
            if (window.JSZip) return window.JSZip;
        } catch (e) {
            /* 老版本酒馆没有，走 CDN */
        }
        await new Promise((resolve, reject) => {
            const sc = document.createElement('script');
            sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            sc.onload = resolve;
            sc.onerror = () => reject(new Error('JSZip 加载失败'));
            document.head.appendChild(sc);
        });
        return window.JSZip;
    }

    function resolvePath(base, href) {
        const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
        const out = [];
        for (const p of parts) {
            if (p === '..') out.pop();
            else if (p !== '.' && p !== '') out.push(p);
        }
        return out.join('/');
    }

    /** 读 EPUB：按书脊顺序取正文，插图在原位置留〔插图N〕，图片数据另存 */
    async function parseEpubWithImages(buf) {
        const JSZip = await loadJSZip();
        const zip = await JSZip.loadAsync(buf);
        const xml = (t) => new DOMParser().parseFromString(t, 'application/xml');
        const container = zip.file('META-INF/container.xml');
        if (!container) throw new Error('不是有效的 EPUB');
        const opfPath = xml(await container.async('string')).querySelector('rootfile')?.getAttribute('full-path');
        const opfFile = opfPath && zip.file(opfPath);
        if (!opfFile) throw new Error('不是有效的 EPUB');
        const opf = xml(await opfFile.async('string'));
        const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
        const manifest = {};
        opf.querySelectorAll('manifest > item, manifest item').forEach((it) => {
            manifest[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type') || '' };
        });
        const title = (opf.querySelector('metadata title') || opf.getElementsByTagName('dc:title')[0])?.textContent?.trim() || '';
        const images = [];
        const seen = new Map(); // zip 路径 -> id，同一张图多次出现只存一份
        const texts = [];
        for (const ref of opf.querySelectorAll('spine itemref')) {
            const item = manifest[ref.getAttribute('idref')];
            if (!item || !/html/.test(item.type)) continue;
            const path = resolvePath(base, item.href);
            const file = zip.file(path);
            if (!file) continue;
            const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
            const doc = new DOMParser().parseFromString(await file.async('string'), 'text/html');
            if (!doc.body) continue;
            doc.querySelectorAll('script, style').forEach((el) => el.remove());
            for (const el of [...doc.body.querySelectorAll('img, image')]) {
                const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
                const zp = src && !/^(data|https?):/i.test(src) ? resolvePath(dir, src) : '';
                const zf = zp && zip.file(zp);
                let marker = '';
                if (zf) {
                    let id = seen.get(zp);
                    if (!id) {
                        id = images.length + 1;
                        const ext = (zp.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || 'png';
                        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext] || 'image/png';
                        images.push({ id, name: zp.split('/').pop(), mime, data: await zf.async('base64') });
                        seen.set(zp, id);
                    }
                    marker = `\n〔插图${id}〕\n`;
                }
                // <svg><image/></svg> 整个换掉
                const host = el.tagName.toLowerCase() === 'image' && el.closest('svg') ? el.closest('svg') : el;
                host.replaceWith(doc.createTextNode(marker));
            }
            doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
            doc.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, section, article').forEach((el) => el.append('\n'));
            const text = (doc.body.textContent || '')
                .replace(/[ \t]+/g, ' ')
                .replace(/ ?\n ?/g, '\n')
                .replace(/\n{2,}/g, '\n')
                .trim();
            if (text) texts.push(text);
        }
        return { title, text: texts.join('\n'), images };
    }

    // ============================================
    // 文件导入
    // ============================================

    async function onNovelFile(file) {
        let text;
        State.images = [];
        State.imagePaths = null;
        try {
            if (/\.epub$/i.test(file.name)) {
                setStatus('正在读取 EPUB...');
                const r = await parseEpubWithImages(await file.arrayBuffer());
                text = r.text;
                State.images = r.images;
            } else text = await decodeTxt(file);
        } catch (e) {
            setStatus('');
            return toast(`读取失败：${e.message}`, 'error');
        }
        setStatus('');
        // 换了一本书：剧情地图和既成事实是上一本的，清掉；同一本重新导入就保留
        const book = PM.hashText(text);
        if (State.planBook !== book) resetBookPlan();
        State.planBook = book;
        State.text = text;
        State.fileName = file.name;
        State.engine = null;
        State.meta = { cardName: baseName(), worldName: baseName(), avatar: '', description: '', scenario: '' };
        renderExport();
        log(`已读取 ${file.name}，${text.length} 字${State.images.length ? `，插图 ${State.images.length} 张` : ''}`);
        await prepareLayers();
    }

    function applyTemplate(tpl, messageTemplate, source) {
        State.tableTemplate = tpl;
        const withNotes = tpl.tables.filter((t) => t.note || t.insertNode || t.updateNode || t.deleteNode).length;
        if (messageTemplate) {
            State.settings.tableMessageTemplate = messageTemplate;
            saveSettings();
            fillFields();
        }
        const msg = `${source}：${tpl.tables.length} 张表，${withNotes} 张有填写说明${messageTemplate ? '，已读取消息模板' : '，没有消息模板'}`;
        log(`${msg}（${tpl.tables.map((t) => t.name).join('、')}）`);
        toast(msg, withNotes ? 'success' : 'warning');
        // 还没开始跑的话，用新模板重建引擎
        if (State.engine && !State.engine.results.some((r) => r && r.status === 'done')) {
            State.engine = makeEngine(State.engine.settings);
            State.engine.prepare(State.text);
        }
        saveProgress();
        renderAll();
    }

    async function onTemplateFile(file) {
        try {
            const json = JSON.parse(await readFileText(file));
            applyTemplate(C.parseTableTemplate(json), (json && typeof json.message_template === 'string' && json.message_template) || '', '已导入表格模板');
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    /** 从插件读：表名和列取当前聊天里的表，填写说明和消息模板取插件设置 */
    function templateFromPlugin() {
        const live = ST.readPluginTables();
        if (!live || !live.length) return toast('没读到记忆插件的表格：请先打开一个有表格的聊天', 'warning');
        const notes = ST.readPluginTemplateNotes();
        const list = live.map((t) => ({ tableName: t.name, columns: t.data[0] || [], ...(notes[t.name] || {}) }));
        applyTemplate(C.parseTableTemplate(list), ST.readMessageTemplate(), '已从记忆插件读取');
    }

    async function onWorldbookFile(file) {
        try {
            State.seedWorldbook = C.importWorldbook(JSON.parse(await readFileText(file)));
            const n = Object.values(State.seedWorldbook).reduce((a, x) => a + Object.keys(x).length, 0);
            log(`已读入初始世界书 ${n} 条，处理时会在此基础上更新`);
            saveProgress();
            renderAll();
        } catch (e) {
            toast(`世界书读取失败：${e.message}`, 'error');
        }
    }

    function setSeedGlossary(list, source) {
        State.seedGlossary = C.normalizeGlossary(list);
        log(`${source}：术语 ${State.seedGlossary.length} 条`);
        toast(`术语表 ${State.seedGlossary.length} 条`, 'success');
        if (State.engine) State.engine = rebuildEngineKeepResults();
        saveProgress();
        renderAll();
    }

    /** 换了初始术语表或世界书后，已跑完的层保留，后面的层用新的 */
    function rebuildEngineKeepResults() {
        const snap = State.engine.serialize();
        const e = makeEngine(snap.settings);
        e.restore(snap);
        return e;
    }

    function glossaryFromTranslator() {
        try {
            const s = JSON.parse(localStorage.getItem('novelTranslateSettings') || '{}');
            if (!Array.isArray(s.glossary) || !s.glossary.length) return toast('小说翻译模块里还没有术语表', 'warning');
            setSeedGlossary(s.glossary, '已从小说翻译模块读取');
        } catch (e) {
            toast(`读取失败：${e.message}`, 'error');
        }
    }

    async function onGlossaryFile(file) {
        try {
            const t = await readFileText(file);
            let list;
            try {
                const j = JSON.parse(t);
                list = Array.isArray(j) ? j : j.glossary || [];
            } catch (e) {
                list = C.parseGlossaryLines(t);
            }
            setSeedGlossary(list, `已导入 ${file.name}`);
        } catch (e) {
            toast(`术语表读取失败：${e.message}`, 'error');
        }
    }

    async function onPresetFile(file) {
        try {
            const p = C.parseSTPreset(JSON.parse(await readFileText(file)));
            State.settings.preset = { name: file.name.replace(/\.json$/i, ''), entries: p.entries, squash: p.squash };
            storePresetInLibrary(State.settings.preset);
            if (p.params.temperature != null) State.settings.temperature = p.params.temperature;
            if (p.params.maxTokens) State.settings.maxTokens = p.params.maxTokens;
            saveSettings();
            fillFields();
            presetUi.selecting = false;
            presetUi.selected.clear();
            renderPreset();
            const notes = [
                `已导入 ${p.promptCount} 个条目（启用 ${p.enabledCount}）`,
                p.skipped ? `酒馆条目列表里没放的 ${p.skipped} 个条目不导入（酒馆里也不发送）` : '',
                p.droppedMarkers ? `角色卡、世界书等占位 ${p.droppedMarkers} 个不导入` : '',
                p.hadChatHistory ? '' : '预设里没有聊天记录，本层提示词放在了末尾',
            ].filter(Boolean);
            log(`预设 ${State.settings.preset.name}：${notes.join('；')}`);
            toast(notes.join('；'), 'success');
        } catch (e) {
            toast(`导入预设失败：${e.message}`, 'error');
        }
    }

    // ============================================
    // 预设方案：存几套预设，按模型切换
    // ============================================

    const DEFAULT_PRESET_KEY = '__default__';

    function presetLibrary() {
        return Array.isArray(State.settings.presetLibrary) ? State.settings.presetLibrary : [];
    }

    /** 同名的覆盖，没有就加在最后 */
    function storePresetInLibrary(preset, name = preset.name) {
        const lib = presetLibrary().filter((x) => x.name !== name);
        lib.push({ name: name || '未命名预设', preset: JSON.parse(JSON.stringify({ ...preset, name: name || preset.name })) });
        State.settings.presetLibrary = lib;
        saveSettings();
        renderPresetLibrary();
    }

    function renderPresetLibrary() {
        const sel = $('nim-preset-lib');
        if (!sel) return;
        const cur = State.settings.preset && State.settings.preset.name;
        sel.innerHTML =
            `<option value="${DEFAULT_PRESET_KEY}">插件默认</option>` +
            presetLibrary()
                .map((x, k) => `<option value="${k}" ${x.name === cur ? 'selected' : ''}>${esc(x.name)}</option>`)
                .join('');
    }

    function usePresetFromLibrary() {
        const v = $('nim-preset-lib').value;
        const p = v === DEFAULT_PRESET_KEY ? C.presetDefaults() : presetLibrary()[Number(v)] && presetLibrary()[Number(v)].preset;
        if (!p) return;
        State.settings.preset = C.normalizePreset(JSON.parse(JSON.stringify(p)));
        saveSettings();
        presetUi.selecting = false;
        presetUi.selected.clear();
        renderPreset();
        log(`预设切换到「${State.settings.preset.name || '插件默认'}」`);
        toast(`已切换到「${State.settings.preset.name || '插件默认'}」，后面的层按它发`, 'success');
    }

    function savePresetToLibrary() {
        const cur = State.settings.preset || {};
        const input = $('nim-preset-name-input');
        const name = ((input && input.value) || cur.name || '').trim() || `预设方案 ${presetLibrary().length + 1}`;
        storePresetInLibrary(cur, name);
        State.settings.preset = { ...cur, name };
        saveSettings();
        renderPreset();
        toast(`已存成方案「${name}」`, 'success');
    }

    function deletePresetFromLibrary() {
        const v = $('nim-preset-lib').value;
        if (v === DEFAULT_PRESET_KEY) return toast('插件默认不能删', 'info');
        const x = presetLibrary()[Number(v)];
        if (!x || !confirm(`删掉方案「${x.name}」？当前正在用的预设不受影响。`)) return;
        State.settings.presetLibrary = presetLibrary().filter((_, k) => k !== Number(v));
        saveSettings();
        renderPresetLibrary();
    }

    /** 预设条目里的 {{char}}/{{user}} 等宏交给酒馆展开 */
    function substituteMacros(text) {
        try {
            const c = window.SillyTavern && window.SillyTavern.getContext();
            if (c && typeof c.substituteParams === 'function') return c.substituteParams(text);
        } catch (e) {
            /* 不在酒馆里就原样发 */
        }
        return text;
    }

    // ============================================
    // 预设面板：条目开关、按住抓手拖动排序、编辑、多选删除（和柏宝绘的重型提示词一样）
    // ============================================

    const ROLE_LABEL = { system: '系统', user: '用户', assistant: 'AI' };
    const presetUi = { selecting: false, selected: new Set(), dragId: null, editing: null };

    function presetEntries() {
        return State.settings.preset.entries;
    }

    function presetRow(e) {
        const slot = e.id === C.PRESET_SLOT_ID;
        const picked = presetUi.selected.has(e.id);
        const cls = ['nim-pr', slot ? 'is-slot' : '', !slot && !e.enabled ? 'is-off' : '', presetUi.dragId === e.id ? 'is-dragging' : '', picked ? 'is-picked' : ''].join(' ');
        let lead;
        if (slot) lead = '<span class="nim-pr-pin" title="固定条目：每层的提示词放在这里">📌</span>';
        else if (presetUi.selecting) lead = `<input type="checkbox" class="nim-pr-check" data-pick="${esc(e.id)}" ${picked ? 'checked' : ''} title="选择">`;
        else lead = `<label class="nim-pr-toggle" title="${e.enabled ? '关闭此条目' : '启用此条目'}"><input type="checkbox" data-toggle="${esc(e.id)}" ${e.enabled ? 'checked' : ''}><span class="nim-switch"></span></label>`;
        const tags = slot ? '' : `<span class="nim-pr-tag">${ROLE_LABEL[e.role]}</span><span class="nim-pr-tag ${e.position === 'depth' ? 'is-depth' : ''}">${e.position === 'depth' ? `深度 ${e.depth}` : '相对'}</span>`;
        const handle = `<span class="nim-pr-handle" data-drag="${esc(e.id)}" title="按住拖动排序"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>`;
        return `<li class="${cls}" data-id="${esc(e.id)}">${handle}${lead}<button class="nim-pr-open" data-open="${esc(e.id)}" ${slot ? 'disabled' : ''}><span class="nim-pr-name">${esc(e.name)}</span>${tags}</button></li>`;
    }

    function renderPreset() {
        const box = $('nim-preset');
        if (!box) return;
        const p = State.settings.preset;
        const real = p.entries.filter((e) => e.id !== C.PRESET_SLOT_ID);
        const selectable = real.map((e) => e.id);
        const allPicked = selectable.length && selectable.every((id) => presetUi.selected.has(id));
        $('nim-preset-name').innerHTML = `${esc(p.name || '未导入预设')}${real.length ? ` <span class="nim-muted">已启用 ${real.filter((e) => e.enabled).length}/${real.length}</span>` : ''}`;
        $('nim-preset-list').innerHTML = p.entries.map((e) => presetRow(e)).join('');
        $('nim-preset-actions').innerHTML = presetUi.selecting
            ? `<button class="nim-btn sm" data-act="all">${allPicked ? '全不选' : '全选'}</button><button class="nim-btn sm danger-ghost" data-act="del" ${presetUi.selected.size ? '' : 'disabled'}>删除选中（${presetUi.selected.size}）</button><button class="nim-btn sm" data-act="done">完成</button>`
            : `<button class="nim-btn sm" data-act="add">新建条目</button>${selectable.length ? '<button class="nim-btn sm" data-act="select">多选删除</button>' : ''}${real.length ? '<button class="nim-btn sm danger-ghost" data-act="clear">清空预设</button>' : ''}`;
        $('nim-preset-squash').checked = !!p.squash;
        renderPresetLibrary();
    }

    function findPresetEntry(id) {
        const p = State.settings.preset;
        return p.entries.find((e) => e.id === id) || null;
    }

    function presetChanged() {
        saveSettings();
        renderPreset();
    }

    function bindPreset() {
        const box = $('nim-preset');
        if (!box) return;
        box.addEventListener('change', (ev) => {
            const t = ev.target;
            if (t.dataset.toggle) {
                const e = findPresetEntry(t.dataset.toggle);
                if (e) e.enabled = t.checked;
                presetChanged();
            } else if (t.dataset.pick) {
                if (t.checked) presetUi.selected.add(t.dataset.pick);
                else presetUi.selected.delete(t.dataset.pick);
                renderPreset();
            } else if (t.id === 'nim-preset-squash') {
                State.settings.preset.squash = t.checked;
                presetChanged();
            }
        });
        box.addEventListener('click', async (ev) => {
            const t = ev.target.closest('button');
            if (!t) return;
            const p = State.settings.preset;
            if (t.dataset.open) {
                if (presetUi.selecting) {
                    const id = t.dataset.open;
                    if (presetUi.selected.has(id)) presetUi.selected.delete(id);
                    else presetUi.selected.add(id);
                    renderPreset();
                } else openPresetEdit(t.dataset.open);
            } else if (t.dataset.act === 'add') {
                const e = { id: `nim-custom-${Date.now().toString(36)}`, name: '新条目', role: 'system', content: '', enabled: true, position: 'relative', depth: 4, order: 100 };
                p.entries.push(e);
                presetChanged();
                openPresetEdit(e.id);
            } else if (t.dataset.act === 'select') {
                presetUi.selecting = true;
                presetUi.selected.clear();
                renderPreset();
            } else if (t.dataset.act === 'done') {
                presetUi.selecting = false;
                presetUi.selected.clear();
                renderPreset();
            } else if (t.dataset.act === 'all') {
                const ids = p.entries.filter((e) => e.id !== C.PRESET_SLOT_ID).map((e) => e.id);
                const all = ids.every((id) => presetUi.selected.has(id));
                presetUi.selected.clear();
                if (!all) ids.forEach((id) => presetUi.selected.add(id));
                renderPreset();
            } else if (t.dataset.act === 'del') {
                if (!confirm(`删除选中的 ${presetUi.selected.size} 个条目？删除后要重新导入预设才能找回。`)) return;
                p.entries = p.entries.filter((e) => e.id === C.PRESET_SLOT_ID || !presetUi.selected.has(e.id));
                presetUi.selecting = false;
                presetUi.selected.clear();
                presetChanged();
            } else if (t.dataset.act === 'clear') {
                if (!confirm('清空后所有条目都会删除，需要时重新导入。')) return;
                State.settings.preset = C.presetDefaults();
                presetChanged();
            }
        });
        // 拖动用 Pointer Events：手机上触摸不会触发 HTML5 的 dragstart。抓手设了 touch-action:none，按住上下滑就能换位
        const list = $('nim-preset-list');
        list.addEventListener('pointerdown', (ev) => {
            const h = ev.target.closest('[data-drag]');
            if (!h || ev.button !== 0 || presetUi.selecting) return;
            ev.preventDefault();
            presetUi.dragId = h.dataset.drag;
            h.setPointerCapture(ev.pointerId);
            list.querySelector(`li[data-id="${CSS.escape(presetUi.dragId)}"]`)?.classList.add('is-dragging');
        });
        list.addEventListener('pointermove', (ev) => {
            if (!presetUi.dragId) return;
            const entries = presetEntries();
            const from = entries.findIndex((e) => e.id === presetUi.dragId);
            if (from < 0) return;
            const rows = [...list.children];
            let to = from;
            // 越过相邻行的中线才换位，免得在交界处来回抖
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i].getBoundingClientRect();
                const mid = r.top + r.height / 2;
                if (i < from && ev.clientY < mid) {
                    to = i;
                    break;
                }
                if (i > from && ev.clientY > mid) to = i;
            }
            if (to === from) return;
            const [moved] = entries.splice(from, 1);
            entries.splice(to, 0, moved);
            const row = rows[from];
            if (to > from) rows[to].after(row);
            else rows[to].before(row);
        });
        const end = () => {
            if (!presetUi.dragId) return;
            presetUi.dragId = null;
            presetChanged();
        };
        list.addEventListener('pointerup', end);
        list.addEventListener('pointercancel', end);
    }

    function openPresetEdit(id) {
        const e = findPresetEntry(id);
        if (!e || e.id === C.PRESET_SLOT_ID) return;
        presetUi.editing = id;
        $('nim-pe-name').value = e.name;
        $('nim-pe-role').value = e.role;
        $('nim-pe-pos').value = e.position;
        $('nim-pe-depth').value = e.depth;
        $('nim-pe-order').value = e.order;
        $('nim-pe-content').value = e.content;
        $('nim-pe-depthrow').hidden = e.position !== 'depth';
        $('nim-pe').hidden = false;
    }

    function closePresetEdit(save) {
        const e = presetUi.editing && findPresetEntry(presetUi.editing);
        if (save && e) {
            e.name = $('nim-pe-name').value.trim() || e.name;
            e.role = $('nim-pe-role').value;
            e.position = $('nim-pe-pos').value === 'depth' ? 'depth' : 'relative';
            e.depth = Math.max(0, Math.floor(Number($('nim-pe-depth').value)) || 0);
            e.order = Math.floor(Number($('nim-pe-order').value)) || 0;
            e.content = $('nim-pe-content').value;
        }
        presetUi.editing = null;
        $('nim-pe').hidden = true;
        presetChanged();
    }

    function removePresetEditing() {
        const id = presetUi.editing;
        const p = State.settings.preset;
        p.entries = p.entries.filter((e) => e.id !== id);
        presetUi.editing = null;
        $('nim-pe').hidden = true;
        presetChanged();
    }

    // ============================================
    // 世界书分类：和「TXT转世界书」的自定义提取分类同一套字段和操作
    // ============================================

    const catUi = { editing: null };
    function categories() {
        return State.settings.worldbookCategories;
    }

    function renderCategories() {
        const el = $('nim-cats');
        if (!el) return;
        const list = categories();
        el.innerHTML = list.length
            ? list
                  .map((c, i) => {
                      const hasDefault = C.DEFAULT_WORLDBOOK_CATEGORIES.some((d) => d.name === c.name);
                      return `<li class="nim-pr ${c.enabled ? '' : 'is-off'}">
                        <label class="nim-pr-toggle" title="${c.enabled ? '不提取这一类' : '提取这一类'}"><input type="checkbox" data-cat-on="${i}" ${c.enabled ? 'checked' : ''}><span class="nim-switch"></span></label>
                        <button class="nim-pr-open" data-cat-edit="${i}"><span class="nim-pr-name">${esc(c.name)}</span>${c.isBuiltin ? '<span class="nim-pr-tag">内置</span>' : ''}${c.constant ? '<span class="nim-pr-tag is-depth">常驻</span>' : ''}</button>
                        <button class="nim-icon-btn sm" data-cat-reset="${i}" title="重置为默认" ${hasDefault ? '' : 'disabled'}>↺</button>
                        <button class="nim-icon-btn sm" data-cat-del="${i}" title="删除" ${c.isBuiltin ? 'disabled' : ''}>✕</button>
                      </li>`;
                  })
                  .join('')
            : '<li class="nim-empty">暂无分类</li>';
    }

    function catsChanged() {
        saveSettings();
        // 恢复的任务里引擎带的是当时的设置副本，分类改了要同步过去，导出才按新的位置、顺序走
        if (State.engine) State.engine.settings.worldbookCategories = State.settings.worldbookCategories;
        renderCategories();
    }

    function openCatEdit(index) {
        const c = index === null ? C.normalizeCategory({ name: '' }) : categories()[index];
        catUi.editing = index;
        $('nim-ce-title').textContent = index === null ? '添加分类' : '编辑分类';
        $('nim-ce-name').value = c.name;
        $('nim-ce-example').value = index === null ? '' : c.entryExample;
        $('nim-ce-keywords').value = index === null ? '' : c.keywordsExample.join(', ');
        $('nim-ce-guide').value = index === null ? '' : c.contentGuide;
        $('nim-ce-pos').value = String(c.defaultPosition);
        $('nim-ce-depth').value = c.defaultDepth;
        $('nim-ce-order').value = c.defaultOrder;
        $('nim-ce-inc').checked = c.autoIncrementOrder;
        $('nim-ce-constant').checked = c.constant;
        $('nim-ce').hidden = false;
        $('nim-ce-name').focus({ preventScroll: true });
    }

    function saveCatEdit() {
        const name = $('nim-ce-name').value.trim();
        if (!name) return toast('请输入分类名称', 'warning');
        const list = categories();
        const i = catUi.editing;
        if (list.some((c, k) => c.name === name && k !== i)) return toast('这个分类名称已经有了', 'warning');
        const old = i === null ? null : list[i];
        const cat = C.normalizeCategory({
            name,
            enabled: old ? old.enabled : true,
            isBuiltin: old ? old.isBuiltin : false,
            entryExample: $('nim-ce-example').value.trim() || `${name}名称`,
            keywordsExample: $('nim-ce-keywords').value,
            contentGuide: $('nim-ce-guide').value.trim() || `基于原文的${name}描述`,
            defaultPosition: parseInt($('nim-ce-pos').value, 10) || 0,
            defaultDepth: parseInt($('nim-ce-depth').value, 10) || 4,
            defaultOrder: parseInt($('nim-ce-order').value, 10) || 100,
            autoIncrementOrder: $('nim-ce-inc').checked,
            constant: $('nim-ce-constant').checked,
        });
        if (i === null) list.push(cat);
        else list[i] = cat;
        $('nim-ce').hidden = true;
        catsChanged();
    }

    /** 读「TXT转世界书」存在浏览器里的自定义提取分类 */
    async function categoriesFromTxtToWorldbook() {
        try {
            if (indexedDB.databases) {
                const dbs = await indexedDB.databases();
                if (!dbs.some((d) => d.name === 'TxtToWorldbookDB')) return toast('还没在「TXT转世界书」里设置过分类', 'warning');
            }
            const db = await new Promise((res, rej) => {
                const r = indexedDB.open('TxtToWorldbookDB');
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
            const value = await new Promise((res) => {
                if (!db.objectStoreNames.contains('categories')) return res(null);
                const r = db.transaction(['categories'], 'readonly').objectStore('categories').get('customCategories');
                r.onsuccess = () => res(r.result ? r.result.value : null);
                r.onerror = () => res(null);
            });
            db.close();
            if (!Array.isArray(value) || !value.length) return toast('还没在「TXT转世界书」里设置过分类', 'warning');
            // 已有分类的「常驻」设置保留
            const constants = new Map(categories().map((c) => [c.name, c.constant]));
            State.settings.worldbookCategories = C.normalizeCategories(value).map((c) => ({ ...c, constant: constants.get(c.name) || false }));
            catsChanged();
            toast(`已读取 ${value.length} 个分类`, 'success');
        } catch (e) {
            toast(`读取失败：${e.message}`, 'error');
        }
    }

    function bindCategories() {
        const el = $('nim-cats');
        if (!el) return;
        el.addEventListener('change', (ev) => {
            const i = ev.target.dataset.catOn;
            if (i === undefined) return;
            categories()[Number(i)].enabled = ev.target.checked;
            catsChanged();
        });
        el.addEventListener('click', (ev) => {
            const b = ev.target.closest('button');
            if (!b) return;
            const list = categories();
            if (b.dataset.catEdit !== undefined) openCatEdit(Number(b.dataset.catEdit));
            else if (b.dataset.catReset !== undefined) {
                const i = Number(b.dataset.catReset);
                const d = C.DEFAULT_WORLDBOOK_CATEGORIES.find((x) => x.name === list[i].name);
                if (!d || !confirm(`把「${list[i].name}」重置为默认配置？`)) return;
                list[i] = C.normalizeCategory(JSON.parse(JSON.stringify(d)));
                catsChanged();
            } else if (b.dataset.catDel !== undefined) {
                const i = Number(b.dataset.catDel);
                if (list[i].isBuiltin || !confirm(`删除分类「${list[i].name}」？`)) return;
                list.splice(i, 1);
                catsChanged();
            }
        });
        $('nim-cat-add').addEventListener('click', () => openCatEdit(null));
        $('nim-cat-ttw').addEventListener('click', categoriesFromTxtToWorldbook);
        $('nim-cat-reset').addEventListener('click', () => {
            if (!confirm('把分类恢复成默认？自己加的分类会删掉。')) return;
            State.settings.worldbookCategories = C.normalizeCategories(JSON.parse(JSON.stringify(C.DEFAULT_WORLDBOOK_CATEGORIES)));
            catsChanged();
        });
        $('nim-ce-pos').addEventListener('change', () => ($('nim-ce-depthrow').style.opacity = $('nim-ce-pos').value === '4' ? '1' : '.5'));
        $('nim-ce').addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-ce]');
            if (!b) return;
            if (b.dataset.ce === 'save') saveCatEdit();
            else $('nim-ce').hidden = true;
        });
    }

    function categoriesHtml() {
        return `<div class="nim-sub">提取分类</div>
          <div class="nim-muted">打开的分类每层都会提取。点分类名编辑条目名示例、关键词示例和内容提取指南，和「TXT转世界书」的自定义提取分类一样。</div>
          <ul id="nim-cats" class="nim-pr-list"></ul>
          <div class="nim-row"><button id="nim-cat-add" class="nim-btn sm">添加分类</button><button id="nim-cat-ttw" class="nim-btn sm">从 TXT转世界书 读取分类</button><button id="nim-cat-reset" class="nim-btn sm ghost">恢复默认分类</button></div>`;
    }

    function catEditHtml() {
        return `<div id="nim-ce" class="nim-sheet" hidden><div class="nim-sheet-box" role="dialog" aria-label="编辑分类">
          <div class="nim-sheet-head"><b id="nim-ce-title">编辑分类</b><button class="nim-icon-btn" data-ce="cancel" title="关闭">✕</button></div>
          <div class="nim-sheet-body">
            <div class="nim-field"><label for="nim-ce-name">分类名称 *</label><input id="nim-ce-name" class="nim-input" placeholder="如：道具、玩法"></div>
            <div class="nim-field"><label for="nim-ce-example">条目名称示例</label><input id="nim-ce-example" class="nim-input" placeholder="如：道具名称"></div>
            <div class="nim-field"><label for="nim-ce-keywords">关键词示例 <span class="nim-hint">· 逗号分隔</span></label><input id="nim-ce-keywords" class="nim-input" placeholder="如：道具名, 别名"></div>
            <div class="nim-field"><label for="nim-ce-guide">内容提取指南</label><textarea id="nim-ce-guide" class="nim-input nim-textarea" rows="5" placeholder="描述 AI 应该提取哪些信息..."></textarea></div>
            <div class="nim-sub">导出时的默认配置</div>
            <div class="nim-grid">
              <div class="nim-field"><label for="nim-ce-pos">位置</label><select id="nim-ce-pos" class="nim-input">${POS_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
              <div class="nim-field" id="nim-ce-depthrow"><label for="nim-ce-depth">深度 <span class="nim-hint">· 位置选自定义深度时有效</span></label><input id="nim-ce-depth" class="nim-input" type="number" min="0" max="999"></div>
              <div class="nim-field"><label for="nim-ce-order">起始顺序</label><input id="nim-ce-order" class="nim-input" type="number" min="0" max="9999"></div>
            </div>
            <label class="nim-check"><input type="checkbox" id="nim-ce-inc"><span class="nim-switch"></span><span>顺序自动递增<span class="nim-hint">同分类的条目从起始值开始 100、101、102…</span></span></label>
            <label class="nim-check"><input type="checkbox" id="nim-ce-constant"><span class="nim-switch"></span><span>常驻（蓝灯）<span class="nim-hint">不用关键词触发，一直发送</span></span></label>
          </div>
          <div class="nim-sheet-foot"><span class="nim-grow-sp"></span><button class="nim-btn" data-ce="cancel">取消</button><button class="nim-btn primary" data-ce="save">保存</button></div>
        </div></div>`;
    }

    // ============================================
    // 酒馆里开着的世界书：当作输出要求发给 AI
    // ============================================

    /** 重新读一遍酒馆现在开着的世界书，按勾选拼成输出要求 */
    async function refreshStWorlds() {
        const books = await ST.listActiveWorldbooks();
        const list = [];
        for (const b of books) {
            try {
                const entries = await ST.loadWorldbookEntries(b.name);
                list.push({ ...b, entries, items: C.outputRuleItems(entries) });
            } catch (e) {
                list.push({ ...b, entries: {}, items: [], error: e.message });
            }
        }
        State.stWorlds = list;
        updateOutputRules();
        renderStWorlds();
        return list;
    }

    const entryKey = (book, it) => `${book}::${it.key}`;

    function updateOutputRules() {
        const ex = new Set(State.settings.stWorldExclude || []);
        const skip = new Set(State.settings.stWorldEntryExclude || []);
        for (const b of State.stWorlds || []) {
            b.rules = C.buildOutputRules([{ name: b.name, entries: b.entries }], { skip });
            b.on = (b.items || []).filter((it) => !skip.has(entryKey(b.name, it))).length;
        }
        State.outputRules = (State.stWorlds || [])
            .filter((b) => !ex.has(b.name) && b.rules)
            .map((b) => b.rules)
            .join('\n\n');
    }

    function renderStWorlds() {
        const box = $('nim-stwb-list');
        if (!box) return;
        const list = State.stWorlds;
        if (!list) {
            box.innerHTML = '<div class="nim-muted">还没读取，点上面的按钮看看现在开着哪些世界书。</div>';
            return;
        }
        if (!list.length) {
            box.innerHTML = '<div class="nim-muted">酒馆里现在没有开着的世界书（全局、角色、聊天、人设都没绑）。</div>';
            return;
        }
        const ex = new Set(State.settings.stWorldExclude || []);
        const skip = new Set(State.settings.stWorldEntryExclude || []);
        const open = State.stwbOpen || (State.stwbOpen = new Set());
        const picked = list.filter((b) => !ex.has(b.name));
        box.innerHTML =
            list
                .map((b) => {
                    const items = b.items || [];
                    const info = b.error ? `读取失败：${esc(b.error)}` : `发 ${b.on} / ${items.length} 个条目，约 ${b.rules.length} 字`;
                    const entries = items
                        .map(
                            (it) =>
                                `<label class="nim-check nim-stwb-entry"><input type="checkbox" data-stwb-entry="${esc(entryKey(b.name, it))}" ${skip.has(entryKey(b.name, it)) ? '' : 'checked'}><span class="nim-switch"></span><span>${esc(it.title || '（没有标题）')}<span class="nim-hint">${esc(it.content.slice(0, 60))}${it.content.length > 60 ? '…' : ''}</span></span></label>`,
                        )
                        .join('');
                    return `<div class="nim-stwb-book">
                      <label class="nim-check"><input type="checkbox" data-stwb="${esc(b.name)}" ${ex.has(b.name) ? '' : 'checked'}><span class="nim-switch"></span><span>${esc(b.name)} <span class="nim-pr-tag">${b.source}</span><span class="nim-hint">${info}</span></span></label>
                      ${
                          items.length
                              ? `<details class="nim-fold" data-stwb-fold="${esc(b.name)}" ${open.has(b.name) ? 'open' : ''}><summary>逐条开关</summary>
                          <div class="nim-row"><button class="nim-btn ghost sm" data-stwb-all="${esc(b.name)}" data-on="1">全开</button><button class="nim-btn ghost sm" data-stwb-all="${esc(b.name)}" data-on="0">全关</button></div>
                          ${entries}</details>`
                              : ''
                      }
                    </div>`;
                })
                .join('') +
            `<div class="nim-muted">勾选的 ${picked.length} 本合计约 ${State.outputRules.length} 字，每层都会带上。这里的开关只管发不发给 AI，不改酒馆里的条目。点「开始」时会重新读一遍，在酒馆里改了世界书不用再点读取。</div>`;
    }

    function setEntrySkip(keys, on) {
        const skip = new Set(State.settings.stWorldEntryExclude || []);
        for (const k of keys) on ? skip.delete(k) : skip.add(k);
        State.settings.stWorldEntryExclude = [...skip];
        saveSettings();
        updateOutputRules();
        renderStWorlds();
    }

    function bindStWorlds() {
        const box = $('nim-stwb');
        if (!box) return;
        box.addEventListener('change', (ev) => {
            const d = ev.target.dataset || {};
            if (d.stwbEntry !== undefined) return setEntrySkip([d.stwbEntry], ev.target.checked);
            const name = d.stwb;
            if (name === undefined) return;
            const ex = new Set(State.settings.stWorldExclude || []);
            if (ev.target.checked) ex.delete(name);
            else ex.add(name);
            State.settings.stWorldExclude = [...ex];
            saveSettings();
            updateOutputRules();
            renderStWorlds();
        });
        box.addEventListener('click', (ev) => {
            const btn = ev.target.closest && ev.target.closest('[data-stwb-all]');
            if (!btn) return;
            ev.preventDefault();
            const b = (State.stWorlds || []).find((x) => x.name === btn.dataset.stwbAll);
            if (b) setEntrySkip((b.items || []).map((it) => entryKey(b.name, it)), btn.dataset.on === '1');
        });
        // 记住展开了哪本，重绘后保持展开
        box.addEventListener(
            'toggle',
            (ev) => {
                const name = ev.target.dataset && ev.target.dataset.stwbFold;
                if (name === undefined) return;
                const open = State.stwbOpen || (State.stwbOpen = new Set());
                ev.target.open ? open.add(name) : open.delete(name);
            },
            true,
        );
        $('nim-stwb-refresh').addEventListener('click', async () => {
            try {
                const list = await refreshStWorlds();
                toast(list.length ? `读到 ${list.length} 本开着的世界书` : '酒馆里没有开着的世界书', list.length ? 'success' : 'warning');
            } catch (e) {
                toast(`读取酒馆世界书失败：${e.message}`, 'error');
            }
        });
    }

    function stWorldsHtml() {
        return `<div id="nim-stwb">
          <div class="nim-muted">适合放写作规则、文风、输出格式这类要求的世界书。勾选的世界书里没关掉的条目会按顺序整理成「输出要求」，放进每层的提示词里，AI 写正文时照着做。</div>
          <div class="nim-row"><button id="nim-stwb-refresh" class="nim-btn sm">读取酒馆已开的世界书</button></div>
          <div id="nim-stwb-list"></div>
        </div>`;
    }

    function presetHtml() {
        return `<div id="nim-preset">
          <div class="nim-pr-bar"><div id="nim-preset-name" class="nim-pr-title"></div><label class="nim-btn primary sm">导入预设<input type="file" id="nim-preset-file" accept=".json,application/json" hidden></label></div>
          <div class="nim-muted">支持酒馆导出的聊天补全预设 JSON，顺序和开关和酒馆里一样。角色卡、世界书、示例对话等占位条目不导入；📌 是每层的提示词（小说正文和任务），相当于预设里「聊天记录」的位置。按住左边的抓手上下拖动调整顺序，点条目名编辑。</div>
          <ul id="nim-preset-list" class="nim-pr-list"></ul>
          <div id="nim-preset-actions" class="nim-row"></div>
          <div class="nim-sub">预设方案（按模型切换）</div>
          <div class="nim-row"><select id="nim-preset-lib" class="nim-input nim-grow"></select><button id="nim-preset-use" class="nim-btn sm">切换到这个</button></div>
          <div class="nim-row"><input id="nim-preset-name-input" class="nim-input nim-grow" placeholder="方案名，比如「Claude 用」「Gemini 用」"><button id="nim-preset-save" class="nim-btn sm">把当前预设存成方案</button><button id="nim-preset-libdel" class="nim-btn sm danger-ghost">删掉选中的方案</button></div>
          <div class="nim-muted">导入的预设会自动存成方案。「插件默认」是本模块自带的预设，随时能切回。切换后，还没处理的层按新预设发。</div>
          <label class="nim-check"><input type="checkbox" id="nim-preset-squash"><span class="nim-switch"></span><span>合并相邻的系统消息<span class="nim-hint">和酒馆的「压缩系统消息」一样</span></span></label>
        </div>`;
    }

    // ============================================
    // 清掉的内容：分层时删掉的广告行、行内水印、重复垃圾段、空章，给用户核对
    // ============================================

    function openCleanLog() {
        const e = State.engine;
        const lg = e && e.stats && e.stats.cleanLog;
        if (!lg) return toast(e && e.layers.length ? '这份任务是旧版本分的层，点「按当前设置重新分层」后才能看清掉的内容' : '先选择小说并分层，才有清掉的内容', 'warning');
        const empty = (e.stats.emptyChapters || []).map((t) => ({ text: t }));
        const chap = (c) => (c ? `<div class="nim-cl-chap">${esc(c)}</div>` : '');
        // 「保留」按钮：段落文字放在数组里按下标取，免得引号之类的进属性出问题
        clUi.items = [];
        const keepBtn = (text) => {
            clUi.items.push(text);
            const on = isCleanKept(text);
            return `<button class="nim-btn sm ${on ? 'is-on' : ''}" data-keep="${clUi.items.length - 1}">${on ? '已保留' : '保留'}</button>`;
        };
        // 一模一样的广告行合成一条，记次数
        const adMap = new Map();
        for (const a of lg.ads) {
            let g = adMap.get(a.text);
            if (!g) adMap.set(a.text, (g = { text: a.text, chapter: a.chapter, count: 0, prevMap: new Map() }));
            g.count++;
            if (a.prev) g.prevMap.set(a.prev, (g.prevMap.get(a.prev) || 0) + 1);
        }
        const ads = [...adMap.values()].map((g) => ({ ...g, prevs: [...g.prevMap.entries()] }));
        const group = (title, list, row, note) =>
            `<details class="nim-cl-group" ${list.length ? '' : 'disabled'}><summary>${title}<span class="nim-muted">${list.length ? '' : '无'}</span></summary>${note ? `<div class="nim-muted">${note}</div>` : ''}<ul class="nim-cl-list">${list.map(row).join('')}</ul>${list.length >= 3000 ? '<div class="nim-muted">太多了，只列出前 3000 条</div>' : ''}</details>`;
        $('nim-cl-body').innerHTML =
            `<div class="nim-muted">分层时清掉的内容都在这里，按类别展开看。删错的点「保留」，然后点下面的「重新分层」就不会再删；保留的段落在设置「分层与清洗」里能看到和撤销。</div>` +
            group(
                `广告行（${lg.ads.length} 行，${ads.length} 种${lg.ads.some((a) => a.prev) ? `，连带上一行 ${lg.ads.filter((a) => a.prev).length} 行` : ''}）`,
                ads,
                (a) =>
                    `<li>${chap(a.chapter)}${a.prevs.map(([t, n]) => `<div class="nim-cl-line"><div class="nim-cl-prev">连带删掉：${esc(t)}${n > 1 ? `（${n} 处）` : ''}</div>${keepBtn(t)}</div>`).join('')}<div class="nim-cl-line"><div><div>${esc(a.text)}</div>${a.count > 1 ? `<div class="nim-cl-prev">一模一样的删了 ${a.count} 处，章节是第一次出现的位置</div>` : ''}</div>${keepBtn(a.text)}</div></li>`,
                '一模一样的行合成一条，点一次「保留」全部生效。「连带删掉」是广告上面那行没有句末标点的短行，可以在设置里关掉「同时删掉广告行上面那行短标题」。',
            ) +
            group(
                `行内水印（${lg.inline.length} 处）`,
                lg.inline,
                (a) => {
                    // 水印前后各带 30 个字，看得出删的是哪儿
                    const at = Math.max(0, a.line.indexOf(a.text));
                    const before = a.line.slice(Math.max(0, at - 30), at);
                    const after = a.line.slice(at + a.text.length, at + a.text.length + 30);
                    return `<li>${chap(a.chapter)}<div>${at > 30 ? '…' : ''}${esc(before)}<mark class="nim-cl-mark">${esc(a.text)}</mark>${esc(after)}${at + a.text.length + 30 < a.line.length ? '…' : ''}</div></li>`;
                },
            ) +
            group(
                `重复垃圾段（${lg.repeated.length} 种，共 ${e.stats.repeatedLines} 段）`,
                lg.repeated,
                (a) =>
                    `<li>${chap(a.chapter)}<div class="nim-cl-line"><div><div>${esc(a.text)}</div><div class="nim-cl-prev">${a.reason === 'chapter' ? '这一章大半是垃圾段，剩下的零星几行一起删' : '全书重复出现'}，删了 ${a.count} 处</div></div>${keepBtn(a.text)}</div></li>`,
                '同一段只列一次，章节是第一次出现的位置。不该删的点「保留」，再点下面的「重新分层」。',
            ) +
            group(`没有正文的章（${empty.length} 章）`, empty, (a) => `<li><div>${esc(a.text)}</div></li>`, '这些章去掉垃圾内容后没有正文，原文可能被盗版站替换了，建议换个源。');
        renderCleanFoot();
        $('nim-cl').hidden = false;
    }

    const clUi = { items: [], changed: false };

    function cleanKeepKey(t) {
        return String(t || '').replace(/[\s\u3000]/g, '');
    }

    function isCleanKept(t) {
        const k = cleanKeepKey(t);
        return (State.settings.cleanKeep || []).some((x) => cleanKeepKey(x) === k);
    }

    function toggleCleanKeep(text) {
        const k = cleanKeepKey(text);
        const list = State.settings.cleanKeep || [];
        State.settings.cleanKeep = isCleanKept(text) ? list.filter((x) => cleanKeepKey(x) !== k) : list.concat([text]);
        clUi.changed = true;
        saveSettings();
        fillFields();
    }

    function renderCleanFoot() {
        $('nim-cl-relayer').hidden = !clUi.changed;
    }
    // ============================================
    // 术语表：看、搜、改、删、加（和小说翻译模块的术语表一样，分页显示）
    // ============================================

    const GLOSS_PAGE = 50;
    const glossUi = { list: [], opened: [], page: 0, q: '' };

    function currentGlossary() {
        const e = State.engine;
        try {
            if (e && e.layers.length) return e.finalState().glossary || [];
        } catch (err) {
            /* 退回初始表 */
        }
        return C.normalizeGlossary(State.seedGlossary);
    }

    function openGlossary() {
        glossUi.list = currentGlossary().map((t) => ({ ...t }));
        glossUi.opened = glossUi.list.map((t) => t.source);
        glossUi.page = 0;
        glossUi.q = '';
        $('nim-gl-search').value = '';
        renderGlossaryEdit();
        $('nim-gl').hidden = false;
    }

    function renderGlossaryEdit() {
        const q = glossUi.q.trim().toLowerCase();
        const rows = glossUi.list.map((t, i) => ({ t, i })).filter(({ t }) => !q || [t.source, t.target, t.note].some((v) => String(v || '').toLowerCase().includes(q)));
        const pages = Math.max(1, Math.ceil(rows.length / GLOSS_PAGE));
        glossUi.page = Math.min(Math.max(0, glossUi.page), pages - 1);
        const slice = rows.slice(glossUi.page * GLOSS_PAGE, (glossUi.page + 1) * GLOSS_PAGE);
        $('nim-gl-count').textContent = `共 ${glossUi.list.length} 条${q ? `，搜到 ${rows.length} 条` : ''}`;
        $('nim-gl-list').innerHTML = slice.length
            ? slice
                  .map(
                      ({ t, i }) => `<li class="nim-gl-row">
                <input class="nim-input" data-gl="${i}" data-f="source" value="${esc(t.source)}" placeholder="原文">
                <span class="nim-gl-arrow">→</span>
                <input class="nim-input" data-gl="${i}" data-f="target" value="${esc(t.target)}" placeholder="译名">
                <button class="nim-icon-btn sm" data-gl-del="${i}" title="删除">✕</button>
                <input class="nim-input nim-gl-note" data-gl="${i}" data-f="note" value="${esc(t.note || '')}" placeholder="说明（可选）">
              </li>`,
                  )
                  .join('')
            : `<li class="nim-empty">${glossUi.list.length ? '没有匹配的术语' : '还没有术语。翻译外文小说时会自动积累，也可以手动添加。'}</li>`;
        $('nim-gl-pager').innerHTML =
            pages > 1
                ? `<button class="nim-btn sm" data-gl-page="-1" ${glossUi.page ? '' : 'disabled'}>上一页</button><span class="nim-muted">${glossUi.page + 1} / ${pages}</span><button class="nim-btn sm" data-gl-page="1" ${glossUi.page < pages - 1 ? '' : 'disabled'}>下一页</button>`
                : '';
    }

    /** 完成：存成初始术语表（优先于 AI 报的），删掉的词记下来，之后 AI 再报也不收 */
    function saveGlossaryEdit() {
        const list = C.normalizeGlossary(glossUi.list);
        const keep = new Set(list.map((t) => t.source));
        const gone = glossUi.opened.filter((src) => !keep.has(src));
        State.glossaryRemoved = [...new Set([...(State.glossaryRemoved || []).filter((src) => !keep.has(src)), ...gone])];
        State.seedGlossary = list;
        $('nim-gl').hidden = true;
        log(`术语表已保存：${list.length} 条${gone.length ? `，删掉 ${gone.length} 条` : ''}`);
        toast(`术语表已保存（${list.length} 条），后面的层按新的来`, 'success');
        saveProgress();
        renderAll();
    }

    function bindGlossaryEdit() {
        const box = $('nim-gl');
        box.addEventListener('input', (ev) => {
            const i = ev.target.dataset.gl;
            if (i !== undefined && glossUi.list[i]) glossUi.list[i][ev.target.dataset.f] = ev.target.value;
            else if (ev.target.id === 'nim-gl-search') {
                glossUi.q = ev.target.value;
                glossUi.page = 0;
                renderGlossaryEdit();
            }
        });
        box.addEventListener('click', (ev) => {
            const b = ev.target.closest('button');
            if (ev.target === box) return ($('nim-gl').hidden = true);
            if (!b) return;
            if (b.dataset.glDel !== undefined) {
                glossUi.list.splice(Number(b.dataset.glDel), 1);
                renderGlossaryEdit();
            } else if (b.dataset.glPage) {
                glossUi.page += Number(b.dataset.glPage);
                renderGlossaryEdit();
            } else if (b.dataset.gl === 'add') {
                glossUi.list.unshift({ source: '', target: '', note: '' });
                glossUi.q = '';
                glossUi.page = 0;
                $('nim-gl-search').value = '';
                renderGlossaryEdit();
                box.querySelector('[data-gl="0"][data-f="source"]')?.focus({ preventScroll: true });
            } else if (b.dataset.gl === 'clear') {
                if (confirm('清空术语表？删掉的词之后 AI 再报也不会收。')) {
                    glossUi.list = [];
                    renderGlossaryEdit();
                }
            } else if (b.dataset.gl === 'save') saveGlossaryEdit();
            else if (b.dataset.gl === 'cancel') $('nim-gl').hidden = true;
        });
    }

    function glossaryHtml() {
        return `<div id="nim-gl" class="nim-sheet" hidden><div class="nim-sheet-box" role="dialog" aria-label="术语表">
          <div class="nim-sheet-head"><b>术语表 <span id="nim-gl-count" class="nim-muted"></span></b><button class="nim-icon-btn" data-gl="cancel" title="关闭">✕</button></div>
          <div class="nim-sheet-body">
            <div class="nim-muted">术语表只发给 AI 参考，不会出现在正文里。这里改的优先于 AI 报的；删掉的词，之后 AI 再报也不会收。已经翻好的层不会变，后面的层按新的来。</div>
            <input id="nim-gl-search" class="nim-input" placeholder="搜索原文、译名、说明">
            <div class="nim-row"><button class="nim-btn sm" data-gl="add">添加术语</button><button class="nim-btn sm danger-ghost" data-gl="clear">清空</button></div>
            <ul id="nim-gl-list" class="nim-gl-list"></ul>
            <div id="nim-gl-pager" class="nim-row nim-gl-pager"></div>
          </div>
          <div class="nim-sheet-foot"><span class="nim-grow-sp"></span><button class="nim-btn" data-gl="cancel">取消</button><button class="nim-btn primary" data-gl="save">保存</button></div>
        </div></div>`;
    }

    // ============================================
    // 和原文不同的事实（剧情改写的账本）：看、改、删、加
    // ============================================

    const ledgerUi = { list: [], opened: [] };

    /** 账本的行：AI 在改写层报的事实（来自已处理的层）+ 用户手动加的（含还没生效的） */
    function currentLedgerRows() {
        const e = State.engine;
        let ai = [];
        try {
            if (e && e.layers.length) ai = ((e.finalState().divergence || {}).facts || []).filter((f) => !f.manual);
        } catch (err) {
            /* 还没分层 */
        }
        return [
            ...ai.map((f) => ({ text: f.text, from: f.layer + 1, ai: true, orig: f.text })),
            ...(State.ledgerManual || []).map((m) => ({ text: m.text, from: Number(m.from) || 0, ai: false })),
        ];
    }

    function nextLayerIndex() {
        const e = State.engine;
        if (!e) return 0;
        let n = 0;
        while (n < e.results.length && e.results[n] && e.results[n].status === 'done') n++;
        return n;
    }

    function openLedger() {
        ledgerUi.list = currentLedgerRows();
        ledgerUi.opened = ledgerUi.list.filter((r) => r.ai).map((r) => r.orig);
        renderLedgerEdit();
        $('nim-lg').hidden = false;
    }

    function renderLedgerEdit() {
        $('nim-lg-count').textContent = `共 ${ledgerUi.list.length} 条`;
        $('nim-lg-list').innerHTML = ledgerUi.list.length
            ? ledgerUi.list
                  .map(
                      (r, i) => `<li class="nim-lg-row">
                <textarea class="nim-input" rows="2" data-lg="${i}" data-f="text" placeholder="比如：林晚没有被送走，仍留在宗门">${esc(r.text)}</textarea>
                <div class="nim-row">
                  <span class="nim-muted">${r.ai ? `AI 在第 ${r.from} 层记下，第 ${r.from + 1} 层起生效` : '手动 · 从第'}</span>
                  ${r.ai ? '' : `<input class="nim-input nim-lg-from" type="number" min="1" data-lg="${i}" data-f="from" value="${r.from + 1}"><span class="nim-muted">层起生效</span>`}
                  <span class="nim-grow-sp"></span>
                  <button class="nim-icon-btn sm" data-lg-del="${i}" title="删除">✕</button>
                </div>
              </li>`,
                  )
                  .join('')
            : `<li class="nim-empty">还没有事实。剧情改写的层会让 AI 记下和原文不同的事实，也可以手动添加。</li>`;
    }

    /** 保存：AI 的事实删掉或改过的，原句记进 ledgerRemoved（之后 AI 再报也不收），改过的变成手动事实 */
    function saveLedgerEdit() {
        const rows = ledgerUi.list.map((r) => ({ ...r, text: String(r.text || '').trim() })).filter((r) => r.text);
        const keptAi = new Set(rows.filter((r) => r.ai && r.text === r.orig).map((r) => r.orig));
        const gone = ledgerUi.opened.filter((t) => !keptAi.has(t));
        const manual = rows
            .filter((r) => !r.ai || r.text !== r.orig)
            .map((r) => ({ from: Math.max(0, r.ai ? r.from : Number(r.from) || 0), text: r.text }));
        State.ledgerRemoved = [...new Set([...(State.ledgerRemoved || []).filter((t) => !keptAi.has(t)), ...gone])];
        State.ledgerManual = manual;
        $('nim-lg').hidden = true;
        log(`事实账本已保存：${rows.length} 条${gone.length ? `，删掉或改掉 AI 记的 ${gone.length} 条` : ''}`);
        toast('事实账本已保存，后面的层按新的来', 'success');
        saveProgress();
        renderAll();
    }

    function bindLedgerEdit() {
        const box = $('nim-lg');
        box.addEventListener('input', (ev) => {
            const i = ev.target.dataset.lg;
            if (i === undefined || !ledgerUi.list[i]) return;
            // 界面上的层号从 1 开始，存的从 0 开始
            if (ev.target.dataset.f === 'from') ledgerUi.list[i].from = Math.max(0, (parseInt(ev.target.value, 10) || 1) - 1);
            else ledgerUi.list[i].text = ev.target.value;
        });
        box.addEventListener('click', (ev) => {
            const b = ev.target.closest('button');
            if (ev.target === box) return ($('nim-lg').hidden = true);
            if (!b) return;
            if (b.dataset.lgDel !== undefined) {
                ledgerUi.list.splice(Number(b.dataset.lgDel), 1);
                renderLedgerEdit();
            } else if (b.dataset.lg === 'add') {
                ledgerUi.list.unshift({ text: '', from: nextLayerIndex(), ai: false });
                renderLedgerEdit();
                box.querySelector('[data-lg="0"][data-f="text"]')?.focus({ preventScroll: true });
            } else if (b.dataset.lg === 'save') saveLedgerEdit();
            else if (b.dataset.lg === 'cancel') $('nim-lg').hidden = true;
        });
    }

    function ledgerHtml() {
        return `<div id="nim-lg" class="nim-sheet" hidden><div class="nim-sheet-box" role="dialog" aria-label="和原文不同的事实">
          <div class="nim-sheet-head"><b>和原文不同的事实 <span id="nim-lg-count" class="nim-muted"></span></b><button class="nim-icon-btn" data-lg="cancel" title="关闭">✕</button></div>
          <div class="nim-sheet-body">
            <div class="nim-muted">剧情改写后成立的、和原文不一样的事实。每层都会全部发给 AI，接回原文后也照样遵守；后面原文和这些事实冲突时，那一层会自动改写。这里改的优先于 AI 记的，删掉的 AI 再报也不收。已经处理好的层不会变，后面的层按新的来。</div>
            <div class="nim-row"><button class="nim-btn sm" data-lg="add">添加事实</button></div>
            <ul id="nim-lg-list" class="nim-gl-list"></ul>
          </div>
          <div class="nim-sheet-foot"><span class="nim-grow-sp"></span><button class="nim-btn" data-lg="cancel">取消</button><button class="nim-btn primary" data-lg="save">保存</button></div>
        </div></div>`;
    }

    // ============================================
    // 剧情地图：正式改写前先摸清每层讲了什么，再定怎么改
    // ============================================

    const PM = window.NovelImporterPlotMap;
    const mapUi = { stats: null, statsKey: '', openVol: new Set([0]), openLayer: null, filter: 'all', char: '', scan: null, busy: '', live: new Map() };

    function mapEngine() {
        const e = State.engine;
        return e && e.layers && e.layers.length ? e : null;
    }

    function savePlan() {
        saveProgress();
    }

    /** 换书时清空剧情地图（含正在跑的扫描）和既成事实 */
    function resetBookPlan() {
        if (mapUi.scan) mapUi.scan.ctl.abort();
        State.plan = PM.normalizePlan(null);
        State.ledgerManual = [];
        State.ledgerRemoved = [];
        Object.assign(mapUi, { stats: null, statsKey: '', openVol: new Set([0]), openLayer: null, char: '' });
        mapUi.live.clear();
        fillMapFields();
    }

    function mapNames() {
        return PM.parseNameList(State.plan.names);
    }

    function chapterTest() {
        const re = C.safeRegex(State.settings.chapterRegex || C.DEFAULT_CHAPTER_REGEX);
        return (t) => C.isChapterTitle(t, re);
    }

    /** 免费统计按人物名单、关键词、分层缓存；有变化才重算 */
    function mapStats() {
        const e = mapEngine();
        if (!e) return null;
        const key = [e.layers.length, e.layers[0].paras.length, State.plan.names, State.plan.keywords, State.settings.chapterRegex].join('|');
        if (mapUi.statsKey !== key) {
            mapUi.stats = PM.analyze(e.layers, { names: mapNames(), keywords: PM.parseWordList(State.plan.keywords), isChapterTitle: chapterTest() });
            mapUi.statsKey = key;
        }
        return mapUi.stats;
    }

    function ledgerFacts() {
        try {
            return (State.engine.finalState().divergence || {}).facts || [];
        } catch (err) {
            return [];
        }
    }

    function volOf(i) {
        return Math.floor(i / State.plan.volumeSize);
    }

    /** 一层的标签：统计、扫描、规划、处理进度 */
    function mapChips(i, row, lp, conflicts) {
        const e = State.engine;
        const r = e.results[i];
        const out = [];
        if (r && r.status === 'done') out.push(`<span class="nim-tag">${r.skipped ? '已跳过' : '已处理'}</span>`);
        if (lp.bookmark) out.push('<span class="nim-tag orange">★ 书签</span>');
        if (lp.todo) out.push('<span class="nim-tag orange">待决定</span>');
        if (PM.hasRewritePlan(lp)) out.push('<span class="nim-tag violet">改写</span>');
        if (lp.resume) out.push('<span class="nim-tag violet">接回</span>');
        if (lp.skip) out.push('<span class="nim-tag">跳过</span>');
        if (lp.scan && lp.scan.toxic.length) out.push(`<span class="nim-tag red">雷点 ${esc(lp.scan.toxic.map((t) => t.rule).join('、'))}</span>`);
        if (row && row.hot) out.push(`<span class="nim-tag red">关键词 ${row.keywordTotal}</span>`);
        if (conflicts[i]) out.push('<span class="nim-tag orange">可能和事实冲突</span>');
        if (row && row.newNames.length) out.push(`<span class="nim-tag blue">新：${esc(row.newNames.join('、'))}</span>`);
        if (row && row.odd.length) out.push(`<span class="nim-tag orange">${row.odd.map((c) => (c.flag === 'short' ? '短章' : '长章')).join(' ')}</span>`);
        if (row) out.push(`<span class="nim-tag">${row.pace}</span>`);
        if (lp.scan) for (const t of lp.scan.tags) out.push(`<span class="nim-tag">${esc(t)}</span>`);
        return out.join('');
    }

    function mapMatches(i, row, lp, conflicts) {
        const f = mapUi.filter;
        if (mapUi.char) {
            const n = (row && row.names[mapUi.char]) || 0;
            const inScan = lp.scan && lp.scan.characters.includes(mapUi.char);
            if (!n && !inScan) return false;
        }
        if (f === 'all') return true;
        if (f === 'toxic') return !!((lp.scan && lp.scan.toxic.length) || (row && row.hot));
        if (f === 'plan') return PM.hasRewritePlan(lp) || lp.resume || lp.skip;
        if (f === 'mark') return lp.bookmark || lp.todo;
        if (f === 'conflict') return !!conflicts[i];
        if (f === 'new') return !!(row && row.newNames.length);
        if (f === 'unscanned') return !lp.scan;
        return true;
    }

    function layerTitle(i, row, lp) {
        const r = State.engine.results[i];
        if (lp.scan && lp.scan.oneLine) return lp.scan.oneLine;
        if (r && r.status === 'done' && r.parsed && r.parsed.title && !r.skipped) return r.parsed.title;
        if (row && row.chapters.length) return row.chapters.slice(0, 2).join(' / ') + (row.chapters.length > 2 ? ` 等 ${row.chapters.length} 章` : '');
        return '（无章节标题）';
    }

    function topNames(row, n = 4) {
        return Object.entries((row && row.names) || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([k, v]) => `${esc(k)} ${v}`)
            .join(' · ');
    }

    function renderMap() {
        const box = $('nim-map');
        if (!box) return;
        const e = mapEngine();
        if (!e) {
            box.innerHTML = '<div class="nim-empty">先在「小说」页选一本小说，分好层以后这里会显示全书的剧情地图。</div>';
            return;
        }
        const stats = mapStats();
        const plan = State.plan;
        const conflicts = PM.conflictHints(stats.rows, ledgerFacts(), mapNames());
        const n = e.layers.length;
        const vols = Math.ceil(n / plan.volumeSize);
        const scanned = e.layers.filter((l) => PM.layerPlan(plan, l.index).scan).length;
        const planned = Object.keys(plan.layers).filter((k) => {
            const lp = PM.layerPlan(plan, k);
            return PM.hasRewritePlan(lp) || lp.resume || lp.skip;
        }).length;

        // C9 卷纲卡片（手机上横着滑）
        const cards = [];
        for (let v = 0; v < vols; v++) {
            const from = v * plan.volumeSize;
            const to = Math.min(n, from + plan.volumeSize) - 1;
            let tox = 0;
            let hot = 0;
            let pl = 0;
            const lines = [];
            for (let i = from; i <= to; i++) {
                const lp = PM.layerPlan(plan, i);
                if (lp.scan && lp.scan.toxic.length) tox++;
                if (stats.rows[i] && stats.rows[i].hot) hot++;
                if (PM.hasRewritePlan(lp)) pl++;
                if (lp.scan && lp.scan.oneLine && lines.length < 3) lines.push(lp.scan.oneLine);
            }
            cards.push(`<button class="nim-vol-card ${mapUi.openVol.has(v) ? 'on' : ''}" data-map-vol="${v}">
                <b>第 ${v + 1} 卷</b><span class="nim-muted">第 ${from + 1}–${to + 1} 层</span>
                <span class="nim-vol-lines">${lines.length ? lines.map(esc).join('；') : '还没扫描'}</span>
                <span>${tox ? `<span class="nim-tag red">雷点 ${tox}</span>` : ''}${hot ? `<span class="nim-tag red">关键词 ${hot}</span>` : ''}${pl ? `<span class="nim-tag violet">改写 ${pl}</span>` : ''}</span>
              </button>`);
        }

        const filters = [
            ['all', '全部'],
            ['toxic', '雷点和关键词'],
            ['plan', '有改写安排'],
            ['mark', '书签和待决定'],
            ['conflict', '可能冲突'],
            ['new', '新角色'],
            ['unscanned', '没扫描'],
        ];
        const names = mapNames();
        let body = '';
        for (let v = 0; v < vols; v++) {
            const from = v * plan.volumeSize;
            const to = Math.min(n, from + plan.volumeSize) - 1;
            const open = mapUi.openVol.has(v) || mapUi.filter !== 'all' || mapUi.char;
            let rows = '';
            if (open) {
                for (let i = from; i <= to; i++) {
                    const row = stats.rows[i];
                    const lp = PM.layerPlan(plan, i);
                    if (!mapMatches(i, row, lp, conflicts)) continue;
                    rows += `<li class="nim-map-row ${mapUi.openLayer === i ? 'open' : ''}" data-map-row="${i}">
                        <button class="nim-map-head" data-map-act="toggle" data-i="${i}">
                          <span class="nim-map-no">${i + 1}</span>
                          <span class="nim-map-main"><span class="nim-map-title">${esc(layerTitle(i, row, lp))}</span><span class="nim-map-chips">${mapChips(i, row, lp, conflicts)}</span>${row && Object.keys(row.names).length ? `<span class="nim-muted">${topNames(row)}</span>` : ''}</span>
                        </button>
                        ${mapUi.openLayer === i ? layerDetailHtml(i, row, lp, conflicts) : ''}
                      </li>`;
                }
                if (!rows) continue;
            }
            body += `<section class="nim-map-vol"><button class="nim-map-volhead" data-map-vol="${v}"><b>${open ? '▾' : '▸'} 第 ${v + 1} 卷</b><span class="nim-muted">第 ${from + 1}–${to + 1} 层</span></button>${open ? `<ul class="nim-map-list">${rows}</ul>` : ''}</section>`;
        }

        const sg = plan.suggestions.length
            ? `<div class="nim-sub">AI 提议的改写点（${plan.suggestions.length} 条）</div><ul class="nim-map-sugg">${plan.suggestions
                  .map(
                      (s, k) => `<li><b>第 ${s.layer + 1} 层${s.resume !== null && s.resume !== undefined ? ` → 第 ${s.resume + 1} 层接回` : ''}</b><div class="nim-muted">${esc(s.reason)}</div><div>${esc(s.change)}</div>
                        <div class="nim-row"><button class="nim-btn sm" data-map-act="sugg-take" data-k="${k}">采用</button><button class="nim-btn sm ghost" data-map-act="sugg-go" data-k="${k}">看这层</button><button class="nim-btn sm ghost" data-map-act="sugg-drop" data-k="${k}">不要</button></div></li>`,
                  )
                  .join('')}</ul>`
            : '';

        box.innerHTML = `
          <div class="nim-map-summary">共 ${n} 层 · 已扫描 ${scanned} 层 · 有改写安排 ${planned} 层${ledgerFacts().length ? ` · 账本 ${ledgerFacts().length} 条事实` : ''}</div>
          <div class="nim-vol-cards">${cards.join('')}</div>
          ${sg}
          <div class="nim-row nim-map-filters">${filters.map(([k, t]) => `<button class="nim-chip ${mapUi.filter === k ? 'on' : ''}" data-map-filter="${k}">${t}</button>`).join('')}
            <select id="nim-map-char" class="nim-input nim-map-char"><option value="">所有人物</option>${names.map((x) => `<option ${mapUi.char === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
          ${body || '<div class="nim-empty">这个筛选下没有层</div>'}`;
        renderMapStatsBox();
    }

    function layerDetailHtml(i, row, lp, conflicts) {
        const e = State.engine;
        const r = e.results[i];
        const s = lp.scan;
        const after = r && r.status === 'done' && !r.skipped ? r.parsed.summary : '';
        const pairs = Object.entries((row && row.pairs) || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, v]) => `${esc(k.replace('|', ' + '))} ${v}`)
            .join(' · ');
        const tpl = mapTemplates().map((t, k) => `<option value="${k}">${esc(t.length > 30 ? t.slice(0, 30) + '…' : t)}</option>`).join('');
        const outlines = lp.outlines.length
            ? `<div class="nim-sub">候选新大纲（选一个）</div>${lp.outlines
                  .map(
                      (o, k) => `<div class="nim-map-outline"><b>${esc(o.name || `方案 ${k + 1}`)}</b>${Object.entries(o.layers)
                          .map(([li, t]) => `<div><span class="nim-muted">第 ${Number(li) + 1} 层：</span>${esc(t)}</div>`)
                          .join('')}<button class="nim-btn sm" data-map-act="outline-pick" data-i="${i}" data-k="${k}">用这个方案</button></div>`,
                  )
                  .join('')}`
            : '';
        return `<div class="nim-map-detail">
            ${row && row.chapters.length ? `<div class="nim-muted">章节：${esc(row.chapters.join(' / '))}</div>` : ''}
            ${row && row.odd.length ? `<div class="nim-muted">长度异常：${row.odd.map((c) => `${esc(c.title)} ${c.chars} 字（${c.flag === 'short' ? '偏短' : '偏长'}）`).join('；')}</div>` : ''}
            ${row ? `<div class="nim-muted">出场：${topNames(row, 10) || '（名单里的人物都没出场）'}${pairs ? `<br>同场：${pairs}` : ''}<br>关键词：${Object.entries(row.keywords).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '无'} · 对话 ${row.dialogue}% · 节奏 ${row.pace}</div>` : ''}
            ${conflicts[i] ? `<div class="nim-alert warn">后面原文又写到账本里的人：${conflicts[i].map((c) => `${esc(c.names.join('、'))}（${esc(c.fact)}）`).join('；')}。处理这层时会按账本改，留意看。</div>` : ''}
            ${s ? `<div class="nim-sub">原剧情（预扫描）</div><div>${esc(s.summary || s.oneLine)}</div>${s.relations.length ? `<div class="nim-muted">关系变化：${s.relations.map((x) => `${esc(x.a)}${x.b ? ' 和 ' + esc(x.b) : ''} ${esc(x.change)}`).join('；')}</div>` : ''}${s.toxic.length ? `<div class="nim-alert warn">${s.toxic.map((t) => `${esc(t.rule)}：${esc(t.evidence)}`).join('<br>')}</div>` : ''}` : '<div class="nim-muted">还没预扫描。</div>'}
            ${after ? `<div class="nim-sub">改写后（已处理）</div><div>${esc(after)}</div>` : ''}
            <div class="nim-row">
              <button class="nim-btn sm" data-map-act="source" data-i="${i}">看原文</button>
              <button class="nim-btn sm" data-map-act="scan-one" data-i="${i}">${s ? '重新扫描这层' : '扫描这层'}</button>
              <button class="nim-btn sm" data-map-act="goto-run" data-i="${i}">去处理页</button>
            </div>
            <div class="nim-row">
              <label class="nim-check"><input type="checkbox" data-map-flag="bookmark" data-i="${i}" ${lp.bookmark ? 'checked' : ''}><span class="nim-switch"></span><span>书签</span></label>
              <label class="nim-check"><input type="checkbox" data-map-flag="todo" data-i="${i}" ${lp.todo ? 'checked' : ''}><span class="nim-switch"></span><span>待决定</span></label>
              <label class="nim-check"><input type="checkbox" data-map-flag="resume" data-i="${i}" ${lp.resume ? 'checked' : ''}><span class="nim-switch"></span><span>从这层接回原文</span></label>
              <label class="nim-check"><input type="checkbox" data-map-flag="condense" data-i="${i}" ${lp.condense ? 'checked' : ''}><span class="nim-switch"></span><span>水章压缩</span></label>
              <label class="nim-check"><input type="checkbox" data-map-flag="skip" data-i="${i}" ${lp.skip ? 'checked' : ''}><span class="nim-switch"></span><span>跳过这层</span></label>
            </div>
            <div class="nim-field"><label>这层的改写指令 <select class="nim-input nim-map-tpl" data-map-tpl="${i}"><option value="">套用模板…</option>${tpl}</select></label>
              <textarea class="nim-input nim-textarea" rows="3" data-map-text="instruction" data-i="${i}" placeholder="比如：这里女主没被送走，改成男主出手拦下">${esc(lp.instruction)}</textarea></div>
            <div class="nim-field"><label>新大纲（定下来以后改写按它写）</label>
              <textarea class="nim-input nim-textarea" rows="3" data-map-text="outline" data-i="${i}" placeholder="可以自己写，也可以按指令让 AI 出">${esc(lp.outline)}</textarea>
              <div class="nim-row"><button class="nim-btn sm" data-map-act="outline" data-i="${i}">按指令出新大纲</button><span class="nim-muted">到下一个「接回原文」的层为止，方案数在上面设置</span></div></div>
            ${outlines}
            <div class="nim-field"><label>在这层后面插一段自创剧情</label>
              <textarea class="nim-input nim-textarea" rows="2" data-map-text="insert" data-i="${i}" placeholder="比如：加一段男主和女主月下谈心">${esc(lp.insert)}</textarea></div>
            <div class="nim-field"><label>备注</label><input class="nim-input" data-map-text="note" data-i="${i}" value="${esc(lp.note)}"></div>
          </div>`;
    }

    function renderMapStatsBox() {
        const box = $('nim-map-stats');
        if (!box) return;
        const stats = mapStats();
        if (!stats) return (box.innerHTML = '');
        const plan = State.plan;
        const names = stats.names.slice(0, 12);
        const vols = Math.ceil(stats.rows.length / plan.volumeSize);
        // A2 出场热力图：人物 × 卷
        const grid = names.length
            ? (() => {
                  const cells = names.map((nm) => {
                      const per = [];
                      for (let v = 0; v < vols; v++) {
                          let c = 0;
                          for (let i = v * plan.volumeSize; i < Math.min(stats.rows.length, (v + 1) * plan.volumeSize); i++) c += stats.rows[i].names[nm] || 0;
                          per.push(c);
                      }
                      return per;
                  });
                  const max = Math.max(1, ...cells.flat());
                  return `<div class="nim-heat-wrap"><table class="nim-heat"><tr><th></th>${Array.from({ length: vols }, (_, v) => `<th>${v + 1}</th>`).join('')}</tr>${names
                      .map((nm, a) => `<tr><th>${esc(nm)}</th>${cells[a].map((c) => `<td style="--h:${(c / max).toFixed(2)}" title="${c}">${c || ''}</td>`).join('')}</tr>`)
                      .join('')}</table></div><div class="nim-muted">每格是这个人物在这一卷出现的次数，颜色越深越多；看哪段消失、哪段集中出场。</div>`;
              })()
            : '<div class="nim-muted">先填人物名单（或点「从原文猜人名」），这里会显示每个人在各卷的出场次数。</div>';
        const pairs = stats.pairs.slice(0, 12).map((p) => `${esc(p.a)} + ${esc(p.b)} ${p.count}`).join(' · ');
        const odd = stats.chapters.filter((c) => c.flag);
        box.innerHTML = `${grid}
          ${pairs ? `<div class="nim-sub">人名共现（同一段里一起出现的次数）</div><div class="nim-muted">${pairs}</div>` : ''}
          <div class="nim-sub">章节</div><div class="nim-muted">共 ${stats.chapters.length} 章，中位数 ${Math.round(stats.medianChapter)} 字；偏短 ${odd.filter((c) => c.flag === 'short').length} 章，偏长 ${odd.filter((c) => c.flag === 'long').length} 章（在地图里标出）</div>`;
    }

    function mapTemplates() {
        const t = State.settings.mapTemplates;
        return Array.isArray(t) && t.length ? t : PM.DEFAULT_TEMPLATES;
    }

    function setPlanField(i, patch) {
        State.plan = PM.setLayerPlan(State.plan, i, patch);
        savePlan();
    }

    function guessNamesIntoList() {
        const e = mapEngine();
        if (!e) return toast('先选一本小说', 'warning');
        const have = new Set(mapNames().flatMap((n) => n.aliases));
        // 世界书里的角色名也收进来
        let wbNames = [];
        try {
            const wb = e.finalState().worldbook || {};
            wbNames = Object.keys(wb['角色'] || wb['人物'] || {});
        } catch (err) {
            /* 没有 */
        }
        const guessed = PM.guessNames(e.layers).map((x) => x.name);
        const add = [...new Set([...wbNames, ...guessed])].filter((x) => x && !have.has(x) && x !== '{{user}}');
        if (!add.length) return toast('没有猜到新的人名', 'info');
        State.plan = { ...State.plan, names: [State.plan.names.trim(), ...add].filter(Boolean).join('\n') };
        $('nim-map-names').value = State.plan.names;
        savePlan();
        renderMap();
        toast(`加了 ${add.length} 个名字，删掉猜错的就行`, 'success');
    }

    // --------- 预扫描（B1 G5 C5，F1 F2 F3 F6）---------

    function scanModelInfo() {
        const s = State.settings;
        return {
            endpoint: (s.mapScanEndpoint || '').trim() || s.apiEndpoint,
            key: (s.mapScanKey || '').trim() || s.apiKey,
            model: (s.mapScanModel || '').trim() || s.apiModel,
        };
    }

    let sideUsageOk = true;

    /** 预扫描、提议、出大纲用的请求：流式，onChunk(delta, full) 拿实时输出；不占主流程的停止按钮，超时按多久没收到新数据算 */
    async function callSideAPI(prompt, { signal, maxTokens = 2000, onChunk } = {}) {
        const m = scanModelInfo();
        const h = { 'Content-Type': 'application/json' };
        if (m.key) h.Authorization = `Bearer ${m.key}`;
        const timeout = Number(State.settings.apiTimeout) || 300000;
        let last;
        for (let k = 0; k < 3; k++) {
            if (signal && signal.aborted) throw new Error('ABORTED');
            const body = { model: m.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, stream: true, max_tokens: maxTokens };
            if (sideUsageOk) body.stream_options = { include_usage: true };
            const ctl = new AbortController();
            const onAbort = () => ctl.abort();
            if (signal) signal.addEventListener('abort', onAbort);
            let timer = setTimeout(() => ctl.abort(), timeout);
            const tick = () => {
                clearTimeout(timer);
                timer = setTimeout(() => ctl.abort(), timeout);
            };
            try {
                const resp = await fetch(chatUrl(m.endpoint), { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctl.signal });
                if (!resp.ok) {
                    const t = await resp.text().catch(() => '');
                    if (sideUsageOk && resp.status === 400 && /stream_options|include_usage/i.test(t)) {
                        sideUsageOk = false;
                        k--;
                        continue;
                    }
                    const err = new Error(`API 返回 ${resp.status}：${t.slice(0, 200)}`);
                    err.retryable = RETRYABLE.has(resp.status);
                    throw err;
                }
                const ct = resp.headers.get('content-type') || '';
                if (!ct.includes('event-stream') || !resp.body) {
                    const data = await resp.json();
                    const text = data?.choices?.[0]?.message?.content || '';
                    if (onChunk) onChunk(text, text);
                    return { text, usage: data.usage || null };
                }
                let usage = null;
                const text = await readSSE(resp, { onDelta: onChunk, onUsage: (u) => (usage = u), onTick: tick });
                return { text, usage };
            } catch (e) {
                if (signal && signal.aborted) throw new Error('ABORTED');
                if (e.name === 'AbortError') last = new Error('响应中断：太久没有收到新数据');
                else {
                    last = e;
                    if (e.retryable === false) throw e;
                }
                await sleep(2 ** k * 1500);
            } finally {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
            }
        }
        throw last;
    }

    /** 剧情地图的实时输出：同时扫几层就显示几段，只留最近 6 段 */
    let mapLiveRaf = 0;
    function mapLive(key, full, reset = false) {
        if (reset) mapUi.live.clear();
        if (key) {
            mapUi.live.delete(key);
            mapUi.live.set(key, full);
            while (mapUi.live.size > 6) mapUi.live.delete(mapUi.live.keys().next().value);
        }
        if (mapLiveRaf) return;
        mapLiveRaf = requestAnimationFrame(() => {
            mapLiveRaf = 0;
            const el = $('nim-map-live');
            if (!el) return;
            const box = $('nim-map-live-box');
            if (mapUi.live.size && box && !box.open) box.open = true;
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
            el.textContent = [...mapUi.live].map(([k, v]) => `【${k}】\n${v.length > 3000 ? '…' + v.slice(-3000) : v}`).join('\n\n');
            if (atBottom) el.scrollTop = el.scrollHeight;
        });
    }

    function scanTargets(onlyMissing) {
        const e = mapEngine();
        const from = Math.max(1, parseInt($('nim-map-from')?.value, 10) || 1) - 1;
        const to = Math.min(e.layers.length, parseInt($('nim-map-to')?.value, 10) || e.layers.length) - 1;
        return e.layers.filter((l) => {
            if (l.index < from || l.index > to) return false;
            if (!onlyMissing) return true;
            const s = PM.layerPlan(State.plan, l.index).scan;
            // F3：原文没变就用缓存
            return !s || s.hash !== PM.hashText(PM.layerText(l));
        });
    }

    function showScanEstimate() {
        const e = mapEngine();
        if (!e) return toast('先选一本小说', 'warning');
        const t = scanTargets(true);
        const s = State.settings;
        const est = PM.estimateScanCost(t, { estimateTokens: C.estimateTokens, inPrice: Number(s.mapPriceIn) || 0, outPrice: Number(s.mapPriceOut) || 0 });
        const money = Number(s.mapPriceIn) || Number(s.mapPriceOut) ? `，约 ${est.cost.toFixed(est.cost < 1 ? 3 : 2)}（按你填的单价）` : '，填上单价能算出钱';
        $('nim-map-est').textContent = `要扫 ${est.layers} 层：输入约 ${fmtNum(est.input)} token，输出约 ${fmtNum(est.output)} token${money}`;
    }

    async function runScan(onlyMissing, single = null) {
        const e = mapEngine();
        if (!e) return toast('先选一本小说', 'warning');
        if (mapUi.scan) return toast('正在扫描', 'info');
        const targets = single !== null ? [e.layers[single]] : scanTargets(onlyMissing);
        if (!targets.length) return toast('这个范围里的层都扫过了', 'info');
        const ctl = new AbortController();
        mapUi.scan = { ctl, done: 0, total: targets.length, failed: 0, tokens: 0 };
        mapLive('', '', true);
        renderScanState();
        const names = mapNames();
        const toxic = State.settings.mapToxic || State.settings.divergenceRules || PM.DEFAULT_TOXIC;
        await PM.runPool(
            targets,
            Math.max(1, Math.min(8, Number(State.settings.mapConcurrency) || 3)),
            async (l) => {
                const prev = PM.layerPlan(State.plan, l.index - 1).scan;
                const prompt = PM.buildScanPrompt(l, { names, toxicRules: toxic, prevOneLine: prev ? prev.oneLine : '' });
                try {
                    const key = `第 ${l.index + 1} 层`;
                    const res = await callSideAPI(prompt, { signal: ctl.signal, maxTokens: 1200, onChunk: (_d, full) => mapLive(key, full) });
                    mapLive(`${key} ✓`, res.text);
                    mapUi.live.delete(key);
                    const parsed = PM.parseScanResponse(res.text, C.parseLooseJson);
                    if (res.usage) mapUi.scan.tokens += (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0);
                    setPlanField(l.index, { scan: { ...parsed, hash: PM.hashText(PM.layerText(l)) } });
                } catch (err) {
                    if (String(err.message) === 'ABORTED') return;
                    mapUi.scan.failed++;
                    log(`剧情地图：第 ${l.index + 1} 层扫描失败：${err.message}`);
                }
                mapUi.scan.done++;
                renderScanState();
                if (mapUi.scan.done % 5 === 0 || single !== null) renderMap();
            },
            () => ctl.signal.aborted,
        );
        const sc = mapUi.scan;
        mapUi.scan = null;
        renderScanState();
        renderMap();
        toast(`扫描完成 ${sc.done - sc.failed} 层${sc.failed ? `，失败 ${sc.failed} 层（日志里有原因）` : ''}${sc.tokens ? `，用了约 ${fmtNum(sc.tokens)} token` : ''}`, sc.failed ? 'warning' : 'success');
    }

    function renderScanState() {
        const el = $('nim-map-scanstate');
        if (!el) return;
        const sc = mapUi.scan;
        el.textContent = sc ? `扫描中 ${sc.done} / ${sc.total}${sc.failed ? `，失败 ${sc.failed}` : ''}` : '';
        $('nim-map-scanstop').hidden = !sc;
    }

    // --------- D4 AI 提议、D5/D8 新大纲 ---------

    async function suggestPoints() {
        const e = mapEngine();
        if (!e) return toast('先选一本小说', 'warning');
        const scanned = e.layers.filter((l) => PM.layerPlan(State.plan, l.index).scan).length;
        if (!scanned) return toast('先预扫描，AI 要看着剧情地图提议', 'warning');
        if (mapUi.busy) return;
        mapUi.busy = 'suggest';
        setStatus('AI 正在通读剧情地图、找要改的地方…');
        try {
            const pref = (State.settings.mapToxic || '') + (State.settings.divergenceDirection ? `\n改写方向：${State.settings.divergenceDirection}` : '');
            const res = await callSideAPI(PM.buildSuggestPrompt(e.layers, State.plan, { preference: pref, toxicRules: State.settings.divergenceRules }), { maxTokens: 4000, onChunk: (_d, full) => mapLive('AI 提议改写点', full) });
            const list = PM.parseSuggestResponse(res.text, C.parseLooseJson);
            State.plan = { ...State.plan, suggestions: list };
            savePlan();
            toast(list.length ? `AI 提了 ${list.length} 个改写点，在地图上方` : 'AI 觉得没有要改的', 'success');
        } catch (err) {
            toast(`提议失败：${err.message}`, 'error');
        } finally {
            mapUi.busy = '';
            setStatus('');
            renderMap();
        }
    }

    function takeSuggestion(k) {
        const s = State.plan.suggestions[k];
        if (!s) return;
        const lp = PM.layerPlan(State.plan, s.layer);
        setPlanField(s.layer, { instruction: lp.instruction ? `${lp.instruction}\n${s.change}` : s.change });
        if (s.resume !== null && s.resume !== undefined && s.resume >= s.layer) setPlanField(s.resume, { resume: true });
        State.plan = { ...State.plan, suggestions: State.plan.suggestions.filter((_, j) => j !== k) };
        savePlan();
        mapUi.openVol.add(volOf(s.layer));
        mapUi.openLayer = s.layer;
        renderMap();
        toast(`已写进第 ${s.layer + 1} 层的改写指令`, 'success');
    }

    /** 从第 i 层到下一个标了接回的层（没有就只这一层）出新大纲 */
    async function genOutline(i) {
        const e = mapEngine();
        if (mapUi.busy) return;
        let to = i;
        for (let k = i; k < Math.min(e.layers.length, i + 15); k++) {
            if (PM.layerPlan(State.plan, k).resume) {
                to = k;
                break;
            }
        }
        const instr = [];
        for (let k = i; k <= to; k++) {
            const t = PM.layerPlan(State.plan, k).instruction.trim();
            if (t) instr.push(`第 ${k + 1} 层：${t}`);
        }
        if (!instr.length) return toast('先在这层写改写指令', 'warning');
        mapUi.busy = 'outline';
        setStatus(`AI 正在出第 ${i + 1}–${to + 1} 层的新大纲…`);
        try {
            const variants = Math.max(1, Math.min(3, Number(State.settings.mapVariants) || 1));
            const prompt = PM.buildOutlinePrompt(e.layers, State.plan, i, to, { instruction: instr.join('\n'), facts: ledgerFacts().map((f) => f.text), variants });
            const res = await callSideAPI(prompt, { maxTokens: 3000, onChunk: (_d, full) => mapLive(`第 ${i + 1}–${to + 1} 层新大纲`, full) });
            const list = PM.parseOutlineResponse(res.text, C.parseLooseJson);
            if (!list.length) throw new Error('没拿到大纲');
            if (list.length === 1) applyOutline(list[0]);
            else setPlanField(i, { outlines: list });
            toast(list.length === 1 ? '新大纲已填进各层' : `出了 ${list.length} 个方案，选一个`, 'success');
        } catch (err) {
            toast(`出大纲失败：${err.message}`, 'error');
        } finally {
            mapUi.busy = '';
            setStatus('');
            renderMap();
        }
    }

    function applyOutline(o) {
        for (const [li, t] of Object.entries(o.layers)) setPlanField(Number(li), { outline: t });
    }

    // --------- H1 规划导出导入、一键应用 ---------

    function exportPlan() {
        download(JSON.stringify({ type: 'novel-importer-plan', version: 1, plan: State.plan }, null, 2), `${baseName()}-剧情规划.json`);
    }

    async function importPlan(file) {
        try {
            const j = JSON.parse(await file.text());
            State.plan = PM.normalizePlan(j.plan || j);
            savePlan();
            renderMap();
            toast('规划已导入', 'success');
        } catch (err) {
            toast(`导入失败：${err.message}`, 'error');
        }
    }

    /** 雷点清单直接当「触发剧情改写的情节」用 */
    function applyToxicToRules() {
        const t = (State.settings.mapToxic || '').trim();
        if (!t) return toast('先填雷点清单', 'warning');
        const cur = State.settings.divergenceRules || '';
        const add = t.split('\n').filter((line) => line.trim() && !cur.includes(line.trim()));
        if (!add.length) return toast('雷点都已经在改写规则里了', 'info');
        State.settings.divergenceRules = [cur.trim(), ...add].filter(Boolean).join('\n');
        saveSettings();
        fillFields();
        if (State.engine) State.engine = rebuildEngineKeepResults();
        toast(`加了 ${add.length} 条到「触发剧情改写的情节」，后面的层按新规则判断`, 'success');
    }

    function bindMap() {
        const panel = document.querySelector('#nim-modal [data-panel="map"]');
        panel.addEventListener('click', (ev) => {
            const vol = ev.target.closest('[data-map-vol]');
            if (vol) {
                const v = Number(vol.dataset.mapVol);
                if (mapUi.openVol.has(v)) mapUi.openVol.delete(v);
                else mapUi.openVol.add(v);
                if (vol.classList.contains('nim-vol-card')) {
                    mapUi.openVol.add(v);
                    renderMap();
                    document.querySelector(`#nim-map [data-map-row="${v * State.plan.volumeSize}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                    return;
                }
                return renderMap();
            }
            const f = ev.target.closest('[data-map-filter]');
            if (f) {
                mapUi.filter = f.dataset.mapFilter;
                return renderMap();
            }
            const b = ev.target.closest('[data-map-act]');
            if (!b) return;
            const i = Number(b.dataset.i);
            const act = b.dataset.mapAct;
            if (act === 'toggle') {
                mapUi.openLayer = mapUi.openLayer === i ? null : i;
                renderMap();
            } else if (act === 'source') openSource(i, { query: mapUi.char || '' });
            else if (act === 'scan-one') runScan(false, i);
            else if (act === 'goto-run') {
                State.selected = i;
                switchTab('run');
                renderAll();
            } else if (act === 'outline') genOutline(i);
            else if (act === 'outline-pick') {
                const o = PM.layerPlan(State.plan, i).outlines[Number(b.dataset.k)];
                if (o) applyOutline(o);
                setPlanField(i, { outlines: [] });
                renderMap();
            } else if (act === 'sugg-take') takeSuggestion(Number(b.dataset.k));
            else if (act === 'sugg-go') {
                const s = State.plan.suggestions[Number(b.dataset.k)];
                mapUi.openVol.add(volOf(s.layer));
                mapUi.openLayer = s.layer;
                renderMap();
            } else if (act === 'sugg-drop') {
                State.plan = { ...State.plan, suggestions: State.plan.suggestions.filter((_, j) => j !== Number(b.dataset.k)) };
                savePlan();
                renderMap();
            }
        });
        panel.addEventListener('change', (ev) => {
            const t = ev.target;
            if (t.dataset.mapFlag) {
                setPlanField(Number(t.dataset.i), { [t.dataset.mapFlag]: t.checked });
                renderMap();
            } else if (t.dataset.mapTpl !== undefined && t.value !== '') {
                const i = Number(t.dataset.mapTpl);
                const tpl = mapTemplates()[Number(t.value)];
                const lp = PM.layerPlan(State.plan, i);
                setPlanField(i, { instruction: lp.instruction ? `${lp.instruction}\n${tpl}` : tpl });
                renderMap();
            } else if (t.id === 'nim-map-char') {
                mapUi.char = t.value;
                renderMap();
            } else if (t.dataset.mapText) {
                setPlanField(Number(t.dataset.i), { [t.dataset.mapText]: t.value });
                renderMap();
            } else if (t.id === 'nim-map-names' || t.id === 'nim-map-keywords' || t.id === 'nim-map-volsize') {
                State.plan = {
                    ...State.plan,
                    names: $('nim-map-names').value,
                    keywords: $('nim-map-keywords').value,
                    volumeSize: Math.max(2, parseInt($('nim-map-volsize').value, 10) || 10),
                };
                savePlan();
                renderMap();
            } else if (t.dataset.mapSet) {
                State.settings[t.dataset.mapSet] = t.type === 'number' ? Number(t.value) : t.dataset.mapSet === 'mapTemplates' ? t.value.split('\n').map((x) => x.trim()).filter(Boolean) : t.value;
                saveSettings();
            } else if (t.id === 'nim-map-plan-file' && t.files[0]) {
                importPlan(t.files[0]);
                t.value = '';
            }
        });
        const on = (id, ev, fn) => {
            const el = $(id);
            if (el) el.addEventListener(ev, fn);
        };
        on('nim-map-guess', 'click', guessNamesIntoList);
        on('nim-map-est-btn', 'click', showScanEstimate);
        on('nim-map-scan', 'click', () => runScan(true));
        on('nim-map-rescan', 'click', () => runScan(false));
        on('nim-map-scanstop', 'click', () => mapUi.scan && mapUi.scan.ctl.abort());
        on('nim-map-suggest', 'click', suggestPoints);
        on('nim-map-export', 'click', exportPlan);
        on('nim-map-apply-toxic', 'click', applyToxicToRules);
    }

    function fillMapFields() {
        if (!$('nim-map-names')) return;
        $('nim-map-names').value = State.plan.names;
        $('nim-map-keywords').value = State.plan.keywords;
        $('nim-map-volsize').value = State.plan.volumeSize;
        document.querySelectorAll('#nim-modal [data-map-set]').forEach((el) => {
            const v = el.dataset.mapSet === 'mapTemplates' ? mapTemplates() : State.settings[el.dataset.mapSet];
            el.value = Array.isArray(v) ? v.join('\n') : v ?? '';
        });
    }

    function mapPanelHtml() {
        const s = (key, label, type = 'text', hint = '', extra = '') =>
            `<div class="nim-field"><label>${label}</label>${type === 'textarea' ? `<textarea class="nim-input nim-textarea" rows="3" data-map-set="${key}" ${extra}></textarea>` : `<input class="nim-input" type="${type}" data-map-set="${key}" ${extra}>`}${hint ? `<div class="nim-hint">${hint}</div>` : ''}</div>`;
        return `
      ${card(
          'map-stats',
          '人物和关键词（免费统计）',
          '不花 token：出场热力图、关键词雷达、人名共现、新角色、节奏、章节长度',
          `<div class="nim-field"><label>人物名单（每行一个人，同一人的叫法用 / 隔开）</label><textarea id="nim-map-names" class="nim-input nim-textarea" rows="4" placeholder="裘月寒 / 月寒 / 裘仙子&#10;路长远"></textarea></div>
           <div class="nim-row"><button id="nim-map-guess" class="nim-btn sm">从原文和世界书猜人名</button></div>
           <div class="nim-field"><label>关键词雷达（顿号或换行隔开，命中多的层标红）</label><textarea id="nim-map-keywords" class="nim-input nim-textarea" rows="2"></textarea></div>
           <div class="nim-field"><label>每卷几层</label><input id="nim-map-volsize" class="nim-input" type="number" min="2"></div>
           <div id="nim-map-stats"></div>`,
      )}
      ${card(
          'map-scan',
          '预扫描与 AI',
          '便宜模型逐层出剧情、人物、关系、雷点；AI 提议改写点、出新大纲',
          `${s('mapScanModel', '预扫描用的模型', 'text', '留空用主 API 的模型；建议填便宜的，比如 Flash、Haiku、mini 档')}
           ${s('mapScanEndpoint', '预扫描 API 地址', 'text', '留空用主 API')}
           ${s('mapScanKey', '预扫描 API Key', 'password', '留空用主 API')}
           <div class="nim-grid">${s('mapConcurrency', '同时扫几层', 'number', '1 到 8', 'min="1" max="8"')}${s('mapPriceIn', '输入单价（每百万 token）', 'number', '', 'step="0.01"')}${s('mapPriceOut', '输出单价（每百万 token）', 'number', '', 'step="0.01"')}${s('mapVariants', '新大纲出几个方案', 'number', '1 到 3', 'min="1" max="3"')}</div>
           ${s('mapToxic', '雷点清单（每行一条，扫描时找出来，AI 提议时照着改）', 'textarea', '留空用「触发剧情改写的情节」')}
           <div class="nim-row"><button id="nim-map-apply-toxic" class="nim-btn sm">把雷点加进剧情改写规则</button></div>
           ${s('mapTemplates', '改写指令模板（每行一条）', 'textarea')}
           <div class="nim-row"><span class="nim-muted">范围：第</span><input id="nim-map-from" class="nim-input nim-map-num" type="number" min="1" placeholder="1"><span class="nim-muted">到</span><input id="nim-map-to" class="nim-input nim-map-num" type="number" min="1" placeholder="最后"><span class="nim-muted">层</span></div>
           <div class="nim-row"><button id="nim-map-est-btn" class="nim-btn sm">估算花费</button><button id="nim-map-scan" class="nim-btn sm primary">扫描没扫过的层</button><button id="nim-map-rescan" class="nim-btn sm">全部重扫</button><button id="nim-map-scanstop" class="nim-btn sm danger-ghost" hidden>停止</button><span id="nim-map-scanstate" class="nim-muted"></span></div>
           <div id="nim-map-est" class="nim-muted"></div>
           <details class="nim-fold" id="nim-map-live-box"><summary>实时输出</summary><pre id="nim-map-live" class="nim-pre"></pre></details>
           <div class="nim-row"><button id="nim-map-suggest" class="nim-btn sm">AI 提议改写点</button><button id="nim-map-export" class="nim-btn sm">导出规划</button><label class="nim-btn sm">导入规划<input type="file" id="nim-map-plan-file" accept=".json" hidden></label></div>`,
      )}
      <div id="nim-map" class="nim-map"></div>`;
    }

    // ============================================
    // 原文阅读、全书搜索、目录、功能导航
    // ============================================

    const srcUi = { layer: null, title: '', paras: [], query: '', cur: 0, total: 0, chapter: '' };

    function chapterTest1() {
        const re = C.safeRegex(State.settings.chapterRegex || C.DEFAULT_CHAPTER_REGEX);
        return (t) => C.isChapterTitle(t, re);
    }

    /** 打开原文阅读：某一层（可带关键词、第几处命中、跳到某章），或者一段原文摘录 */
    function openSource(i, { query = '', nth = 0, chapter = '', excerpt = null, title = '' } = {}) {
        const e = State.engine;
        if (excerpt !== null) {
            srcUi.layer = null;
            srcUi.title = title || '原文';
            srcUi.paras = String(excerpt).split('\n');
        } else {
            const l = e && e.layers[i];
            if (!l) return toast('先选择小说并分层', 'warning');
            srcUi.layer = i;
            srcUi.title = `第 ${i + 1} 层`;
            srcUi.paras = l.paras.map((p) => p.text);
        }
        srcUi.query = query;
        srcUi.cur = nth;
        srcUi.chapter = chapter;
        $('nim-src-q').value = query;
        $('nim-src').hidden = false;
        renderSource(true);
    }

    function renderSource(jump) {
        const e = State.engine;
        const isTitle = chapterTest1();
        const re = PM.searchRegex(srcUi.query);
        let n = 0;
        const html = srcUi.paras
            .map((t) => {
                let body;
                if (re) {
                    body = '';
                    let last = 0;
                    re.lastIndex = 0;
                    let m;
                    while ((m = re.exec(t))) {
                        if (!m[0]) {
                            re.lastIndex++;
                            continue;
                        }
                        body += esc(t.slice(last, m.index)) + `<mark class="nim-hl" data-hl="${n}">${esc(m[0])}</mark>`;
                        last = m.index + m[0].length;
                        n++;
                    }
                    body += esc(t.slice(last));
                } else body = esc(t);
                if (!t.trim()) return '';
                return isTitle(t) ? `<h4 class="nim-src-chap" data-chap="${esc(t)}">${body}</h4>` : `<p>${body}</p>`;
            })
            .join('');
        srcUi.total = n;
        if (srcUi.cur >= n) srcUi.cur = 0;
        const box = $('nim-src-body');
        box.innerHTML = html || '<div class="nim-empty">这一层没有内容</div>';
        const l = srcUi.layer !== null && e ? e.layers[srcUi.layer] : null;
        $('nim-src-title').textContent = srcUi.title;
        $('nim-src-sub').textContent = l ? `${fmtNum(l.chars)} 字${l.chapters.length ? ` · ${l.chapters[0]}${l.chapters.length > 1 ? ` 等 ${l.chapters.length} 章` : ''}` : ''}` : '';
        $('nim-src-count').textContent = srcUi.query ? (n ? `${srcUi.cur + 1} / ${n}` : '没找到') : '';
        $('nim-src-nav').hidden = srcUi.layer === null;
        if (l) {
            $('nim-src-prev').disabled = srcUi.layer <= 0;
            $('nim-src-next').disabled = srcUi.layer >= e.layers.length - 1;
        }
        if (jump) focusSourceHit();
    }

    function focusSourceHit() {
        const box = $('nim-src-body');
        box.querySelectorAll('.nim-hl.cur').forEach((m) => m.classList.remove('cur'));
        let target = null;
        if (srcUi.total) {
            target = box.querySelector(`[data-hl="${srcUi.cur}"]`);
            if (target) target.classList.add('cur');
            $('nim-src-count').textContent = `${srcUi.cur + 1} / ${srcUi.total}`;
        } else if (srcUi.chapter) {
            target = [...box.querySelectorAll('.nim-src-chap')].find((h) => h.dataset.chap === srcUi.chapter);
        }
        if (target) {
            box.scrollTop = Math.max(0, target.offsetTop - box.clientHeight / 3);
        } else box.scrollTop = 0;
    }

    function bindSource() {
        const sheet = $('nim-src');
        sheet.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-src]');
            if (ev.target === sheet || (b && b.dataset.src === 'close')) return (sheet.hidden = true);
            if (!b) return;
            const act = b.dataset.src;
            if ((act === 'up' || act === 'down') && srcUi.total) {
                srcUi.cur = (srcUi.cur + (act === 'down' ? 1 : -1) + srcUi.total) % srcUi.total;
                focusSourceHit();
            } else if (act === 'prev' || act === 'next') {
                openSource(srcUi.layer + (act === 'next' ? 1 : -1), { query: srcUi.query });
            } else if (act === 'map' && srcUi.layer !== null) {
                const i = srcUi.layer;
                sheet.hidden = true;
                $('nim-find').hidden = true;
                switchTab('map');
                mapUi.openVol.add(volOf(i));
                mapUi.openLayer = i;
                renderMap();
                const row = document.querySelector(`#nim-map [data-map-row="${i}"]`);
                if (row) row.scrollIntoView({ block: 'start' });
            }
        });
        let t = 0;
        $('nim-src-q').addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                srcUi.query = $('nim-src-q').value.trim();
                srcUi.cur = 0;
                renderSource(true);
            }, 200);
        });
        $('nim-src-q').addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && srcUi.total) {
                ev.preventDefault();
                srcUi.cur = (srcUi.cur + (ev.shiftKey ? -1 : 1) + srcUi.total) % srcUi.total;
                focusSourceHit();
            }
        });
    }

    function sourceSheetHtml() {
        return `<div id="nim-src" class="nim-sheet" hidden><div class="nim-sheet-box nim-reader" role="dialog" aria-label="原文">
          <div class="nim-sheet-head"><div class="nim-reader-title"><b id="nim-src-title">原文</b><div id="nim-src-sub" class="nim-muted nim-ellipsis"></div></div><button class="nim-icon-btn" data-src="close" title="关闭">✕</button></div>
          <div class="nim-reader-bar">
            <div class="nim-search-in"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="nim-src-q" type="search" placeholder="在这一层里找" enterkeyhint="search"></div>
            <span id="nim-src-count" class="nim-muted nim-src-count"></span>
            <button class="nim-icon-btn sm" data-src="up" title="上一处">↑</button><button class="nim-icon-btn sm" data-src="down" title="下一处">↓</button>
          </div>
          <div id="nim-src-body" class="nim-src-body"></div>
          <div id="nim-src-nav" class="nim-sheet-foot"><button id="nim-src-prev" class="nim-btn sm" data-src="prev">‹ 上一层</button><button class="nim-btn sm ghost" data-src="map">在剧情地图里看</button><button id="nim-src-next" class="nim-btn sm" data-src="next">下一层 ›</button></div>
        </div></div>`;
    }

    // ---- 全书搜索：原文 / 目录 / 功能和设置 ----

    const findUi = { mode: 'text', q: '', hits: null, index: null };
    const TAB_NAMES = { file: '小说', map: '剧情地图', settings: '设置', run: '处理', export: '导入酒馆' };

    function openFind(mode, q) {
        if (mode) findUi.mode = mode;
        if (q !== undefined) $('nim-find-q').value = q;
        $('nim-find').hidden = false;
        renderFind();
        const input = $('nim-find-q');
        // 手机上弹键盘会把面板顶起来；只在电脑上自动聚焦，手机上目录和功能页不弹键盘
        if (!window.matchMedia('(max-width: 760px)').matches || findUi.mode === 'text') setTimeout(() => input.focus(), 50);
    }

    /** 把面板里的卡片、设置项、按钮编成可搜的功能目录 */
    function buildFeatureIndex() {
        const out = [];
        const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
        document.querySelectorAll('#nim-modal .nim-panel').forEach((panel) => {
            const tab = panel.dataset.panel;
            panel.querySelectorAll('details.nim-card, .nim-res, .nim-field, .nim-check, .nim-btn, .nim-sub').forEach((el) => {
                let text;
                let kind;
                if (el.matches('details.nim-card')) {
                    text = clean(el.querySelector('.nim-card-title')?.textContent);
                    kind = 'card';
                } else if (el.matches('.nim-res')) {
                    text = clean(el.querySelector('.nim-res-title')?.textContent);
                    kind = 'card';
                } else if (el.matches('.nim-field')) {
                    const lb = el.querySelector(':scope>label');
                    text = clean(lb && (lb.firstChild?.textContent || lb.textContent));
                    kind = 'field';
                } else if (el.matches('.nim-check')) {
                    text = clean(el.querySelector('span:not(.nim-switch)')?.firstChild?.textContent || el.textContent);
                    kind = 'field';
                } else if (el.matches('.nim-sub')) {
                    text = clean(el.textContent);
                    kind = 'field';
                } else {
                    text = clean(el.textContent);
                    kind = 'btn';
                    if (el.closest('.nim-field')) return;
                }
                if (!text || text.length > 40) return;
                const card = el.closest('details.nim-card');
                const where = [TAB_NAMES[tab], card && card !== el ? clean(card.querySelector('.nim-card-title')?.textContent) : ''].filter(Boolean).join(' › ');
                const desc = kind === 'card' ? clean(el.querySelector('.nim-card-desc, .nim-res-state')?.textContent) : '';
                out.push({ text, kind, where, desc, el, tab });
            });
        });
        // 页面外的入口
        out.push({ text: '原文搜索、看原文', kind: 'btn', where: '右上角 🔍', desc: '', action: () => openFind('text') });
        out.push({ text: '目录、空章', kind: 'btn', where: '右上角 🔍', desc: '', action: () => openFind('toc') });
        return out;
    }

    function goToEl(el, tab) {
        $('nim-find').hidden = true;
        switchTab(tab);
        let d = el.closest('details');
        while (d) {
            d.open = true;
            d = d.parentElement && d.parentElement.closest('details');
        }
        if (el.matches('details')) el.open = true;
        requestAnimationFrame(() => {
            el.scrollIntoView({ block: el.matches('details, .nim-res') ? 'start' : 'center' });
            el.classList.remove('nim-flash');
            void el.offsetWidth;
            el.classList.add('nim-flash');
        });
    }

    function renderFind() {
        const box = $('nim-find-body');
        const q = $('nim-find-q').value.trim();
        findUi.q = q;
        document.querySelectorAll('#nim-find [data-find-mode]').forEach((b) => b.classList.toggle('on', b.dataset.findMode === findUi.mode));
        $('nim-find-q').placeholder = findUi.mode === 'text' ? '搜原文：人名、台词、情节…（/正则/ 也行）' : findUi.mode === 'toc' ? '筛选章节标题' : '找功能或设置，例如 雷点、模型、清洗';
        const e = State.engine;
        const noBook = '<div class="nim-empty">先在「小说」页选一本小说</div>';
        if (findUi.mode === 'text') {
            if (!e || !e.layers.length) return (box.innerHTML = noBook);
            if (!q) return (box.innerHTML = '<div class="nim-empty">输入关键词搜全书原文，点结果直接跳到那一处。<br>英文不分大小写；用 /.../ 包起来按正则搜。</div>');
            const r = PM.searchLayers(e.layers, q, { limit: 400, isChapterTitle: chapterTest1() });
            findUi.hits = r.hits;
            if (r.bad) return (box.innerHTML = '<div class="nim-empty">正则写得不对</div>');
            if (!r.total) return (box.innerHTML = '<div class="nim-empty">全书没有找到</div>');
            const layers = new Set(r.hits.map((h) => h.layer)).size;
            box.innerHTML =
                `<div class="nim-find-sum">共 ${fmtNum(r.total)} 处${r.total > r.hits.length ? `，先列前 ${r.hits.length} 处` : `，在 ${layers} 层里`}</div>` +
                r.hits
                    .map(
                        (h, k) =>
                            `<button class="nim-hit" data-hit="${k}"><div class="nim-hit-where"><b>第 ${h.layer + 1} 层</b>${h.chapter ? ` · ${esc(h.chapter)}` : ''}</div><div class="nim-hit-text">${esc(h.before)}<mark class="nim-hl">${esc(h.match)}</mark>${esc(h.after)}</div></button>`,
                    )
                    .join('');
            return;
        }
        if (findUi.mode === 'toc') {
            if (!e || !e.layers.length) return (box.innerHTML = noBook);
            const toc = PM.chapterIndex(e.layers);
            const empties = emptyChapterInfo();
            const ql = q.toLowerCase();
            const list = q ? toc.filter((c) => c.title.toLowerCase().includes(ql)) : toc;
            const emptyHtml = empties.length
                ? `<div class="nim-alert warn"><b>${empties.length} 章没有正文</b>（清洗后只剩标题，多半被盗版站替换了），已从正文里去掉。点一章看它在原文里的样子。</div>` +
                  empties
                      .filter((x) => !q || x.title.toLowerCase().includes(ql))
                      .map((x, k) => `<button class="nim-hit warn" data-empty="${k}"><div class="nim-hit-where"><b>${esc(x.title)}</b>${x.layer !== null ? ` · 在第 ${x.layer + 1} 层附近` : ''}</div><div class="nim-hit-text">${x.after ? esc(x.after) : '（标题后面什么都没有）'}</div></button>`)
                      .join('')
                : '';
            box.innerHTML =
                emptyHtml +
                `<div class="nim-find-sum">共 ${fmtNum(toc.length)} 章${q ? `，筛出 ${list.length} 章` : ''}</div>` +
                (list.length
                    ? list
                          .slice(0, 3000)
                          .map((c) => `<button class="nim-toc" data-toc-layer="${c.layer}" data-toc="${esc(c.title)}"><span class="nim-toc-title">${esc(c.title)}</span><span class="nim-muted">第 ${c.layer + 1} 层</span></button>`)
                          .join('')
                    : '<div class="nim-empty">没有识别出章节标题，可以在设置「分层与清洗」里改章节标题规则</div>');
            return;
        }
        // 功能和设置
        findUi.index = buildFeatureIndex();
        const ql = q.toLowerCase();
        if (!q) {
            // 没输入时列出每页有哪些功能，当成功能目录
            const byTab = {};
            for (const it of findUi.index) if (it.kind === 'card' && it.el) (byTab[it.tab] = byTab[it.tab] || []).push(it);
            box.innerHTML =
                '<div class="nim-find-sum">每一页都有什么，点一下直接过去</div>' +
                Object.entries(TAB_NAMES)
                    .map(([tab, name]) => {
                        const items = findUi.index.filter((it) => it.tab === tab && it.kind === 'card');
                        return `<div class="nim-find-group"><div class="nim-find-gtitle">${name}</div>${items.length ? items.map((it) => `<button class="nim-hit" data-feat="${findUi.index.indexOf(it)}"><div class="nim-hit-where"><b>${esc(it.text)}</b></div>${it.desc ? `<div class="nim-hit-text">${esc(it.desc)}</div>` : ''}</button>`).join('') : `<button class="nim-hit" data-tab-go="${tab}"><div class="nim-hit-where"><b>打开「${name}」</b></div></button>`}</div>`;
                    })
                    .join('');
            return;
        }
        const seen = new Set();
        const list = findUi.index.filter((it) => {
            if (!(it.text.toLowerCase().includes(ql) || it.desc.toLowerCase().includes(ql) || it.where.toLowerCase().includes(ql))) return false;
            const k = it.text + '|' + it.where;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        box.innerHTML = list.length
            ? list
                  .slice(0, 80)
                  .map((it) => `<button class="nim-hit" data-feat="${findUi.index.indexOf(it)}"><div class="nim-hit-where"><b>${esc(it.text)}</b><span class="nim-tag">${it.kind === 'card' ? '版块' : it.kind === 'field' ? '设置项' : '按钮'}</span></div><div class="nim-hit-text">${esc(it.where)}${it.desc ? ` · ${esc(it.desc)}` : ''}</div></button>`)
                  .join('')
            : '<div class="nim-empty">没有找到这个功能。换个说法试试，比如「模型」「雷点」「广告」「标题」。</div>';
    }

    let emptyCache = { key: '', list: [] };
    function emptyChapterInfo() {
        const e = State.engine;
        const titles = (e && e.stats && e.stats.emptyChapters) || [];
        if (!titles.length) return [];
        const key = `${State.fileName}|${State.text.length}|${titles.length}|${e.layers.length}`;
        if (emptyCache.key !== key) emptyCache = { key, list: PM.locateEmptyChapters(State.text, titles, e.layers, chapterTest1()) };
        return emptyCache.list;
    }

    /** 空章在原文里的样子：标题和后面到下一章之前的原文 */
    function openEmptyChapter(k) {
        const x = emptyChapterInfo()[k];
        if (!x) return;
        const lines = [x.title, x.after || '（标题后面什么都没有）'];
        if (x.next) lines.push('', `下一章：${x.next}`);
        openSource(null, { excerpt: lines.join('\n'), title: `空章：${x.title}` });
        $('nim-src-sub').textContent = x.layer !== null ? `原文里在第 ${x.layer + 1} 层附近；清洗时整章去掉了，建议换个源补上` : '原文里没找到这一行';
    }

    function bindFind() {
        const sheet = $('nim-find');
        sheet.addEventListener('click', (ev) => {
            if (ev.target === sheet || ev.target.closest('[data-find="close"]')) return (sheet.hidden = true);
            const m = ev.target.closest('[data-find-mode]');
            if (m) {
                findUi.mode = m.dataset.findMode;
                $('nim-find-q').value = '';
                return renderFind();
            }
            const hit = ev.target.closest('[data-hit]');
            if (hit) {
                const h = findUi.hits[Number(hit.dataset.hit)];
                return openSource(h.layer, { query: findUi.q, nth: h.nth });
            }
            const toc = ev.target.closest('[data-toc]');
            if (toc) return openSource(Number(toc.dataset.tocLayer), { chapter: toc.dataset.toc });
            const em = ev.target.closest('[data-empty]');
            if (em) return openEmptyChapter(Number(em.dataset.empty));
            const ft = ev.target.closest('[data-feat]');
            if (ft) {
                const it = findUi.index[Number(ft.dataset.feat)];
                if (it.action) return it.action();
                return goToEl(it.el, it.tab);
            }
            const tg = ev.target.closest('[data-tab-go]');
            if (tg) {
                sheet.hidden = true;
                switchTab(tg.dataset.tabGo);
            }
        });
        let t = 0;
        $('nim-find-q').addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(renderFind, findUi.mode === 'text' ? 300 : 120);
        });
        $('nim-find-q').addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                clearTimeout(t);
                renderFind();
                ev.target.blur();
            }
        });
    }

    function findSheetHtml() {
        return `<div id="nim-find" class="nim-sheet" hidden><div class="nim-sheet-box nim-findbox" role="dialog" aria-label="搜索">
          <div class="nim-sheet-head nim-find-head">
            <div class="nim-search-in grow"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="nim-find-q" type="search" enterkeyhint="search"></div>
            <button class="nim-icon-btn" data-find="close" title="关闭">✕</button>
          </div>
          <div class="nim-seg"><button data-find-mode="text">原文</button><button data-find-mode="toc">目录和空章</button><button data-find-mode="ui">功能和设置</button></div>
          <div id="nim-find-body" class="nim-sheet-body nim-find-body"></div>
        </div></div>`;
    }

    const wrUi = { text: '', total: 0, summary: '' };

    /** 词语替换写进已生成的层之前，先列出每条规则换了几处、在哪一层哪一块，带前后文 */
    function openReplacePreview(text) {
        const { rules, hits } = State.engine.previewReplaceInResults(text);
        if (!hits.length) return toast('已生成的层里没有要替换的词', 'info');
        wrUi.text = text;
        wrUi.total = hits.length;
        wrUi.summary = rules
            .filter((r) => r.count)
            .map((r) => `${r.text}（${r.count} 处）`)
            .join('；');
        const MAX = 500;
        const row = (h) =>
            `<li><div class="nim-cl-chap">第 ${h.layer + 1} 层 · ${esc(h.where)}</div><div>${esc(h.pre)}<del class="nim-cl-mark">${esc(h.from)}</del><ins class="nim-wr-to">${esc(h.to) || '（删掉）'}</ins>${esc(h.post)}</div></li>`;
        const groups = rules
            .map((r, ri) => {
                const list = hits.filter((h) => h.rule === ri);
                const where = {};
                for (const h of list) where[h.where] = (where[h.where] || 0) + 1;
                const layers = new Set(list.map((h) => h.layer)).size;
                const info = list.length ? `${list.length} 处，${layers} 层（${Object.entries(where).map(([k, n]) => `${k} ${n}`).join('、')}）` : '没有匹配';
                return `<details class="nim-cl-group" ${list.length ? '' : 'disabled'}><summary>${esc(r.text)}<span class="nim-muted">${info}</span></summary><ul class="nim-cl-list">${list.slice(0, MAX).map(row).join('')}</ul>${list.length > MAX ? `<div class="nim-muted">太多了，只列出前 ${MAX} 处</div>` : ''}</details>`;
            })
            .join('');
        $('nim-wr-body').innerHTML =
            `<div class="nim-muted">共 ${hits.length} 处。红色删除线是原来的字，绿色是换成的字。核对没问题再点「确认替换」，改完不能撤销，只能重跑那一层。</div>` + groups;
        $('nim-wr').hidden = false;
    }

    function replacePreviewHtml() {
        return `<div id="nim-wr" class="nim-sheet" hidden><div class="nim-sheet-box" role="dialog" aria-label="词语替换预览">
          <div class="nim-sheet-head"><b>词语替换会换掉这些</b><button class="nim-icon-btn" data-wr="close" title="关闭">✕</button></div>
          <div id="nim-wr-body" class="nim-sheet-body"></div>
          <div class="nim-sheet-foot"><span class="nim-grow-sp"></span><button class="nim-btn" data-wr="close">取消</button><button class="nim-btn primary" data-wr="apply">确认替换</button></div>
        </div></div>`;
    }

    function cleanLogHtml() {
        return `<div id="nim-cl" class="nim-sheet" hidden><div class="nim-sheet-box" role="dialog" aria-label="清掉的内容">
          <div class="nim-sheet-head"><b>清掉的内容</b><button class="nim-icon-btn" data-cl="close" title="关闭">✕</button></div>
          <div id="nim-cl-body" class="nim-sheet-body"></div>
          <div class="nim-sheet-foot"><button class="nim-btn" data-cl="close">关闭</button><button id="nim-cl-relayer" class="nim-btn primary" data-cl="relayer" hidden>重新分层，让保留生效</button></div>
        </div></div>`;
    }

    function presetEditHtml() {
        return `<div id="nim-pe" class="nim-sheet" hidden><div class="nim-sheet-box" role="dialog" aria-label="编辑预设条目">
          <div class="nim-sheet-head"><b>编辑条目</b><button class="nim-icon-btn" data-pe="cancel" title="关闭">✕</button></div>
          <div class="nim-sheet-body">
            <div class="nim-field"><label for="nim-pe-name">名称</label><input id="nim-pe-name" class="nim-input"></div>
            <div class="nim-grid">
              <div class="nim-field"><label for="nim-pe-role">身份</label><select id="nim-pe-role" class="nim-input"><option value="system">系统</option><option value="user">用户</option><option value="assistant">AI 助手</option></select></div>
              <div class="nim-field"><label for="nim-pe-pos">位置</label><select id="nim-pe-pos" class="nim-input"><option value="relative">相对</option><option value="depth">聊天中（按深度）</option></select></div>
            </div>
            <div id="nim-pe-depthrow">
              <div class="nim-grid">
                <div class="nim-field"><label for="nim-pe-depth">深度</label><input id="nim-pe-depth" class="nim-input" type="number" min="0" step="1"></div>
                <div class="nim-field"><label for="nim-pe-order">顺序</label><input id="nim-pe-order" class="nim-input" type="number" step="1"></div>
              </div>
              <div class="nim-muted">深度 0 放在本层提示词之后，深度 1 及以上放在它前面；同深度按顺序从小到大。</div>
            </div>
            <div class="nim-field"><label for="nim-pe-content">内容</label><textarea id="nim-pe-content" class="nim-input nim-textarea" rows="12" placeholder="要发送的提示词"></textarea></div>
          </div>
          <div class="nim-sheet-foot"><button class="nim-btn danger-ghost" data-pe="remove">删除</button><span class="nim-grow-sp"></span><button class="nim-btn" data-pe="cancel">取消</button><button class="nim-btn primary" data-pe="save">完成</button></div>
        </div></div>`;
    }

    // ============================================
    // 渲染
    // ============================================

    /** 滚动框是不是停在（接近）底部 */
    function atBottom(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }

    function log(msg) {
        const el = $('nim-log');
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(`[NovelImporter] ${msg}`);
        if (!el) return;
        const follow = atBottom(el);
        el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
        if (follow) el.scrollTop = el.scrollHeight;
        const last = $('nim-last-log');
        if (last) last.textContent = msg;
    }

    function setStatus(s) {
        const el = $('nim-status');
        if (el) el.textContent = s;
    }

    let streamRaf = 0;
    function renderStream(info) {
        if (streamRaf) return;
        streamRaf = requestAnimationFrame(() => {
            streamRaf = 0;
            const el = $('nim-stream');
            if (!el) return;
            // 用户往上翻着看的时候不拉回底部；停在底部附近才跟着新内容走
            const follow = atBottom(el);
            const top = el.scrollTop;
            el.textContent = State.stream.length > 60000 ? '…' + State.stream.slice(-60000) : State.stream;
            el.scrollTop = follow ? el.scrollHeight : top;
            setStatus(`${info.purpose === 'card' ? '生成角色卡简介' : info.purpose === 'repair' ? `第 ${info.layer + 1} 层修格式` : info.purpose === 'json' ? `第 ${info.layer + 1} 层重新输出 JSON` : `第 ${info.layer + 1} 层输出`}中 · ${State.stream.length} 字`);
        });
    }

    function switchTab(name) {
        State.tab = name;
        document.querySelectorAll('#nim-modal .nim-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
        document.querySelectorAll('#nim-modal .nim-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
        const body = document.querySelector('#nim-modal .nim-body');
        if (body) body.scrollTop = 0;
        if (name === 'map') {
            fillMapFields();
            renderMap();
        }
    }

    /** 手机上分层列表和单层详情分两屏，点一层进详情，「返回」回列表 */
    // 手机上打开详情时列表被隐藏，滚动位置会丢；记下来，返回时滚回原处
    const listScroll = { body: 0, list: 0 };

    function openDetail(on) {
        const box = document.querySelector('#nim-modal .nim-runbox');
        const body = document.querySelector('#nim-modal .nim-body');
        const list = $('nim-layers');
        const narrow = window.matchMedia('(max-width: 760px)').matches;
        const wasOpen = !!(box && box.classList.contains('detail-open'));
        if (on && !wasOpen) {
            listScroll.body = body ? body.scrollTop : 0;
            listScroll.list = list ? list.scrollTop : 0;
        }
        if (box) box.classList.toggle('detail-open', !!on);
        if (body && on && narrow) body.scrollTop = 0;
        if (!on && wasOpen && narrow) {
            if (list) list.scrollTop = listScroll.list;
            if (body) body.scrollTop = listScroll.body;
        }
    }

    function layerState(r, i, e) {
        if (e.reviewing === i) return 'review';
        if (!r) return 'todo';
        return r.status;
    }

    const STATE_TEXT = { todo: '未开始', running: '处理中', done: '完成', failed: '失败', review: '待审阅' };

    function renderLayers() {
        const el = $('nim-layers');
        const e = State.engine;
        if (!el) return;
        if (!e || !e.layers.length) {
            el.innerHTML = '<div class="nim-empty">选择小说后，这里会列出每一层</div>';
            return;
        }
        // 上千层时只画选中层附近和正在跑的层附近，免得每层刷新都重排整个列表
        const n = e.layers.length;
        const runningAt = e.results.findIndex((r) => !r || r.status !== 'done');
        const focus = State.selected ?? (runningAt < 0 ? n - 1 : runningAt);
        const from = n > 300 ? Math.max(0, focus - 100) : 0;
        const to = n > 300 ? Math.min(n, from + 200) : n;
        const rows = [];
        if (from > 0) rows.push(`<div class="nim-more">前面还有 ${from} 层</div>`);
        for (let i = from; i < to; i++) {
            const l = e.layers[i];
            const r = e.results[i];
            const st = layerState(r, i, e);
            const title = r && r.parsed ? r.parsed.title : (l.chapters[0] || l.paras[0].text).slice(0, 30);
            const flags = [];
            if (r && r.divergenceStart) flags.push('<span class="nim-tag red">改写起点</span>');
            else if (r && r.inDivergence) flags.push('<span class="nim-tag orange">改写中</span>');
            if (r && r.patchStats && r.patchStats.failed.length) flags.push(`<span class="nim-tag">${r.patchStats.failed.length} 条补丁没对上</span>`);
            if (r && r.askedBigSummary) flags.push('<span class="nim-tag blue">大总结</span>');
            if (l.translate) flags.push('<span class="nim-tag violet">翻译</span>');
            if (l.note) flags.push('<span class="nim-tag blue" title="这层有提前写好的提示词">专属提示词</span>');
            rows.push(
                `<button class="nim-layer ${State.selected === i ? 'sel' : ''}" data-i="${i}" title="${STATE_TEXT[st] || ''}">
                   <span class="nim-dot ${st}"></span><span class="nim-layer-no">${i + 1}</span>
                   <span class="nim-layer-title">${esc(title)}</span>
                   <span class="nim-layer-meta">${flags.join('')}<span class="nim-muted">${l.chars} 字</span></span>
                 </button>`,
            );
        }
        if (to < n) rows.push(`<div class="nim-more">后面还有 ${n - to} 层</div>`);
        el.innerHTML = rows.join('');
        el.querySelectorAll('.nim-layer').forEach((d) =>
            d.addEventListener('click', () => {
                State.selected = Number(d.dataset.i);
                openDetail(true);
                renderAll();
            }),
        );
    }

    /** 3725000 → 「1 小时 2 分」；不到 1 分钟写「不到 1 分钟」 */
    function fmtDuration(ms) {
        const m = Math.round(ms / 60000);
        if (m < 1) return '不到 1 分钟';
        const h = Math.floor(m / 60);
        return h ? `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分钟`;
    }

    function renderProgress() {
        const e = State.engine;
        const total = e ? e.layers.length : 0;
        const done = e ? e.results.filter((r) => r && r.status === 'done').length : 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const bar = $('nim-progress-bar');
        if (bar) bar.style.width = `${pct}%`;
        const t = $('nim-progress');
        const eta = e && done < total ? e.estimateRemaining() : 0;
        if (t) t.textContent = total ? `${done} / ${total} 层 · ${pct}%${eta ? ` · 约剩 ${fmtDuration(eta)}` : ''}` : '还没有分层';
        const tk = $('nim-tokens');
        if (tk) tk.textContent = e ? `${e.stats.estimated ? '估算 ' : ''}输入 ${fmtNum(e.stats.inputTokens)}${e.stats.cachedTokens ? `（缓存 ${fmtNum(e.stats.cachedTokens)}）` : ''} · 输出 ${fmtNum(e.stats.outputTokens)} tokens` : '';
    }

    /** 一层的用量：输入 / 输出（缓存命中）· 请求次数；没有真实用量时标「估算」 */
    function tokenText(t) {
        if (!t || !t.calls) return '';
        return `${t.estimated ? '估算 ' : ''}输入 ${fmtNum(t.input)}${t.cached ? `（缓存 ${fmtNum(t.cached)}）` : ''} · 输出 ${fmtNum(t.output)} tokens${t.calls > 1 ? ` · ${t.calls} 次请求` : ''}`;
    }

    function fmtNum(n) {
        n = Number(n) || 0;
        return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n);
    }

    /** 这一层 AI 写进世界书的条目：和前面的层比，标出新增还是更新 */
    function layerWorldbookHtml(e, i, r) {
        const wb = (r.parsed && r.parsed.worldbook) || {};
        const items = [];
        for (const [cat, entries] of Object.entries(wb)) for (const [name, it] of Object.entries(entries || {})) if (it && typeof it === 'object') items.push({ cat, name, it });
        if (!items.length) return `<div class="nim-sub">本层世界书</div><div class="nim-muted">这一层没有新增或更新条目</div>`;
        let before = {};
        let after = {};
        let aliases = [];
        try {
            before = (e.replay(i) || {}).worldbook || {};
            after = (e.replay(i + 1) || {}).worldbook || {};
            aliases = e.finalState().aliases || [];
        } catch (err) {
            /* 比不出来就都当新增 */
        }
        const target = C.aliasTargetOf(State.settings);
        const provided = new Set(r.providedNames || []);
        // 和合并时一样：名字或任一关键词对上旧条目就算同一个
        const findOld = (cat, name, keys) => {
            const old = before[cat] || {};
            if (old[name]) return name;
            const want = new Set([name, ...keys]);
            return Object.keys(old).find((n) => [n, ...(old[n].关键词 || [])].some((k) => want.has(k))) || null;
        };
        const rows = items.map((x) => {
            const keys = Array.isArray(x.it.关键词) ? x.it.关键词 : x.it.关键词 ? [String(x.it.关键词)] : [];
            const old = findOld(x.cat, x.name, keys);
            const kind = !old ? 'add' : provided.has(`${x.cat}/${old}`) && !C.isPartialWbUpdate(x.it.内容, before[x.cat][old].内容) ? 'replace' : 'append';
            return { ...x, keys, old, kind };
        });
        const n = (k) => rows.filter((x) => x.kind === k).length;
        const TAG = { add: '新增', replace: '更新（整条改写）', append: '补充（接在旧内容后）' };
        return (
            `<details class="nim-fold" open><summary>本层世界书（${rows.length} 条：新增 ${n('add')}，更新 ${n('replace') + n('append')}）</summary>` +
            `<div class="nim-muted">这里是 AI 这一层原样给的内容。同名或关键词对上的条目会并进同一条，导出时一个角色只有一条。「整条改写」：AI 拿到了旧内容，回的是改好的完整版，直接替换；「补充」：这次没把旧内容发给 AI，或者 AI 只回了追加的一段，新内容接在旧内容后面。点「合并后的完整条目」看这一层处理完后条目的样子。称呼表里的名字导出时会换成 ${esc(target)}。</div><ul class="nim-wb-list">` +
            rows
                .map(({ cat, name, keys, old, kind }) => {
                    const asUser = aliases.includes(name);
                    return `<li><div class="nim-wb-head"><span class="nim-pr-tag">${esc(cat)}</span><b>${esc(name)}</b><span class="nim-pr-tag ${kind === 'add' ? 'is-depth' : ''}">${TAG[kind]}</span>${old && old !== name ? `<span class="nim-muted">并进「${esc(old)}」</span>` : ''}${asUser ? `<span class="nim-muted">导出为 ${esc(target)}</span>` : ''}</div>${keys.length ? `<div class="nim-muted">关键词：${esc(keys.join('、'))}</div>` : ''}<div class="nim-wb-content">${esc(String(r.parsed.worldbook[cat][name].内容 || ''))}</div>${old && after[cat] && after[cat][old] ? `<details class="nim-fold"><summary>合并后的完整条目</summary><div class="nim-wb-content">${esc(String(after[cat][old].内容 || ''))}</div></details>` : ''}</li>`;
                })
                .join('') +
            `</ul></details>`
        );
    }

    /** 这一层发出去的提示词：可以改本模块拼的那部分，然后用它重做这层 */
    /** 提示词构成：各部分字数和占比，重复发送的大段标出来 */
    function breakdownHtml(r) {
        const b = C.promptBreakdown(r.prompt, r.request);
        if (!b.total) return '';
        const pct = (n) => `${Math.round((n / b.total) * 100)}%`;
        const rows = b.parts.map((x) => `<tr><td>${esc(x.name)}</td><td class="nim-num">${fmtNum(x.chars)}</td><td class="nim-num">${pct(x.chars)}</td></tr>`).join('');
        const dup = b.promptCopies > 1 ? `<div class="nim-alert warn">本模块的提示词在完整消息里出现了 ${b.promptCopies} 次，被重复发送了（检查预设里是不是有多个聊天记录位置）</div>` : '';
        const rep = b.repeats.length
            ? `<div class="nim-alert warn">完整消息里有 ${b.repeats.length} 段 200 字以上的内容重复出现：${b.repeats
                  .slice(0, 5)
                  .map((x) => `「${esc(x.text.slice(0, 30))}…」${x.count} 次（${fmtNum(x.text.length)} 字）`)
                  .join('；')}</div>`
            : '';
        return `<details class="nim-fold"><summary>提示词构成（共 ${fmtNum(b.total)} 字）</summary>${dup}${rep}<table class="nim-bd"><tr><th>部分</th><th>字数</th><th>占比</th></tr>${rows}</table><div class="nim-muted">按字数算，不是 token；中文大约 1 字 1 token 多一点。</div></details>`;
    }

    function promptHtml(r) {
        if (!r.request && !r.prompt) return '';
        const full = (r.request || []).map((m) => `【${m.role}】\n${m.content}`).join('\n\n');
        return `${breakdownHtml(r)}<details class="nim-fold"><summary>本层发出去的提示词${r.customPrompt ? '（用的是你改过的）' : ''}</summary>
          ${full ? `<details class="nim-fold"><summary>完整消息（套上预设后的，${(r.request || []).length} 条）</summary><div class="nim-row"><button id="nim-req-export" class="nim-btn sm">导出完整消息为文件</button></div><pre class="nim-pre">${esc(full)}</pre></details>` : ''}
          ${
              r.prompt
                  ? `<div class="nim-muted">下面是本模块拼的部分（任务、规则、世界书、表格、原文），发送时会照常套上预设。改完点按钮，用改过的重做这一层，之后的层作废。预设里的条目在设置「酒馆预设」里改。</div>
          <textarea id="nim-prompt-edit" class="nim-input nim-textarea" rows="12">${esc(r.prompt)}</textarea>
          <div class="nim-row"><button id="nim-prompt-redo" class="nim-btn sm">用改过的提示词重做这层</button></div>`
                  : ''
          }
        </details>`;
    }

    /** 这一层每次请求的原始输出（首次、重试、修格式），按顺序列出来 */
    function callsHtml(r) {
        const calls = r.calls || [];
        if (!calls.length) return '';
        const NAME = { layer: '正文请求', repair: '修 JSON 格式', json: '只重新输出 JSON' };
        return (
            `<details class="nim-fold"><summary>每次请求的原始输出（${calls.length} 次）</summary>` +
            calls
                .map((c, k) => {
                    const head = `第 ${k + 1} 次 · ${NAME[c.purpose] || c.purpose}${c.purpose === 'layer' ? `（第 ${c.attempt + 1} 次尝试）` : ''}${c.tokens ? ` · ${tokenText({ ...c.tokens, calls: 1 })}` : ''}`;
                    const state = c.error ? `<div class="nim-alert danger">请求失败：${esc(c.error)}</div>` : c.problem ? `<div class="nim-alert warn">${esc(c.problem)}</div>` : '';
                    const req = c.request ? `<details class="nim-fold"><summary>发出去的内容</summary><pre class="nim-pre">${esc(c.request.map((m) => `【${m.role}】\n${m.content}`).join('\n\n'))}</pre></details>` : '';
                    return `<details class="nim-fold"><summary>${esc(head)}</summary>${state}${req}<pre class="nim-pre">${esc(c.raw || '')}</pre></details>`;
                })
                .join('') +
            `</details>`
        );
    }

    /** 楼层内容转成 HTML，AI 补充的部分用 <mark> 标出来（只在界面里，不改楼层本身） */
    function floorHtml(e, i, floor) {
        const mes = floor ? floor.mes : '';
        if (State.hlOff || !floor || typeof e.markedBody !== 'function') return esc(mes);
        const marked = e.markedBody(i);
        if (!marked || C.stripMarks(marked) !== floor.body || !/\uE000/.test(marked)) return esc(mes);
        const at = mes.indexOf(floor.body);
        if (at < 0) return esc(mes);
        const hl = esc(marked).replace(/\uE000/g, '<mark class="nim-hl">').replace(/\uE001/g, '</mark>');
        return esc(mes.slice(0, at)) + hl + esc(mes.slice(at + floor.body.length));
    }

    /** 高亮之间跳转：在楼层内容框里滚到上一处/下一处，当前那处加深 */
    function bindHlNav() {
        const nav = $('nim-hl-nav');
        const pre = $('nim-floor-pre');
        if (!nav || !pre) return;
        const marks = [...pre.querySelectorAll('mark.nim-hl')];
        if (!marks.length) return;
        nav.hidden = false;
        let cur = -1;
        const pos = $('nim-hl-pos');
        pos.textContent = `共 ${marks.length} 处`;
        nav.onclick = (ev) => {
            const b = ev.target.closest('[data-hl-go]');
            if (!b) return;
            if (cur >= 0) marks[cur].classList.remove('cur');
            cur = (cur + Number(b.dataset.hlGo) + marks.length) % marks.length;
            const m = marks[cur];
            m.classList.add('cur');
            const pr = pre.getBoundingClientRect();
            pre.scrollTop += m.getBoundingClientRect().top - pr.top - pr.height / 3;
            pre.scrollIntoView({ block: 'nearest' });
            pos.textContent = `${cur + 1} / ${marks.length}`;
        };
    }

    /** 重做时是否保留后面的层：详情页的勾选框，没有后面的层时无所谓 */
    function keepLaterChecked() {
        const b = $('nim-keep-later');
        return b ? b.checked : false;
    }

    function renderDetail() {
        const el = $('nim-detail');
        const e = State.engine;
        if (!el) return;
        const i = State.selected;
        if (!e || i === null || i === undefined || !e.layers[i]) {
            el.innerHTML = '<div class="nim-empty">选一层查看结果</div>';
            return;
        }
        const r = e.results[i];
        const reviewing = e.reviewing === i;
        const hasLater = e.results.slice(i + 1).some((x) => x);
        let body = '';
        if (r && r.status === 'done' && r.skipped) {
            body += '<div class="nim-alert">这层在剧情地图里标了「跳过」：没有调用 AI，也不出楼层。要处理的话去剧情地图取消跳过，再从这层重新处理。</div>';
        } else if (r && r.status === 'done') {
            const floor = e.renderFloors().find((f) => f.layer === i);
            const d = r.parsed.divergence;
            if (r.warnings && r.warnings.length) body += `<div class="nim-alert warn">${esc(r.warnings.join('；'))}</div>`;
            body += d.triggered || r.inDivergence ? `<div class="nim-alert warn">剧情改写：${esc(d.rule)} ${esc(d.note)}${d.resume ? '（本层接回原文）' : ''}</div>` : '';
            body += `<div class="nim-sub">楼层内容${State.hlOff ? '' : '<span class="nim-muted">（<mark class="nim-hl">高亮</mark>是 AI 补充的，只在这里显示，导出不带）</span>'}<button id="nim-hl-toggle" class="nim-btn ghost sm" style="margin-left:8px">${State.hlOff ? '显示高亮' : '关掉高亮'}</button></div>${State.hlOff ? '' : '<div class="nim-row nim-hl-nav" id="nim-hl-nav" hidden><button class="nim-btn sm" data-hl-go="-1">↑ 上一处</button><span id="nim-hl-pos" class="nim-muted"></span><button class="nim-btn sm" data-hl-go="1">下一处 ↓</button></div>'}<pre class="nim-pre" id="nim-floor-pre">${floorHtml(e, i, floor)}</pre>`;
            if (r.patchStats.failed.length)
                body += `<div class="nim-sub">没对上的补丁</div><pre class="nim-pre">${esc(r.patchStats.failed.map((f) => `P${f.patch.pid} | ${f.patch.anchor} | ${f.patch.text}  →  ${f.reason}`).join('\n'))}</pre>`;
            if (r.tableLog && r.tableLog.length) body += `<div class="nim-sub">表格提示</div><pre class="nim-pre">${esc(r.tableLog.join('\n'))}</pre>`;
            body += layerWorldbookHtml(e, i, r);
            if (r.parsed.terms && r.parsed.terms.length) body += `<div class="nim-sub">本层新术语</div><pre class="nim-pre">${esc(r.parsed.terms.map((t) => `${t.source} → ${t.target}${t.note ? `（${t.note}）` : ''}`).join('\n'))}</pre>`;
            body += `<details class="nim-fold"><summary>程序最后用的回复${(r.calls || []).some((c) => c.purpose === 'repair' || c.purpose === 'json') ? '（修过格式后拼回去的）' : ''}</summary><pre class="nim-pre">${esc(r.raw)}</pre></details>`;
        } else if (r && r.status === 'failed') {
            body += `<div class="nim-alert danger">失败：${esc(r.error)}</div>`;
        }
        if (!reviewing && r && (r.status === 'done' || r.status === 'failed'))
            body += `<div class="nim-sub">这层的修改要求</div>
              <textarea id="nim-layer-fb" class="nim-input nim-textarea" rows="3" placeholder="例如：NTR 那段改得更彻底；对话多补几句神态；译名统一用「花恋」"></textarea>
              <div class="nim-row"><button id="nim-layer-fb-go" class="nim-btn sm">按要求重做这层</button><span class="nim-muted">会带上这层上次的输出</span></div>`;
        if (!reviewing && r && r.status === 'done') {
            const bad = r.warnings && r.warnings.length;
            body += `<details class="nim-fold"${bad ? ' open' : ''}><summary>只重新输出 JSON（正文不动）${bad ? '<span class="nim-muted">：这层有 JSON 没用上</span>' : ''}</summary>
              <textarea id="nim-json-fb" class="nim-input nim-textarea" rows="3" placeholder="可留空。例如：表格 JSON 里的字符串引号要转义；世界书补上花恋的身高"></textarea>
              <div class="nim-row"><label class="nim-muted"><input type="checkbox" id="nim-json-preset"> 套用酒馆预设（AI 拒绝时再勾）</label></div>
              <div class="nim-row"><button id="nim-json-go" class="nim-btn sm">只重新输出 JSON</button><span class="nim-muted">只要改写判定、世界书、表格三段，之后的层保留</span></div>
            </details>`;
        }
        const note = e.layers[i].note || '';
        body += `<details class="nim-fold"${note || !r ? ' open' : ''}><summary>这层的专属提示词${note ? '<span class="nim-muted">：已填</span>' : ''}</summary>
              <textarea id="nim-layer-note" class="nim-input nim-textarea" rows="3" placeholder="提前写好，处理到这层时（包括重做）放在提示词最后一起发给 AI。例如：这层把告白那段改成女主先开口；这层开始叫主角「远」">${esc(note)}</textarea>
              <div class="nim-row"><button id="nim-layer-note-save" class="nim-btn sm">保存</button><span class="nim-muted">${r && r.status === 'done' ? '这层已经生成过了，要生效得重做这层' : '自动保存，跑到这层时生效'}</span></div>
            </details>`;
        if (r) body += promptHtml(r);
        if (r) body += callsHtml(r);
        body += `<details class="nim-fold"><summary>原文</summary><pre class="nim-pre">${esc(e.layers[i].paras.map((p) => p.text).join('\n'))}</pre></details>`;
        const reviewHtml = reviewing
            ? `<div class="nim-review">
                 <div class="nim-sub">审阅这一层：没问题就继续，不行就写修改意见重做</div>
                 <textarea id="nim-feedback" class="nim-input nim-textarea" rows="3" placeholder="例如：第 3 段的补充太长了；这里的改写和前面冲突了"></textarea>
                 <div class="nim-row"><button id="nim-accept" class="nim-btn primary">可以，继续</button><button id="nim-reject" class="nim-btn">按意见重做这层</button></div>
               </div>`
            : '';
        el.innerHTML = `<div class="nim-detail-head"><div><div class="nim-detail-title">第 ${i + 1} 层</div><div class="nim-muted">${STATE_TEXT[layerState(r, i, e)]} · ${e.layers[i].chars} 字</div>${r && r.tokens ? `<div class="nim-muted">${esc(tokenText(r.tokens))}</div>` : ''}</div><div class="nim-row" style="justify-content:flex-end">${r && (r.status === 'done' || r.status === 'failed') ? '<button id="nim-reroll" class="nim-btn sm" title="同样的提示词再要一次，后面的层保留">只重 roll 这层</button>' : ''}<button id="nim-rerun" class="nim-btn ghost sm">从这层开始重跑</button></div></div>${hasLater ? `<label class="nim-muted nim-keep-later"><input type="checkbox" id="nim-keep-later"${State.keepLater === false ? '' : ' checked'}> 重做这层时保留后面的层（后面的世界书、表格按新结果重算）</label>` : ''}${reviewHtml}${body}`;
        bindHlNav();
        const noteEl = $('nim-layer-note');
        const saveNote = () => {
            const t = noteEl.value.trim();
            e.setLayerNote(i, t);
            saveProgress();
            renderLayers();
            toast(t ? '已保存，跑到这层时一起发给 AI' : '已删掉这层的专属提示词', 'success');
        };
        // 边打边记到层上，处理中界面刷新也不会丢字
        noteEl.addEventListener('input', () => e.setLayerNote(i, noteEl.value));
        noteEl.addEventListener('change', () => {
            saveProgress();
            renderLayers();
        });
        $('nim-layer-note-save').onclick = saveNote;
        const fbBtn = $('nim-layer-fb-go');
        if (fbBtn)
            fbBtn.onclick = async () => {
                if (e.running) return toast('正在处理中，先暂停再重做', 'warning');
                const fb = $('nim-layer-fb').value.trim();
                if (!fb) return toast('请先写修改要求', 'warning');
                const keepLater = keepLaterChecked();
                if (!keepLater && hasLater && !confirm(`第 ${i + 2} 层及之后的结果会清空，确定吗？`)) return;
                collectFields();
                State.stopped = false;
                log(`按要求重做第 ${i + 1} 层${keepLater ? '（保留后面的层）' : ''}：${fb}`);
                const job = e.redoWithFeedback(i, fb, { keepLater });
                renderButtons();
                await job;
                saveProgress();
                renderAll();
            };
        const jsonBtn = $('nim-json-go');
        if (jsonBtn)
            jsonBtn.onclick = async () => {
                if (e.running) return toast('正在处理中，先暂停再重做', 'warning');
                const extra = $('nim-json-fb').value.trim();
                const usePreset = $('nim-json-preset').checked;
                collectFields();
                // 点过停止后这个标记还留着，不清掉请求一发就会被当成已停止
                State.stopped = false;
                jsonBtn.disabled = true;
                log(`第 ${i + 1} 层只重新输出 JSON${extra ? `：${extra}` : ''}`);
                try {
                    const job = e.regenJson(i, extra, { usePreset });
                    renderButtons();
                    const nr = await job;
                    toast(nr.warnings && nr.warnings.length ? `换上了能用的部分，还有：${nr.warnings.join('；')}` : '已换上新的 JSON', nr.warnings && nr.warnings.length ? 'warning' : 'success');
                } catch (err) {
                    log(`第 ${i + 1} 层重新输出 JSON 失败：${err.message}`);
                    if (State.stopped) toast('已停止，这层结果没动', 'info');
                    else toast(`没换成：${err.message}（原始输出在下面「请求记录」里）`, 'error');
                }
                saveProgress();
                renderAll();
            };
        const reqBtn = $('nim-req-export');
        if (reqBtn)
            reqBtn.onclick = () => {
                const b = C.promptBreakdown(r.prompt, r.request);
                const head = [
                    `第 ${i + 1} 层发出去的完整消息（${(r.request || []).length} 条，共 ${b.total} 字）`,
                    '提示词构成：' + b.parts.map((x) => `${x.name} ${x.chars} 字`).join('，'),
                    b.promptCopies > 1 ? `本模块的提示词出现了 ${b.promptCopies} 次` : '',
                    b.repeats.length ? `重复出现的大段：${b.repeats.length} 段` : '',
                ].filter(Boolean);
                const body = (r.request || []).map((m, k) => `===== 第 ${k + 1} 条消息【${m.role}】${String(m.content || '').length} 字 =====\n${m.content}`).join('\n\n');
                download(head.join('\n') + '\n\n' + body, `${baseName()}-第${i + 1}层-完整消息.txt`, 'text/plain');
            };
        const redoBtn = $('nim-prompt-redo');
        if (redoBtn)
            redoBtn.onclick = async () => {
                if (e.running) return toast('正在处理中，先暂停再重做', 'warning');
                const p = $('nim-prompt-edit').value;
                if (!p.trim()) return toast('提示词是空的', 'warning');
                const keepLater = keepLaterChecked();
                if (!confirm(`用改过的提示词重做第 ${i + 1} 层？${keepLater || !hasLater ? '' : `第 ${i + 2} 层及之后的结果会清空`}`)) return;
                collectFields();
                State.stopped = false;
                log(`用改过的提示词重做第 ${i + 1} 层${keepLater ? '（保留后面的层）' : ''}`);
                const job = e.redoWithPrompt(i, p, { keepLater });
                renderButtons();
                await job;
                saveProgress();
                renderAll();
            };
        const hlBtn = $('nim-hl-toggle');
        if (hlBtn)
            hlBtn.onclick = () => {
                State.hlOff = !State.hlOff;
                renderDetail();
            };
        const keepBox = $('nim-keep-later');
        if (keepBox) keepBox.onchange = () => (State.keepLater = keepBox.checked);
        const rerollBtn = $('nim-reroll');
        if (rerollBtn)
            rerollBtn.onclick = async () => {
                if (e.running) return toast('正在处理中，先暂停再重做', 'warning');
                collectFields();
                State.stopped = false;
                log(`只重 roll 第 ${i + 1} 层，后面的层保留`);
                const job = e.rerollLayer(i, { keepLater: true });
                renderButtons();
                const res = await job;
                if (res && res.status !== 'done') toast(`第 ${i + 1} 层重 roll 失败，保留了原来的结果：${res.error || ''}`, 'error');
                else if (res) toast(`第 ${i + 1} 层已重 roll`, 'success');
                saveProgress();
                renderAll();
            };
        $('nim-rerun').onclick = () => {
            if (!confirm(`第 ${i + 1} 层及之后的结果会清空，确定吗？`)) return;
            e.resetFrom(i);
            saveProgress();
            renderAll();
        };
        if (reviewing) {
            $('nim-accept').onclick = async () => {
                e.accept();
                await start();
            };
            $('nim-reject').onclick = async () => {
                const fb = $('nim-feedback').value.trim();
                if (!fb) return toast('请先写修改意见', 'warning');
                collectFields();
                State.stopped = false;
                log(`按意见重做第 ${i + 1} 层`);
                const job = e.reject(fb);
                renderButtons();
                await job;
                saveProgress();
                renderAll();
            };
        }
    }

    function renderExport() {
        if (!$('nim-card-name')) return;
        $('nim-card-name').value = State.meta.cardName || baseName();
        $('nim-world-name').value = State.meta.worldName || State.meta.cardName || baseName();
        $('nim-card-desc').value = State.meta.description || '';
        $('nim-card-avatar').textContent = State.meta.avatar ? `已绑定角色卡 ${State.meta.avatar}，再次导入会更新这张卡并新建一个聊天` : '导入时会新建角色卡';
    }

    function readMetaInputs() {
        if (!$('nim-card-name')) return;
        State.meta.cardName = $('nim-card-name').value.trim() || baseName();
        State.meta.worldName = $('nim-world-name').value.trim() || State.meta.cardName;
        State.meta.description = $('nim-card-desc').value;
    }

    function setRes(id, ok, text) {
        const el = $(id);
        if (!el) return;
        el.textContent = text;
        el.closest('.nim-res')?.classList.toggle('ok', !!ok);
    }

    function renderInfo() {
        const e = State.engine;
        const st = e ? e.stats : null;
        const head = $('nim-info');
        if (head) head.textContent = State.fileName ? `${State.fileName} · ${fmtNum(State.text.length)} 字${e ? ` · ${e.layers.length} 层` : ''}` : '把小说一层层导入成角色卡、世界书和聊天';
        const drop = $('nim-drop-text');
        if (drop) drop.textContent = State.fileName ? `已选 ${State.fileName}，点这里换一本` : '点这里选择小说，或把文件拖进来';
        const chips = $('nim-file-stats');
        if (chips) {
            const c = [];
            if (State.fileName) c.push(['字数', fmtNum(State.text.length)]);
            if (e) c.push(['层数', e.layers.length]);
            if (st && st.chapterUnit) c.push(['标题', `第X${st.chapterUnit}`]);
            if (st) c.push(['翻译', st.translate ? '整本翻译' : '不需要']);
            if (State.images.length) c.push(['插图', `${State.images.length} 张`]);
            if (st && st.cleanedLines + st.repeatedLines + st.inlineAds) c.push(['清掉广告 ›', `${st.cleanedLines + st.repeatedLines + st.inlineAds} 处`, 'link']);
            if (st && st.emptyChapters.length) c.push(['空章 ›', `${st.emptyChapters.length} 章`, 'warn link toc']);
            chips.innerHTML = c
                .map(([k, v, cls]) => {
                    const tag = (cls || '').includes('link') ? 'button' : 'div';
                    const act = (cls || '').includes('toc') ? 'data-find-open="toc" title="看是哪几章"' : 'data-cleanlog title="查看清掉的内容"';
                    return `<${tag} class="nim-stat ${cls || ''}" ${tag === 'button' ? act : ''}><div class="nim-stat-v">${esc(v)}</div><div class="nim-stat-k">${esc(k)}</div></${tag}>`;
                })
                .join('');
        }
        renderFileExtras();
        const tpl = State.tableTemplate;
        const tplText = tpl ? `${tpl.tables.length} 张表${State.settings.tableMessageTemplate ? ' · 有消息模板' : ''}` : '还没导入';
        setRes('nim-res-tpl', tpl, tplText);
        if ($('nim-tpl-state2')) $('nim-tpl-state2').textContent = `表格模板：${tplText}`;
        const wbN = State.seedWorldbook ? Object.values(State.seedWorldbook).reduce((a, x) => a + Object.keys(x).length, 0) : 0;
        setRes('nim-res-wb', wbN, wbN ? `${wbN} 条` : '可选，从头建');
        const gNow = e ? (e.finalState().glossary || []).length : 0;
        const gSeed = (State.seedGlossary || []).length;
        const facts = currentLedgerRows();
        setRes('nim-res-ledger', facts.length, facts.length ? `${facts.length} 条${State.ledgerManual.length ? `，手动 ${State.ledgerManual.length} 条` : ''}` : '剧情改写后自动记录，也可以手动加');
        setRes('nim-res-gloss', gSeed || gNow, gNow || gSeed ? `${gSeed} 条初始${gNow > gSeed ? `，已积累到 ${gNow} 条` : ''}` : st && st.translate ? '会边翻译边积累' : '翻译外文小说时用');
    }

    /** 小说页：空章提醒和「下一步做什么」 */
    function renderFileExtras() {
        const e = State.engine;
        const st = e ? e.stats : null;
        const drop = $('nim-drop');
        if (drop) drop.classList.toggle('has-file', !!State.fileName);
        const iss = $('nim-file-issues');
        if (iss) {
            const n = st ? st.emptyChapters.length : 0;
            iss.innerHTML = n ? `<button class="nim-issue" data-find-open="toc"><span>⚠️</span><span><b>${n} 章没有正文</b><br><span class="nim-muted">原文可能被盗版站替换了，点这里看是哪几章、在哪里</span></span><span class="nim-chev r"></span></button>` : '';
        }
        const g = $('nim-guide');
        if (!g) return;
        const s = State.settings;
        const layers = e ? e.layers.length : 0;
        const done = e ? e.results.filter((r) => r && r.status === 'done').length : 0;
        const scanned = layers ? e.layers.filter((l) => PM.layerPlan(State.plan, l.index).scan).length : 0;
        const planned = layers ? e.layers.filter((l) => PM.hasRewritePlan(PM.layerPlan(State.plan, l.index))).length : 0;
        const apiOk = !!(s.apiEndpoint && s.apiModel);
        const steps = [
            [!!State.fileName, '选小说', State.fileName ? `${fmtNum(State.text.length)} 字，分成 ${layers} 层` : '点上面选 TXT 或 EPUB', ''],
            [apiOk, '填 API', apiOk ? s.apiModel : '还没填接口地址和模型', 'data-goto="nim-sec-api"'],
            [planned > 0, '剧情地图（可选）', scanned ? `已扫描 ${scanned}/${layers} 层，${planned} 层有改写安排` : '先摸清每层剧情，标出要改的地方', 'data-tab-go="map"'],
            [layers > 0 && done === layers, '开始处理', done ? `已处理 ${done}/${layers} 层` : '点底部「开始」，在「处理」页看每层结果', 'data-tab-go="run"'],
            [false, '导入酒馆', '生成角色卡、世界书和聊天', 'data-tab-go="export"'],
        ];
        g.innerHTML =
            '<div class="nim-sub nim-sec-title">步骤</div>' +
            steps
                .map(([ok, t, d, act], k) => `<${act ? 'button' : 'div'} class="nim-step ${ok ? 'ok' : ''}" ${act}><span class="nim-step-no">${ok ? '✓' : k + 1}</span><span class="nim-step-main"><b>${t}</b><span class="nim-muted">${esc(d)}</span></span>${act ? '<span class="nim-chev r"></span>' : ''}</${act ? 'button' : 'div'}>`)
                .join('');
    }

    function renderButtons() {
        const e = State.engine;
        const running = !!(e && e.running);
        const allDone = !!(e && e.layers.length && e.reviewing === null && e.results.every((r) => r && r.status === 'done'));
        $('nim-start').disabled = running || allDone;
        $('nim-start').textContent = running ? '处理中…' : allDone ? '已完成' : e && e.results.some((r) => r && r.status === 'done') ? '继续' : '开始';
        if (!running && !State.importing) setStatus('');
        $('nim-pause').disabled = !running;
        $('nim-stop').disabled = !running;
        $('nim-modal').classList.toggle('is-running', running);
        const badge = $('nim-run-badge');
        if (badge) badge.hidden = !(e && e.reviewing !== null);
    }

    function renderAll() {
        if (State.tab === 'map') renderMap();
        renderInfo();
        renderProgress();
        renderLayers();
        renderDetail();
        renderButtons();
    }

    // ============================================
    // 弹窗
    // ============================================

    function card(id, title, desc, inner, open = false) {
        return `<details class="nim-card" ${open ? 'open' : ''} id="nim-sec-${id}">
          <summary><div><div class="nim-card-title">${title}</div>${desc ? `<div class="nim-card-desc">${desc}</div>` : ''}</div><span class="nim-chev"></span></summary>
          <div class="nim-card-body">${inner}</div></details>`;
    }

    function res(id, icon, title, inner) {
        return `<div class="nim-res"><div class="nim-res-icon">${icon}</div><div class="nim-res-main"><div class="nim-res-title">${title}</div><div class="nim-res-state" id="${id}"></div></div><div class="nim-res-actions">${inner}</div></div>`;
    }

    function buildHtml() {
        const f = (k) => `<div class="nim-grid">${FIELDS[k].map(fieldHtml).join('')}</div>`;
        const tabs = [
            ['file', '1', '📖', '小说'],
            ['map', '2', '🗺️', '剧情地图'],
            ['settings', '3', '⚙️', '设置'],
            ['run', '4', '📝', '处理'],
            ['export', '5', '🎴', '导入酒馆'],
        ];
        return `
<div id="nim-modal" class="nim-overlay"><div class="nim-modal" role="dialog" aria-label="小说导入改写">
  <header class="nim-header">
    <div class="nim-brand">
      <div class="nim-logo">📥</div>
      <div class="nim-brand-text"><div class="nim-title">小说导入改写 <span class="nim-ver">v${C.VERSION}</span></div><div id="nim-info" class="nim-subtitle"></div></div>
    </div>
    <div class="nim-head-actions"><button class="nim-icon-btn" data-find-open="text" title="搜索原文、目录、功能"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button><button id="nim-close" class="nim-icon-btn" title="关闭">✕</button></div>
  </header>
  <nav class="nim-tabs">${tabs
      .map(([k, n, ic, t]) => `<button class="nim-tab ${k === State.tab ? 'active' : ''}" data-tab="${k}"><span class="nim-tab-no">${n}</span><span class="nim-tab-ico">${ic}</span><span class="nim-tab-lbl">${t}</span>${k === 'run' ? '<span id="nim-run-badge" class="nim-badge" hidden>审阅</span>' : ''}</button>`)
      .join('')}</nav>
  <main class="nim-body">

    <section class="nim-panel" data-panel="file">
      <label class="nim-drop" id="nim-drop">
        <input type="file" id="nim-file" accept=".txt,.epub" hidden>
        <div class="nim-drop-icon">📖</div>
        <div class="nim-drop-main" id="nim-drop-text"></div>
        <div class="nim-muted">TXT 或 EPUB，按 1000 万字设计；EPUB 的插图会留在原位置</div>
      </label>
      <button class="nim-searchbar" data-find-open="text"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><span>搜原文、看目录和空章、找功能</span></button>
      <div id="nim-file-issues"></div>
      <div id="nim-file-stats" class="nim-stats"></div>
      <div id="nim-guide" class="nim-guide"></div>
      <div class="nim-sub nim-sec-title">素材（可选）</div>
      <div class="nim-res-list">
        ${res('nim-res-tpl', '📊', '记忆表格模板', `<label class="nim-btn sm">导入文件<input type="file" id="nim-tpl" accept=".json" hidden></label><button id="nim-tpl-live" class="nim-btn sm">从记忆插件读取</button>`)}
        ${res('nim-res-wb', '📚', '初始世界书', `<label class="nim-btn sm">导入<input type="file" id="nim-seed-wb" accept=".json" hidden></label><button id="nim-clear-wb" class="nim-btn ghost sm">清除</button>`)}
        ${res(
            'nim-res-gloss',
            '🔤',
            '术语表',
            `<button id="nim-gloss-edit" class="nim-btn sm">查看和编辑</button><button id="nim-gloss-nt" class="nim-btn sm">从小说翻译读取</button><label class="nim-btn sm">导入<input type="file" id="nim-gloss-file" accept=".json,.txt" hidden></label><button id="nim-gloss-clear" class="nim-btn ghost sm">清除</button>`,
        )}
        ${res('nim-res-ledger', '📝', '和原文不同的事实', `<button id="nim-ledger-edit" class="nim-btn sm">查看和编辑</button>`)}
      </div>
      ${card('file', '分层与清洗', '每层字数、章节识别、广告和水印规则', `${f('layer')}<div class="nim-row"><button id="nim-prepare" class="nim-btn">按当前设置重新分层</button><button id="nim-cleanlog" class="nim-btn">查看清掉的内容</button></div>`)}
    </section>

    <section class="nim-panel" data-panel="map">
      ${mapPanelHtml()}
    </section>

    <section class="nim-panel" data-panel="settings">
      <nav class="nim-setnav">${[
          ['api', 'API'],
          ['preset', '预设'],
          ['rewrite', '改写'],
          ['translate', '翻译和标题'],
          ['alias', '主角'],
          ['wb', '世界书'],
          ['stwb', '酒馆世界书'],
          ['table', '记忆表格'],
          ['cfg', '配置'],
      ]
          .map(([id, t]) => `<button class="nim-chip" data-goto="nim-sec-${id}">${t}</button>`)
          .join('')}<button class="nim-chip" data-find-open="ui">🔍 找设置</button></nav>
      ${card(
          'api',
          'API',
          'OpenAI 兼容接口',
          `${f('api')}
           <div class="nim-row">
             <button id="nim-models" class="nim-btn sm">拉取模型列表</button>
             <select id="nim-model-list" class="nim-input nim-grow"></select>
             <button id="nim-test" class="nim-btn sm">测试</button>
           </div>`,
      )}
      ${card('preset', '酒馆预设', '导入后每个条目可以开关、拖动排序、编辑', presetHtml())}
      ${card('translate', '翻译、标题与插图', '外文整本翻译、术语表、#第X章：标题、EPUB 插图', f('translate') + '<div class="nim-row"><button id="nim-gloss-edit2" class="nim-btn sm">查看和编辑术语表</button></div>')}
      ${card('rewrite', '改写与剧情改写', '扩写比例、改写要求、送女/NTR 等改写规则、审阅', f('rewrite') + '<div class="nim-row"><button id="nim-ledger-edit2" class="nim-btn sm">查看和编辑「和原文不同的事实」</button></div>')}
      ${card('stwb', '酒馆世界书（输出要求）', '把酒馆里开着的世界书当作写作要求发给 AI', f('stwb') + stWorldsHtml())}
      ${card('alias', '主角与标签', '主角替换成 {{user}}、标题和正文标签', f('alias'))}
      ${card('wb', '世界书', '提取分类（和 TXT转世界书 一样）、额外要求', categoriesHtml() + '<div class="nim-sub">其他</div>' + f('worldbook'))}
      ${card(
          'table',
          '记忆表格',
          '导入表格模板、表格角色、消息模板、大总结',
          `<div class="nim-row nim-tpl-row"><span id="nim-tpl-state2" class="nim-muted nim-grow"></span><label class="nim-btn sm">导入表格模板<input type="file" id="nim-tpl2" accept=".json" hidden></label><button id="nim-tpl-live2" class="nim-btn sm">从记忆插件读取</button></div>${f('table')}`,
      )}
      ${card(
          'cfg',
          '配置与任务',
          '导入导出配置和任务进度',
          `<div class="nim-row">
             <button id="nim-cfg-export" class="nim-btn sm">导出配置</button>
             <label class="nim-btn sm">导入配置<input type="file" id="nim-cfg-import" accept=".json" hidden></label>
             <button id="nim-cfg-reset" class="nim-btn ghost sm">恢复默认提示词</button>
           </div>
           <div class="nim-row">
             <button id="nim-task-export" class="nim-btn sm">导出任务进度</button>
             <label class="nim-btn sm">导入任务进度<input type="file" id="nim-task-import" accept=".json" hidden></label>
             <button id="nim-preview" class="nim-btn sm">预览当前层提示词</button>
           </div>`,
      )}
    </section>

    <section class="nim-panel" data-panel="run">
      <div class="nim-runbox">
        <div class="nim-split">
          <div class="nim-col"><div class="nim-col-head">分层</div><div id="nim-layers" class="nim-layers"></div></div>
          <div class="nim-col nim-col-wide"><button id="nim-detail-back" class="nim-back">‹ 返回分层列表</button><div id="nim-detail" class="nim-detail"></div></div>
        </div>
        <details class="nim-fold" id="nim-stream-box"><summary>实时输出</summary><pre id="nim-stream" class="nim-pre"></pre></details>
        <details class="nim-fold" open><summary>日志</summary><pre id="nim-log" class="nim-pre nim-log"></pre></details>
      </div>
    </section>

    <section class="nim-panel" data-panel="export" id="nim-sec-export">
      <div class="nim-card static"><div class="nim-card-body">
        <div class="nim-grid">
          <div class="nim-field"><label>角色卡名</label><input id="nim-card-name" class="nim-input"></div>
          <div class="nim-field"><label>世界书名</label><input id="nim-world-name" class="nim-input"></div>
        </div>
        <div class="nim-field"><label>角色卡简介 <button id="nim-gen-desc" class="nim-btn ghost xs">AI 生成</button></label><textarea id="nim-card-desc" class="nim-input nim-textarea" rows="5"></textarea></div>
        <div id="nim-card-avatar" class="nim-muted"></div>
        <button id="nim-import" class="nim-btn primary block">一键导入酒馆</button>
        <div id="nim-import-result" class="nim-alert" hidden></div>
        <div class="nim-muted nim-center">角色卡 + 世界书 + 聊天楼层 + 插图，然后让记忆插件逐层重建表格并核对</div>
      </div></div>
      <div class="nim-card static"><div class="nim-card-body">
        <div class="nim-sub">其他操作</div>
        <div class="nim-row">
          <button id="nim-rebuild" class="nim-btn sm">只在当前聊天重建表格</button>
          <button id="nim-persona" class="nim-btn sm">主角人设写入当前用户人设</button>
        </div>
        <div class="nim-sub">下载</div>
        <div class="nim-dl">
          <button class="nim-btn sm" data-export="chat">聊天 JSONL</button>
          <button class="nim-btn sm" data-export="world">世界书</button>
          <button class="nim-btn sm" data-export="card">角色卡 JSON</button>
          <button class="nim-btn sm" data-export="persona">用户人设</button>
          <button class="nim-btn sm" data-export="tables">表格</button>
          <button class="nim-btn sm" data-export="glossary">术语表</button>
          <button class="nim-btn sm" data-export="txt">改写后的 TXT</button>
        </div>
      </div></div>
    </section>
  </main>
  <footer class="nim-footer">
    <div class="nim-foot-info">
      <div class="nim-foot-line"><span id="nim-progress"></span><span id="nim-status" class="nim-status"></span></div>
      <div class="nim-bar"><div id="nim-progress-bar" class="nim-bar-fill"></div></div>
      <div class="nim-foot-line nim-foot-sub nim-muted"><span id="nim-last-log" class="nim-ellipsis"></span><span id="nim-tokens"></span></div>
    </div>
    <div class="nim-foot-actions">
      <button id="nim-start" class="nim-btn primary">开始</button>
      <button id="nim-pause" class="nim-btn" title="当前这层写完后停下，让你审阅" aria-label="这层写完后暂停"><span class="nim-ico"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></span><span class="nim-lbl">这层后暂停</span></button>
      <button id="nim-stop" class="nim-btn danger-ghost" title="停止" aria-label="停止"><span class="nim-ico"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></span><span class="nim-lbl">停止</span></button>
    </div>
  </footer>
  ${presetEditHtml()}
  ${catEditHtml()}
  ${cleanLogHtml()}
  ${replacePreviewHtml()}
  ${glossaryHtml()}
  ${ledgerHtml()}
  ${findSheetHtml()}
  ${sourceSheetHtml()}
</div></div>`;
    }

    const STYLE = `
/* 手机版酒馆会改写弹窗的尺寸，inset:0 在手机上高度会变成 0，所以写死宽高并加 !important */
.nim-overlay{position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important;height:100dvh !important;max-height:none !important;display:flex !important;align-items:center;justify-content:center;background:rgba(8,8,14,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:99999 !important;box-sizing:border-box;padding:24px;}
.nim-modal{--bg:#15161c;--surface:#1c1d25;--surface2:#242530;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--text:#ececf2;--muted:#9496a8;--accent:#8b7cf6;--accent2:#6aa8ff;--ok:#3ccf91;--warn:#f2b441;--bad:#f06464;
  position:relative;display:flex;flex-direction:column;width:min(1080px,100%);height:min(900px,100%);background:var(--bg);color:var(--text);border:1px solid var(--line2);border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;overflow:clip;font-size:14px;line-height:1.5;text-align:left;}
.nim-modal *{box-sizing:border-box;}
.nim-modal{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
.nim-head-actions{display:flex;gap:8px;flex:none;}
.nim-icon-btn{display:inline-grid;place-items:center;}
/* 搜索入口 */
.nim-searchbar{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border-radius:14px;border:1px solid var(--line2);background:var(--surface);color:var(--muted);font:inherit;font-size:14px;cursor:pointer;text-align:left;}
.nim-searchbar:hover{border-color:var(--accent);color:var(--text);}
.nim-search-in{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:0 12px;border-radius:12px;background:var(--bg);border:1px solid var(--line2);color:var(--muted);}
.nim-search-in:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,124,246,.22);}
.nim-search-in input{flex:1;min-width:0;border:0;background:transparent;color:var(--text);font:inherit;font-size:15px;padding:10px 0;outline:none;}
.nim-sec-title{margin:6px 2px 0 !important;font-size:12px;letter-spacing:.5px;}
/* 小说页：空章提醒、步骤 */
.nim-issue{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border-radius:14px;border:1px solid rgba(242,180,65,.4);background:rgba(242,180,65,.10);color:var(--text);font:inherit;font-size:14px;text-align:left;cursor:pointer;}
.nim-issue>span:nth-child(2){flex:1;min-width:0;}
.nim-guide{display:flex;flex-direction:column;gap:6px;}
.nim-guide:empty{display:none;}
.nim-step{display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;border-radius:14px;border:1px solid var(--line);background:var(--surface);color:var(--text);font:inherit;text-align:left;}
button.nim-step{cursor:pointer;}
button.nim-step:hover{border-color:var(--line2);background:var(--surface2);}
.nim-step-no{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:var(--surface2);color:var(--muted);}
.nim-step.ok .nim-step-no{background:rgba(60,207,145,.18);color:var(--ok);}
.nim-step-main{flex:1;min-width:0;display:flex;flex-direction:column;}
.nim-step-main b{font-size:14px;font-weight:600;}
.nim-step-main .nim-muted{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nim-chev.r{transform:rotate(-45deg);}
.nim-drop.has-file{flex-direction:row;justify-content:flex-start;gap:12px;padding:12px 14px;border-style:solid;border-width:1px;text-align:left;}
.nim-drop.has-file .nim-drop-icon{font-size:22px;}
.nim-drop.has-file .nim-drop-main{font-size:14px;}
.nim-drop.has-file .nim-muted{display:none;}
/* 设置页目录 */
.nim-setnav{position:sticky;top:-16px;z-index:5;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:-16px -18px 0;padding:12px 18px 10px;background:var(--bg);border-bottom:1px solid var(--line);}
.nim-setnav::-webkit-scrollbar{display:none;}
.nim-setnav .nim-chip{flex:none;}
.nim-flash{animation:nimFlash 1.8s ease-out;}
.nim-card,.nim-res,.nim-field,.nim-check{scroll-margin-top:64px;}
.nim-field>.nim-hint{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5;}
.nim-stats{display:flex !important;gap:8px;overflow-x:auto;scrollbar-width:none;}
.nim-stats::-webkit-scrollbar{display:none;}
.nim-stats .nim-stat{flex:none;min-width:84px;padding:8px 12px;}
.nim-stats .nim-stat-v{font-size:15px;}
@keyframes nimFlash{0%,40%{box-shadow:0 0 0 3px var(--accent);}100%{box-shadow:0 0 0 3px transparent;}}
/* 搜索面板 */
.nim-findbox{height:min(760px,100%);}
.nim-find-head{gap:10px;}
.nim-seg{display:flex;gap:4px;margin:10px 16px 0;padding:4px;border-radius:12px;background:var(--surface);border:1px solid var(--line);}
.nim-seg button{flex:1;padding:8px 6px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer;}
.nim-seg button.on{background:var(--surface2);color:var(--text);box-shadow:0 1px 0 rgba(255,255,255,.06) inset;}
.nim-find-body{gap:6px;}
.nim-find-sum{font-size:12px;color:var(--muted);padding:2px 2px 4px;}
.nim-find-group{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}
.nim-find-gtitle{font-size:12px;font-weight:700;color:var(--accent2);padding:4px 2px 0;}
.nim-hit{display:flex;flex-direction:column;gap:3px;width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--text);font:inherit;text-align:left;cursor:pointer;}
.nim-hit:hover{border-color:var(--line2);background:var(--surface2);}
.nim-hit.warn{border-color:rgba(242,180,65,.35);}
.nim-hit-where{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--muted);}
.nim-hit-where b{color:var(--text);font-size:13px;}
.nim-hit-text{font-size:13px;line-height:1.6;word-break:break-word;}
.nim-toc{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);font:inherit;font-size:14px;text-align:left;cursor:pointer;}
.nim-toc:hover{background:var(--surface);}
.nim-toc-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nim-toc .nim-muted{flex:none;}
/* 原文阅读 */
.nim-reader{height:min(820px,100%);}
.nim-reader-title{min-width:0;flex:1;}
.nim-reader-bar{display:flex;align-items:center;gap:6px;padding:10px 16px;border-bottom:1px solid var(--line);}
.nim-src-count{flex:none;min-width:3.5em;text-align:center;font-variant-numeric:tabular-nums;}
.nim-src-body{flex:1;min-height:0;overflow-y:auto;padding:14px 18px 24px;font-size:16px;line-height:1.9;position:relative;}
.nim-src-body p{margin:0 0 .7em;text-indent:2em;}
.nim-src-chap{margin:1.2em 0 .6em;font-size:17px;font-weight:700;text-indent:0;color:var(--accent2);}
.nim-src-chap:first-child{margin-top:0;}
#nim-src-nav{justify-content:space-between;}
#nim-src-nav[hidden]{display:none;}
.nim-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(139,124,246,.10),transparent);}
.nim-brand{display:flex;align-items:center;gap:12px;min-width:0;}
.nim-logo{width:38px;height:38px;flex:none;border-radius:11px;display:grid;place-items:center;font-size:20px;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 18px rgba(139,124,246,.35);}
.nim-brand-text{min-width:0;}
.nim-title{font-size:16px;font-weight:650;letter-spacing:.2px;}
.nim-ver{font-size:11px;font-weight:500;color:var(--muted);margin-left:4px;}
.nim-subtitle{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nim-icon-btn{flex:none;width:34px;height:34px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--muted);font-size:15px;cursor:pointer;}
.nim-icon-btn:hover{background:var(--surface2);color:var(--text);}
.nim-tabs{display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none;}
.nim-tabs::-webkit-scrollbar{display:none;}
.nim-tab{flex:none;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--muted);font-size:13px;font-weight:550;cursor:pointer;white-space:nowrap;}
.nim-tab:hover{color:var(--text);background:var(--surface);}
.nim-tab.active{color:var(--text);background:var(--surface2);border-color:var(--line2);}
.nim-tab-ico,.nim-ico,.nim-back{display:none;}
.nim-header{order:0;}.nim-tabs{order:1;}.nim-body{order:2;}.nim-footer{order:3;}
.nim-tab-no{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:var(--surface2);color:var(--muted);}
.nim-tab.active .nim-tab-no{background:var(--accent);color:#fff;}
.nim-badge{font-size:10px;padding:1px 7px;border-radius:999px;background:var(--warn);color:#1b1404;}
.nim-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 18px 20px;}
.nim-panel{display:none;flex-direction:column;gap:14px;}
.nim-panel.active{display:flex;}
.nim-muted{color:var(--muted);font-size:12px;}
.nim-center{text-align:center;margin-top:8px;}
.nim-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nim-empty{padding:28px 12px;text-align:center;color:var(--muted);font-size:13px;}
/* 选文件 */
.nim-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:28px 16px;border:1.5px dashed var(--line2);border-radius:16px;background:var(--surface);cursor:pointer;text-align:center;transition:border-color .15s,background .15s;}
.nim-drop:hover,.nim-drop.over{border-color:var(--accent);background:rgba(139,124,246,.08);}
.nim-drop-icon{font-size:30px;}
.nim-drop-main{font-size:15px;font-weight:600;}
.nim-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;}
.nim-stats:empty{display:none;}
.nim-stat{padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--line);}
.nim-stat-v{font-size:16px;font-weight:650;}
.nim-stat-k{font-size:11px;color:var(--muted);}
.nim-stat.warn .nim-stat-v{color:var(--warn);}
button.nim-stat{font:inherit;color:inherit;text-align:left;cursor:pointer;}
button.nim-stat .nim-stat-k{color:var(--accent2);}
.nim-res-list{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden;}
.nim-res{display:flex;align-items:center;gap:12px;padding:12px 14px;flex-wrap:wrap;}
.nim-res+.nim-res{border-top:1px solid var(--line);}
.nim-res-icon{width:34px;height:34px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--surface2);}
.nim-res-main{flex:1 1 140px;min-width:0;}
.nim-res-title{font-weight:600;font-size:13px;}
.nim-res-state{font-size:12px;color:var(--muted);}
.nim-res.ok .nim-res-state{color:var(--ok);}
.nim-res-actions{display:flex;gap:6px;flex-wrap:wrap;}
/* 卡片 */
.nim-card{border:1px solid var(--line);border-radius:14px;background:var(--surface);}
.nim-card>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;cursor:pointer;}
.nim-card>summary::-webkit-details-marker{display:none;}
.nim-card-title{font-weight:600;}
.nim-card-desc{font-size:12px;color:var(--muted);}
.nim-chev{flex:none;width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg);transition:transform .2s;margin-right:4px;}
.nim-card[open]>summary .nim-chev{transform:rotate(225deg);}
.nim-card[open]>summary{border-bottom:1px solid var(--line);}
.nim-card-body{padding:14px 16px 16px;}
.nim-card.static .nim-card-body{display:flex;flex-direction:column;gap:10px;}
.nim-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;}
.nim-field{min-width:0;}
.nim-field.wide{grid-column:1/-1;}
.nim-field>label{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;font-weight:550;color:var(--muted);margin-bottom:5px;}
.nim-hint{font-weight:400;opacity:.8;}
.nim-input{width:100%;background:var(--bg);border:1px solid var(--line2);border-radius:10px;color:var(--text);padding:9px 11px;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s;font-family:inherit;}
.nim-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,124,246,.22);}
select.nim-input{appearance:auto;}
.nim-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;resize:vertical;line-height:1.55;}
.nim-bad{border-color:var(--bad) !important;}
.nim-grow{flex:1 1 160px;width:auto;}
/* 开关 */
.nim-check{grid-column:1/-1;position:relative;display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;user-select:none;}
.nim-check input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none;}
.nim-switch{flex:none;position:relative;width:38px;height:22px;border-radius:999px;background:var(--surface2);border:1px solid var(--line2);transition:background .15s;}
.nim-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#cfd0dc;transition:transform .15s;}
.nim-check input:checked+.nim-switch{background:var(--accent);border-color:transparent;}
.nim-check input:checked+.nim-switch::after{transform:translateX(16px);background:#fff;}
.nim-check input:focus-visible+.nim-switch{box-shadow:0 0 0 3px rgba(139,124,246,.3);}
.nim-check .nim-hint{display:block;font-size:11px;color:var(--muted);}
/* 按钮 */
.nim-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;}
.nim-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px;border-radius:10px;border:1px solid var(--line2);background:var(--surface2);color:var(--text);font-size:13px;font-weight:550;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s;font-family:inherit;}
.nim-btn:hover{border-color:var(--accent);}
.nim-btn:disabled{opacity:.4;cursor:not-allowed;border-color:var(--line2);}
.nim-btn.sm{padding:6px 12px;font-size:12px;border-radius:9px;}
.nim-btn.xs{padding:2px 8px;font-size:11px;border-radius:7px;}
.nim-btn.ghost{background:transparent;}
.nim-btn.primary{background:linear-gradient(135deg,var(--accent),#6f62e8);border-color:transparent;color:#fff;box-shadow:0 6px 16px rgba(139,124,246,.3);}
.nim-btn.primary:hover{filter:brightness(1.08);}
.nim-btn.danger-ghost{background:transparent;color:var(--bad);border-color:rgba(240,100,100,.35);}
.nim-btn.block{width:100%;padding:13px;font-size:15px;margin-top:4px;}
.nim-dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;}
.nim-sub{font-size:12px;font-weight:650;color:var(--muted);margin:12px 0 6px;text-transform:none;}
.nim-card.static .nim-sub:first-child{margin-top:0;}
/* 处理 */
.nim-split{display:grid;grid-template-columns:minmax(260px,1fr) 2fr;gap:14px;min-height:0;}
.nim-col{min-width:0;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden;}
.nim-col-head{padding:10px 14px;font-size:12px;font-weight:650;color:var(--muted);border-bottom:1px solid var(--line);}
.nim-layers{max-height:520px;overflow-y:auto;padding:6px;}
.nim-layer{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:transparent;color:var(--text);font-size:13px;text-align:left;cursor:pointer;font-family:inherit;}
.nim-layer:hover{background:var(--surface2);}
.nim-layer.sel{background:rgba(139,124,246,.16);box-shadow:inset 0 0 0 1px rgba(139,124,246,.45);}
.nim-layer-no{flex:none;min-width:28px;font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;}
.nim-layer-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nim-layer-meta{flex:none;display:flex;gap:4px;align-items:center;}
.nim-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--line2);}
.nim-dot.done{background:var(--ok);}.nim-dot.running{background:var(--accent2);animation:nimPulse 1s infinite;}.nim-dot.failed{background:var(--bad);}.nim-dot.review{background:var(--warn);}
@keyframes nimPulse{50%{opacity:.35;}}
.nim-more{padding:6px 10px;font-size:11px;color:var(--muted);text-align:center;}
.nim-tag{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--surface2);color:var(--muted);white-space:nowrap;}
.nim-tag.red{background:rgba(240,100,100,.18);color:#ff9a9a;}.nim-tag.orange{background:rgba(242,180,65,.18);color:#ffcf75;}.nim-tag.blue{background:rgba(106,168,255,.18);color:#9cc5ff;}.nim-tag.violet{background:rgba(139,124,246,.18);color:#bdb3ff;}
.nim-detail{padding:14px;max-height:620px;overflow-y:auto;}
.nim-detail-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;}
.nim-detail-title{font-size:15px;font-weight:650;}
.nim-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;background:var(--bg);border:1px solid var(--line);padding:10px 12px;border-radius:10px;max-height:340px;overflow-y:auto;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.nim-stwb-book{border-bottom:1px solid var(--line);padding:4px 0;}
.nim-stwb-entry{padding-left:12px;}
.nim-hl{background:rgba(242,180,65,.35);color:inherit;border-radius:3px;padding:0 1px;}
.nim-hl.cur{background:rgba(242,140,40,.75);outline:2px solid rgba(242,140,40,.9);}
.nim-hl-nav{align-items:center;justify-content:space-between;margin:4px 0;}
.nim-hl-nav[hidden]{display:none;}
.nim-log{max-height:200px;}
.nim-fold{margin-top:10px;}
.nim-fold>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--muted);padding:4px 0;}
.nim-runbox .nim-fold{border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:8px 12px;}
.nim-alert{padding:9px 12px;border-radius:10px;font-size:12px;margin:6px 0;}
.nim-alert.warn{background:rgba(242,180,65,.12);border:1px solid rgba(242,180,65,.3);}
.nim-alert.danger{background:rgba(240,100,100,.12);border:1px solid rgba(240,100,100,.3);}
.nim-alert.ok{background:rgba(80,200,120,.12);border:1px solid rgba(80,200,120,.3);}
.nim-alert:not(.ok):not(.warn):not(.danger){background:var(--surface2);border:1px solid var(--line);}
.nim-review{border:1px solid rgba(242,180,65,.45);background:rgba(242,180,65,.06);border-radius:12px;padding:12px;margin:8px 0;}
.nim-review .nim-sub{margin-top:0;}
/* 底栏 */
.nim-footer{display:flex;align-items:center;gap:16px;padding:12px 18px;border-top:1px solid var(--line);background:var(--surface);}
.nim-foot-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;}
.nim-foot-line{display:flex;justify-content:space-between;gap:10px;font-size:12px;min-width:0;}
.nim-status{color:var(--accent2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nim-bar{height:6px;border-radius:999px;background:var(--surface2);overflow:hidden;}
.nim-bar-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .3s;}
.is-running .nim-bar-fill{background-size:200% 100%;animation:nimFlow 1.6s linear infinite;background-image:linear-gradient(90deg,var(--accent),var(--accent2),var(--accent));}
@keyframes nimFlow{to{background-position:-200% 0;}}
.nim-foot-actions{flex:none;display:flex;gap:8px;}
/* 条目列表（预设、世界书分类） */
.nim-pr-bar{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.nim-pr-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nim-pr-list{list-style:none;margin:10px 0;padding:0;display:flex;flex-direction:column;gap:6px;}
.nim-pr{display:flex;align-items:center;gap:8px;padding:4px 8px 4px 4px;border:1px solid var(--line);border-radius:12px;background:var(--surface2);min-height:48px;}
.nim-pr.is-slot{border-color:rgba(139,124,246,.6);background:rgba(139,124,246,.12);}
.nim-pr.is-off .nim-pr-open{opacity:.5;}
.nim-pr.is-dragging{border-color:var(--accent);box-shadow:0 4px 14px rgba(0,0,0,.35);}
.nim-pr.is-picked{border-color:var(--bad);}
.nim-pr.is-picked .nim-pr-open{opacity:1;}
.nim-pr-handle{flex:none;width:36px;height:40px;display:inline-flex;align-items:center;justify-content:center;color:var(--muted);cursor:grab;touch-action:none;user-select:none;}
.nim-pr.is-dragging .nim-pr-handle{cursor:grabbing;color:var(--accent);}
.nim-pr-pin{flex:none;width:38px;text-align:center;}
.nim-pr-toggle{flex:none;position:relative;display:inline-flex;align-items:center;cursor:pointer;}
.nim-pr-toggle input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none;}
.nim-pr-toggle input:checked+.nim-switch{background:var(--accent);border-color:transparent;}
.nim-pr-toggle input:checked+.nim-switch::after{transform:translateX(16px);background:#fff;}
.nim-pr-check{flex:none;width:20px;height:20px;margin:0 9px;accent-color:var(--bad);}
.nim-pr-open{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:8px 0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;font-family:inherit;}
.nim-pr-open:disabled{cursor:default;}
.nim-pr-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;}
.nim-pr-tag{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;color:var(--muted);border:1px solid var(--line2);}
.nim-pr-tag.is-depth{color:#bdb3ff;border-color:rgba(139,124,246,.6);}
.nim-chev.up{transform:rotate(225deg);}
.nim-icon-btn.sm{width:34px;height:34px;font-size:13px;}
.nim-icon-btn:disabled{opacity:.3;cursor:not-allowed;}
/* 编辑弹层：电脑上居中，手机上从底部弹出 */
/* 用 fixed 而不是 absolute：弹窗本身 overflow:hidden，输入框聚焦时会把它整体卷上去 */
.nim-sheet{position:fixed;top:0;left:0;width:100vw;height:100vh;height:100dvh;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(8,8,14,.6);padding:20px;}
.nim-sheet[hidden]{display:none;}
.nim-gl-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}
.nim-gl-row{display:grid;grid-template-columns:1fr auto 1fr auto;gap:6px;align-items:center;padding:8px;border-radius:10px;background:var(--surface);border:1px solid var(--line);}
.nim-gl-row .nim-gl-note{grid-column:1/-1;font-size:12px;}
.nim-lg-row{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:10px;background:var(--surface);border:1px solid var(--line);}
.nim-lg-row textarea{resize:vertical;min-height:2.6em;}
.nim-lg-from{width:4.5em;}
.nim-chip{padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--muted);font-size:12px;cursor:pointer;}
.nim-chip.on{background:var(--accent);border-color:var(--accent);color:#fff;}
.nim-map{display:flex;flex-direction:column;gap:10px;margin-top:12px;}
.nim-map-summary{font-size:13px;color:var(--muted);}
.nim-vol-cards{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scroll-snap-type:x mandatory;}
.nim-vol-card{flex:none;width:200px;scroll-snap-align:start;display:flex;flex-direction:column;gap:4px;text-align:left;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--text);cursor:pointer;}
.nim-vol-card.on{border-color:var(--accent);}
.nim-vol-lines{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.nim-map-filters{margin-top:0;}
.nim-map-char{width:auto;min-width:8em;}
.nim-map-vol{border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden;}
.nim-map-volhead{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:baseline;width:100%;padding:10px 12px;cursor:pointer;color:var(--text);}
.nim-map-list{list-style:none;margin:0;padding:0;}
.nim-map-row{border-top:1px solid var(--line);}
.nim-map-row.open{background:var(--bg);}
.nim-map-head{all:unset;box-sizing:border-box;display:grid;grid-template-columns:2.6em 1fr;gap:8px;width:100%;padding:9px 12px;cursor:pointer;color:var(--text);}
.nim-map-no{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600;}
.nim-map-main{display:flex;flex-direction:column;gap:4px;min-width:0;}
.nim-map-title{font-size:13px;}
.nim-map-chips{display:flex;flex-wrap:wrap;gap:4px;}
.nim-map-detail{padding:4px 12px 14px;display:flex;flex-direction:column;gap:8px;font-size:13px;}
.nim-map-detail .nim-row{margin-top:0;}
.nim-map-tpl{width:auto;max-width:60%;margin-left:6px;font-size:12px;padding:2px 6px;}
.nim-map-outline{padding:8px;border-radius:10px;border:1px solid var(--line);display:flex;flex-direction:column;gap:4px;}
.nim-map-sugg{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}
.nim-map-sugg li{padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--surface);font-size:13px;}
.nim-map-num{width:5em;}
.nim-heat-wrap{overflow-x:auto;}
.nim-heat{border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums;}
.nim-heat th{padding:3px 6px;color:var(--muted);font-weight:500;white-space:nowrap;text-align:left;}
.nim-heat td{min-width:26px;padding:3px 4px;text-align:center;background:rgba(106,168,255,calc(var(--h) * .75));color:var(--text);border:1px solid var(--line);}
.nim-gl-arrow{color:var(--muted);}
.nim-gl-pager{justify-content:center;align-items:center;}
.nim-wb-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;}
.nim-wb-list li{padding:8px 10px;border-radius:10px;background:var(--surface2);font-size:13px;word-break:break-word;}
.nim-wb-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px;}
.nim-wb-content{white-space:pre-wrap;margin-top:4px;}
.nim-cl-group{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:0 12px;}
.nim-cl-group>summary{display:flex;justify-content:space-between;gap:8px;padding:12px 0;cursor:pointer;font-weight:600;font-size:13px;list-style:none;}
.nim-cl-group>summary::-webkit-details-marker{display:none;}
.nim-cl-group[disabled]>summary{color:var(--muted);cursor:default;}
.nim-cl-list{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:8px;}
.nim-cl-list li{padding:8px 10px;border-radius:8px;background:var(--surface2);font-size:13px;word-break:break-all;}
.nim-cl-chap{font-size:11px;color:var(--accent2);margin-bottom:2px;}
.nim-cl-line{display:flex;align-items:flex-start;gap:8px;justify-content:space-between;}
.nim-cl-line>div{flex:1;min-width:0;}
.nim-cl-line+.nim-cl-line{margin-top:6px;}
.nim-cl-line .nim-btn{flex:none;}
.nim-cl-line .nim-btn.is-on{background:var(--ok);border-color:transparent;color:#0b1a12;}
.nim-cl-prev{font-size:12px;color:var(--muted);}
.nim-bd{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0;}
.nim-bd th,.nim-bd td{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;}
.nim-bd .nim-num{text-align:right;white-space:nowrap;}
.nim-keep-later{display:flex;align-items:center;gap:6px;margin:6px 0;font-size:12px;}
.nim-cl-mark{background:rgba(240,100,100,.25);color:var(--text);border-radius:3px;padding:0 2px;}
.nim-wr-to{background:rgba(80,200,120,.25);color:var(--text);border-radius:3px;padding:0 2px;margin-left:2px;text-decoration:none;}
.nim-sheet-box{width:min(620px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line2);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);}
.nim-sheet-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);}
.nim-sheet-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;}
.nim-sheet-foot{display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid var(--line);}
.nim-grow-sp{flex:1;}
/* 手机：导航放到底部拇指够得着的地方，底栏压成一行，分层列表和详情分两屏 */
@media (max-width:760px){
  .nim-overlay{padding:0;align-items:stretch;}
  .nim-modal{width:100%;height:100%;border-radius:0;border:0;font-size:15px;}
  .nim-header{padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top));}
  .nim-logo{width:34px;height:34px;font-size:18px;}
  .nim-icon-btn{width:40px;height:40px;}
  .nim-tabs{order:4;display:grid;grid-template-columns:repeat(5,1fr);gap:0;padding:4px;padding-bottom:max(4px,env(safe-area-inset-bottom));border-top:1px solid var(--line);border-bottom:0;background:var(--surface);overflow:visible;}
  .nim-tab{position:relative;flex-direction:column;gap:2px;padding:6px 2px;border-radius:12px;font-size:11px;min-height:52px;justify-content:center;}
  .nim-tab.active{background:rgba(139,124,246,.14);border-color:transparent;color:var(--text);}
  .nim-tab-no{display:none;}
  .nim-tab-ico{display:block;font-size:19px;line-height:1;}
  .nim-badge{position:absolute;top:2px;right:8px;}
  .nim-body{padding:12px;}
  .nim-grid{grid-template-columns:1fr;}
  .nim-card>summary{padding:14px;min-height:56px;}
  .nim-card-body{padding:12px 14px 16px;}
  .nim-footer{gap:10px;padding:8px 12px;}
  .nim-foot-sub{display:none;}
  .nim-foot-actions .nim-btn{min-height:42px;}
  #nim-start{min-width:86px;}
  .nim-foot-actions .nim-lbl{display:none;}
  .nim-foot-actions .nim-ico{display:inline-flex;}
  #nim-pause,#nim-stop{width:44px;padding:0;}
  .nim-btn{min-height:42px;}
  .nim-btn.sm{min-height:40px;font-size:13px;}
  .nim-btn.xs{min-height:28px;}
  .nim-input{font-size:16px;padding:11px 12px;}
  .nim-res-actions{width:100%;}
  .nim-res-actions .nim-btn{flex:1;}
  .nim-row .nim-btn{flex:1 1 auto;}
  .nim-split{grid-template-columns:1fr;}
  .nim-layers{max-height:none;padding:4px;}
  .nim-layer{min-height:50px;padding:10px;}
  .nim-col-wide{display:none;}
  .nim-runbox.detail-open .nim-col:not(.nim-col-wide),.nim-runbox.detail-open>.nim-fold{display:none;}
  .nim-runbox.detail-open .nim-col-wide{display:flex;}
  .nim-back{display:block;width:100%;padding:13px 14px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--accent2);font-size:14px;text-align:left;cursor:pointer;font-family:inherit;}
  .nim-detail{max-height:none;}
  .nim-pre{max-height:50vh;}
  .nim-dl{grid-template-columns:1fr 1fr;}
  .nim-sheet{padding:0;align-items:flex-end;}
  .nim-sheet-box{width:100%;max-height:92%;border-radius:18px 18px 0 0;border-bottom:0;}
  .nim-sheet-foot{padding-bottom:max(12px,env(safe-area-inset-bottom));}
  .nim-sheet-foot .nim-btn{flex:1;}
  .nim-sheet-foot .nim-grow-sp{display:none;}
}
`;

    function bind() {
        const on = (id, ev, fn) => {
            const el = $(id);
            if (el) el.addEventListener(ev, fn);
        };
        const onFile = (id, fn) =>
            on(id, 'change', (ev) => {
                const file = ev.target.files && ev.target.files[0];
                ev.target.value = '';
                if (file) fn(file);
            });
        on('nim-close', 'click', close);
        bindPreset();
        bindCategories();
        bindStWorlds();
        renderStWorlds();
        onFile('nim-preset-file', onPresetFile);
        $('nim-pe').addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-pe]');
            if (!b) return;
            if (b.dataset.pe === 'save') closePresetEdit(true);
            else if (b.dataset.pe === 'remove') {
                if (confirm('删除这个条目？')) removePresetEditing();
            } else closePresetEdit(false);
        });
        on('nim-pe-pos', 'change', () => ($('nim-pe-depthrow').hidden = $('nim-pe-pos').value !== 'depth'));
        on('nim-detail-back', 'click', () => openDetail(false));
        document.querySelectorAll('#nim-modal .nim-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
        onFile('nim-file', onNovelFile);
        const drop = $('nim-drop');
        ['dragenter', 'dragover'].forEach((t) =>
            drop.addEventListener(t, (ev) => {
                ev.preventDefault();
                drop.classList.add('over');
            }),
        );
        ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
        drop.addEventListener('drop', (ev) => {
            ev.preventDefault();
            const file = ev.dataTransfer && ev.dataTransfer.files[0];
            if (file) onNovelFile(file);
        });
        onFile('nim-tpl', onTemplateFile);
        onFile('nim-tpl2', onTemplateFile);
        onFile('nim-seed-wb', onWorldbookFile);
        onFile('nim-gloss-file', onGlossaryFile);
        onFile('nim-cfg-import', importConfig);
        onFile('nim-task-import', importTask);
        on('nim-prepare', 'click', prepareLayers);
        on('nim-cleanlog', 'click', openCleanLog);
        $('nim-file-stats').addEventListener('click', (ev) => {
            if (ev.target.closest('[data-cleanlog]')) openCleanLog();
        });
        $('nim-cl').addEventListener('click', async (ev) => {
            const keep = ev.target.closest('[data-keep]');
            if (keep) {
                const text = clUi.items[Number(keep.dataset.keep)];
                toggleCleanKeep(text);
                // 同一段可能在几个地方出现（例如连带删掉的那行），按钮一起更新
                $('nim-cl-body')
                    .querySelectorAll('[data-keep]')
                    .forEach((b) => {
                        const on = isCleanKept(clUi.items[Number(b.dataset.keep)]);
                        b.classList.toggle('is-on', on);
                        b.textContent = on ? '已保留' : '保留';
                    });
                renderCleanFoot();
            } else if (ev.target.closest('[data-cl="relayer"]')) {
                $('nim-cl').hidden = true;
                clUi.changed = false;
                await prepareLayers();
            } else if (ev.target === $('nim-cl') || ev.target.closest('[data-cl="close"]')) $('nim-cl').hidden = true;
        });
        on('nim-tpl-live', 'click', templateFromPlugin);
        on('nim-tpl-live2', 'click', templateFromPlugin);
        on('nim-gloss-nt', 'click', glossaryFromTranslator);
        on('nim-gloss-edit', 'click', openGlossary);
        on('nim-gloss-edit2', 'click', openGlossary);
        bindGlossaryEdit();
        on('nim-ledger-edit', 'click', openLedger);
        on('nim-ledger-edit2', 'click', openLedger);
        bindLedgerEdit();
        bindMap();
        bindSource();
        bindFind();
        // 各处的「去某个设置」「打开搜索」「去某一页」
        $('nim-modal').addEventListener('click', (ev) => {
            const go = ev.target.closest('[data-goto]');
            if (go) {
                const el = $(go.dataset.goto);
                const panel = el && el.closest('.nim-panel');
                if (el && panel) goToEl(el, panel.dataset.panel);
                return;
            }
            const fo = ev.target.closest('[data-find-open]');
            if (fo && !fo.closest('#nim-find')) return openFind(fo.dataset.findOpen, '');
            const tg = ev.target.closest('[data-tab-go]');
            if (tg && !tg.closest('#nim-find')) switchTab(tg.dataset.tabGo);
        });
        on('nim-preset-use', 'click', usePresetFromLibrary);
        on('nim-preset-save', 'click', savePresetToLibrary);
        on('nim-preset-libdel', 'click', deletePresetFromLibrary);
        on('nim-gloss-clear', 'click', () => setSeedGlossary([], '已清除初始术语表'));
        on('nim-clear-wb', 'click', () => {
            State.seedWorldbook = null;
            if (State.engine) State.engine = rebuildEngineKeepResults();
            saveProgress();
            renderAll();
        });
        on('nim-start', 'click', () => {
            switchTab('run');
            start();
        });
        on('nim-pause', 'click', () => {
            if (State.engine) State.engine.pauseAfterCurrentLayer();
            log('这一层写完后会暂停');
        });
        on('nim-stop', 'click', stop);
        on('nim-cfg-export', 'click', exportConfig);
        on('nim-cfg-reset', 'click', () => {
            if (!confirm('把改写要求、剧情改写规则、世界书分类恢复成默认？')) return;
            const d = defaultSettings();
            for (const k of ['rewritePrompt', 'divergenceRules', 'divergenceDirection', 'worldbookCategories', 'adPatterns', 'chapterRegex']) State.settings[k] = d[k];
            saveSettings();
            fillFields();
            renderCategories();
        });
        on('nim-task-export', 'click', exportTask);
        document.querySelectorAll('#nim-modal [data-reset]').forEach((b) =>
            b.addEventListener('click', (ev) => {
                ev.preventDefault();
                const key = b.dataset.reset;
                if (!confirm('恢复成默认内容？你改过的会丢掉。')) return;
                State.settings[key] = defaultSettings()[key];
                fillFields();
                collectFields();
                toast('已恢复默认', 'success');
            }),
        );
        on('nim-wr-apply', 'click', (ev) => {
            ev.preventDefault();
            const e = State.engine;
            if (!e) return toast('请先选择小说', 'warning');
            if (e.running) return toast('正在处理中，先暂停再替换', 'warning');
            collectFields();
            const text = State.settings.wordReplace || '';
            if (!C.parseWordReplace(text).length) return toast('还没填替换规则', 'warning');
            openReplacePreview(text);
        });
        $('nim-wr').addEventListener('click', (ev) => {
            if (ev.target.closest('[data-wr="apply"]')) {
                const e = State.engine;
                $('nim-wr').hidden = true;
                if (!e || e.running) return toast('正在处理中，先暂停再替换', 'warning');
                const n = e.applyReplaceToResults(wrUi.text);
                saveProgress();
                renderAll();
                toast(`已替换 ${wrUi.total} 处，涉及 ${n} 层`, 'success');
                log(`词语替换已写入 ${n} 层：${wrUi.summary}`);
            } else if (ev.target === $('nim-wr') || ev.target.closest('[data-wr="close"]')) $('nim-wr').hidden = true;
        });
        on('nim-preview', 'click', async () => {
            if (!State.engine) return toast('请先选择小说', 'warning');
            collectFields();
            if (State.settings.stWorldEnabled) await refreshStWorlds().catch((e) => toast(`读取酒馆世界书失败：${e.message}`, 'error'));
            const i = State.selected ?? State.engine.results.findIndex((r) => !r || r.status !== 'done');
            const req = State.engine.buildRequestFor(Math.max(0, i));
            $('nim-stream').textContent = req.messages.map((m) => `【${m.role}】\n${m.content}`).join('\n\n');
            $('nim-stream-box').open = true;
            switchTab('run');
        });
        on('nim-models', 'click', async () => {
            collectFields();
            try {
                const list = await fetchModels();
                $('nim-model-list').innerHTML = list.map((m) => `<option>${esc(m)}</option>`).join('');
                toast(`拉到 ${list.length} 个模型`, 'success');
            } catch (e) {
                toast(`拉取失败：${e.message}`, 'error');
            }
        });
        on('nim-model-list', 'change', (ev) => {
            State.settings.apiModel = ev.target.value;
            saveSettings();
            fillFields();
        });
        on('nim-test', 'click', async () => {
            collectFields();
            try {
                const t = await callAPI([{ role: 'user', content: '回复「OK」两个字即可。' }]);
                toast(`接口可用：${t.slice(0, 30)}`, 'success');
            } catch (e) {
                toast(`测试失败：${e.message}`, 'error');
            }
        });
        on('nim-gen-desc', 'click', () => {
            collectFields();
            genCardInfo();
        });
        on('nim-import', 'click', importToTavern);
        on('nim-rebuild', 'click', rebuildOnly);
        on('nim-persona', 'click', writePersona);
        document.querySelectorAll('#nim-modal [data-export]').forEach((b) => b.addEventListener('click', () => exportFile(b.dataset.export)));
        document.querySelectorAll('#nim-modal [data-key]').forEach((el) => el.addEventListener('change', () => {
            collectFields();
            renderAll();
        }));
        // 世界书名没单独改过时跟着角色卡名走
        on('nim-card-name', 'input', () => {
            const w = $('nim-world-name');
            if (!w.value.trim() || w.value === State.meta.cardName || w.value === baseName()) w.value = $('nim-card-name').value;
        });
        ['nim-card-name', 'nim-world-name', 'nim-card-desc'].forEach((id) =>
            on(id, 'change', () => {
                readMetaInputs();
                saveProgress();
            }),
        );
    }

    async function open() {
        if ($('nim-modal')) return;
        if (!State.settings) loadSettings();
        if (!document.getElementById('nim-style')) {
            const st = document.createElement('style');
            st.id = 'nim-style';
            st.textContent = STYLE;
            document.head.appendChild(st);
        }
        const wrap = document.createElement('div');
        wrap.innerHTML = buildHtml();
        document.body.appendChild(wrap.firstElementChild);
        // 弹窗本身不该滚动：手机上聚焦藏起来的开关时浏览器会把它整个卷上去，卷了就拉回来
        const box = document.querySelector('#nim-modal .nim-modal');
        box.addEventListener('scroll', () => {
            if (box.scrollTop || box.scrollLeft) box.scrollTop = box.scrollLeft = 0;
        });
        bind();
        fillFields();
        renderPreset();
        renderCategories();
        switchTab(State.tab);
        if (!State.text) {
            const snap = await dbGet();
            if (snap && snap.text) {
                restoreSnapshot(snap);
                log(`已恢复上次的任务：${State.fileName}`);
            }
        }
        renderExport();
        renderAll();
    }

    function close() {
        const el = $('nim-modal');
        if (el) el.remove();
    }

    window.NovelImporter = { open, close, switchTab, _state: State, _bbiPromptHash: bbiPromptHash, _parseEpub: parseEpubWithImages };
})();
