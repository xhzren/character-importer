import { renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    getRequestHeaders,
    characters,
    name1,
    getCharacters,
    eventSource,
    event_types,
} from '../../../../script.js';

const MODULE_NAME = 'third-party/character-importer';
const STORE_NAMESPACE = 'character-importer';
const STORE_KEY = 'character_index';

// ---------------------------------------------------------------------------
// Extension Store (TauriTave persistent storage)
// ---------------------------------------------------------------------------

function getStore() {
    try {
        const host = window.__TAURITAVERN__;
        return host?.api?.extension?.store ?? null;
    } catch {
        return null;
    }
}

async function loadIndexFromStore() {
    const store = getStore();
    if (!store) return null;
    try {
        const result = await store.tryGetJson({ namespace: STORE_NAMESPACE, key: STORE_KEY });
        return result.found ? result.value : null;
    } catch {
        return null;
    }
}

async function saveIndexToStore() {
    const store = getStore();
    if (!store) return;
    try {
        const names = {};
        for (const c of characters) {
            const name = (c.data?.name ?? c.name ?? '').trim();
            if (name) names[name.toLowerCase()] = c.avatar ?? '';
        }
        await store.setJson({
            namespace: STORE_NAMESPACE,
            key: STORE_KEY,
            value: {
                builtAt: new Date().toISOString(),
                total: characters.length,
                names,
            },
        });
    } catch (err) {
        console.error('[CharImporter] store save error:', err);
    }
}


// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function appendLog(message) {
    const $area = $('#char_importer_log');
    const timestamp = new Date().toLocaleTimeString();
    $area.append(`[${timestamp}] ${message}\n`);
    $area.scrollTop($area[0].scrollHeight);
}

// ---------------------------------------------------------------------------
// 1. Initialize Index — reload character list and report count
// ---------------------------------------------------------------------------

async function onInitClick() {
    appendLog('[初始化索引] 正在加载角色列表…');
    try {
        await getCharacters();
        appendLog(`[初始化索引] 完成 — 共 ${characters.length} 张角色卡`);
        await saveIndexToStore();
        const store = getStore();
        if (store) appendLog('[初始化索引] 已持久化索引到本地存储');
    } catch (err) {
        appendLog(`[初始化索引] 加载失败: ${err.message ?? err}`);
    }
}

// ---------------------------------------------------------------------------
// 2. Import — overwrite on duplicate (same logic as original handleImportDuplicate)
// ---------------------------------------------------------------------------

/**
 * Extract base64-encoded JSON from a PNG tEXt chunk with correct UTF-8 handling.
 * `extractDataFromPng` in utils.js uses atob+JSON.parse which corrupts UTF-8 text,
 * so we do our own extraction with proper TextDecoder conversion.
 */
function extractCardFromPng(data, identifier) {
    if (!data || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4E || data[3] !== 0x47 ||
        data[4] !== 0x0D || data[5] !== 0x0A || data[6] !== 0x1A || data[7] !== 0x0A) {
        return null;
    }

    const uint8 = new Uint8Array(4);
    const uint32 = new Uint32Array(uint8.buffer);
    let idx = 8;

    while (idx < data.length) {
        uint8[3] = data[idx++]; uint8[2] = data[idx++]; uint8[1] = data[idx++]; uint8[0] = data[idx++];
        const length = uint32[0] + 4;
        const chunk = new Uint8Array(length);
        chunk[0] = data[idx++]; chunk[1] = data[idx++]; chunk[2] = data[idx++]; chunk[3] = data[idx++];

        const name = String.fromCharCode(chunk[0], chunk[1], chunk[2], chunk[3]);

        if (name === 'IEND') break;

        for (let i = 4; i < length; i++) chunk[i] = data[idx++];
        idx += 4; // CRC

        if (name === 'tEXt' && chunk.length - 4 > identifier.length &&
            [...Array(identifier.length)].every((_, i) => String.fromCharCode(chunk[i + 4]) === identifier[i])) {

            // Build base64 string from chunk bytes
            let b64buf = '';
            const bytes = new Uint8Array(chunk.buffer, 4);
            const start = identifier.length + 1;
            for (let i = start; i < bytes.length; i++) {
                b64buf += String.fromCharCode(bytes[i]);
            }

            // Fix: proper UTF-8 decoding (atob returns binary string, not UTF-8)
            const binary = atob(b64buf);
            const utf8Bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                utf8Bytes[i] = binary.charCodeAt(i) & 0xFF;
            }
            const text = new TextDecoder('utf-8').decode(utf8Bytes);
            try {
                return JSON.parse(text);
            } catch (e) {
                // Fallback: try direct JSON.parse (for ASCII-only cards)
                try { return JSON.parse(binary); } catch {}
                return null;
            }
        }
    }
    return null;
}

