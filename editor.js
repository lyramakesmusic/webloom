// editor.js - Text editor with tree synchronization

// Editor state
let editorState = {
    nodeId: null,          // Currently displayed node path endpoint
    segments: [],          // Array of { nodeId, start, end, text } for tracking
    isUpdating: false,     // Prevent recursive updates
    structureChanged: false, // Track if tree structure changed (needs full re-render)
    selectionStart: 0,     // Selection start before input (for replace detection)
    selectionEnd: 0        // Selection end before input
};

// Debounced save/render for performance
let saveDebounceTimer = null;
let renderDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 300;
const RENDER_DEBOUNCE_MS = 100;

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

function debouncedRenderTree() {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => renderTree(), RENDER_DEBOUNCE_MS);
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

    // Get path from root to selected node
    const path = getPathToNode(appState.tree.nodes, selectedId);

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

    editor.innerHTML = html || '';

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

    // innerText can return trailing \n for empty lines or after <br>, normalize it
    let newText = editor.innerText || '';
    // Normalize line endings: \r\n → \n, lone \r → \n, strip trailing browser-added \n
    newText = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
    // Also normalize oldText - node text may have \r\n from imported files
    let oldText = editorState.segments.map(s => s.text).join('');
    oldText = oldText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
        editorState.structureChanged = true;
        const root = createNode(null, changes.text, 'human', null, { x: 100, y: 200 }, {});
        appState.tree.nodes[root.id] = root;
        appState.tree.selected_node_id = root.id;
        refreshSegments();
        saveTree();
        renderTree();
        panToNode(root.id);
        return;
    }

    if (!selectedNode) return;

    // Find which segment(s) are affected
    if (changes.type === 'insert') {
        handleInsert(changes.start, changes.text);
    } else if (changes.type === 'delete') {
        handleDelete(changes.start, changes.count);
    } else if (changes.type === 'replace') {
        handleDelete(changes.start, changes.deleteCount);
        handleInsert(changes.start, changes.insertText);
    }

    // Refresh segments
    refreshSegments();
}

// Handle text insertion
function handleInsert(position, text) {
    const segment = findSegmentAtPosition(position);
    console.log('[editor] handleInsert:', { position, textLen: text.length, segmentNodeId: segment?.nodeId, segmentStart: segment?.start, segmentEnd: segment?.end });

    if (!segment) {
        // Append to end of last node, or create new root
        const selectedId = appState.tree.selected_node_id;
        if (selectedId) {
            const node = appState.tree.nodes[selectedId];
            if (node) {
                node.text = (node.text || '') + text;
            }
        }
        return;
    }

    const node = appState.tree.nodes[segment.nodeId];
    if (!node) return;

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
        // This preserves context for existing generations
        if (atEnd && hasChildren) {
            editorState.structureChanged = true;
            const newNode = createNode(node.id, text, 'human', null, {
                x: node.position.x + 320,
                y: node.position.y
            }, {});
            appState.tree.nodes[newNode.id] = newNode;
            appState.tree.selected_node_id = newNode.id;
            return;
        }

        // Otherwise insert text directly
        const before = nodeText.substring(0, nodeOffset);
        const after = nodeText.substring(nodeOffset);
        node.text = before + text + after;
    } else {
        // AI node - check for adjacent human nodes at boundaries
        const segmentIndex = editorState.segments.indexOf(segment);

        // At start of AI node - append to previous human node if exists
        // Note: Always append here (don't create child) to preserve AI continuation in path
        if (nodeOffset === 0 && segmentIndex > 0) {
            const prevSegment = editorState.segments[segmentIndex - 1];
            const prevNode = appState.tree.nodes[prevSegment.nodeId];
            if (prevNode && prevNode.type === 'human') {
                console.log('[editor] AI boundary insert: appending to', prevNode.id);
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
                appState.tree.selected_node_id = newNode.id;
            }
        }
        return;
    }

    // Special case: inserting at very start (offset 0) - create sibling, don't empty the node
    if (!beforeText && node.parent_id) {
        // Create human node as sibling (same parent as AI node)
        const humanNode = createNode(node.parent_id, insertText, 'human', null, {
            x: node.position.x,
            y: node.position.y - 40
        }, {});
        nodes[humanNode.id] = humanNode;
        if (originalSelectedId === node.id) {
            appState.tree.selected_node_id = humanNode.id;
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
        child.parent_id = afterNode.id;
    });

    // Only change selection if we were selecting the split node itself
    // Otherwise preserve selection (descendant nodes are now under afterNode)
    if (originalSelectedId === node.id) {
        appState.tree.selected_node_id = afterNode.id;
    }
    // Note: repositionSiblings is called from root after structure changes
}

