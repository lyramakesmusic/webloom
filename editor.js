// editor.js - Text editor with tree synchronization

// Editor state
let editorState = {
    nodeId: null,          // Currently displayed node path endpoint
    segments: [],          // Array of { nodeId, start, end, text } for tracking
    isUpdating: false,     // Prevent recursive updates
    structureChanged: false, // Track if tree structure changed (needs full re-render)
    selectionStart: 0,     // Selection start before input (for replace detection)
    selectionEnd: 0,       // Selection end before input
    // Live-split mode state
    liveSplitMode: false,  // Whether we're in live-split mode
    liveSplitNodeId: null, // The visible node being edited in live-split
    liveSplitHiddenId: null, // The hidden child accumulating deleted chars
    // Cursor focus (separate from view focus)
    cursorNodeId: null,    // Node where cursor/typing goes (may differ from selected_node_id)
    inlineEditNodeId: null // Node in inline edit mode (append instead of branch)
};

// Debounced save/render for performance
let saveDebounceTimer = null;
let renderDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 300;
const RENDER_DEBOUNCE_MS = 100;

// Helper: update selected node and path together (for editor operations)
// Uses current path as hint to preserve DAG branch context
function updateSelectedNode(nodeId) {
    if (!nodeId || !appState.tree.nodes[nodeId]) {
        appState.tree.selected_node_id = null;
        appState.tree.selected_path = [];
        return;
    }
    const oldPath = appState.tree.selected_path || [];
    const newPath = getPathToNode(appState.tree.nodes, nodeId, oldPath);
    appState.tree.selected_path = newPath.map(n => n.id);
    appState.tree.selected_node_id = nodeId;
}

// Undo/redo state (tree snapshots)
let undoStack = [];
let redoStack = [];
const MAX_UNDO_STATES = 50;

function debouncedSave() {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => saveTree(), SAVE_DEBOUNCE_MS);
}

// Push current tree state to undo stack (call before making changes)
function pushUndoState() {
    const snapshot = JSON.stringify(appState.tree);
    // Avoid duplicate consecutive states
    if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) return;
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO_STATES) undoStack.shift();
    redoStack = []; // clear redo on new action
}

function undo() {
    if (undoStack.length === 0) return;
    // Save current state for redo
    redoStack.push(JSON.stringify(appState.tree));
    // Restore previous state
    const snapshot = undoStack.pop();
    appState.tree = JSON.parse(snapshot);
    renderTree();
    updateEditor(true);
    saveTree();
}

function redo() {
    if (redoStack.length === 0) return;
    // Save current state for undo
    undoStack.push(JSON.stringify(appState.tree));
    // Restore next state
    const snapshot = redoStack.pop();
    appState.tree = JSON.parse(snapshot);
    renderTree();
    updateEditor(true);
    saveTree();
}

// Split node at current cursor position (for split button)
function splitAtCursor() {
    const editor = document.getElementById('editor');
    if (!editor) return;

    // Preserve scroll position
    const scrollTop = editor.scrollTop;

    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const cursorPos = getAbsoluteOffset(editor, range.startContainer, range.startOffset);

    // Don't split at position 0 or at the very end
    const totalLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);
    if (cursorPos <= 0 || cursorPos >= totalLen) {
        console.log('[editor] splitAtCursor: cannot split at boundary', { cursorPos, totalLen });
        return;
    }

    console.log('[editor] splitAtCursor at position:', cursorPos);

    // Save state for undo
    pushUndoState();

    // Use branching edit with no delete and no insert - just split
    handleBranchingEdit(cursorPos, 0, '');

    // Refresh, reformat, and re-render
    refreshSegments();
    autoformatTree(appState.tree.nodes);
    saveTree();
    renderTree();
    updateEditor(true);

    // Restore scroll position
    editor.scrollTop = scrollTop;

    // Place cursor at the split point (end of the branch point node)
    const branchPointLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);
    placeCursorAtPosition(branchPointLen);
}

// Generate from cursor position - splits first if cursor is not at end
// When n=1, auto-selects the result like continue
async function generateFromCursor() {
    const editor = document.getElementById('editor');
    const selectedId = appState.tree.selected_node_id;

    if (!selectedId) {
        showError('No node selected');
        return;
    }

    // Get cursor position and total length
    let cursorPos = 0;
    const totalLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);

    if (editor) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            cursorPos = getAbsoluteOffset(editor, range.startContainer, range.startOffset);
        }
    }

    // If cursor is not at the end, split first
    if (cursorPos > 0 && cursorPos < totalLen) {
        console.log('[editor] generateFromCursor: splitting at', cursorPos, 'of', totalLen);
        pushUndoState();
        handleBranchingEdit(cursorPos, 0, '');
        refreshSegments();
        autoformatTree(appState.tree.nodes);
        saveTree();
        renderTree();
        updateEditor(true);
    }

    // Generate from the (possibly new) selected node
    const generateFromId = appState.tree.selected_node_id;
    if (generateFromId) {
        const n = parseInt(document.getElementById('siblings-input').value) || 3;
        await generateCompletions(generateFromId);

        // When n=1, auto-select the result like continue
        if (n === 1) {
            const children = getChildren(appState.tree.nodes, generateFromId);
            if (children.length > 0) {
                const newestChild = children[children.length - 1];
                selectNode(newestChild.id);
            }
        }
    }
}

// Continue from cursor - splits first if needed, generates single completion, selects it
async function continueFromCursor() {
    const editor = document.getElementById('editor');
    const selectedId = appState.tree.selected_node_id;

    if (!selectedId) {
        showError('No node selected');
        return;
    }

    // Get cursor position and total length
    let cursorPos = 0;
    const totalLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);

    if (editor) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            cursorPos = getAbsoluteOffset(editor, range.startContainer, range.startOffset);
        }
    }

    // If cursor is not at the end, split first
    if (cursorPos > 0 && cursorPos < totalLen) {
        console.log('[editor] continueFromCursor: splitting at', cursorPos, 'of', totalLen);
        pushUndoState();
        handleBranchingEdit(cursorPos, 0, '');
        refreshSegments();
        autoformatTree(appState.tree.nodes);
        saveTree();
        renderTree();
        updateEditor(true);
    }

    // Generate single completion from the (possibly new) selected node
    const generateFromId = appState.tree.selected_node_id;
    if (generateFromId) {
        await generateCompletions(generateFromId, 1);
        // Select the spawned node and update editor
        const children = getChildren(appState.tree.nodes, generateFromId);
        if (children.length > 0) {
            const newestChild = children[children.length - 1];
            selectNode(newestChild.id);
            updateEditor(true);
        }
    }
}

function debouncedRenderTree() {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => renderTree(), RENDER_DEBOUNCE_MS);
}

// Exit live-split mode (called on type, paste, click elsewhere)
function exitLiveSplitMode() {
    if (editorState.liveSplitMode) {
        console.log('[editor] exiting live-split mode');
        editorState.liveSplitMode = false;
        editorState.liveSplitNodeId = null;
        editorState.liveSplitHiddenId = null;
    }
}

