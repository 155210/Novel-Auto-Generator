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
        messageChain: [{ role: 'user', content: '{PROMPT}', enabled: true }],
    };

    const State = {
        settings: null, // 模块设置 + API 设置
        text: '',
        fileName: '',
        engine: null,
        tableTemplate: null,
        seedWorldbook: null,
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

    async function decodeTxt(file) {
        const buf = await file.arrayBuffer();
        let best = { text: '', score: -Infinity };
        for (const enc of ['utf-8', 'gb18030', 'big5']) {
            try {
                const text = new TextDecoder(enc, { fatal: false }).decode(buf);
                const bad = (text.match(/�/g) || []).length;
                const score = text.length - bad * 50;
                if (score > best.score) best = { text, score };
            } catch (e) {
                /* 不支持的编码 */
            }
        }
        return best.text;
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
        return { ...d, ...JSON.parse(JSON.stringify(API_DEFAULTS)) };
    }

    function loadSettings() {
        const d = defaultSettings();
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                State.settings = { ...d, ...saved, tableRoles: { ...d.tableRoles, ...(saved.tableRoles || {}) } };
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
    const FIELDS = {
        layer: [
            { key: 'layerChars', label: '每层字数', type: 'number', hint: '默认 15000' },
            { key: 'alignToChapter', label: '尽量在章节标题处分层', type: 'check' },
            { key: 'chapterRegex', label: '章节标题正则', type: 'text' },
            { key: 'adPatterns', label: '广告行规则（每行一条正则，命中的行删掉）', type: 'lines' },
            { key: 'adRemovePrevLine', label: '同时删掉广告行上面那行短标题（如「书名」+「请收藏：」）', type: 'check' },
            { key: 'inlineAdPatterns', label: '行内水印规则（每行一条正则，只删命中的那段，如「bg90○ cc」）', type: 'lines' },
            { key: 'repeatParaLimit', label: '全书重复几次以上的段落当垃圾段删掉', type: 'number', hint: '盗版源常把整章换成同一段垃圾文字；0 为不删，默认 3' },
            { key: 'repeatParaMinChars', label: '参与重复检测的最短段落字数', type: 'number', hint: '默认 12，太短的句子不算' },
        ],
        rewrite: [
            { key: 'expansionRatio', label: '扩写比例 %', type: 'number', hint: '补充内容约占原文字数的比例，默认 10' },
            { key: 'maxPatchChars', label: '单条补丁最多字数', type: 'number' },
            { key: 'rewritePrompt', label: '改写要求', type: 'textarea', rows: 5 },
            { key: 'extraRules', label: '其他规则（随便写，会原样放进提示词）', type: 'textarea', rows: 3 },
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
        alias: [
            { key: 'protagonistName', label: '主角原名', type: 'text', hint: '例如 路长远' },
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
            { key: 'worldbookCategories', label: '分类（JSON：name 名称、enabled 启用、constant 常驻、guide 要写的内容）', type: 'json', rows: 8 },
            { key: 'worldbookPrompt', label: '世界书额外要求', type: 'textarea', rows: 3 },
            { key: 'worldbookContextChars', label: '每层带给 AI 的已有条目字数上限', type: 'number' },
            { key: 'plotSummaryEntries', label: '每层摘要也导出为「剧情」条目', type: 'check' },
        ],
        table: [
            { key: 'tablesEnabled', label: '每层填写记忆表格', type: 'check' },
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
            { key: 'messageChain', label: '消息链（JSON，{PROMPT} 处放每层的提示词；导入酒馆预设会自动生成）', type: 'json', rows: 6 },
        ],
    };

    function fieldHtml(f) {
        const id = `nim-f-${f.key.replace(/\./g, '-')}`;
        const hint = f.hint ? ` <span class="nim-hint">${esc(f.hint)}</span>` : '';
        if (f.type === 'check') {
            return `<label class="nim-check"><input type="checkbox" id="${id}" data-key="${f.key}" data-type="check"> ${esc(f.label)}</label>`;
        }
        let input;
        if (f.type === 'textarea' || f.type === 'lines' || f.type === 'json') {
            input = `<textarea id="${id}" class="nim-input nim-textarea" rows="${f.rows || 4}" data-key="${f.key}" data-type="${f.type}"></textarea>`;
        } else if (f.type === 'select') {
            input = `<select id="${id}" class="nim-input" data-key="${f.key}" data-type="select">${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
        } else {
            const t = f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text';
            input = `<input id="${id}" class="nim-input" type="${t}" ${f.step ? `step="${f.step}"` : ''} data-key="${f.key}" data-type="${f.type}">`;
        }
        return `<div class="nim-field"><label for="${id}">${esc(f.label)}${hint}</label>${input}</div>`;
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
    async function callAPI(messages, onChunk) {
        const s = State.settings;
        const timeout = Number(s.apiTimeout) || 300000;
        const body = { model: s.apiModel || 'gpt-4o', messages, temperature: Number(s.temperature), stream: true };
        if (s.maxTokens) body.max_tokens = Number(s.maxTokens);
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
            const err = new Error(`API 返回 ${resp.status}：${t.slice(0, 300)}`);
            err.retryable = RETRYABLE.has(resp.status);
            throw err;
        }
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('event-stream') || !resp.body) {
            clearTimeout(timer);
            const data = await resp.json();
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
                return await callAPI(messages, (_d, full) => {
                    State.stream = full;
                    renderStream(info);
                });
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
            messageChain: State.settings.messageChain,
            tableTemplate: State.tableTemplate,
            seedWorldbook: State.seedWorldbook,
            callModel,
            onEvent: onEngineEvent,
        });
    }

    function onEngineEvent(type, p) {
        if (type === 'layer-start') log(`第 ${p.index + 1} 层开始`);
        else if (type === 'layer-retry') log(`第 ${p.index + 1} 层第 ${p.attempt + 1} 次结果不合格：${p.error}`);
        else if (type === 'layer-failed') log(`第 ${p.index + 1} 层失败：${p.error}`);
        else if (type === 'layer-done') {
            const r = p.result;
            const f = r.patchStats.failed.length;
            log(
                `第 ${p.index + 1} 层完成：${r.parsed.title}${r.divergenceStart ? '（改写起点）' : r.inDivergence ? '（改写中）' : ''}` +
                    (r.patchStats.rewritten ? '，整层改写' : `，补丁 ${r.patchStats.applied} 条${f ? `，${f} 条没对上` : ''}`) +
                    (r.askedBigSummary ? '，已做大总结' : ''),
            );
            saveProgress();
        } else if (type === 'review') {
            State.selected = p.index;
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
        if (!State.settings.protagonistName && !confirm('没有填主角原名，正文里不会替换主角称呼，继续吗？')) return;
        if (State.engine.reviewing !== null) State.engine.accept();
        State.stopped = false;
        renderAll();
        await State.engine.run();
        renderAll();
        if (State.engine.reviewing === null && State.engine.results.every((r) => r && r.status === 'done')) {
            log('全部层已完成，可以在下面「导入酒馆与导出」一键导入');
            const sec = $('nim-sec-export');
            if (sec) {
                sec.open = true;
                sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
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
        if (!State.meta.description && State.settings.apiEndpoint) await genCardInfo();
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
                chatArray: out.chat,
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
        if (kind === 'chat') download(C.chatToJsonl(out.chat), `${n}.jsonl`, 'application/jsonl');
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
        else if (kind === 'txt') {
            const txt = out.floors
                .map((f) => `${f.title}\n\n${f.body}`)
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
            State.settings = { ...defaultSettings(), ...j, apiKey: j.apiKey || key, tableRoles: { ...C.DEFAULT_TABLE_ROLES, ...(j.tableRoles || {}) } };
            saveSettings();
            fillFields();
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
    // 文件导入
    // ============================================

    async function onNovelFile(file) {
        let text;
        if (/\.epub$/i.test(file.name)) {
            if (!window.EpubToTxt) return toast('EPUB 模块没加载，请先转成 TXT', 'error');
            const r = await window.EpubToTxt.parseEpub(await file.arrayBuffer());
            text = (r.chapters || []).map((c) => `${c.title || ''}\n${c.content || ''}`).join('\n\n') || r.content || '';
        } else text = await decodeTxt(file);
        State.text = text;
        State.fileName = file.name;
        State.engine = null;
        State.meta = { cardName: baseName(), worldName: baseName(), avatar: '', description: '', scenario: '' };
        renderExport();
        log(`已读取 ${file.name}，${text.length} 字`);
        await prepareLayers();
    }

    async function onTemplateFile(file) {
        try {
            State.tableTemplate = C.parseTableTemplate(JSON.parse(await readFileText(file)));
            log(`表格模板：${State.tableTemplate.tables.map((t) => t.name).join('、')}`);
            // 还没开始跑的话，用新模板重建引擎
            if (State.engine && !State.engine.results.some((r) => r && r.status === 'done')) {
                State.engine = makeEngine(State.engine.settings);
                State.engine.prepare(State.text);
            }
            saveProgress();
            renderAll();
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    function templateFromPlugin() {
        const live = ST.readPluginTables();
        if (!live || !live.length) return toast('没读到记忆插件的表格：请先打开一个有表格的聊天', 'warning');
        State.tableTemplate = C.parseTableTemplate(live);
        log(`从记忆插件读取表格：${State.tableTemplate.tables.map((t) => t.name).join('、')}（没有填写说明，建议用导出的模板文件）`);
        saveProgress();
        renderAll();
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

    async function onPresetFile(file) {
        try {
            const p = C.parseTavernPreset(JSON.parse(await readFileText(file)));
            State.settings.messageChain = p.chain;
            if (p.params.temperature != null) State.settings.temperature = p.params.temperature;
            if (p.params.maxTokens) State.settings.maxTokens = p.params.maxTokens;
            saveSettings();
            fillFields();
            log(`已导入预设：${p.chain.length} 条消息`);
        } catch (e) {
            toast(e.message, 'error');
        }
    }

    // ============================================
    // 渲染
    // ============================================

    function log(msg) {
        const el = $('nim-log');
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(`[NovelImporter] ${msg}`);
        if (!el) return;
        el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
        el.scrollTop = el.scrollHeight;
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
            el.textContent = State.stream.slice(-3000);
            el.scrollTop = el.scrollHeight;
            setStatus(`第 ${info.layer + 1} 层输出中：${State.stream.length} 字`);
        });
    }

    function statusIcon(r) {
        if (!r) return '⏳';
        return { running: '🔄', done: '✅', failed: '❌' }[r.status] || '⏳';
    }

    function renderLayers() {
        const el = $('nim-layers');
        const e = State.engine;
        if (!el) return;
        if (!e || !e.layers.length) {
            el.innerHTML = '<div class="nim-hint">选择文件后会显示分层</div>';
            return;
        }
        const done = e.results.filter((r) => r && r.status === 'done').length;
        $('nim-progress').textContent = `${done}/${e.layers.length} 层，估算已用 输入 ${e.stats.inputTokens} / 输出 ${e.stats.outputTokens} tokens`;
        el.innerHTML = e.layers
            .map((l, i) => {
                const r = e.results[i];
                const title = r && r.parsed ? r.parsed.title : (l.chapters[0] || l.paras[0].text).slice(0, 30);
                const flags = [];
                if (r && r.divergenceStart) flags.push('<span class="nim-tag nim-tag-red">改写起点</span>');
                else if (r && r.inDivergence) flags.push('<span class="nim-tag nim-tag-orange">改写中</span>');
                if (r && r.patchStats && r.patchStats.failed.length) flags.push(`<span class="nim-tag">${r.patchStats.failed.length} 条补丁没对上</span>`);
                if (r && r.askedBigSummary) flags.push('<span class="nim-tag nim-tag-blue">大总结</span>');
                if (e.reviewing === i) flags.push('<span class="nim-tag nim-tag-orange">待审阅</span>');
                return `<div class="nim-layer ${State.selected === i ? 'sel' : ''}" data-i="${i}">${statusIcon(r)} <b>${i + 1}</b> ${esc(title)} <span class="nim-hint">${l.chars} 字</span> ${flags.join(' ')}</div>`;
            })
            .join('');
        el.querySelectorAll('.nim-layer').forEach((d) =>
            d.addEventListener('click', () => {
                State.selected = Number(d.dataset.i);
                renderAll();
            }),
        );
    }

    function renderDetail() {
        const el = $('nim-detail');
        const e = State.engine;
        if (!el) return;
        const i = State.selected;
        if (!e || i === null || i === undefined || !e.layers[i]) {
            el.innerHTML = '';
            return;
        }
        const r = e.results[i];
        const reviewing = e.reviewing === i;
        let body = '';
        if (r && r.status === 'done') {
            const floor = e.renderFloors()[i];
            const d = r.parsed.divergence;
            body += d.triggered || r.inDivergence ? `<div class="nim-warn">剧情改写：${esc(d.rule)} ${esc(d.note)}${d.resume ? '（本层接回原文）' : ''}</div>` : '';
            body += `<div class="nim-sub">楼层内容</div><pre class="nim-pre">${esc(floor ? floor.mes : '')}</pre>`;
            if (r.patchStats.failed.length)
                body += `<div class="nim-sub">没对上的补丁</div><pre class="nim-pre">${esc(r.patchStats.failed.map((f) => `P${f.patch.pid} | ${f.patch.anchor} | ${f.patch.text}  →  ${f.reason}`).join('\n'))}</pre>`;
            if (r.tableLog && r.tableLog.length) body += `<div class="nim-sub">表格提示</div><pre class="nim-pre">${esc(r.tableLog.join('\n'))}</pre>`;
            body += `<details><summary>AI 原始输出</summary><pre class="nim-pre">${esc(r.raw)}</pre></details>`;
        } else if (r && r.status === 'failed') {
            body += `<div class="nim-warn">失败：${esc(r.error)}</div>`;
        }
        body += `<details><summary>原文</summary><pre class="nim-pre">${esc(e.layers[i].paras.map((p) => p.text).join('\n'))}</pre></details>`;
        const reviewHtml = reviewing
            ? `<div class="nim-review">
                 <div class="nim-sub">审阅这一层：可以就继续，不行就写修改意见重做这一层</div>
                 <textarea id="nim-feedback" class="nim-input nim-textarea" rows="3" placeholder="例如：第 3 段的补充太长了；这里的改写和前面冲突了"></textarea>
                 <div class="nim-row"><button id="nim-accept" class="nim-btn nim-btn-primary">✅ 可以，继续</button><button id="nim-reject" class="nim-btn">✏️ 按意见重做这层</button></div>
               </div>`
            : '';
        el.innerHTML = `<div class="nim-row"><b>第 ${i + 1} 层</b><button id="nim-rerun" class="nim-btn-small">从这层开始重跑</button></div>${reviewHtml}${body}`;
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
        $('nim-card-avatar').textContent = State.meta.avatar ? `已绑定角色卡：${State.meta.avatar}（再次导入会更新这张卡，并新建一个聊天）` : '导入时新建角色卡';
    }

    function readMetaInputs() {
        if (!$('nim-card-name')) return;
        State.meta.cardName = $('nim-card-name').value.trim() || baseName();
        State.meta.worldName = $('nim-world-name').value.trim() || State.meta.cardName;
        State.meta.description = $('nim-card-desc').value;
    }

    function renderInfo() {
        const el = $('nim-info');
        if (!el) return;
        const parts = [];
        parts.push(State.fileName ? `📄 ${esc(State.fileName)}（${State.text.length} 字）` : '还没选小说');
        parts.push(State.tableTemplate ? `📊 表格：${State.tableTemplate.tables.length} 张` : '📊 没有表格模板');
        if (State.seedWorldbook) parts.push(`📚 初始世界书 ${Object.values(State.seedWorldbook).reduce((a, x) => a + Object.keys(x).length, 0)} 条`);
        el.innerHTML = parts.join(' · ');
    }

    function renderButtons() {
        const e = State.engine;
        const running = !!(e && e.running);
        $('nim-start').disabled = running;
        $('nim-start').textContent = e && e.results.some((r) => r && r.status === 'done') ? '▶️ 继续' : '▶️ 开始';
        $('nim-pause').disabled = !running;
        $('nim-stop').disabled = !running;
    }

    function renderAll() {
        renderInfo();
        renderLayers();
        renderDetail();
        renderButtons();
    }

    // ============================================
    // 弹窗
    // ============================================

    function section(id, title, inner, open = false) {
        return `<details class="nim-section" ${open ? 'open' : ''} id="nim-sec-${id}"><summary>${title}</summary><div class="nim-section-body">${inner}</div></details>`;
    }

    function buildHtml() {
        const f = (k) => FIELDS[k].map(fieldHtml).join('');
        return `
<div id="nim-modal" class="nim-overlay"><div class="nim-modal">
  <div class="nim-header"><b>📥 小说导入改写 v${C.VERSION}</b><button id="nim-close" class="nim-close">✕</button></div>
  <div class="nim-body">
    <div id="nim-info" class="nim-info"></div>
    ${section(
        'file',
        '📄 小说与分层',
        `<div class="nim-row">
           <label class="nim-btn">选择小说（TXT / EPUB）<input type="file" id="nim-file" accept=".txt,.epub" hidden></label>
           <button id="nim-prepare" class="nim-btn">按当前设置重新分层</button>
         </div>${f('layer')}`,
        true,
    )}
    ${section(
        'api',
        '🔧 API 与预设',
        `${f('api')}
         <div class="nim-row">
           <button id="nim-models" class="nim-btn-small">拉取模型列表</button>
           <select id="nim-model-list" class="nim-input" style="flex:1"></select>
           <button id="nim-test" class="nim-btn-small">测试</button>
           <label class="nim-btn-small">导入酒馆预设<input type="file" id="nim-preset" accept=".json" hidden></label>
         </div>`,
    )}
    ${section('rewrite', '✍️ 改写与剧情改写', f('rewrite'))}
    ${section('alias', '👤 主角称呼与标签', f('alias'))}
    ${section(
        'wb',
        '📚 世界书',
        `<div class="nim-row"><label class="nim-btn-small">导入已有世界书（可用「TXT转世界书」的导出）<input type="file" id="nim-seed-wb" accept=".json" hidden></label><button id="nim-clear-wb" class="nim-btn-small">清除</button></div>${f('worldbook')}`,
    )}
    ${section(
        'table',
        '📊 记忆表格',
        `<div class="nim-row">
           <label class="nim-btn-small">导入表格模板（记忆插件导出的设置 JSON）<input type="file" id="nim-tpl" accept=".json" hidden></label>
           <button id="nim-tpl-live" class="nim-btn-small">从当前聊天的记忆插件读取</button>
         </div>${f('table')}`,
    )}
    ${section(
        'cfg',
        '💾 配置与任务',
        `<div class="nim-row">
           <button id="nim-cfg-export" class="nim-btn-small">导出配置</button>
           <label class="nim-btn-small">导入配置<input type="file" id="nim-cfg-import" accept=".json" hidden></label>
           <button id="nim-cfg-reset" class="nim-btn-small">恢复默认提示词</button>
           <button id="nim-task-export" class="nim-btn-small">导出任务进度</button>
           <label class="nim-btn-small">导入任务进度<input type="file" id="nim-task-import" accept=".json" hidden></label>
           <button id="nim-preview" class="nim-btn-small">预览当前层提示词</button>
         </div>`,
    )}
    <div class="nim-section nim-run">
      <div class="nim-row">
        <button id="nim-start" class="nim-btn nim-btn-primary">▶️ 开始</button>
        <button id="nim-pause" class="nim-btn" title="当前这层写完后停下，让你审阅">⏸️ 这层写完后暂停</button>
        <button id="nim-stop" class="nim-btn">⏹️ 停止</button>
        <span id="nim-progress" class="nim-hint"></span>
      </div>
      <div id="nim-status" class="nim-hint"></div>
      <div class="nim-split">
        <div id="nim-layers" class="nim-layers"></div>
        <div id="nim-detail" class="nim-detail"></div>
      </div>
      <details><summary>实时输出</summary><pre id="nim-stream" class="nim-pre"></pre></details>
      <pre id="nim-log" class="nim-pre nim-log"></pre>
    </div>
    ${section(
        'export',
        '🎴 导入酒馆与导出',
        `<div class="nim-row">
           <div class="nim-field"><label>角色卡名</label><input id="nim-card-name" class="nim-input"></div>
           <div class="nim-field"><label>世界书名</label><input id="nim-world-name" class="nim-input"></div>
         </div>
         <div class="nim-field"><label>角色卡简介 <button id="nim-gen-desc" class="nim-btn-small">AI 生成</button></label><textarea id="nim-card-desc" class="nim-input nim-textarea" rows="4"></textarea></div>
         <div id="nim-card-avatar" class="nim-hint"></div>
         <div class="nim-row">
           <button id="nim-import" class="nim-btn nim-btn-primary">一键导入酒馆（角色卡 + 世界书 + 聊天 + 重建表格）</button>
           <button id="nim-rebuild" class="nim-btn-small">只在当前聊天重建表格</button>
           <button id="nim-persona" class="nim-btn-small">主角人设写入当前用户人设</button>
         </div>
         <div class="nim-row">
           <button class="nim-btn-small" data-export="chat">下载聊天 JSONL</button>
           <button class="nim-btn-small" data-export="world">下载世界书</button>
           <button class="nim-btn-small" data-export="card">下载角色卡 JSON</button>
           <button class="nim-btn-small" data-export="persona">下载用户人设</button>
           <button class="nim-btn-small" data-export="tables">下载表格</button>
           <button class="nim-btn-small" data-export="txt">下载改写后的 TXT</button>
         </div>`,
    )}
  </div>
</div></div>`;
    }

    const STYLE = `
.nim-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:99999;overflow-y:auto;}
.nim-modal{max-width:1000px;margin:16px auto;background:var(--SmartThemeBlurTintColor,#1e1e1e);color:var(--SmartThemeBodyColor,#eee);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:10px;}
.nim-header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#1c1c1c;border-bottom:1px solid #444;border-radius:10px 10px 0 0;}
.nim-close{background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;}
.nim-body{padding:12px;}
.nim-info{font-size:12px;opacity:.8;margin-bottom:10px;}
.nim-section{background:rgba(0,0,0,.2);border-radius:8px;margin-bottom:10px;}
.nim-section>summary{padding:10px 14px;cursor:pointer;font-weight:500;}
.nim-section-body{padding:4px 14px 14px;}
.nim-run{padding:12px 14px;}
.nim-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0;}
.nim-field{margin-bottom:10px;flex:1 1 200px;}
.nim-field>label{display:block;font-size:12px;opacity:.85;margin-bottom:4px;}
.nim-input{width:100%;box-sizing:border-box;background:rgba(0,0,0,.3);border:1px solid #555;border-radius:6px;color:#fff;padding:8px 10px;font-size:13px;}
.nim-textarea{font-family:monospace;font-size:12px;resize:vertical;}
.nim-bad{border-color:#e74c3c;}
.nim-check{display:block;margin:6px 0 10px;font-size:13px;cursor:pointer;}
.nim-hint{font-size:11px;opacity:.6;}
.nim-btn,.nim-btn-small{border:1px solid #555;border-radius:6px;background:rgba(255,255,255,.08);color:#fff;cursor:pointer;}
.nim-btn{padding:8px 14px;font-size:13px;}
.nim-btn-small{padding:5px 10px;font-size:12px;}
.nim-btn:disabled{opacity:.45;cursor:not-allowed;}
.nim-btn-primary{background:linear-gradient(135deg,#27ae60,#1e8449);border-color:transparent;}
.nim-split{display:flex;gap:10px;flex-wrap:wrap;}
.nim-layers{flex:1 1 300px;max-height:420px;overflow-y:auto;border:1px solid #333;border-radius:6px;}
.nim-detail{flex:2 1 400px;max-height:420px;overflow-y:auto;}
.nim-layer{padding:6px 8px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer;}
.nim-layer.sel{background:rgba(52,152,219,.25);}
.nim-tag{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.12);}
.nim-tag-red{background:#c0392b;}.nim-tag-orange{background:#d35400;}.nim-tag-blue{background:#2471a3;}
.nim-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:rgba(0,0,0,.3);padding:8px;border-radius:6px;max-height:300px;overflow-y:auto;}
.nim-log{max-height:160px;}
.nim-sub{font-size:12px;font-weight:bold;margin:8px 0 4px;}
.nim-warn{background:rgba(211,84,0,.25);padding:6px 8px;border-radius:6px;font-size:12px;margin:6px 0;}
.nim-review{border:1px solid #d35400;border-radius:6px;padding:8px;margin:8px 0;}
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
        onFile('nim-file', onNovelFile);
        onFile('nim-tpl', onTemplateFile);
        onFile('nim-seed-wb', onWorldbookFile);
        onFile('nim-preset', onPresetFile);
        onFile('nim-cfg-import', importConfig);
        onFile('nim-task-import', importTask);
        on('nim-prepare', 'click', prepareLayers);
        on('nim-tpl-live', 'click', templateFromPlugin);
        on('nim-clear-wb', 'click', () => {
            State.seedWorldbook = null;
            saveProgress();
            renderAll();
        });
        on('nim-start', 'click', start);
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
        });
        on('nim-task-export', 'click', exportTask);
        on('nim-preview', 'click', () => {
            if (!State.engine) return toast('请先选择小说', 'warning');
            collectFields();
            const i = State.selected ?? State.engine.results.findIndex((r) => !r || r.status !== 'done');
            const req = State.engine.buildRequestFor(Math.max(0, i));
            const el = $('nim-stream');
            el.textContent = req.messages.map((m) => `【${m.role}】\n${m.content}`).join('\n\n');
            el.closest('details').open = true;
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
        document.querySelectorAll('#nim-modal [data-key]').forEach((el) => el.addEventListener('change', () => collectFields()));
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
        bind();
        fillFields();
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

    window.NovelImporter = { open, close, _state: State };
})();