// Handle text deletion
function handleDelete(position, count) {
    const endPosition = position + count;
    console.log('[editor] handleDelete:', { position, count, endPosition });

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
    console.log('[editor] maybeRemoveEmptyNode:', { nodeId: node.id, type: node.type, hasParent: !!node.parent_id });
    editorState.structureChanged = true;
    const nodes = appState.tree.nodes;

    // If root node is emptied, promote child on selected branch to new root
    if (!node.parent_id) {
        const children = getChildren(nodes, node.id);
        if (children.length === 0) {
            // No children - actually clear the tree
            Object.keys(nodes).forEach(id => delete nodes[id]);
            appState.tree.selected_node_id = null;
            return;
        }

        // Find child on path to selected node (or first child if root was selected)
        let newRoot = children[0];
        if (appState.tree.selected_node_id && appState.tree.selected_node_id !== node.id) {
            const path = getPathToNode(nodes, appState.tree.selected_node_id);
            // path[0] is root, path[1] is the child we want
            if (path.length > 1 && path[0].id === node.id) {
                newRoot = path[1];
            }
        }

        // Promote child to root
        newRoot.parent_id = null;
        delete nodes[node.id];

        // Update selection if it was on the old root
        if (appState.tree.selected_node_id === node.id) {
            appState.tree.selected_node_id = newRoot.id;
        }
        return;
    }

    const parent = nodes[node.parent_id];
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
            child.parent_id = parent.id;
        });

        // Update selection
        if (appState.tree.selected_node_id === node.id ||
            appState.tree.selected_node_id === continuation.id) {
            appState.tree.selected_node_id = parent.id;
        }

        // Delete the empty human node and the continuation node
        delete nodes[node.id];
        delete nodes[continuation.id];
        return;
    }

    // Update selection before deleting
    if (appState.tree.selected_node_id === node.id) {
        appState.tree.selected_node_id = node.parent_id;
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

    const path = getPathToNode(appState.tree.nodes, selectedId);
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

// Handle paste - plain text only, normalize line endings
function handleEditorPaste(e) {
    e.preventDefault();
    let text = e.clipboardData.getData('text/plain');
    // Normalize line endings: \r\n → \n, lone \r → \n
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const textNode = document.createTextNode(text);
    range.insertNode(textNode);

    // Move cursor to end of inserted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);

    // Trigger input event for tree sync
    const editor = document.getElementById('editor');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
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

    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);

    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    sel.removeAllRanges();
    sel.addRange(range);

    const editor = document.getElementById('editor');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
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

    // Ctrl+Enter to generate
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const selectedId = appState.tree.selected_node_id;
        if (selectedId) {
            generateCompletions(selectedId);
        }
        return;
    }

    // Plain Enter - insert newline
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();

        // Insert a text node with newline character
        const selection = window.getSelection();
        if (!selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();

        const textNode = document.createTextNode('\n');
        range.insertNode(textNode);

        // Move cursor after the newline
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);

        // Trigger input event for tree sync
        const editor = document.getElementById('editor');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// Get absolute character offset from DOM position (counts <br> as \n)
function getAbsoluteOffset(container, node, offset) {
    let total = 0;
    const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_ALL,
        null,
        false
    );

    let current;
    while ((current = walker.nextNode())) {
        if (current === node) {
            return total + offset;
        }
        if (current.nodeType === Node.TEXT_NODE) {
            total += current.textContent.length;
        } else if (current.nodeName === 'BR') {
            total += 1; // <br> counts as \n
        }
    }

    return total;
}

// Place cursor at specific character position
function placeCursorAtPosition(offset) {
    const editor = document.getElementById('editor');
    if (!editor) return;

    // Ensure editor has focus
    editor.focus();

    // Use the existing restore function
    restoreCursorPosition(editor, offset);
}

// Restore cursor position (handles <br> as \n)
function restoreCursorPosition(container, offset) {
    let remaining = offset;
    const totalTextLen = container.innerText?.length;
    console.log('[editor] restoreCursorPosition: target offset', offset, 'totalTextLen:', totalTextLen);

    // Safety check: if offset is beyond text length, place at end
    if (offset > totalTextLen) {
        console.warn('[editor] cursor offset', offset, 'exceeds text length', totalTextLen, '- placing at end');
        offset = totalTextLen;
        remaining = offset;
    }

    const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_ALL,
        null,
        false
    );

    let current;
    let lastTextNode = null;
    let debugPos = 0;
    let brCount = 0;
    while ((current = walker.nextNode())) {
        if (current.nodeType === Node.TEXT_NODE) {
            if (remaining <= current.textContent.length) {
                console.log('[editor] placing cursor: debugPos', debugPos, 'brCount', brCount, 'remaining', remaining, 'nodeLen', current.textContent.length, 'final pos:', debugPos + brCount + remaining);
                const range = document.createRange();
                range.setStart(current, remaining);
                range.collapse(true);

                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            remaining -= current.textContent.length;
            debugPos += current.textContent.length;
            lastTextNode = current;
        } else if (current.nodeName === 'BR') {
            brCount++;
            debugPos++; // BR counts as 1 char (\n in innerText)
            if (remaining <= 1) {
                // Position after the <br>
                const range = document.createRange();
                range.setStartAfter(current);
                range.collapse(true);

                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            remaining -= 1;
        }
    }

    // If we couldn't position, put cursor at end
    if (lastTextNode) {
        const range = document.createRange();
        range.setStart(lastTextNode, lastTextNode.textContent.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
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

// Escape HTML and convert newlines to <br> for proper display
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // Normalize line endings and convert to <br>
    return div.innerHTML.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '<br>');
}