// Handle live-split backspace: remove char from visible, prepend to hidden child
// Returns true if handled (in live-split mode), false otherwise
function handleLiveSplitBackspace(position) {
    const nodes = appState.tree.nodes;
    const segment = findSegmentAtPosition(position);
    if (!segment) return false;

    const node = nodes[segment.nodeId];
    if (!node) return false;

    // Check if we should use live-split (AI node, or human with children)
    const children = getChildren(nodes, node.id);
    const shouldLiveSplit = node.type === 'ai' || (node.type === 'human' && children.length > 0);
    if (!shouldLiveSplit) return false;

    const offsetInNode = position - segment.start;
    if (offsetInNode <= 0) return false; // Can't backspace at start of node

    // Normalize node text
    node.text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Get the character being deleted
    const deletedChar = node.text[offsetInNode - 1];
    const beforeText = node.text.substring(0, offsetInNode - 1);
    const afterText = node.text.substring(offsetInNode);
    const newText = beforeText + afterText;

    // Special case: backspacing whitespace at AI node boundary (offset 1) - just edit silently
    // Don't create live-split structure for simple boundary cleanup
    if (node.type === 'ai' && offsetInNode === 1 && /\s/.test(deletedChar)) {
        console.log('[editor] AI boundary whitespace: silent edit');
        node.text = newText;
        return true;
    }

    // SPEC 2.2b: If this backspace would EMPTY a human node with children,
    // use destructive behavior (children reparent to grandparent, node deleted)
    // The char is lost, NOT preserved in hidden child
    if (node.type === 'human' && children.length > 0 && !newText) {
        console.log('[editor] human-with-children empties: using 2.2b behavior (destructive)');
        editorState.structureChanged = true;
        exitLiveSplitMode();

        const nodeParentIds = getParentIds(node);

        // Reparent children to grandparent
        children.forEach(child => {
            child.parent_ids = nodeParentIds.length > 0 ? [...nodeParentIds] : [];
        });

        // Update selection to parent (or first child if root)
        if (nodeParentIds.length > 0) {
            updateSelectedNode(nodeParentIds[0]);
        } else {
            // Root empties - promote first child to root
            const firstChild = children[0];
            firstChild.parent_ids = [];
            updateSelectedNode(firstChild.id);
        }

        // Delete the empty node
        delete nodes[node.id];
        return true;
    }

    // Check if we're continuing in live-split mode on the same node
    if (editorState.liveSplitMode && editorState.liveSplitNodeId === node.id && editorState.liveSplitHiddenId) {
        const hiddenNode = nodes[editorState.liveSplitHiddenId];
        if (hiddenNode) {
            // Prepend deleted char to hidden child
            hiddenNode.text = deletedChar + (hiddenNode.text || '');
            node.text = newText;

            // If AI node empties, handle specially
            if (!node.text && node.type === 'ai') {
                handleEmptyLiveSplitNode(node, hiddenNode);
            }

            console.log('[editor] live-split continue: prepended', JSON.stringify(deletedChar), 'to hidden, now:', hiddenNode.text);
            editorState.structureChanged = true;
            return true;
        }
    }

    // Entering live-split mode: create hidden child with deleted char
    editorState.structureChanged = true;

    // Remove char from visible
    node.text = newText;

    // Create hidden child with the deleted char
    const existingChildren = getChildren(nodes, node.id);

    const hiddenChild = createNode(node.id, deletedChar, node.type, node.model, {
        x: node.position.x + 320,
        y: node.position.y
    }, {
        temperature: node.temperature,
        min_p: node.min_p,
        max_tokens: node.max_tokens
    });
    nodes[hiddenChild.id] = hiddenChild;

    // Reparent existing children to hidden child
    existingChildren.forEach(child => {
        child.parent_ids = [hiddenChild.id];
    });

    // Enter live-split mode
    editorState.liveSplitMode = true;
    editorState.liveSplitNodeId = node.id;
    editorState.liveSplitHiddenId = hiddenChild.id;

    console.log('[editor] entered live-split mode: visible=', node.id, 'hidden=', hiddenChild.id, 'char=', deletedChar);

    // If AI node empties after first backspace, handle specially
    if (!node.text && node.type === 'ai') {
        handleEmptyLiveSplitNode(node, hiddenChild);
    }

    return true;
}

// Handle when a live-split node empties (selection moves to parent, mode continues)
function handleEmptyLiveSplitNode(emptyNode, hiddenNode) {
    const nodes = appState.tree.nodes;
    const emptyNodeParentIds = getParentIds(emptyNode);
    console.log('[editor] live-split node emptied:', emptyNode.id);

    if (emptyNodeParentIds.length > 0) {
        // Reparent hidden child to grandparent
        hiddenNode.parent_ids = [...emptyNodeParentIds];

        // Update selection to parent
        updateSelectedNode(emptyNodeParentIds[0]);

        // Update live-split to track parent
        editorState.liveSplitNodeId = emptyNodeParentIds[0];

        // Delete the empty node
        delete nodes[emptyNode.id];
    } else {
        // Root node emptied - promote hidden child to root
        hiddenNode.parent_ids = [];
        updateSelectedNode(hiddenNode.id);

        // Exit live-split since we're now on the hidden branch
        exitLiveSplitMode();

        // Delete the empty root
        delete nodes[emptyNode.id];
    }
}

// Initialize editor
function initEditor() {
    const editor = document.getElementById('editor');
    if (!editor) return;

    // Capture selection BEFORE input (for detecting replace operations)
    editor.addEventListener('beforeinput', handleEditorBeforeInput);

    // Input handler for user edits
    editor.addEventListener('input', handleEditorInput);

    // Paste/drop handlers - plain text only
    editor.addEventListener('paste', handleEditorPaste);
    editor.addEventListener('dragover', handleEditorDragover);
    editor.addEventListener('drop', handleEditorDrop);

    // Keyboard shortcuts
    editor.addEventListener('keydown', handleEditorKeydown);

    // Click anywhere in container to focus editor (mobile fix)
    const container = document.querySelector('.editor-container');
    if (container) {
        container.addEventListener('click', (e) => {
            if (e.target === container) {
                editor.focus();
            }
        });
    }
}

// Capture selection before input for accurate replace detection
function handleEditorBeforeInput(e) {
    const editor = e.target;
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        editorState.selectionStart = getAbsoluteOffset(editor, range.startContainer, range.startOffset);
        editorState.selectionEnd = getAbsoluteOffset(editor, range.endContainer, range.endOffset);
        const selLen = editorState.selectionEnd - editorState.selectionStart;
        if (selLen > 0) {
            console.log('[editor] beforeinput captured selection:', editorState.selectionStart, '-', editorState.selectionEnd, '(len:', selLen + ')');
        }
    } else {
        editorState.selectionStart = 0;
        editorState.selectionEnd = 0;
    }
}

// Update editor to show text for selected node
function updateEditor(skipCursorRestore = false) {
    if (editorState.isUpdating) return;
    editorState.isUpdating = true;
    editorState.skipCursorRestore = skipCursorRestore;

    const editor = document.getElementById('editor');
    if (!editor) {
        editorState.isUpdating = false;
        return;
    }

    const selectedId = appState.tree.selected_node_id;

    if (!selectedId || !appState.tree.nodes[selectedId]) {
        editor.innerHTML = '';
        editorState.nodeId = null;
        editorState.segments = [];
        editorState.isUpdating = false;
        // Keep focus so user can type to create new root
        editor.focus();
        return;
    }

    editorState.nodeId = selectedId;

    // Get path from root to selected node (use stored path as hint for DAG navigation)
    const pathHint = appState.tree.selected_path || [];
    const path = getPathToNode(appState.tree.nodes, selectedId, pathHint);

    // Build segments for color-coded display
    editorState.segments = [];
    let position = 0;

    path.forEach(node => {
        // Normalize text to ensure consistent positions (handles imported \r\n)
        const text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (text) {
            editorState.segments.push({
                nodeId: node.id,
                start: position,
                end: position + text.length,
                text: text,
                type: node.type,
                model: node.model,
                temperature: node.temperature,
                min_p: node.min_p,
                max_tokens: node.max_tokens
            });
            position += text.length;
        }
    });

    // Render with color-coded spans
    renderEditorContent(editor, editorState.segments);

    editorState.isUpdating = false;
}

