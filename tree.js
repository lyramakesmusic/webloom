// tree.js - DAG data structure and operations (supports path convergence)

// Node structure:
// {
//   id: string (uuid),
//   parent_ids: string[] (empty=root, multiple=convergence point),
//   text: string,
//   type: 'human' | 'ai',
//   model: string | null,
//   position: { x: number, y: number },
//   loading: boolean,
//   error: string | null
// }
// Legacy: parent_id string is auto-converted to parent_ids array

// Helper: get parent_ids array (handles legacy parent_id)
function getParentIds(node) {
    if (!node) return [];
    if (Array.isArray(node.parent_ids)) return node.parent_ids;
    if (node.parent_id) return [node.parent_id];
    return [];
}

// Helper: check if node is a root (no parents)
function isRoot(node) {
    return getParentIds(node).length === 0;
}

// Helper: check if node is a convergence point (multiple parents)
function isConvergence(node) {
    return getParentIds(node).length > 1;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Get array of nodes from root to given node
// For DAG: follows first parent when multiple exist, unless pathHint provided
// pathHint: array of node IDs specifying exact path to follow
function getPathToNode(nodes, nodeId, pathHint = null) {
    const path = [];
    let current = nodes[nodeId];

    while (current) {
        path.unshift(current);
        const parentIds = getParentIds(current);
        if (parentIds.length === 0) break;

        // Choose which parent to follow
        let nextParentId;
        if (pathHint) {
            // Find the parent that's in the path hint
            nextParentId = parentIds.find(pid => pathHint.includes(pid)) || parentIds[0];
        } else {
            nextParentId = parentIds[0];
        }
        current = nodes[nextParentId];
    }

    return path;
}

// Get concatenated text from root to node
function getFullText(nodes, nodeId) {
    const path = getPathToNode(nodes, nodeId);
    return path.map(n => n.text || '').join('');
}

// Get all children of a node (nodes that have this node as any parent)
function getChildren(nodes, nodeId) {
    return Object.values(nodes).filter(n => getParentIds(n).includes(nodeId));
}

// Get all descendants of a node (recursive)
function getDescendants(nodes, nodeId) {
    const descendants = [];
    const children = getChildren(nodes, nodeId);

    children.forEach(child => {
        descendants.push(child);
        descendants.push(...getDescendants(nodes, child.id));
    });

    return descendants;
}

// Check if node is a leaf (has no children)
function isLeaf(nodes, nodeId) {
    return getChildren(nodes, nodeId).length === 0;
}

// Find root node(s) - in DAG there can be multiple roots
function findRoot(nodes) {
    return Object.values(nodes).find(n => isRoot(n));
}

// Find all root nodes
function findRoots(nodes) {
    return Object.values(nodes).filter(n => isRoot(n));
}

// Create a new node
// parentId can be: null (root), string (single parent), or string[] (multiple parents for convergence)
function createNode(parentId, text, type = 'human', model = null, position = null, params = {}) {
    const p = params || {};
    // Normalize parent_ids to array
    let parentIds;
    if (parentId === null || parentId === undefined) {
        parentIds = [];
    } else if (Array.isArray(parentId)) {
        parentIds = parentId;
    } else {
        parentIds = [parentId];
    }

    return {
        id: generateUUID(),
        parent_ids: parentIds,
        text: text,
        type: type,
        model: model,
        temperature: p.temperature,
        min_p: p.min_p,
        max_tokens: p.max_tokens,
        position: position || { x: 0, y: 0 },
        loading: false,
        error: null
    };
}

// Add node to tree and return the new node
function addNode(nodes, parentId, text, type = 'human', model = null) {
    const parent = nodes[parentId];
    if (!parent) return null;

    // Calculate position based on parent
    const siblings = getChildren(nodes, parentId);
    const position = {
        x: parent.position.x + 320,
        y: parent.position.y + (siblings.length * 80)
    };

    const node = createNode(parentId, text, type, model, position);
    nodes[node.id] = node;

    return node;
}

// Delete node and all descendants
function deleteNode(nodes, nodeId) {
    const descendants = getDescendants(nodes, nodeId);

    // Delete descendants first
    descendants.forEach(d => {
        delete nodes[d.id];
    });

    // Delete the node itself
    delete nodes[nodeId];
}

// Add a parent to a node (for creating convergence points)
function addParentToNode(node, newParentId) {
    const parentIds = getParentIds(node);
    if (!parentIds.includes(newParentId)) {
        node.parent_ids = [...parentIds, newParentId];
    }
}

// Remove a parent from a node
function removeParentFromNode(node, parentIdToRemove) {
    const parentIds = getParentIds(node);
    node.parent_ids = parentIds.filter(pid => pid !== parentIdToRemove);
}

// Delete node but preserve children (reparent to grandparents)
function deleteNodePreserveChildren(nodes, nodeId) {
    const node = nodes[nodeId];
    if (!node) return;

    const children = getChildren(nodes, nodeId);
    const parentIds = getParentIds(node);

    // Reparent children: replace this node's ID with its parent IDs in children's parent_ids
    children.forEach(child => {
        const childParentIds = getParentIds(child);
        const newParentIds = childParentIds.filter(pid => pid !== nodeId);
        // Add this node's parents to the child's parents
        parentIds.forEach(pid => {
            if (!newParentIds.includes(pid)) {
                newParentIds.push(pid);
            }
        });
        child.parent_ids = newParentIds;
    });

    // Delete the node
    delete nodes[nodeId];
}

// Calculate node dimensions for rendering
function calculateNodeDimensions(text, maxCharsPerLine = 36) {
    const LINE_HEIGHT = 18;
    const PADDING = 10;
    const MIN_HEIGHT = 40;
    const FIXED_WIDTH = 280;

    const lines = wrapText(text || '', maxCharsPerLine);
    const height = Math.max(MIN_HEIGHT, lines.length * LINE_HEIGHT + PADDING * 2);

    return { width: FIXED_WIDTH, height };
}

// Wrap text into lines
function wrapText(text, maxChars) {
    if (!text) return [''];

    const lines = [];
    const paragraphs = text.split(/\n/);

    paragraphs.forEach(para => {
        if (!para) {
            lines.push('');
            return;
        }

        const words = para.split(' ');
        let currentLine = '';

        words.forEach(word => {
            // Force break long words
            if (word.length > maxChars) {
                if (currentLine) {
                    lines.push(currentLine);
                    currentLine = '';
                }
                for (let i = 0; i < word.length; i += maxChars) {
                    lines.push(word.substring(i, i + maxChars));
                }
                return;
            }

            const testLine = currentLine ? currentLine + ' ' + word : word;
            if (testLine.length <= maxChars) {
                currentLine = testLine;
            } else {
                if (currentLine) lines.push(currentLine);
                currentLine = word;
            }
        });

        if (currentLine) lines.push(currentLine);
    });

    return lines.length > 0 ? lines : [''];
}

// Generate SVG path for bezier curve between nodes
function generateSpline(parentNode, childNode) {
    const parentDims = calculateNodeDimensions(parentNode.text);
    const childDims = calculateNodeDimensions(childNode.text);

    const start = {
        x: parentNode.position.x + parentDims.width,
        y: parentNode.position.y + (parentDims.height / 2)
    };

    const end = {
        x: childNode.position.x,
        y: childNode.position.y + (childDims.height / 2)
    };

    const midX = start.x + (end.x - start.x) * 0.5;

    return `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
}

// Calculate visible nodes based on focused node (smart visibility)
// pathHint: array of node IDs representing the current navigation path (for DAG)
function calculateVisibleNodes(focusedNodeId, nodes, pathHint = null) {
    const visible = new Set();

    if (!focusedNodeId || !nodes[focusedNodeId]) {
        // Show all nodes if no focus
        Object.keys(nodes).forEach(id => visible.add(id));
        return visible;
    }

    visible.add(focusedNodeId);

    const focused = nodes[focusedNodeId];
    const focusedParentIds = getParentIds(focused);

    // Focused node's siblings (only from active path parent)
    if (focusedParentIds.length > 0) {
        // Use pathHint to find which parent we came from, fallback to first
        let activeParentId = focusedParentIds[0];
        if (pathHint && pathHint.length > 0) {
            const pathParent = focusedParentIds.find(pid => pathHint.includes(pid));
            if (pathParent) activeParentId = pathParent;
        }
        Object.values(nodes).forEach(node => {
            const nodeParentIds = getParentIds(node);
            if (nodeParentIds.includes(activeParentId)) {
                visible.add(node.id);
            }
        });
    }

    // Add descendants with smart branching logic
    function addDescendants(nodeId) {
        const children = getChildren(nodes, nodeId);

        if (children.length === 0) return;

        // Add all children
        children.forEach(child => visible.add(child.id));

        // If only one child, continue down
        if (children.length === 1) {
            addDescendants(children[0].id);
        } else {
            // Multiple children - check which have descendants
            const childrenWithDescendants = children.filter(child => {
                return getChildren(nodes, child.id).length > 0;
            });

            // If only one sibling has descendants, expand that path
            if (childrenWithDescendants.length === 1) {
                addDescendants(childrenWithDescendants[0].id);
            }
        }
    }

    addDescendants(focusedNodeId);

    // Walk up ancestors (use pathHint to follow correct parent at DAG merges)
    let current = focused;
    let currentParentIds = getParentIds(current);
    while (currentParentIds.length > 0) {
        // Use pathHint to find which parent to follow, fallback to first
        let parentId = currentParentIds[0];
        if (pathHint && pathHint.length > 0) {
            const pathParent = currentParentIds.find(pid => pathHint.includes(pid));
            if (pathParent) parentId = pathParent;
        }
        const parent = nodes[parentId];
        if (!parent) break;
        visible.add(parent.id);

        // Parent's siblings (only from the active grandparent)
        const parentParentIds = getParentIds(parent);
        if (parentParentIds.length > 0) {
            // Find active grandparent from path
            let activeGrandparentId = parentParentIds[0];
            if (pathHint && pathHint.length > 0) {
                const pathGrandparent = parentParentIds.find(pid => pathHint.includes(pid));
                if (pathGrandparent) activeGrandparentId = pathGrandparent;
            }
            Object.values(nodes).forEach(node => {
                const nodeParentIds = getParentIds(node);
                if (nodeParentIds.includes(activeGrandparentId)) {
                    visible.add(node.id);
                }
            });
        }

        current = parent;
        currentParentIds = getParentIds(current);
    }

    return visible;
}

// Autoformat tree layout
function autoformatTree(nodes) {
    const root = findRoot(nodes);
    if (!root) return;

    // Reset all manual positioning
    Object.values(nodes).forEach(node => {
        delete node.manually_positioned;
    });

    root.position = { x: 100, y: 200 };
    formatNodeAndChildren(nodes, root.id);
}

// Only position children where this is their FIRST parent (prevents DAG nodes being positioned multiple times)
function formatNodeAndChildren(nodes, nodeId) {
    const parent = nodes[nodeId];
    const allChildren = getChildren(nodes, nodeId);
    // Filter: only position if this parent is the child's FIRST parent
    const children = allChildren.filter(c => getParentIds(c)[0] === nodeId);

    if (children.length === 0) return;

    const HORIZONTAL_OFFSET = 320;
    const VERTICAL_GAP = 30;

    children.sort((a, b) => a.position.y - b.position.y);

    const parentDims = calculateNodeDimensions(parent.text);
    const parentCenterY = parent.position.y + (parentDims.height / 2);

    const heights = children.map(child => calculateNodeDimensions(child.text).height);
    const totalHeight = heights.reduce((sum, h) => sum + h, 0) + (children.length - 1) * VERTICAL_GAP;

    let currentCenterY = parentCenterY - (totalHeight / 2) + (heights[0] / 2);

    children.forEach((child, i) => {
        const childHeight = heights[i];
        child.position.x = parent.position.x + HORIZONTAL_OFFSET;
        child.position.y = currentCenterY - (childHeight / 2);

        if (i < children.length - 1) {
            currentCenterY += (childHeight / 2) + VERTICAL_GAP + (heights[i + 1] / 2);
        }

        formatNodeAndChildren(nodes, child.id);
    });
}

// Export tree to JSON
function exportTree(tree) {
    return JSON.stringify(tree, null, 2);
}

// Import tree from JSON
function importTree(jsonString) {
    try {
        const tree = JSON.parse(jsonString);
        if (!tree.nodes || typeof tree.nodes !== 'object') {
            throw new Error('Invalid tree format: missing nodes object');
        }
        return tree;
    } catch (e) {
        throw new Error('Failed to parse tree JSON: ' + e.message);
    }
}