/**
 * Client-side peek: reads character name from PNG / JSON / WEBP / CHARX / YAML.
 */
async function peekCharacterFile(file) {
    const ext = (file.name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase();

    try {
        // JSON text-based cards
        if (ext === 'json') {
            const text = await file.text();
            const obj = JSON.parse(text);
            const name = obj?.data?.name ?? obj?.name ?? '';
            const version = obj?.data?.character_version ?? obj?.character_version ?? '';
            return { name, version };
        }
        if (ext === 'yaml' || ext === 'yml') {
            const text = await file.text();
            const nameMatch = text.match(/^\s*name\s*:\s*(.+)$/im);
            const verMatch = text.match(/^\s*character_version\s*:\s*(.+)$/im);
            const name = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, '').trim() : '';
            const version = verMatch ? verMatch[1].replace(/^["']|["']$/g, '').trim() : '';
            return { name, version };
        }

        // PNG / WEBP / CHARX → own extraction with correct UTF-8 handling
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const card = extractCardFromPng(bytes, 'chara')
                  || extractCardFromPng(bytes, 'ccv3')
                  || extractCardFromPng(bytes, 'byaf');
        if (card) {
            const name = card?.data?.name ?? card?.name ?? '';
            const version = card?.data?.character_version ?? card?.character_version ?? '';
            return { name, version };
        }

        return { name: '', version: '' };
    } catch (err) {
        console.error('[CharImporter] peek error:', file.name, err);
        return { name: '', version: '' };
    }
}

async function onImportClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.png,.json,.webp,.charx,.yaml,.yml';
    input.style.display = 'none';

    input.addEventListener('change', async () => {
        const files = Array.from(input.files);
        input.remove();
        if (files.length === 0) return;

        appendLog(`[导入] 已选择 ${files.length} 个文件`);
        const total = files.length;
        let ok = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const label = `[${i + 1}/${total}]`;
            appendLog(`${label} 处理: ${file.name}`);

            try {
                // --- Step 1: peek — same logic as original _peekCharacterFile ---
                const peeked = await peekCharacterFile(file);
                appendLog(`${label} 解析结果: name="${peeked.name}", version="${peeked.version}"`);

                if (!peeked.name) {
                    appendLog(`${label} 无法解析角色卡名称，跳过`);
                    continue;
                }

                // --- Step 2: duplicate check — use persistent index (O(1)) if available ---
                const peekedLower = peeked.name.trim().toLowerCase();
                let target = null;
                const storedIndex = await loadIndexFromStore();
                if (storedIndex?.names) {
                    const avatar = storedIndex.names[peekedLower];
                    if (avatar) {
                        target = { name: peeked.name.trim(), avatar };
                    }
                }
                // Fallback: scan in-memory characters array
                if (!target) {
                    const found = characters.find(c => {
                        const cName = (c.data?.name ?? c.name ?? '').trim().toLowerCase();
                        return cName === peekedLower;
                    });
                    if (found) target = { name: found.data?.name ?? found.name, avatar: found.avatar };
                }

                const isOverwrite = !!target;

                if (isOverwrite) {
                    appendLog(`${label} 检测到同名角色 "${target.name}"，执行覆盖更新`);
                    // Delete world book + old character (keep chats), then import as new.
                    // This avoids relying on `preserved_name` which some backends (TauriTave) don't support.
                    await deleteCharacterWorldBook(target);
                    const deleteRes = await fetch('/api/characters/delete', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ avatar_url: target.avatar, delete_chats: false }),
                    });
                    if (!deleteRes.ok) {
                        appendLog(`${label} 删除旧角色失败，跳过`);
                        continue;
                    }
                    appendLog(`${label} 已移除旧角色，保留对话`);
                } else {
                    appendLog(`${label} 新角色，直接导入`);
                }

                // --- Step 3: import via standard API ---
                const ext = (file.name.match(/\.(\w+)$/) ?? ['', 'png'])[1].toLowerCase();
                const formData = new FormData();
                formData.append('avatar', file);
                formData.append('file_type', ext);
                formData.append('user_name', name1);

                const importRes = await fetch('/api/characters/import', {
                    method: 'POST',
                    body: formData,
                    headers: getRequestHeaders({ omitContentType: true }),
                    cache: 'no-cache',
                });

                if (!importRes.ok) {
                    appendLog(`${label} 导入失败 HTTP ${importRes.status}`);
                    continue;
                }

                const result = await importRes.json();
                if (result.error) {
                    appendLog(`${label} 服务端错误: ${result.error}`);
                    continue;
                }

                const avatarFileName = `${result.file_name}.png`;

                // --- Step 4: for overwrites, re-associate old preserved chats ---
                if (isOverwrite) {
                    try {
                        const searchRes = await fetch('/api/chats/search', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({ avatar_url: avatarFileName }),
                        });
                        if (searchRes.ok) {
                            const chatList = await searchRes.json();
                            if (Array.isArray(chatList) && chatList.length > 0) {
                                chatList.sort((a, b) => (b.last_mes || 0) - (a.last_mes || 0));
                                const latestChat = chatList[0];
                                if (latestChat.file_name) {
                                    const mergeRes = await fetch('/api/characters/merge-attributes', {
                                        method: 'POST',
                                        headers: getRequestHeaders(),
                                        body: JSON.stringify({
                                            avatar: avatarFileName,
                                            chat: latestChat.file_name,
                                        }),
                                    });
                                    if (mergeRes.ok) {
                                        appendLog(`${label} 已绑定原对话: ${latestChat.file_name}`);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error('[CharImporter] chat re-associate error:', err);
                    }
                }

                ok++;
                const action = isOverwrite ? '覆盖' : '新建';
                appendLog(`${label} 完成 (${action}): ${avatarFileName}`);
            } catch (err) {
                appendLog(`${label} 异常: ${err.message ?? err}`);
                console.error('[CharImporter] import error:', err, file);
            }
        }

        appendLog(`[导入] 结束 — ${ok}/${total} 成功`);
        await getCharacters();
        await saveIndexToStore();
        if (ok > 0) location.reload();
    });

    document.body.appendChild(input);
    input.click();
}