// Render editor content with color-coded spans
function renderEditorContent(editor, segments) {
    // Save cursor position
    const selection = window.getSelection();
    let cursorOffset = 0;

    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        cursorOffset = getAbsoluteOffset(editor, range.startContainer, range.startOffset);
    }

    // Build HTML
    let html = '';

    segments.forEach(segment => {
        const colorClass = segment.type === 'human'
            ? 'text-human'
            : `text-model-${getModelColorIndex(segment.model)}`;

        const tooltip = segment.type === 'human' ? 'human'
            : `${segment.model || 'unknown'}\ntemp: ${segment.temperature ?? '?'}, min_p: ${segment.min_p ?? '?'}, max: ${segment.max_tokens ?? '?'}`;

        const escapedText = escapeHtml(segment.text);
        html += `<span class="${colorClass}" data-node-id="${segment.nodeId}" title="${tooltip}">${escapedText}</span>`;
    });

    // Add zero-width space at the very end if content ends with a newline
    // This allows cursor to be positioned after trailing newline for text insertion
    if (html.endsWith('</span>') && segments.length > 0 && segments[segments.length - 1].text.endsWith('\n')) {
        html += '\u200B';
    }

    editor.innerHTML = html || '';

    // If cursorNodeId is set, position cursor at end of that node's segment (not end of doc)
    if (editorState.cursorNodeId) {
        const cursorSegment = segments.find(s => s.nodeId === editorState.cursorNodeId);
        if (cursorSegment) {
            restoreCursorPosition(editor, cursorSegment.end);
            editorState.skipCursorRestore = false;
            return;
        }
    }

    // Restore cursor position (unless skipped due to tree structure change)
    if (!editorState.skipCursorRestore && cursorOffset > 0 && document.activeElement === editor) {
        restoreCursorPosition(editor, cursorOffset);
    }
    editorState.skipCursorRestore = false;
}

// Handle editor input
function handleEditorInput(e) {
    if (editorState.isUpdating) return;

    const editor = e.target;

    // Capture cursor position BEFORE processing (after browser's DOM update)
    // Cursor is positioned right after any inserted text
    const selection = window.getSelection();
    let cursorAfterInput = 0;
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        cursorAfterInput = getAbsoluteOffset(editor, range.startContainer, range.startOffset);
    }

    // Get text from DOM using innerText (handles BR correctly)
    // Normalize: strip ZWS (cursor positioning only), NBSP to space, line endings
    let newText = (editor.innerText || '').replace(/\u200B/g, '').replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let oldText = editorState.segments.map(s => s.text).join('').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Browser adds exactly ONE trailing newline artifact after BRs for cursor positioning
    // Only strip 1 from newText if it has MORE trailing newlines than oldText
    const countTrailingNewlines = s => { let c = 0; for (let i = s.length - 1; i >= 0 && s[i] === '\n'; i--) c++; return c; };
    const oldTrailing = countTrailingNewlines(oldText);
    const newTrailing = countTrailingNewlines(newText);
    if (newTrailing > oldTrailing) {
        // Strip exactly 1 (the browser artifact)
        newText = newText.slice(0, -1);
    }

    // Debug: detect large text mismatch
    if (Math.abs(newText.length - oldText.length) > 100) {
        console.warn('[editor] Large text delta detected:', {
            oldLen: oldText.length,
            newLen: newText.length,
            delta: newText.length - oldText.length,
            segments: editorState.segments.length,
            selectedId: appState.tree.selected_node_id
        });
    }

    // Find what changed
    const changes = findChanges(oldText, newText);

    // Fix character collision in diff: when inserted/replaced char matches existing char,
    // diff reports wrong position. Use cursor/selection to find true location.
    if (changes.type === 'insert' && cursorAfterInput > 0) {
        // For inserts: cursor is right AFTER inserted text
        const trueStart = cursorAfterInput - changes.text.length;
        if (trueStart >= 0 && trueStart !== changes.start) {
            console.log('[editor] correcting insert position from', changes.start, 'to', trueStart, '(cursor at', cursorAfterInput + ')');
            changes.start = trueStart;
        }
    } else if (changes.type === 'replace' || changes.type === 'delete') {
        // For replacements/deletes: use captured selection from beforeinput event
        // Note: a "delete" might actually be a replace where typed char matched deleted char
        const selectionLength = editorState.selectionEnd - editorState.selectionStart;

        if (selectionLength > 0) {
            // User had a selection - this is a replace operation
            const typedLength = newText.length - oldText.length + selectionLength;
            const trueInsertText = typedLength > 0
                ? newText.substring(editorState.selectionStart, editorState.selectionStart + typedLength)
                : '';

            // Check if we need to correct anything
            const needsCorrection = changes.type === 'delete' ||
                                   changes.start !== editorState.selectionStart ||
                                   (changes.type === 'replace' && changes.deleteCount !== selectionLength);

            if (needsCorrection) {
                console.log('[editor] correcting', changes.type, '→ replace: start', changes.start, '→', editorState.selectionStart,
                            ', deleteCount', changes.deleteCount || changes.count, '→', selectionLength,
                            ', insertText "' + (changes.insertText || '') + '" → "' + trueInsertText + '"');
                changes.type = 'replace';
                changes.start = editorState.selectionStart;
                changes.deleteCount = selectionLength;
                changes.insertText = trueInsertText;
                delete changes.count; // Remove delete-style count if present
            }
        }
    }


    if (changes.type === 'none') return;

    // Save state for undo before making changes
    pushUndoState();

    // Track node count before to detect structure changes
    const nodeCountBefore = Object.keys(appState.tree.nodes).length;
    editorState.structureChanged = false;

    // Apply changes to tree
    applyChangesToTree(changes, oldText, newText);

    // Check if structure changed
    const nodeCountAfter = Object.keys(appState.tree.nodes).length;
    const structureChanged = editorState.structureChanged || nodeCountBefore !== nodeCountAfter;

    // Update segments to match tree
    refreshSegments();
    const newTotalLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);
    console.log('[editor] after refresh, segment total len:', newTotalLen, 'expected (old + change):', oldText.length + (changes.type === 'insert' ? changes.text.length : changes.type === 'delete' ? -changes.count : changes.insertText.length - changes.deleteCount));

    // Debounced save and tree render
    debouncedSave();
    debouncedRenderTree();

    if (structureChanged) {
        // Structure changed - need full rebuild with cursor restore
        let cursorPos = 0;
        if (changes.type === 'insert') {
            cursorPos = changes.start + changes.text.length;
        } else if (changes.type === 'delete') {
            cursorPos = changes.start;
        } else if (changes.type === 'replace') {
            cursorPos = changes.start + changes.insertText.length;
        }
        console.log('[editor] structure changed, restoring cursor to:', cursorPos, 'change was at:', changes.start);

        // Reposition from root once (repositionSiblings is recursive)
        const root = findRoot(appState.tree.nodes);
        if (root) repositionSiblings(root.id);

        updateEditor(true);
        placeCursorAtPosition(cursorPos);
    }
    // If no structure change, browser already updated DOM - just sync data
}

