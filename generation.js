// generation.js - Generation workflow and sibling creation

let activeGenerations = new Map(); // nodeId -> AbortController
let lastRenderTime = 0;
const RENDER_THROTTLE_MS = 80;

// Get current settings from UI
function getCurrentSettings() {
    const modelInput = document.getElementById('model-input').value;
    const detection = detectProvider(modelInput);

    return {
        model: modelInput,
        api_key: document.getElementById('api-key-input').value.trim(),
        oai_api_key: document.getElementById('oai-api-key-input')?.value.trim() || '',
        oai_model: document.getElementById('oai-model-input')?.value.trim() || '',
        temperature: parseFloat(document.getElementById('temp-slider').value),
        min_p: parseFloat(document.getElementById('minp-slider').value),
        max_tokens: parseInt(document.getElementById('max-tokens-input').value),
        n_siblings: parseInt(document.getElementById('siblings-input').value),
        untitled_trick: document.getElementById('untitled-toggle').checked
    };
}

// Generate completions for a parent node
async function generateCompletions(parentNodeId, overrideCount = null) {
    const settings = getCurrentSettings();
    const n = overrideCount ?? settings.n_siblings;
    const parent = appState.tree.nodes[parentNodeId];

    if (!parent) {
        showError('Parent node not found');
        return;
    }

    // Get full prompt from root to parent
    const prompt = getFullText(appState.tree.nodes, parentNodeId);

    if (!prompt.trim()) {
        showError('Cannot generate from empty prompt');
        return;
    }

    // Create placeholder nodes
    const placeholderIds = [];
    const HORIZONTAL_OFFSET = 320;
    const VERTICAL_GAP = 30;
    const ESTIMATED_HEIGHT = 50;

    const parentDims = calculateNodeDimensions(parent.text);
    const parentCenterY = parent.position.y + (parentDims.height / 2);
    const totalHeight = n * ESTIMATED_HEIGHT + (n - 1) * VERTICAL_GAP;
    let currentY = parentCenterY - (totalHeight / 2);

    for (let i = 0; i < n; i++) {
        const id = generateUUID();
        placeholderIds.push(id);

        appState.tree.nodes[id] = {
            id: id,
            parent_id: parentNodeId,
            type: 'ai',
            text: '',
            model: settings.model,
            temperature: settings.temperature,
            min_p: settings.min_p,
            max_tokens: settings.max_tokens,
            loading: true,
            error: null,
            position: {
                x: parent.position.x + HORIZONTAL_OFFSET,
                y: currentY
            }
        };

        currentY += ESTIMATED_HEIGHT + VERTICAL_GAP;
    }

    renderTree();
    showGeneratingUI(true);

    // Generate each sibling
    const promises = placeholderIds.map((nodeId, index) => {
        return new Promise(async (resolve) => {
            const node = appState.tree.nodes[nodeId];

            // Create AbortController for this generation
            const controller = new AbortController();
            activeGenerations.set(nodeId, controller);

            try {
                await streamCompletion(
                    settings,
                    prompt,
                    // onChunk - throttled light update (text only, no DOM rebuild)
                    (chunk, fullText) => {
                        node.text = fullText;
                        const now = Date.now();
                        if (now - lastRenderTime >= RENDER_THROTTLE_MS) {
                            lastRenderTime = now;
                            updateLoadingNodes();
                        }
                    },
                    // onDone
                    (fullText) => {
                        node.text = fullText;
                        node.loading = false;
                        activeGenerations.delete(nodeId);
                        renderTree();
                        resolve({ nodeId, success: true });
                    },
                    // onError
                    (error) => {
                        node.loading = false;
                        node.error = error.message;
                        activeGenerations.delete(nodeId);
                        renderTree();
                        resolve({ nodeId, success: false, error: error.message });
                    },
                    controller // pass AbortController
                );
            } catch (error) {
                node.loading = false;
                node.error = error.message;
                activeGenerations.delete(nodeId);
                renderTree();
                resolve({ nodeId, success: false, error: error.message });
            }
        });
    });

    const results = await Promise.all(promises);

    // Clean up empty/error nodes
    results.forEach(result => {
        const node = appState.tree.nodes[result.nodeId];
        if (node) {
            const text = node.text?.trim() || '';
            const isRefusal = text.startsWith('Unfortunately,') ||
                text.startsWith("I'm sorry") ||
                text.includes('untitled.txt');

            if (!text || node.error || isRefusal) {
                delete appState.tree.nodes[result.nodeId];
            }
        }
    });

    // Reposition siblings
    repositionSiblings(parentNodeId);

    // Show first error if any
    const firstError = results.find(r => !r.success);
    if (firstError && firstError.error) {
        showError(firstError.error);
    }

    showGeneratingUI(false);
    saveTree();
    renderTree();
}