// ---------------------------------------------------------------------------
// World book helpers (inlined from commit 8474da767)
// ---------------------------------------------------------------------------

async function deleteCharacterWorldBook(charEntry) {
    try {
        const res = await fetch('/api/characters/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: charEntry.avatar }),
        });
        if (!res.ok) return;

        const characterData = await res.json();
        const worldName = characterData?.data?.extensions?.world ?? '';
        if (!worldName) return;

        const deleteRes = await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName }),
        });
        if (deleteRes.ok) {
            appendLog(`  已删除关联世界书: "${worldName}"`);
        }
    } catch (err) {
        console.error('[CharImporter] world book delete error:', err);
    }
}

function convertCharacterBookToWorldInfo(characterBook) {
    const result = { ...characterBook, entries: {} };
    for (let i = 0; i < characterBook.entries.length; i++) {
        const entry = characterBook.entries[i];
        result.entries[i.toString()] = {
            uid: entry.id,
            key: entry.keys,
            keysecondary: entry.secondary_keys,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            order: entry.insertion_order,
            disable: !entry.enabled,
            position: entry.position === 'before_char' ? 0 : 1,
            use_regex: entry.use_regex ?? true,
            excludeRecursion: entry.extensions?.exclude_recursion,
            displayIndex: entry.extensions?.display_index,
            probability: entry.extensions?.probability ?? null,
            useProbability: entry.extensions?.useProbability ?? false,
            depth: entry.extensions?.depth ?? 4,
            selectiveLogic: entry.extensions?.selectiveLogic ?? 0,
            outletName: entry.extensions?.outlet_name ?? '',
            group: entry.extensions?.group ?? '',
            groupOverride: entry.extensions?.group_override ?? false,
            groupWeight: entry.extensions?.group_weight ?? null,
            preventRecursion: entry.extensions?.prevent_recursion ?? false,
            delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
            scanDepth: entry.extensions?.scan_depth ?? null,
            matchWholeWords: entry.extensions?.match_whole_words ?? null,
            useGroupScoring: entry.extensions?.use_group_scoring ?? false,
            caseSensitive: entry.extensions?.case_sensitive ?? null,
            automationId: entry.extensions?.automation_id ?? '',
            role: entry.extensions?.role ?? 0,
            vectorized: entry.extensions?.vectorized ?? false,
            sticky: entry.extensions?.sticky ?? null,
            cooldown: entry.extensions?.cooldown ?? null,
            delay: entry.extensions?.delay ?? null,
            matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
            matchCharacterDescription: entry.extensions?.match_character_description ?? false,
            matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
            matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
            matchScenario: entry.extensions?.match_scenario ?? false,
            matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
            triggers: entry.extensions?.triggers ?? [],
            ignoreBudget: entry.extensions?.ignore_budget ?? false,
        };
    }
    return result;
}