// Find changes between old and new text
function findChanges(oldText, newText) {
    if (oldText === newText) {
        return { type: 'none' };
    }

    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < oldText.length && prefixLen < newText.length &&
        oldText[prefixLen] === newText[prefixLen]) {
        prefixLen++;
    }

    // Find common suffix
    let oldSuffixStart = oldText.length;
    let newSuffixStart = newText.length;

    while (oldSuffixStart > prefixLen && newSuffixStart > prefixLen &&
        oldText[oldSuffixStart - 1] === newText[newSuffixStart - 1]) {
        oldSuffixStart--;
        newSuffixStart--;
    }

    const deletedText = oldText.substring(prefixLen, oldSuffixStart);
    const insertedText = newText.substring(prefixLen, newSuffixStart);

    if (deletedText && insertedText) {
        return {
            type: 'replace',
            start: prefixLen,
            deleteCount: deletedText.length,
            insertText: insertedText
        };
    } else if (insertedText) {
        return {
            type: 'insert',
            start: prefixLen,
            text: insertedText
        };
    } else if (deletedText) {
        return {
            type: 'delete',
            start: prefixLen,
            count: deletedText.length
        };
    }

    return { type: 'none' };
}

// Apply changes to the tree structure
function applyChangesToTree(changes, oldText, newText) {
    let selectedId = appState.tree.selected_node_id;
    const selectedNode = selectedId ? appState.tree.nodes[selectedId] : null;

    // No valid node exists - create root on insert
    if (!selectedNode && changes.type === 'insert') {
        exitLiveSplitMode();
        editorState.structureChanged = true;
        const root = createNode(null, changes.text, 'human', null, { x: 100, y: 200 }, {});
        appState.tree.nodes[root.id] = root;
        updateSelectedNode(root.id);
        refreshSegments();
        saveTree();
        renderTree();
        panToNode(root.id);
        return;
    }

    if (!selectedNode) return;

    // Check if delete/replace is in an AI node or human with children (needs live-split)
    const segment = findSegmentAtPosition(changes.start);
    const node = segment ? appState.tree.nodes[segment.nodeId] : null;
    const nodeChildren = node ? getChildren(appState.tree.nodes, node.id) : [];
    const needsLiveSplit = node && (node.type === 'ai' || (node.type === 'human' && nodeChildren.length > 0));

    // Find which segment(s) are affected
    if (changes.type === 'insert') {
        // Exit live-split mode on insert/type
        exitLiveSplitMode();
        handleInsert(changes.start, changes.text);
    } else if (changes.type === 'delete') {
        // Single char delete (backspace) uses live-split for AI and human-with-children
        if (changes.count === 1 && needsLiveSplit) {
            if (handleLiveSplitBackspace(changes.start + changes.count)) {
                refreshSegments();
                return;
            }
        }

        // Exit live-split mode
        exitLiveSplitMode();

        const deleteEnd = changes.start + changes.count;
        const totalLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);

        // Spec 6.1: Select-all (entire document) → destructive, empty tree
        const isSelectAll = changes.start === 0 && deleteEnd >= totalLen;

        // Check if delete spans multiple nodes
        const spansMultipleNodes = editorState.segments.some((seg, i) => {
            const startsInSeg = changes.start >= seg.start && changes.start < seg.end;
            const endsInDiffSeg = editorState.segments.some((seg2, j) =>
                j !== i && deleteEnd > seg2.start && deleteEnd <= seg2.end
            );
            return startsInSeg && endsInDiffSeg;
        });

        // Spec 4.3: Full SELECTION of single node WITH PARENT → branch
        // But spec 2.2: Single-char backspace that empties node → destructive
        // Check if delete exactly matches one segment and node has parent
        const wouldEmptyOneNode = segment && changes.start === segment.start &&
            deleteEnd === segment.end && node;
        const nodeParentIds = node ? getParentIds(node) : [];
        const nodeHasParent = nodeParentIds.length > 0;
        // Only branch for full-node selection (count > 1), not single-char backspace
        const isSelectionDelete = changes.count > 1;
        const fullNodeWithParent = wouldEmptyOneNode && nodeHasParent && isSelectionDelete;

        // Spec 2.4: Human bridge between two AI nodes should recombine, not branch
        let isAIBridge = false;
        if (fullNodeWithParent && node.type === 'human') {
            const parent = appState.tree.nodes[nodeParentIds[0]];
            const children = getChildren(appState.tree.nodes, node.id);
            // Bridge = parent is AI and has at least one AI child
            isAIBridge = parent && parent.type === 'ai' &&
                children.some(c => c.type === 'ai');
        }

        // Determine if branching is needed:
        // - AI nodes always branch
        // - Multi-node selection branches (unless select-all)
        // - Full selection of node with parent branches (spec 4.3)
        // - EXCEPT: AI bridges recombine (spec 2.4)
        const shouldBranch = !isSelectAll && !isAIBridge && (
            (node && node.type === 'ai') ||
            spansMultipleNodes ||
            fullNodeWithParent
        );

        if (isSelectAll) {
            // Spec 6.1: Select-all clears ENTIRE tree (not just path nodes)
            Object.keys(appState.tree.nodes).forEach(id => delete appState.tree.nodes[id]);
            updateSelectedNode(null);
            editorState.structureChanged = true;
        } else if (shouldBranch) {
            handleBranchingEdit(changes.start, changes.count, '');
        } else {
            handleDestructiveDelete(changes.start, changes.count);
        }
    } else if (changes.type === 'replace') {
        // Exit live-split on replace (which includes typing)
        exitLiveSplitMode();

        // Check if this is a select-all replace (spec 6.2)
        const totalLen = editorState.segments.reduce((sum, s) => sum + (s.text?.length || 0), 0);
        const isSelectAllReplace = changes.start === 0 && changes.deleteCount >= totalLen;

        if (isSelectAllReplace) {
            // Spec 6.2: Select-all + type clears entire tree and creates new root
            Object.keys(appState.tree.nodes).forEach(id => delete appState.tree.nodes[id]);
            editorState.structureChanged = true;
            const root = createNode(null, changes.insertText, 'human', null, { x: 100, y: 200 }, {});
            appState.tree.nodes[root.id] = root;
            updateSelectedNode(root.id);
        } else if (node && node.type === 'ai') {
            // AI nodes branch, human nodes use destructive
            handleBranchingEdit(changes.start, changes.deleteCount, changes.insertText);
        } else {
            handleDestructiveDelete(changes.start, changes.deleteCount);
            refreshSegments();
            handleInsert(changes.start, changes.insertText);
        }
    }

    // Refresh segments
    refreshSegments();
}

