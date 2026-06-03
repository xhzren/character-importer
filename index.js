import { renderExtensionTemplateAsync } from '../../extensions.js';

const MODULE_NAME = 'character-importer';

/** @type {string[]} */
let fileList = [];

function appendLog(message) {
    const $area = $('#char_importer_log');
    const timestamp = new Date().toLocaleTimeString();
    $area.append(`[${timestamp}] ${message}\n`);
    $area.scrollTop($area[0].scrollHeight);
}

function clearLog() {
    $('#char_importer_log').val('');
}

function refreshFileListDisplay() {
    const $area = $('#char_importer_log');
    if (fileList.length === 0) {
        $area.val('');
        return;
    }
    $area.val(fileList.join('\n'));
}

function onInitClick() {
    appendLog('[初始化] 扫描角色目录...');
    // TODO: real logic
    appendLog('[初始化] 完成 (占位)');
}

function onImportClick() {
    if (fileList.length === 0) {
        appendLog('[导入] 没有待处理的文件');
        return;
    }
    appendLog(`[导入] 开始处理 ${fileList.length} 个文件...`);
    // TODO: real logic
    appendLog('[导入] 完成 (占位)');
}

function onCleanDuplicatesClick() {
    appendLog('[清理重复] 检查重复角色卡...');
    // TODO: real logic
    appendLog('[清理重复] 完成 (占位)');
}

function setupDragDrop() {
    const $dropZone = $('#char_importer_drop_zone');
    if (!$dropZone.length) return;

    $dropZone.on('dragover', (e) => {
        e.preventDefault();
        $dropZone.addClass('ci-drop-active');
    });

    $dropZone.on('dragleave', () => {
        $dropZone.removeClass('ci-drop-active');
    });

    $dropZone.on('drop', (e) => {
        e.preventDefault();
        $dropZone.removeClass('ci-drop-active');

        const files = Array.from(e.originalEvent.dataTransfer.files)
            .map(f => f.name)
            .filter(name => /\.(png|json|webp|charx|yaml|yml)$/i.test(name));

        if (files.length === 0) {
            appendLog('[拖放] 未检测到支持的角色卡文件 (.png/.json/.webp/.charx/.yaml)');
            return;
        }

        fileList = files;
        refreshFileListDisplay();
        appendLog(`[拖放] 已添加 ${files.length} 个文件`);
    });
}

jQuery(async () => {
    const container = $('#character_importer_container');
    if (!container.length) return;

    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    container.append(html);

    $('#char_importer_init').on('click', onInitClick);
    $('#char_importer_import').on('click', onImportClick);
    $('#char_importer_clean_duplicates').on('click', onCleanDuplicatesClick);

    setupDragDrop();
});