async function importCharacterWorldBook(avatarFileName) {
    try {
        const res = await fetch('/api/characters/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatarFileName }),
        });
        if (!res.ok) return;

        const characterData = await res.json();
        const worldName = characterData?.data?.extensions?.world ?? '';
        const characterBook = characterData?.data?.character_book;

        if (!worldName || !characterBook?.entries?.length) return;

        const worldData = convertCharacterBookToWorldInfo(characterBook);
        await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName, data: worldData }),
        });

        const mergeRes = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar: avatarFileName,
                data: { extensions: { world: worldName } },
            }),
        });
        if (mergeRes.ok) {
            appendLog(`  已导入并关联世界书: "${worldName}"`);
        }
    } catch (err) {
        console.error('[CharImporter] world book import error:', err);
    }
}

// ---------------------------------------------------------------------------
// 3. Clean Duplicates — client-side scan + select + delete
// ---------------------------------------------------------------------------

function findRelatedChars(baseName, chars) {
    const lowerBase = baseName.trim().toLowerCase();
    return chars.filter(c => {
        const cName = (c.data?.name ?? c.name ?? '').trim().toLowerCase();
        return cName === lowerBase || cName.startsWith(lowerBase + '_');
    });
}

function showDeleteSelectionPopup(relatedChars) {
    return new Promise(resolve => {
        const cardRows = relatedChars.map(c => {
            const charName = c.data?.name ?? c.name ?? c.avatar;
            const version = c.data?.character_version ?? c.character_version ?? '';
            const avatar = c.avatar ?? '';
            const thumbUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
            const itemId = `ci_del_${CSS.escape(avatar)}`;

            return `
<label class="ci-delete-card" for="${itemId}">
    <input type="checkbox" id="${itemId}" class="ci-delete-check" data-avatar="${avatar}">
    <div class="ci-delete-thumb-wrap">
        <img class="ci-delete-thumb" src="${thumbUrl}" onerror="this.src='/img/ai4.png'" alt="">
    </div>
    <div class="ci-delete-info">
        <span class="ci-delete-name">${charName}</span>
        ${version ? `<small class="ci-delete-version">v${version}</small>` : ''}
        <small class="ci-delete-avatar">${avatar}</small>
    </div>
</label>`;
        }).join('');

        const html = `
<div class="ci-delete-popup">
    <style>
        .ci-delete-popup { display:flex; flex-direction:column; gap:10px; min-width:320px; max-width:480px; }
        .ci-delete-header { font-size:0.95em; line-height:1.5; }
        .ci-delete-grid { display:flex; flex-direction:column; gap:6px; max-height:380px; overflow-y:auto; padding-right:4px; }
        .ci-delete-card {
            display:flex; align-items:center; gap:10px;
            padding:8px 10px; border-radius:6px; cursor:pointer;
            border:1px solid rgba(128,128,128,0.25);
            transition:background 0.15s;
        }
        .ci-delete-card:hover { background:rgba(255,255,255,0.06); }
        .ci-delete-card:has(.ci-delete-check:checked) { border-color:var(--SmartThemeQuoteColor,#888); background:rgba(255,255,255,0.07); }
        .ci-delete-check { flex-shrink:0; width:16px; height:16px; cursor:pointer; }
        .ci-delete-thumb-wrap { flex-shrink:0; }
        .ci-delete-thumb { width:48px; height:48px; object-fit:cover; border-radius:4px; }
        .ci-delete-info { display:flex; flex-direction:column; gap:2px; flex:1; overflow:hidden; }
        .ci-delete-name { font-weight:600; font-size:0.9em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ci-delete-version, .ci-delete-avatar { font-size:0.78em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0.5; }
        .ci-delete-actions { display:flex; gap:10px; justify-content:center; margin-top:8px; flex-wrap:wrap; }
        .ci-delete-actions .menu_button { min-width:140px; text-align:center; padding:6px 14px; }
    </style>

    <div class="ci-delete-header flex-container alignitemscenter flexwrap" style="justify-content:space-between; gap:10px;">
        <div style="flex:1;">以下是扫描出的所有<strong>相关（重复）角色卡</strong>，请勾选需要删除的旧版本：</div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;">
            <button id="ci_del_toggle_all" class="menu_button menu_button_icon" style="padding:4px 10px; font-size:0.85em; min-width:auto;">
                <i class="fa-solid fa-check-double"></i> <span>全选</span>
            </button>
            <label style="font-size:0.85em; cursor:pointer;">
                <input type="checkbox" id="ci_del_chats_checkbox"> 删除关联对话
            </label>
        </div>
    </div>

    <div class="ci-delete-grid">${cardRows}</div>

    <div class="ci-delete-actions">
        <button id="ci_del_cancel" class="menu_button">取消</button>
        <button id="ci_del_confirm" class="menu_button" style="background:rgba(180,60,60,0.4);border-color:rgba(180,60,60,0.7);">删除选中</button>
    </div>
</div>`;

        const overlay = document.createElement('div');
        overlay.id = 'ci_delete_overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:1000000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:var(--SmartThemeBubbleBgColor,#1a1a2e);color:var(--SmartThemeBodyColor,#ccc);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:10px;padding:18px;max-width:520px;width:90vw;max-height:90vh;overflow-y:auto;';
        dialog.innerHTML = html;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const $overlay = $(overlay);

        $overlay.find('#ci_del_toggle_all').on('click', function () {
            const allChecked = $overlay.find('.ci-delete-check').length === $overlay.find('.ci-delete-check:checked').length;
            $overlay.find('.ci-delete-check').prop('checked', !allChecked);
            $(this).find('span').text(!allChecked ? '取消全选' : '全选');
        });

        $overlay.find('#ci_del_cancel').on('click', () => { overlay.remove(); resolve(null); });

        $overlay.find('#ci_del_confirm').on('click', () => {
            const selected = [];
            $overlay.find('.ci-delete-check:checked').each(function () {
                selected.push($(this).data('avatar'));
            });
            const deleteChats = $overlay.find('#ci_del_chats_checkbox').prop('checked');
            overlay.remove();
            resolve({ selected, deleteChats });
        });

        overlay.addEventListener('click', e => {
            if (e.target === overlay) { overlay.remove(); resolve(null); }
        });
    });
}

