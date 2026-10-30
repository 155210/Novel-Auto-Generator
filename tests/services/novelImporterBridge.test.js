import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// novelImporter/stBridge.js 是浏览器端 IIFE，挂到 globalThis.NovelImporterST；这里只测记忆表格插件的识别和重建
const SRC = readFileSync(new URL('../../novelImporter/stBridge.js', import.meta.url), 'utf8');

function setup({ original, v2, legacyV2 = false, powerUser = {} }) {
    const seen = [];
    const pu = JSON.parse(JSON.stringify(powerUser));
    const chat = [
        { is_user: true, mes: 'u' },
        { is_user: false, mes: 'a', tableEditMatches: ['x'], tableEditMatches_v2: ['x'] },
    ];
    const api = (name, extra = {}) => ({ ext_getAllTables: () => [{ name, data: [['列']] }], ...extra });
    delete globalThis.stMemoryEnhancement;
    delete globalThis.stMemoryEnhancementV2;
    if (original) globalThis.stMemoryEnhancement = api('原版表');
    if (v2) {
        const v2api = api('v2表', { isV2: true, storageKeys: { settings: 'muyoo_dataTable_v2', templates: 'table_database_templates_v2', tableEditMatches: 'tableEditMatches_v2' } });
        if (legacyV2) globalThis.stMemoryEnhancement = v2api;
        else globalThis.stMemoryEnhancementV2 = v2api;
    }
    const ctx = {
        powerUserSettings: pu,
        extensionSettings: {},
        chat,
        eventTypes: { MESSAGE_EDITED: 'edited' },
        eventSource: {
            emit: async (type, i) => {
                seen.push({
                    i,
                    originalOn: (pu.muyoo_dataTable || {}).isExtensionAble,
                    v2Step: (pu.muyoo_dataTable_v2 || {}).step_by_step,
                    matches: [chat[i].tableEditMatches, chat[i].tableEditMatches_v2],
                });
            },
        },
        saveChat: async () => {},
        saveSettingsDebounced: () => {},
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    // eslint-disable-next-line no-eval
    (0, eval)(SRC);
    return { ST: globalThis.NovelImporterST, pu, seen };
}

describe('小说导入：记忆表格插件识别原版 / v2', () => {
    it('只装原版时用原版的设置', () => {
        const { ST } = setup({ original: true, powerUser: { muyoo_dataTable: { message_template: '原版模板' } } });
        expect(ST.memoryMode()).toEqual({ id: 'original', label: '记忆表格（原版）', both: false });
        expect(ST.readMessageTemplate()).toBe('原版模板');
        expect(ST.readPluginTables()[0].name).toBe('原版表');
    });

    it('两个都开时用 v2，读 v2 的设置和表', () => {
        const { ST } = setup({ original: true, v2: true, powerUser: { muyoo_dataTable: { message_template: '原版模板' }, muyoo_dataTable_v2: { message_template: 'v2模板' } } });
        expect(ST.memoryMode()).toEqual({ id: 'v2', label: '记忆表格 v2', both: true });
        expect(ST.readMessageTemplate()).toBe('v2模板');
        expect(ST.readPluginTables()[0].name).toBe('v2表');
    });

    it('v2 关着、原版开着时用原版', () => {
        const { ST } = setup({ original: true, v2: true, powerUser: { muyoo_dataTable_v2: { isExtensionAble: false } } });
        expect(ST.memoryMode().id).toBe('original');
    });

    it('老版本 v2 只挂 stMemoryEnhancement 时也认得出', () => {
        const { ST } = setup({ v2: true, legacyV2: true });
        expect(ST.memoryMode().id).toBe('v2');
    });

    it('重建时关掉 v2 的分步填表和开着的原版，两边的去重标记都清，结束后恢复', async () => {
        const { ST, pu, seen } = setup({ original: true, v2: true, powerUser: { muyoo_dataTable_v2: { step_by_step: true } } });
        let mode = null;
        const r = await ST.rebuildTables({ quietConsole: false, onMode: (m) => (mode = m) });
        expect(mode).toEqual({ id: 'v2', label: '记忆表格 v2', paused: ['记忆表格（原版）'] });
        expect(seen).toEqual([{ i: 1, originalOn: false, v2Step: false, matches: [undefined, undefined] }]);
        expect(pu.muyoo_dataTable_v2.step_by_step).toBe(true);
        expect('isExtensionAble' in pu.muyoo_dataTable).toBe(false);
        expect(r.live[0].name).toBe('v2表');
    });

    it('v2 关着时报它关着', async () => {
        const { ST } = setup({ v2: true, powerUser: { muyoo_dataTable_v2: { isExtensionAble: false } } });
        await expect(ST.rebuildTables({ quietConsole: false })).rejects.toThrow('记忆表格 v2处于关闭状态');
    });
});