// Handle text insertion
function handleInsert(position, text) {
    let segment = findSegmentAtPosition(position);
    console.log('[editor] handleInsert:', { position, textLen: text.length, segmentNodeId: segment?.nodeId, segmentStart: segment?.start, segmentEnd: segment?.end, cursorNodeId: editorState.cursorNodeId });

    // If cursorNodeId is set & position is at boundary, use cursorNode instead
    if (editorState.cursorNodeId && segment) {
        const cursorSegment = editorState.segments.find(s => s.nodeId === editorState.cursorNodeId);
        if (cursorSegment && position === cursorSegment.end) {
            // Position is at end of cursor node - use cursor node for this edit
            segment = cursorSegment;
            console.log('[editor] using cursorNodeId segment:', cursorSegment.nodeId);
        }
    }

    if (!segment) {
        // Append to end of last node, or create new root
        const selectedId = appState.tree.selected_node_id;
        if (selectedId) {
            const node = appState.tree.nodes[selectedId];
            if (node) {
                node.text = (node.text || '') + text;
            }
        } else {
            // No segments and no selected node (tree was cleared) - create new root
            editorState.structureChanged = true;
            const root = createNode(null, text, 'human', null, { x: 100, y: 200 }, {});
            appState.tree.nodes[root.id] = root;
            updateSelectedNode(root.id);
        }
        return;
    }

    const node = appState.tree.nodes[segment.nodeId];
    if (!node) {
        // Stale segment pointing to deleted node - create new root
        editorState.structureChanged = true;
        const root = createNode(null, text, 'human', null, { x: 100, y: 200 }, {});
        appState.tree.nodes[root.id] = root;
        updateSelectedNode(root.id);
        return;
    }

    // Calculate position within this node's text
    const nodeOffset = position - segment.start;

    if (node.type === 'human') {
        // Normalize node text to match diff positions (handles imported \r\n)
        const nodeText = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        node.text = nodeText; // Store normalized version
        const atEnd = nodeOffset >= nodeText.length;
        const children = getChildren(appState.tree.nodes, node.id);
        const hasChildren = children.length > 0;
        console.log('[editor] human node insert:', { nodeId: node.id, nodeText, nodeOffset, atEnd, hasChildren, childIds: children.map(c => c.id) });

        // If appending to end of human node that has children, create new human child
        // EXCEPT if we're in inline edit mode for this node (e.g., after branching edit)
        if (atEnd && hasChildren && editorState.inlineEditNodeId !== node.id) {
            editorState.structureChanged = true;
            const newNode = createNode(node.id, text, 'human', null, {
                x: node.position.x + 320,
                y: node.position.y
            }, {});
            appState.tree.nodes[newNode.id] = newNode;
            updateSelectedNode(newNode.id);
            return;
        }

        // Otherwise insert text directly
        const before = nodeText.substring(0, nodeOffset);
        const after = nodeText.substring(nodeOffset);
        node.text = before + text + after;
    } else {
        // AI node - check for adjacent human nodes at boundaries
        const segmentIndex = editorState.segments.indexOf(segment);

        // At start of AI node - append to previous node (human OR AI parent)
        // This handles boundary inserts between adjacent nodes in the path
        if (nodeOffset === 0 && segmentIndex > 0) {
            const prevSegment = editorState.segments[segmentIndex - 1];
            const prevNode = appState.tree.nodes[prevSegment.nodeId];
            if (prevNode) {
                console.log('[editor] AI boundary insert: appending to', prevNode.id, 'type:', prevNode.type);
                prevNode.text = (prevNode.text || '') + text;
                return;
            }
        }

        // Normalize AI node text to match diff positions
        node.text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // At end of AI node - prepend to next human node if exists
        if (nodeOffset === node.text.length && segmentIndex < editorState.segments.length - 1) {
            const nextSegment = editorState.segments[segmentIndex + 1];
            const nextNode = appState.tree.nodes[nextSegment.nodeId];
            if (nextNode && nextNode.type === 'human') {
                nextNode.text = text + (nextNode.text || '');
                return;
            }
        }

        // No adjacent human node - split AI node
        splitNodeForInsertion(node, nodeOffset, text);
    }
}

// Split an AI node to insert human text
function splitNodeForInsertion(node, offset, insertText) {
    console.log('[editor] splitNodeForInsertion:', { nodeId: node.id, nodeType: node.type, offset, insertTextLen: insertText.length });
    editorState.structureChanged = true;
    const nodes = appState.tree.nodes;

    // Normalize node text to match diff positions (handles imported \r\n)
    node.text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const beforeText = node.text.substring(0, offset);
    const afterText = node.text.substring(offset);
    const originalSelectedId = appState.tree.selected_node_id;

    if (!afterText) {
        // Inserting at end - just append or create child
        if (beforeText === node.text) {
            // Create new human child
            const newNode = createNode(node.id, insertText, 'human', null, {
                x: node.position.x + 320,
                y: node.position.y
            }, {});
            nodes[newNode.id] = newNode;

            // Only change selection if we were selecting the split node
            if (originalSelectedId === node.id) {
                updateSelectedNode(newNode.id);
            }
        }
        return;
    }

    // Special case: inserting at very start (offset 0) - create sibling, don't empty the node
    const nodeParentIds = getParentIds(node);
    if (!beforeText && nodeParentIds.length > 0) {
        // Create human node as sibling (same parent as AI node)
        const humanNode = createNode(nodeParentIds[0], insertText, 'human', null, {
            x: node.position.x,
            y: node.position.y - 40
        }, {});
        nodes[humanNode.id] = humanNode;
        if (originalSelectedId === node.id) {
            updateSelectedNode(humanNode.id);
        }
        return;
    }

    // Split: before stays in node, create human node, move after to new child
    node.text = beforeText;

    // Get existing children
    const existingChildren = getChildren(nodes, node.id);

    // Create human insertion node
    const humanNode = createNode(node.id, insertText, 'human', null, {
        x: node.position.x + 160,
        y: node.position.y
    }, {});
    nodes[humanNode.id] = humanNode;

    // Create continuation node for 'after' text
    const afterNode = createNode(humanNode.id, afterText, node.type, node.model, {
        x: humanNode.position.x + 160,
        y: humanNode.position.y
    }, {
        temperature: node.temperature,
        min_p: node.min_p,
        max_tokens: node.max_tokens
    });
    afterNode.splitFrom = node.id; // Mark as continuation of original node
    nodes[afterNode.id] = afterNode;

    // Reparent existing children to afterNode
    existingChildren.forEach(child => {
        child.parent_ids = [afterNode.id];
    });

    // Only change selection if we were selecting the split node itself
    // Otherwise preserve selection (descendant nodes are now under afterNode)
    if (originalSelectedId === node.id) {
        updateSelectedNode(afterNode.id);
    }
    // Note: repositionSiblings is called from root after structure changes
}

