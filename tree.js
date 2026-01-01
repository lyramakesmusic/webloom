// tree.js - Tree data structure and operations

// Node structure:
// {
//   id: string (uuid),
//   parent_id: string | null,
//   text: string,
//   type: 'human' | 'ai',
//   model: string | null,
//   position: { x: number, y: number },
//   loading: boolean,
//   error: string | null
// }

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Get array of nodes from root to given node
function getPathToNode(nodes, nodeId) {
    const path = [];
    let current = nodes[nodeId];

    while (current) {
        path.unshift(current);
        current = current.parent_id ? nodes[current.parent_id] : null;
    }

    return path;
}

// Get concatenated text from root to node
function getFullText(nodes, nodeId) {
    const path = getPathToNode(nodes, nodeId);
    return path.map(n => n.text || '').join('');
}

// Get all children of a node
function getChildren(nodes, nodeId) {
    return Object.values(nodes).filter(n => n.parent_id === nodeId);
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

// Find root node
function findRoot(nodes) {
    return Object.values(nodes).find(n => !n.parent_id);
}

// Create a new node
function createNode(parentId, text, type = 'human', model = null, position = null, params = {}) {
    const p = params || {};
    return {
        id: generateUUID(),
        parent_id: parentId,
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

// Delete node but preserve children (reparent to grandparent)
function deleteNodePreserveChildren(nodes, nodeId) {
    const node = nodes[nodeId];
    if (!node) return;

    const children = getChildren(nodes, nodeId);

    // Reparent children to grandparent
    children.forEach(child => {
        child.parent_id = node.parent_id;
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
function calculateVisibleNodes(focusedNodeId, nodes) {
    const visible = new Set();

    if (!focusedNodeId || !nodes[focusedNodeId]) {
        // Show all nodes if no focus
        Object.keys(nodes).forEach(id => visible.add(id));
        return visible;
    }

    visible.add(focusedNodeId);

    const focused = nodes[focusedNodeId];

    // Focused node's siblings
    if (focused.parent_id) {
        Object.values(nodes).forEach(node => {
            if (node.parent_id === focused.parent_id) {
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
                return Object.values(nodes).some(n => n.parent_id === child.id);
            });

            // If only one sibling has descendants, expand that path
            if (childrenWithDescendants.length === 1) {
                addDescendants(childrenWithDescendants[0].id);
            }
        }
    }

    addDescendants(focusedNodeId);

    // Walk up ancestors
    let current = focused;
    while (current.parent_id) {
        const parent = nodes[current.parent_id];
        visible.add(parent.id);

        // Parent's siblings
        if (parent.parent_id) {
            Object.values(nodes).forEach(node => {
                if (node.parent_id === parent.parent_id) {
                    visible.add(node.id);
                }
            });
        }

        current = parent;
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

function formatNodeAndChildren(nodes, nodeId) {
    const parent = nodes[nodeId];
    const children = getChildren(nodes, nodeId);

    if (children.length === 0) return;

    const HORIZONTAL_OFFSET = 320;
    const VERTICAL_GAP = 30;

    // Sort by Y position to maintain order
    children.sort((a, b) => a.position.y - b.position.y);

    // Calculate parent height
    const parentDims = calculateNodeDimensions(parent.text);
    const parentCenterY = parent.position.y + (parentDims.height / 2);

    // Calculate children heights
    const heights = children.map(child => calculateNodeDimensions(child.text).height);
    const totalHeight = heights.reduce((sum, h) => sum + h, 0) + (children.length - 1) * VERTICAL_GAP;

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
