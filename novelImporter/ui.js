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
            { key: 'extraRules', label: '其他规则（随便写，会原样放进提示词）', type: 'textarea', rows: 3 },
            { key: 'prevTailChars', label: '带上一层正文结尾的字数', type: 'number', hint: '让本层开头和上一层接得上；0 不带。取的是上一层处理完的正文（补丁、翻译、改写后的）' },
            { key: 'carryTags', label: '上一层回复里一起发的标签', type: 'text', hint: '逗号分隔，比如 Plotline, 摘要。上一层回复里这些标签的内容会原样带给本层' },
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
            { key: 'titleTag', label: '标题标签', type: 'text' },
            { key: 'bodyTag', label: '正文标签', type: 'text' },
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
        return `<div class="nim-field${wide || f.wide ? ' wide' : ''}"><label for="${id}">${esc(f.label)}${hint}</label>${input}</div>`;
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
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let full = '';
        try {
            for (;;) {
                clearTimeout(timer);
                timer = setTimeout(() => controller.abort(), timeout);
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
                    if (j.usage) State.lastUsage = j.usage;
                    const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
                    if (delta) {
                        full += delta;
                        if (onChunk) onChunk(delta, full);
                    }
                }
            }
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
        const floors = e.renderFloors();
        if (!floors.length) throw new Error('还没有处理完的层');
        const cardName = State.meta.cardName || baseName();
        const worldName = State.meta.worldName || cardName;
        const worldbook = e.exportWorldbook();
        const persona = e.exportPersona();
        const userName = ST.currentUserName() || 'User';
        const chat = C.buildChatArray(floors, { charName: cardName, userName });
        return { floors, cardName, worldName, worldbook, persona, chat, tables: e.exportTables() };
    }

    async function genCardInfo() {
        if (!State.engine) return;
        log('正在生成角色卡简介...');
        try {
            const info = await State.engine.generateCardInfo();
            State.meta.description = info.description;
            State.meta.scenario = info.scenario;
            saveProgress();
            renderExport();
            log('简介已生成');
        } catch (e) {
            log(`生成简介失败：${e.message}`);
        }
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
        if (!State.meta.description && State.settings.apiEndpoint) {
            toast('简介是空的，先让 AI 生成简介，再导入', 'info');
            await genCardInfo();
        }
        State.importing = true;
        State.stopped = false;
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
                onStep: (s) => log(`导入：${s}`),
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
        } catch (e) {
            log(`导入失败：${e.message}`);
            toast(`导入失败：${e.message}`, 'error');
        } finally {
            State.importing = false;
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
        const group = (title, list, row, note) =>
            `<details class="nim-cl-group" ${list.length ? '' : 'disabled'}><summary>${title}<span class="nim-muted">${list.length ? '' : '无'}</span></summary>${note ? `<div class="nim-muted">${note}</div>` : ''}<ul class="nim-cl-list">${list.map(row).join('')}</ul>${list.length >= 3000 ? '<div class="nim-muted">太多了，只列出前 3000 条</div>' : ''}</details>`;
        $('nim-cl-body').innerHTML =
            `<div class="nim-muted">分层时清掉的内容都在这里，按类别展开看。删错的点「保留」，然后点下面的「重新分层」就不会再删；保留的段落在设置「分层与清洗」里能看到和撤销。</div>` +
            group(
                `广告行（${lg.ads.length} 行${lg.ads.some((a) => a.prev) ? `，连带上一行 ${lg.ads.filter((a) => a.prev).length} 行` : ''}）`,
                lg.ads,
                (a) =>
                    `<li>${chap(a.chapter)}${a.prev ? `<div class="nim-cl-line"><div class="nim-cl-prev">连带删掉：${esc(a.prev)}</div>${keepBtn(a.prev)}</div>` : ''}<div class="nim-cl-line"><div>${esc(a.text)}</div>${keepBtn(a.text)}</div></li>`,
                '「连带删掉」是广告上面那行没有句末标点的短行，可以在设置里关掉「同时删掉广告行上面那行短标题」。',
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
            setStatus(`${info.purpose === 'card' ? '生成角色卡简介' : info.purpose === 'repair' ? `第 ${info.layer + 1} 层修格式` : `第 ${info.layer + 1} 层输出`}中 · ${State.stream.length} 字`);
        });
    }

    function switchTab(name) {
        State.tab = name;
        document.querySelectorAll('#nim-modal .nim-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
        document.querySelectorAll('#nim-modal .nim-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
        const body = document.querySelector('#nim-modal .nim-body');
        if (body) body.scrollTop = 0;
    }

    /** 手机上分层列表和单层详情分两屏，点一层进详情，「返回」回列表 */
    function openDetail(on) {
        const box = document.querySelector('#nim-modal .nim-runbox');
        if (box) box.classList.toggle('detail-open', !!on);
        const body = document.querySelector('#nim-modal .nim-body');
        if (body && on && window.matchMedia('(max-width: 760px)').matches) body.scrollTop = 0;
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

    function renderProgress() {
        const e = State.engine;
        const total = e ? e.layers.length : 0;
        const done = e ? e.results.filter((r) => r && r.status === 'done').length : 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const bar = $('nim-progress-bar');
        if (bar) bar.style.width = `${pct}%`;
        const t = $('nim-progress');
        if (t) t.textContent = total ? `${done} / ${total} 层 · ${pct}%` : '还没有分层';
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
        let aliases = [];
        try {
            before = (e.replay(i) || {}).worldbook || {};
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
            const kind = !old ? 'add' : provided.has(`${x.cat}/${old}`) ? 'replace' : 'append';
            return { ...x, keys, old, kind };
        });
        const n = (k) => rows.filter((x) => x.kind === k).length;
        const TAG = { add: '新增', replace: '更新（整条改写）', append: '补充（接在旧内容后）' };
        return (
            `<details class="nim-fold" open><summary>本层世界书（${rows.length} 条：新增 ${n('add')}，更新 ${n('replace') + n('append')}）</summary>` +
            `<div class="nim-muted">这里是 AI 这一层原样给的内容。同名或关键词对上的条目会并进同一条，导出时一个角色只有一条。「整条改写」：AI 拿到了旧内容，回的是改好的完整版，直接替换；「补充」：这次没把旧内容发给 AI，新内容接在旧内容后面。称呼表里的名字导出时会换成 ${esc(target)}。</div><ul class="nim-wb-list">` +
            rows
                .map(({ cat, name, keys, old, kind }) => {
                    const asUser = aliases.includes(name);
                    return `<li><div class="nim-wb-head"><span class="nim-pr-tag">${esc(cat)}</span><b>${esc(name)}</b><span class="nim-pr-tag ${kind === 'add' ? 'is-depth' : ''}">${TAG[kind]}</span>${old && old !== name ? `<span class="nim-muted">并进「${esc(old)}」</span>` : ''}${asUser ? `<span class="nim-muted">导出为 ${esc(target)}</span>` : ''}</div>${keys.length ? `<div class="nim-muted">关键词：${esc(keys.join('、'))}</div>` : ''}<div class="nim-wb-content">${esc(String(r.parsed.worldbook[cat][name].内容 || ''))}</div></li>`;
                })
                .join('') +
            `</ul></details>`
        );
    }

    /** 这一层每次请求的原始输出（首次、重试、修格式），按顺序列出来 */
    function callsHtml(r) {
        const calls = r.calls || [];
        if (!calls.length) return '';
        const NAME = { layer: '正文请求', repair: '修 JSON 格式' };
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
        let body = '';
        if (r && r.status === 'done') {
            const floor = e.renderFloors()[i];
            const d = r.parsed.divergence;
            if (r.warnings && r.warnings.length) body += `<div class="nim-alert warn">${esc(r.warnings.join('；'))}</div>`;
            body += d.triggered || r.inDivergence ? `<div class="nim-alert warn">剧情改写：${esc(d.rule)} ${esc(d.note)}${d.resume ? '（本层接回原文）' : ''}</div>` : '';
            body += `<div class="nim-sub">楼层内容${State.hlOff ? '' : '<span class="nim-muted">（<mark class="nim-hl">高亮</mark>是 AI 补充的，只在这里显示，导出不带）</span>'}<button id="nim-hl-toggle" class="nim-btn ghost sm" style="margin-left:8px">${State.hlOff ? '显示高亮' : '关掉高亮'}</button></div>${State.hlOff ? '' : '<div class="nim-row nim-hl-nav" id="nim-hl-nav" hidden><button class="nim-btn sm" data-hl-go="-1">↑ 上一处</button><span id="nim-hl-pos" class="nim-muted"></span><button class="nim-btn sm" data-hl-go="1">下一处 ↓</button></div>'}<pre class="nim-pre" id="nim-floor-pre">${floorHtml(e, i, floor)}</pre>`;
            if (r.patchStats.failed.length)
                body += `<div class="nim-sub">没对上的补丁</div><pre class="nim-pre">${esc(r.patchStats.failed.map((f) => `P${f.patch.pid} | ${f.patch.anchor} | ${f.patch.text}  →  ${f.reason}`).join('\n'))}</pre>`;
            if (r.tableLog && r.tableLog.length) body += `<div class="nim-sub">表格提示</div><pre class="nim-pre">${esc(r.tableLog.join('\n'))}</pre>`;
            body += layerWorldbookHtml(e, i, r);
            if (r.parsed.terms && r.parsed.terms.length) body += `<div class="nim-sub">本层新术语</div><pre class="nim-pre">${esc(r.parsed.terms.map((t) => `${t.source} → ${t.target}${t.note ? `（${t.note}）` : ''}`).join('\n'))}</pre>`;
            body += `<details class="nim-fold"><summary>程序最后用的回复${(r.calls || []).some((c) => c.purpose === 'repair') ? '（修过格式后拼回去的）' : ''}</summary><pre class="nim-pre">${esc(r.raw)}</pre></details>`;
        } else if (r && r.status === 'failed') {
            body += `<div class="nim-alert danger">失败：${esc(r.error)}</div>`;
        }
        if (r) body += callsHtml(r);
        body += `<details class="nim-fold"><summary>原文</summary><pre class="nim-pre">${esc(e.layers[i].paras.map((p) => p.text).join('\n'))}</pre></details>`;
        const reviewHtml = reviewing
            ? `<div class="nim-review">
                 <div class="nim-sub">审阅这一层：没问题就继续，不行就写修改意见重做</div>
                 <textarea id="nim-feedback" class="nim-input nim-textarea" rows="3" placeholder="例如：第 3 段的补充太长了；这里的改写和前面冲突了"></textarea>
                 <div class="nim-row"><button id="nim-accept" class="nim-btn primary">可以，继续</button><button id="nim-reject" class="nim-btn">按意见重做这层</button></div>
               </div>`
            : '';
        el.innerHTML = `<div class="nim-detail-head"><div><div class="nim-detail-title">第 ${i + 1} 层</div><div class="nim-muted">${STATE_TEXT[layerState(r, i, e)]} · ${e.layers[i].chars} 字</div>${r && r.tokens ? `<div class="nim-muted">${esc(tokenText(r.tokens))}</div>` : ''}</div><button id="nim-rerun" class="nim-btn ghost sm">从这层开始重跑</button></div>${reviewHtml}${body}`;
        bindHlNav();
        const hlBtn = $('nim-hl-toggle');
        if (hlBtn)
            hlBtn.onclick = () => {
                State.hlOff = !State.hlOff;
                renderDetail();
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
                await e.reject(fb);
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
            if (st && st.emptyChapters.length) c.push(['空章 ›', `${st.emptyChapters.length} 章`, 'warn link']);
            chips.innerHTML = c
                .map(([k, v, cls]) => {
                    const tag = (cls || '').includes('link') ? 'button' : 'div';
                    return `<${tag} class="nim-stat ${cls || ''}" ${tag === 'button' ? 'data-cleanlog title="查看清掉的内容"' : ''}><div class="nim-stat-v">${esc(v)}</div><div class="nim-stat-k">${esc(k)}</div></${tag}>`;
                })
                .join('');
        }
        const tpl = State.tableTemplate;
        const tplText = tpl ? `${tpl.tables.length} 张表${State.settings.tableMessageTemplate ? ' · 有消息模板' : ''}` : '还没导入';
        setRes('nim-res-tpl', tpl, tplText);
        if ($('nim-tpl-state2')) $('nim-tpl-state2').textContent = `表格模板：${tplText}`;
        const wbN = State.seedWorldbook ? Object.values(State.seedWorldbook).reduce((a, x) => a + Object.keys(x).length, 0) : 0;
        setRes('nim-res-wb', wbN, wbN ? `${wbN} 条` : '可选，从头建');
        const gNow = e ? (e.finalState().glossary || []).length : 0;
        const gSeed = (State.seedGlossary || []).length;
        setRes('nim-res-gloss', gSeed || gNow, gNow || gSeed ? `${gSeed} 条初始${gNow > gSeed ? `，已积累到 ${gNow} 条` : ''}` : st && st.translate ? '会边翻译边积累' : '翻译外文小说时用');
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
            ['settings', '2', '⚙️', '设置'],
            ['run', '3', '📝', '处理'],
            ['export', '4', '🎴', '导入酒馆'],
        ];
        return `
<div id="nim-modal" class="nim-overlay"><div class="nim-modal" role="dialog" aria-label="小说导入改写">
  <header class="nim-header">
    <div class="nim-brand">
      <div class="nim-logo">📥</div>
      <div class="nim-brand-text"><div class="nim-title">小说导入改写 <span class="nim-ver">v${C.VERSION}</span></div><div id="nim-info" class="nim-subtitle"></div></div>
    </div>
    <button id="nim-close" class="nim-icon-btn" title="关闭">✕</button>
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
      <div id="nim-file-stats" class="nim-stats"></div>
      <div class="nim-res-list">
        ${res('nim-res-tpl', '📊', '记忆表格模板', `<label class="nim-btn sm">导入文件<input type="file" id="nim-tpl" accept=".json" hidden></label><button id="nim-tpl-live" class="nim-btn sm">从记忆插件读取</button>`)}
        ${res('nim-res-wb', '📚', '初始世界书', `<label class="nim-btn sm">导入<input type="file" id="nim-seed-wb" accept=".json" hidden></label><button id="nim-clear-wb" class="nim-btn ghost sm">清除</button>`)}
        ${res(
            'nim-res-gloss',
            '🔤',
            '术语表',
            `<button id="nim-gloss-edit" class="nim-btn sm">查看和编辑</button><button id="nim-gloss-nt" class="nim-btn sm">从小说翻译读取</button><label class="nim-btn sm">导入<input type="file" id="nim-gloss-file" accept=".json,.txt" hidden></label><button id="nim-gloss-clear" class="nim-btn ghost sm">清除</button>`,
        )}
      </div>
      ${card('file', '分层与清洗', '每层字数、章节识别、广告和水印规则', `${f('layer')}<div class="nim-row"><button id="nim-prepare" class="nim-btn">按当前设置重新分层</button><button id="nim-cleanlog" class="nim-btn">查看清掉的内容</button></div>`)}
    </section>

    <section class="nim-panel" data-panel="settings">
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
      ${card('rewrite', '改写与剧情改写', '扩写比例、改写要求、送女/NTR 等改写规则、审阅', f('rewrite'))}
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
  ${glossaryHtml()}
</div></div>`;
    }

    const STYLE = `
/* 手机版酒馆会改写弹窗的尺寸，inset:0 在手机上高度会变成 0，所以写死宽高并加 !important */
.nim-overlay{position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important;height:100dvh !important;max-height:none !important;display:flex !important;align-items:center;justify-content:center;background:rgba(8,8,14,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:99999 !important;box-sizing:border-box;padding:24px;}
.nim-modal{--bg:#15161c;--surface:#1c1d25;--surface2:#242530;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--text:#ececf2;--muted:#9496a8;--accent:#8b7cf6;--accent2:#6aa8ff;--ok:#3ccf91;--warn:#f2b441;--bad:#f06464;
  position:relative;display:flex;flex-direction:column;width:min(1080px,100%);height:min(900px,100%);background:var(--bg);color:var(--text);border:1px solid var(--line2);border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;overflow:clip;font-size:14px;line-height:1.5;text-align:left;}
.nim-modal *{box-sizing:border-box;}
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
.nim-cl-mark{background:rgba(240,100,100,.25);color:var(--text);border-radius:3px;padding:0 2px;}
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
  .nim-tabs{order:4;display:grid;grid-template-columns:repeat(4,1fr);gap:0;padding:4px;padding-bottom:max(4px,env(safe-area-inset-bottom));border-top:1px solid var(--line);border-bottom:0;background:var(--surface);overflow:visible;}
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