// Handle branching edit: split tree at position, preserve original as branch, optionally add new text as sibling
// Per spec 5.1: multi-node selection splits at start, hides original, duplicates remainder to visible path
function handleBranchingEdit(position, deleteCount, insertText) {
    console.log('[editor] handleBranchingEdit:', { position, deleteCount, insertTextLen: insertText?.length || 0 });
    editorState.structureChanged = true;
    const nodes = appState.tree.nodes;

    const segment = findSegmentAtPosition(position);
    if (!segment) {
        if (insertText) {
            const root = createNode(null, insertText, 'human', null, { x: 100, y: 200 }, {});
            nodes[root.id] = root;
            updateSelectedNode(root.id);
        }
        return;
    }

    const node = nodes[segment.nodeId];
    if (!node) {
        if (insertText) {
            const root = createNode(null, insertText, 'human', null, { x: 100, y: 200 }, {});
            nodes[root.id] = root;
            updateSelectedNode(root.id);
        }
        return;
    }

    // Calculate remainder text ONLY from the node where selection ends (not all downstream nodes)
    // Downstream nodes are preserved via reparenting to continuation node
    const endPosition = position + deleteCount;
    const endSegment = findSegmentAtPosition(endPosition > 0 ? endPosition - 1 : 0);
    let remainderText = '';
    if (endSegment && deleteCount > 0) {
        const endOffsetInSeg = endPosition - endSegment.start;
        const endNodeText = (endSegment.text || '');
        if (endOffsetInSeg < endNodeText.length) {
            remainderText = endNodeText.substring(endOffsetInSeg);
        }
    }

    // Normalize node text
    node.text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const offsetInNode = position - segment.start;
    let branchPoint;
    let existingChildren = []; // Capture for later use
    let hiddenNodeId = null; // Track hidden branch for DAG structure

    // Calculate how much of deleteCount falls within this node
    const deleteCountInNode = Math.min(deleteCount, node.text.length - offsetInNode);

    if (offsetInNode > 0) {
        // Selection starts in middle of node - split into THREE parts:
        // 1. textBefore (stays in original node)
        // 2. selectedText (goes to hidden branch - ONLY the selected portion)
        // 3. textAfterSelection (continues on visible path)
        const textBefore = node.text.substring(0, offsetInNode);
        const selectedText = node.text.substring(offsetInNode, offsetInNode + deleteCountInNode);
        const textAfterSelection = node.text.substring(offsetInNode + deleteCountInNode);

        // Keep textBefore in original node
        node.text = textBefore;

        // Get existing children before we modify anything
        existingChildren = getChildren(nodes, node.id);

        // Create hidden branch with ONLY the selected text (not the entire continuation)
        if (selectedText) {
            const hiddenNode = createNode(node.id, selectedText, node.type, node.model, {
                x: node.position.x + 160,
                y: node.position.y - 40
            }, {
                temperature: node.temperature,
                min_p: node.min_p,
                max_tokens: node.max_tokens
            });
            hiddenNode.splitFrom = node.id;
            nodes[hiddenNode.id] = hiddenNode;
            hiddenNodeId = hiddenNode.id; // Track for DAG
        }

        // Store textAfterSelection for visible path continuation (used in remainderText logic below)
        // Override remainderText with the text after selection within this node
        if (textAfterSelection) {
            remainderText = textAfterSelection;
        }

        branchPoint = node;
    } else {
        // Selection starts at beginning of node - branch point is parent
        // Capture existing children BEFORE modifying anything - they need to follow visible path
        existingChildren = getChildren(nodes, node.id);

        const nodeParentIds = getParentIds(node);
        if (nodeParentIds.length > 0) {
            branchPoint = nodes[nodeParentIds[0]];
        } else {
            // Node is root and selection starts at 0 - create empty root as parent
            const emptyRoot = createNode(null, '', 'human', null, {
                x: node.position.x - 160,
                y: node.position.y
            }, {});
            nodes[emptyRoot.id] = emptyRoot;
            node.parent_ids = [emptyRoot.id];
            branchPoint = emptyRoot;
        }

        // When selection starts at beginning, the original node becomes part of hidden branch
        // Calculate how much of this node is selected and handle remainder
        const selectedTextInNode = node.text.substring(0, deleteCountInNode);
        const textAfterSelection = node.text.substring(deleteCountInNode);

        if (textAfterSelection) {
            // Original node still has remainder - truncate to selected portion (hidden)
            // The textAfterSelection will become the visible continuation
            node.text = selectedTextInNode;
            remainderText = textAfterSelection;
            hiddenNodeId = node.id; // The original node IS the hidden branch
        }
        // If no textAfterSelection, the entire node is selected - it stays as hidden branch
    }

    // Create separate nodes for human text and AI remainder (don't mix types)
    let newSelectedId = null;

    if (insertText && branchPoint) {
        // Create human node with typed text
        const humanNode = createNode(branchPoint.id, insertText, 'human', null, {
            x: branchPoint.position.x + 160,
            y: branchPoint.position.y + 60
        }, {});
        nodes[humanNode.id] = humanNode;
        newSelectedId = humanNode.id;

        // If there's remainder text, create AI continuation as child of human node
        if (remainderText) {
            const aiNode = createNode(humanNode.id, remainderText, 'ai', node.model, {
                x: humanNode.position.x + 160,
                y: humanNode.position.y
            }, {
                temperature: node.temperature,
                min_p: node.min_p,
                max_tokens: node.max_tokens
            });
            nodes[aiNode.id] = aiNode;

            // DAG structure: aiNode has both humanNode AND hiddenNode as parents (1-2-1 merge)
            // This allows viewing the continuation from either the visible OR hidden branch
            if (hiddenNodeId) {
                aiNode.parent_ids = [humanNode.id, hiddenNodeId];
            }

            // Children follow the visible path (aiNode), not the hidden branch
            existingChildren.forEach(child => {
                child.parent_ids = [aiNode.id];
            });

            // Preserve original selection depth: if original selected node is now a descendant
            // of aiNode (via reparented children), keep it selected to show full context
            const originalSelectedId = appState.tree.selected_node_id;
            let keepOriginalSelection = false;
            if (originalSelectedId && originalSelectedId !== node.id) {
                // Check if original selection is a descendant of any reparented child
                const isDescendantOfVisible = existingChildren.some(child => {
                    if (child.id === originalSelectedId) return true;
                    // Check if original is a descendant of this child
                    const descendants = getDescendants(nodes, child.id);
                    return descendants.some(d => d.id === originalSelectedId);
                });
                if (isDescendantOfVisible) {
                    keepOriginalSelection = true;
                }
            }

            if (keepOriginalSelection) {
                // Keep original selection - full context stays visible
                newSelectedId = originalSelectedId;
            } else {
                // Fall back to aiNode if original isn't accessible
                newSelectedId = aiNode.id;
            }
            editorState.cursorNodeId = humanNode.id;
            editorState.inlineEditNodeId = humanNode.id;
        }
    } else if (remainderText && branchPoint) {
        // No insertText but has remainder - create AI node directly
        const aiNode = createNode(branchPoint.id, remainderText, 'ai', node.model, {
            x: branchPoint.position.x + 160,
            y: branchPoint.position.y + 60
        }, {
            temperature: node.temperature,
            min_p: node.min_p,
            max_tokens: node.max_tokens
        });
        nodes[aiNode.id] = aiNode;

        // DAG structure: aiNode has both branchPoint AND hiddenNode as parents (1-2-1 merge)
        if (hiddenNodeId) {
            aiNode.parent_ids = [branchPoint.id, hiddenNodeId];
        }

        // Children follow the visible path (aiNode), not the hidden branch
        existingChildren.forEach(child => {
            child.parent_ids = [aiNode.id];
        });

        newSelectedId = aiNode.id;
    }

    if (newSelectedId) {
        updateSelectedNode(newSelectedId);
    } else if (branchPoint) {
        // Pure split with no remainder (selection extends to end of doc)
        const branchPointText = (branchPoint.text || '').trim();
        if (!branchPointText) {
            const children = getChildren(nodes, branchPoint.id);
            if (children.length > 0) {
                updateSelectedNode(children[0].id);
            } else {
                updateSelectedNode(branchPoint.id);
            }
        } else {
            updateSelectedNode(branchPoint.id);
        }
    }
}

// Check if a position is inside an AI node
function isPositionInAINode(position) {
    const segment = findSegmentAtPosition(position);
    if (!segment) return false;
    const node = appState.tree.nodes[segment.nodeId];
    return node && node.type === 'ai';
}