async function scanDuplicatesAndCleanup() {
    if (!characters || characters.length === 0) {
        appendLog('[清理重复] 角色库为空');
        return;
    }

    appendLog('[清理重复] 开始全库扫描…');

    const sorted = [...characters]
        .map(c => ({ orig: c, name: (c.data?.name ?? c.name ?? '').trim().toLowerCase() }))
        .sort((a, b) => a.name.length - b.name.length);

    const processedAvatars = new Set();
    const allDuplicatesList = [];

    for (const item of sorted) {
        if (processedAvatars.has(item.orig.avatar)) continue;
        const baseName = item.orig.data?.name ?? item.orig.name ?? '';
        if (!baseName) continue;

        const related = findRelatedChars(baseName, characters);
        related.forEach(r => processedAvatars.add(r.avatar));
        if (related.length > 1) allDuplicatesList.push(...related);
    }

    appendLog(`[清理重复] 扫描完成，发现 ${allDuplicatesList.length} 个重复变体`);

    if (allDuplicatesList.length === 0) {
        appendLog('[清理重复] 未发现任何关联重复的角色卡');
        return;
    }

    const selectionResult = await showDeleteSelectionPopup(allDuplicatesList);
    if (!selectionResult?.selected?.length) {
        appendLog('[清理重复] 用户取消操作');
        return;
    }

    const { selected: selectedAvatars, deleteChats } = selectionResult;
    appendLog(`[清理重复] 正在删除 ${selectedAvatars.length} 张角色卡…`);

    let deletedCount = 0;
    for (const avatar of selectedAvatars) {
        const charEntry = characters.find(c => c.avatar === avatar);
        if (charEntry) await deleteCharacterWorldBook(charEntry);
        try {
            const res = await fetch('/api/characters/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, delete_chats: deleteChats }),
                cache: 'no-cache',
            });
            if (res.ok) {
                deletedCount++;
                if (eventSource && event_types?.CHARACTER_DELETED) {
                    eventSource.emit(event_types.CHARACTER_DELETED, { avatar });
                }
            }
        } catch (err) {
            console.error(`[CharImporter] delete failed for "${avatar}"`, err);
        }
    }

    appendLog(`[清理重复] 完成 — 已删除 ${deletedCount} 张卡片`);
    await getCharacters();
    await saveIndexToStore();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(async () => {
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings2').append(html);

    // Show current index status — try TauriTave store first, fall back to in-memory
    const showIndexStatus = async () => {
        const stored = await loadIndexFromStore();
        if (stored?.total > 0) {
            appendLog(`已加载持久化索引 — 共 ${stored.total} 张角色卡 (${new Date(stored.builtAt).toLocaleString()})`);
            return;
        }
        // Fallback: check in-memory characters (upstream ST)
        if (characters && characters.length > 0) {
            appendLog(`当前角色库共 ${characters.length} 张角色卡`);
            return;
        }
        appendLog('尚未初始化索引，请点击「初始化索引」加载角色列表');
    };
    if (eventSource && event_types?.APP_READY) {
        eventSource.once(event_types.APP_READY, () => showIndexStatus());
    } else {
        showIndexStatus();
    }

    $('#char_importer_init').on('click', onInitClick);
    $('#char_importer_import').on('click', onImportClick);
    $('#char_importer_clean_duplicates').on('click', scanDuplicatesAndCleanup);

    // --- Intercept normal character imports to keep index in sync ---
    // Only add NEW names; never overwrite existing index entries.
    if (typeof window !== 'undefined' && window.fetch) {
        const _origFetch = window.fetch;
        window.fetch = async function (url, options) {
            if (typeof url === 'string' && url === '/api/characters/import') {
                const oldIndex = await loadIndexFromStore();
                const result = await _origFetch.call(window, url, options);
                if (result.ok) {
                    setTimeout(async () => {
                        try {
                            await getCharacters();
                            const store = getStore();
                            if (!store) return;
                            const oldNames = oldIndex?.names ?? {};
                            const names = {};
                            for (const c of characters) {
                                const name = (c.data?.name ?? c.name ?? '').trim();
                                if (!name) continue;
                                const key = name.toLowerCase();
                                names[key] = oldNames[key] ?? (c.avatar ?? '');
                            }
                            await store.setJson({
                                namespace: STORE_NAMESPACE,
                                key: STORE_KEY,
                                value: {
                                    builtAt: new Date().toISOString(),
                                    total: Object.keys(names).length,
                                    names,
                                },
                            });
                        } catch {}
                    }, 1500);
                }
                return result;
            }
            return _origFetch.call(window, url, options);
        };
    }

    // --- Keep index in sync with character operations ---
    if (eventSource && event_types) {
        // Character deleted: remove from index
        if (event_types.CHARACTER_DELETED) {
            eventSource.on(event_types.CHARACTER_DELETED, async ({ character }) => {
                const store = getStore();
                if (!store) return;
                try {
                    const name = (character?.data?.name ?? character?.name ?? '').trim().toLowerCase();
                    if (!name) return;
                    const stored = await loadIndexFromStore();
                    if (stored?.names?.[name]) {
                        delete stored.names[name];
                        stored.total = Object.keys(stored.names).length;
                        await store.setJson({ namespace: STORE_NAMESPACE, key: STORE_KEY, value: stored });
                    }
                } catch {}
            });
        }

        // Character renamed: update key in index
        if (event_types.CHARACTER_RENAMED) {
            eventSource.on(event_types.CHARACTER_RENAMED, async (_oldAvatar, newAvatar) => {
                const store = getStore();
                if (!store) return;
                try {
                    const stored = await loadIndexFromStore();
                    if (!stored?.names) return;
                    // Find old name by avatar
                    const oldLower = Object.keys(stored.names).find(k => stored.names[k] === _oldAvatar);
                    if (!oldLower) return;
                    // Get new name from in-memory characters
                    const entry = characters.find(c => c.avatar === newAvatar);
                    const newName = (entry?.data?.name ?? entry?.name ?? '').trim().toLowerCase();
                    if (!newName) return;
                    delete stored.names[oldLower];
                    stored.names[newName] = newAvatar;
                    await store.setJson({ namespace: STORE_NAMESPACE, key: STORE_KEY, value: stored });
                } catch {}
            });
        }

        // Character duplicated: add to index
        if (event_types.CHARACTER_DUPLICATED) {
            eventSource.on(event_types.CHARACTER_DUPLICATED, async ({ newAvatar }) => {
                const store = getStore();
                if (!store) return;
                try {
                    const entry = characters.find(c => c.avatar === newAvatar);
                    const name = (entry?.data?.name ?? entry?.name ?? '').trim().toLowerCase();
                    if (!name) return;
                    const stored = await loadIndexFromStore();
                    if (!stored) return;
                    stored.names = stored.names || {};
                    stored.names[name] = newAvatar;
                    stored.total = Object.keys(stored.names).length;
                    stored.builtAt = new Date().toISOString();
                    await store.setJson({ namespace: STORE_NAMESPACE, key: STORE_KEY, value: stored });
                } catch {}
            });
        }
    }
});