// Reposition siblings after generation
function repositionSiblings(parentNodeId) {
    const children = getChildren(appState.tree.nodes, parentNodeId);
    if (children.length === 0) return;

    const parent = appState.tree.nodes[parentNodeId];
    const HORIZONTAL_OFFSET = 320;
    const VERTICAL_GAP = 30;

    // Sort by Y position
    children.sort((a, b) => a.position.y - b.position.y);

    // Calculate heights
    const heights = children.map(child => calculateNodeDimensions(child.text).height);
    const totalHeight = heights.reduce((sum, h) => sum + h, 0) + (children.length - 1) * VERTICAL_GAP;

    // Center around parent
    const parentDims = calculateNodeDimensions(parent.text);
    const parentCenterY = parent.position.y + (parentDims.height / 2);

    // Position each child so its center aligns with the stacked layout
    let currentCenterY = parentCenterY - (totalHeight / 2) + (heights[0] / 2);

    children.forEach((child, i) => {
        const childHeight = heights[i];
        child.position.x = parent.position.x + HORIZONTAL_OFFSET;
        // Position by center, then convert to top-left
        child.position.y = currentCenterY - (childHeight / 2);

        // Move to next child's center
        if (i < children.length - 1) {
            currentCenterY += (childHeight / 2) + VERTICAL_GAP + (heights[i + 1] / 2);
        }

        // Recursively reposition descendants
        repositionSiblings(child.id);
    });
}

// Cancel all active generations
function cancelAllGenerations() {
    activeGenerations.forEach((controller) => {
        controller.abort();
    });
    activeGenerations.clear();

    // Delete loading nodes (they're incomplete/cancelled)
    const toDelete = [];
    Object.values(appState.tree.nodes).forEach(node => {
        if (node.loading) {
            toDelete.push(node.id);
        }
    });
    toDelete.forEach(id => delete appState.tree.nodes[id]);

    showGeneratingUI(false);
    saveTree();
    renderTree();
}

// Reroll: delete siblings and regenerate
async function rerollSiblings() {
    const selectedId = appState.tree.selected_node_id;
    if (!selectedId) {
        showError('No node selected');
        return;
    }

    const selectedNode = appState.tree.nodes[selectedId];
    if (!selectedNode || !selectedNode.parent_id) {
        showError('Cannot reroll root node');
        return;
    }

    const parentId = selectedNode.parent_id;
    const siblings = getChildren(appState.tree.nodes, parentId);

    // Delete all siblings (including selected)
    siblings.forEach(sibling => {
        if (!getChildren(appState.tree.nodes, sibling.id).length) {
            // Only delete leaves
            delete appState.tree.nodes[sibling.id];
        }
    });

    // Clear selection
    appState.tree.selected_node_id = parentId;

    // Regenerate
    await generateCompletions(parentId);
}

// Show/hide generating UI state
function showGeneratingUI(isGenerating) {
    const generateBtn = document.getElementById('generate-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    if (isGenerating) {
        generateBtn.style.display = 'none';
        cancelBtn.style.display = 'flex';
    } else {
        generateBtn.style.display = 'flex';
        cancelBtn.style.display = 'none';
    }
}