// Check if a delete operation would completely empty any node
// Returns true only if branching is appropriate (node has parent or siblings)
function wouldDeleteEmptyNode(position, count) {
    const endPosition = position + count;

    for (const segment of editorState.segments) {
        const overlapStart = Math.max(position, segment.start);
        const overlapEnd = Math.min(endPosition, segment.end);

        if (overlapStart < overlapEnd) {
            const node = appState.tree.nodes[segment.nodeId];
            if (!node) continue;

            const nodeText = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const deleteStart = overlapStart - segment.start;
            const deleteEnd = overlapEnd - segment.start;

            // Would this delete empty the node?
            const before = nodeText.substring(0, deleteStart);
            const after = nodeText.substring(deleteEnd);
            if ((before + after).length === 0) {
                // Only branch if the node has a parent (not root) or has siblings
                // Branching a lone root node creates an unusable empty root
                const nodeParentIds = getParentIds(node);
                if (nodeParentIds.length > 0) {
                    return true; // Has parent, safe to branch
                }
                // Check if node has siblings (other roots or children of same parent)
                const siblings = Object.values(appState.tree.nodes).filter(n => {
                    if (n.id === node.id) return false;
                    const nParentIds = getParentIds(n);
                    // Same parents means siblings
                    return nodeParentIds.length === 0 ? nParentIds.length === 0 :
                        nodeParentIds.some(pid => nParentIds.includes(pid));
                });
                if (siblings.length > 0) {
                    return true; // Has siblings, safe to branch
                }
                // Lone root with no parent - don't branch, just delete normally
                return false;
            }
        }
    }
    return false;
}

// Handle text deletion (destructive - for single char backspace without selection)
function handleDestructiveDelete(position, count) {
    const endPosition = position + count;
    console.log('[editor] handleDestructiveDelete:', { position, count, endPosition });

    // Compute all deletions upfront from current segments (avoids stale iteration)
    const deletions = [];
    for (const segment of editorState.segments) {
        const overlapStart = Math.max(position, segment.start);
        const overlapEnd = Math.min(endPosition, segment.end);

        if (overlapStart < overlapEnd) {
            deletions.push({
                nodeId: segment.nodeId,
                startOffset: overlapStart - segment.start,
                endOffset: overlapEnd - segment.start
            });
        }
    }

    // Apply deletions to nodes
    for (const del of deletions) {
        const node = appState.tree.nodes[del.nodeId];
        if (!node) continue;

        // Normalize node text to match diff positions (handles imported \r\n)
        node.text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        const before = node.text.substring(0, del.startOffset);
        const after = node.text.substring(del.endOffset);
        node.text = before + after;

        if (!node.text) {
            maybeRemoveEmptyNode(node);
        }
    }
}

// Remove empty node, reparenting children to grandparent
function maybeRemoveEmptyNode(node) {
    const nodeParentIds = getParentIds(node);
    console.log('[editor] maybeRemoveEmptyNode:', { nodeId: node.id, type: node.type, hasParent: nodeParentIds.length > 0 });
    editorState.structureChanged = true;
    const nodes = appState.tree.nodes;

    // If root node is emptied, promote child on selected branch to new root
    if (nodeParentIds.length === 0) {
        const children = getChildren(nodes, node.id);
        if (children.length === 0) {
            // No children - actually clear the tree
            Object.keys(nodes).forEach(id => delete nodes[id]);
            updateSelectedNode(null);
            return;
        }

        // Find child on path to selected node (or first child if root was selected)
        let newRoot = children[0];
        if (appState.tree.selected_node_id && appState.tree.selected_node_id !== node.id) {
            const pathHint = appState.tree.selected_path || [];
            const path = getPathToNode(nodes, appState.tree.selected_node_id, pathHint);
            // path[0] is root, path[1] is the child we want
            if (path.length > 1 && path[0].id === node.id) {
                newRoot = path[1];
            }
        }

        // Promote child to root
        newRoot.parent_ids = [];

        // Reparent other children to the new root (prevents orphans)
        children.forEach(child => {
            if (child.id !== newRoot.id) {
                child.parent_ids = [newRoot.id];
            }
        });

        delete nodes[node.id];

        // Update selection if it was on the old root
        if (appState.tree.selected_node_id === node.id) {
            updateSelectedNode(newRoot.id);
        }
        return;
    }

    const parent = nodes[nodeParentIds[0]];
    const children = getChildren(nodes, node.id);

    // Check for split AI node recombination:
    // If this empty human node sits between a parent AI node and a single child AI node
    // that was split from that parent, recombine them
    if (node.type === 'human' && parent && parent.type === 'ai' &&
        children.length === 1 && children[0].type === 'ai' &&
        children[0].splitFrom === parent.id) {

        const continuation = children[0];

        // Merge continuation text into parent
        parent.text = (parent.text || '') + (continuation.text || '');

        // Reparent continuation's children to parent
        getChildren(nodes, continuation.id).forEach(child => {
            child.parent_ids = [parent.id];
        });

        // Update selection
        if (appState.tree.selected_node_id === node.id ||
            appState.tree.selected_node_id === continuation.id) {
            updateSelectedNode(parent.id);
        }

        // Delete the empty human node and the continuation node
        delete nodes[node.id];
        delete nodes[continuation.id];
        return;
    }

    // Update selection before deleting
    if (appState.tree.selected_node_id === node.id) {
        updateSelectedNode(nodeParentIds[0]);
    }

    // Delete node but preserve children (reparent to grandparent)
    deleteNodePreserveChildren(nodes, node.id);
}

// Find segment at a text position
function findSegmentAtPosition(position) {
    for (const segment of editorState.segments) {
        // Use < for end because end is exclusive (position after last char)
        if (position >= segment.start && position < segment.end) {
            return segment;
        }
    }
    // Position is at or after the end - return last segment for appending
    return editorState.segments[editorState.segments.length - 1] || null;
}

// Refresh segments after tree modification
function refreshSegments() {
    const selectedId = appState.tree.selected_node_id;
    if (!selectedId) {
        editorState.segments = [];
        return;
    }

    // Use stored path as hint for DAG navigation
    const pathHint = appState.tree.selected_path || [];
    const path = getPathToNode(appState.tree.nodes, selectedId, pathHint);
    editorState.segments = [];
    let position = 0;

    path.forEach(node => {
        // Normalize text to ensure consistent positions (handles imported \r\n)
        const text = (node.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (text) {
            editorState.segments.push({
                nodeId: node.id,
                start: position,
                end: position + text.length,
                text: text,
                type: node.type,
                model: node.model,
                temperature: node.temperature,
                min_p: node.min_p,
                max_tokens: node.max_tokens
            });
            position += text.length;
        }
    });
}

// Unified text insertion: handles paste, enter, drop
// 1. Get cursor position and selection
// 2. Insert text node at cursor
// 3. Place cursor at end of inserted text (in text node, not after element)
// 4. Trigger input event for tree sync
function insertTextAtCursor(text) {
    const editor = document.getElementById('editor');
    if (!editor) return;

    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);

    // Delete any selected content first
    range.deleteContents();

    // Create text node and insert
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);

    // CRITICAL: Place cursor at END of the inserted text node
    // Use setStart with the text node itself, not setStartAfter (which uses parent element)
    range.setStart(textNode, text.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    // Trigger input event for tree sync
    editor.dispatchEvent(new Event('input', { bubbles: true }));
}

// Handle paste - plain text only, normalize line endings
function handleEditorPaste(e) {
    e.preventDefault();
    let text = e.clipboardData.getData('text/plain');
    if (!text) return;

    // Normalize line endings: \r\n → \n, lone \r → \n
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    insertTextAtCursor(text);
}

// Handle dragover - required to allow drop
function handleEditorDragover(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
}

// Handle drop - plain text only, normalize line endings
function handleEditorDrop(e) {
    e.preventDefault();
    let text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
    if (!text) return;

    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Position cursor at drop point
    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) return;

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    insertTextAtCursor(text);
}

// Handle keyboard shortcuts
function handleEditorKeydown(e) {
    // Undo - prevent browser undo which conflicts with tree structure
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
    }

    // Redo (Ctrl+Y or Ctrl+Shift+Z)
    if ((e.key === 'y' && (e.ctrlKey || e.metaKey)) ||
        (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
        e.preventDefault();
        redo();
        return;
    }

    // Ctrl+Enter to generate (splits at cursor if not at end)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generateFromCursor();
        return;
    }

    // Plain Enter - insert newline
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        insertTextAtCursor('\n');
    }

    // Escape - deselect (collapse selection to cursor)
    if (e.key === 'Escape') {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            // Only act if there's an actual selection (not just a cursor)
            if (!range.collapsed) {
                e.preventDefault();
                // Collapse to the end of the selection
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    }
}

// Get absolute character offset from DOM position
// DOM offset rules: for text nodes, offset is char index; for elements, offset is child index
function getAbsoluteOffset(container, node, offset) {
    // Edge case: node is the container itself
    if (node === container) {
        return sumTextInChildren(container, offset);
    }

    // Edge case: node is not inside container
    if (!container.contains(node)) {
        console.warn('[editor] getAbsoluteOffset: node not in container');
        return 0;
    }

    let total = 0;

    // Walk all nodes in document order
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL, null, false);
    let current;

    while ((current = walker.nextNode())) {
        if (current === node) {
            // Found our node - add the offset within it
            if (node.nodeType === Node.TEXT_NODE) {
                return total + offset;
            } else {
                // Element node: offset is child index, sum text in children 0..offset-1
                return total + sumTextInChildren(node, offset);
            }
        }

        // Count text/br we pass
        if (current.nodeType === Node.TEXT_NODE) {
            total += current.textContent.length;
        } else if (current.nodeName === 'BR') {
            total += 1;
        }
    }

    // Node not found in walk - shouldn't happen if contains() passed
    console.warn('[editor] getAbsoluteOffset: node not found in tree walk');
    return total;
}

// Sum text length in first N children of an element (for element offset conversion)
function sumTextInChildren(element, childCount) {
    let total = 0;
    const children = element.childNodes;
    for (let i = 0; i < childCount && i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === Node.TEXT_NODE) {
            total += child.textContent.length;
        } else if (child.nodeName === 'BR') {
            total += 1;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            // Recurse into nested elements (spans, etc)
            total += getTextLength(child);
        }
    }
    return total;
}

// Get total text length of an element (recursive)
function getTextLength(element) {
    let total = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL, null, false);
    let current;
    while ((current = walker.nextNode())) {
        if (current.nodeType === Node.TEXT_NODE) {
            total += current.textContent.length;
        } else if (current.nodeName === 'BR') {
            total += 1;
        }
    }
    return total;
}

// Place cursor at specific character position
function placeCursorAtPosition(offset) {
    const editor = document.getElementById('editor');
    if (!editor) return;
    editor.focus();
    restoreCursorPosition(editor, offset);
}

// Get current cursor position as character offset (returns 0 if no selection)
function getCursorPosition(container) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return 0;
    const range = selection.getRangeAt(0);
    return getAbsoluteOffset(container, range.startContainer, range.startOffset);
}

// Restore cursor to character offset in container
// Handles text nodes, <br> elements, and edge cases
function restoreCursorPosition(container, offset) {
    // Safety: ensure offset is a valid number
    if (typeof offset !== 'number' || isNaN(offset)) {
        console.warn('[editor] restoreCursorPosition: invalid offset', offset);
        offset = 0;
    }

    // Edge case: empty container
    if (!container.hasChildNodes()) {
        const range = document.createRange();
        range.setStart(container, 0);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return;
    }

    // Edge case: offset 0 or negative - place at very start
    if (offset <= 0) {
        const firstNode = findFirstTextOrBr(container);
        const range = document.createRange();
        if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
            range.setStart(firstNode, 0);
        } else if (firstNode && firstNode.nodeName === 'BR') {
            range.setStartBefore(firstNode);
        } else {
            range.setStart(container, 0);
        }
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return;
    }

    let remaining = offset;
    let lastValidNode = null;  // last text node or BR we saw
    let lastValidOffset = 0;   // offset within that node (or 0 for BR)

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL, null, false);
    let current;

    while ((current = walker.nextNode())) {
        if (current.nodeType === Node.TEXT_NODE) {
            const len = current.textContent.length;
            if (remaining <= len) {
                // Cursor lands in this text node
                setCursor(current, remaining);
                return;
            }
            remaining -= len;
            lastValidNode = current;
            lastValidOffset = len;
        } else if (current.nodeName === 'BR') {
            if (remaining <= 1) {
                // Cursor lands at this BR (after it)
                setCursorAfter(current);
                return;
            }
            remaining -= 1;
            lastValidNode = current;
            lastValidOffset = 0; // will use setStartAfter
        }
    }

    // Offset was beyond text length - place at end
    if (lastValidNode) {
        if (lastValidNode.nodeType === Node.TEXT_NODE) {
            setCursor(lastValidNode, lastValidOffset);
        } else {
            setCursorAfter(lastValidNode);
        }
    } else {
        // No text content at all - place at container start
        const range = document.createRange();
        range.setStart(container, 0);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    }
}

// Helper: find first text node or BR in container
function findFirstTextOrBr(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL, null, false);
    let current;
    while ((current = walker.nextNode())) {
        if (current.nodeType === Node.TEXT_NODE || current.nodeName === 'BR') {
            return current;
        }
    }
    return null;
}

// Helper: set cursor at position in text node
function setCursor(textNode, offset) {
    const range = document.createRange();
    // Clamp offset to valid range
    const maxOffset = textNode.textContent.length;
    range.setStart(textNode, Math.min(offset, maxOffset));
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
}

// Helper: set cursor after a node (for BR elements)
function setCursorAfter(node) {
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
}

// Model color index (1-5, cycling)
const modelColorIndices = new Map();
let nextColorIndex = 1;

function getModelColorIndex(model) {
    if (!model) return 1;

    if (!modelColorIndices.has(model)) {
        modelColorIndices.set(model, nextColorIndex);
        nextColorIndex = (nextColorIndex % 5) + 1;
    }

    return modelColorIndices.get(model);
}

// Update model legend by scanning tree nodes
function updateModelLegend() {
    const legend = document.getElementById('model-legend');
    if (!legend) return;

    // Always show "human" first
    let html = `<div class="legend-item">
        <span class="legend-dot color-human"></span>
        <span class="legend-name">human</span>
    </div>`;

    // Scan tree for all unique models and ensure they have color indices
    const models = new Set();
    Object.values(appState.tree.nodes).forEach(node => {
        if (node.type === 'ai' && node.model) {
            models.add(node.model);
            getModelColorIndex(node.model); // ensure color is assigned
        }
    });

    models.forEach(model => {
        const colorIndex = getModelColorIndex(model);
        html += `<div class="legend-item">
            <span class="legend-dot color-${colorIndex}"></span>
            <span class="legend-name" title="${model}">${model}</span>
        </div>`;
    });
    legend.innerHTML = html;
}

// Get text content from DOM, properly handling BR elements as newlines
function getTextFromDOM(container) {
    let text = '';
    const walk = node => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeName === 'BR') {
            text += '\n';
        } else {
            for (const child of node.childNodes) {
                walk(child);
            }
        }
    };
    walk(container);
    return text;
}

// Escape HTML and convert newlines to <br> for proper display
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // Normalize line endings and convert to <br>
    return div.innerHTML.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '<br>');
}
