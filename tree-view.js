// tree-view.js - SVG tree visualization (node-based, like loom-v1)

// Canvas state
let treeCanvas = {
    zoom: 1,
    pan: { x: 0, y: 0 },
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    panStart: { x: 0, y: 0 }
};

// Initialize tree canvas
function initTreeCanvas() {
    const svg = document.getElementById('tree-canvas');
    if (!svg) return;

    // Pan and zoom handlers
    svg.addEventListener('mousedown', handleCanvasMouseDown);
    svg.addEventListener('mousemove', handleCanvasMouseMove);
    svg.addEventListener('mouseup', handleCanvasMouseUp);
    svg.addEventListener('mouseleave', handleCanvasMouseUp);
    svg.addEventListener('wheel', handleCanvasWheel, { passive: false });

    // Touch support
    svg.addEventListener('touchstart', handleCanvasTouchStart, { passive: false });
    svg.addEventListener('touchmove', handleCanvasTouchMove, { passive: false });
    svg.addEventListener('touchend', handleCanvasTouchEnd);
}

function handleCanvasMouseDown(e) {
    // Only pan when clicking on background
    if (e.target.id === 'tree-bg' || e.target.id === 'tree-canvas') {
        treeCanvas.isDragging = true;
        treeCanvas.dragStart = { x: e.clientX, y: e.clientY };
        treeCanvas.panStart = { ...treeCanvas.pan };
        e.currentTarget.classList.add('dragging');
    }
}

function handleCanvasMouseMove(e) {
    if (!treeCanvas.isDragging) return;

    const dx = e.clientX - treeCanvas.dragStart.x;
    const dy = e.clientY - treeCanvas.dragStart.y;

    treeCanvas.pan.x = treeCanvas.panStart.x + dx;
    treeCanvas.pan.y = treeCanvas.panStart.y + dy;

    updateTreeViewport();
}

function handleCanvasMouseUp(e) {
    if (treeCanvas.isDragging) {
        treeCanvas.isDragging = false;
        document.getElementById('tree-canvas')?.classList.remove('dragging');
        saveUIState();
    }
}

function handleCanvasWheel(e) {
    e.preventDefault();

    const svg = document.getElementById('tree-canvas');
    const rect = svg.getBoundingClientRect();

    // Mouse position relative to SVG
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom factor
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(3, treeCanvas.zoom * delta));

    // Adjust pan to zoom towards mouse position
    const zoomRatio = newZoom / treeCanvas.zoom;
    treeCanvas.pan.x = mouseX - (mouseX - treeCanvas.pan.x) * zoomRatio;
    treeCanvas.pan.y = mouseY - (mouseY - treeCanvas.pan.y) * zoomRatio;

    treeCanvas.zoom = newZoom;
    updateTreeViewport();
    saveUIState();
}

// Touch handlers for mobile
let touchState = { startDistance: 0, startZoom: 1 };

function handleCanvasTouchStart(e) {
    if (e.touches.length === 1) {
        // Single touch = pan
        treeCanvas.isDragging = true;
        treeCanvas.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        treeCanvas.panStart = { ...treeCanvas.pan };
    } else if (e.touches.length === 2) {
        // Pinch to zoom
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchState.startDistance = Math.sqrt(dx * dx + dy * dy);
        touchState.startZoom = treeCanvas.zoom;
    }
}

function handleCanvasTouchMove(e) {
    if (e.touches.length === 1 && treeCanvas.isDragging) {
        const dx = e.touches[0].clientX - treeCanvas.dragStart.x;
        const dy = e.touches[0].clientY - treeCanvas.dragStart.y;
        treeCanvas.pan.x = treeCanvas.panStart.x + dx;
        treeCanvas.pan.y = treeCanvas.panStart.y + dy;
        updateTreeViewport();
    } else if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const scale = distance / touchState.startDistance;
        treeCanvas.zoom = Math.max(0.1, Math.min(3, touchState.startZoom * scale));
        updateTreeViewport();
    }
}

function handleCanvasTouchEnd(e) {
    treeCanvas.isDragging = false;
    saveUIState();
}

function updateTreeViewport() {
    const viewport = document.getElementById('tree-viewport');
    if (viewport) {
        viewport.setAttribute('transform',
            `translate(${treeCanvas.pan.x},${treeCanvas.pan.y}) scale(${treeCanvas.zoom})`
        );
    }
}

// Light update - just update text of loading nodes without rebuilding DOM
function updateLoadingNodes() {
    const nodes = appState.tree.nodes;
    Object.values(nodes).forEach(node => {
        if (node.loading) {
            const g = document.querySelector(`[data-node-id="${node.id}"]`);
            if (g) {
                const textGroup = g.querySelector('g[clip-path]');
                if (textGroup) {
                    const displayText = node.text || '⟳ generating...';
                    const lines = wrapText(displayText, 36);
                    textGroup.innerHTML = '';
                    lines.forEach((line, i) => {
                        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                        text.setAttribute('class', 'node-text');
                        text.setAttribute('x', 10);
                        text.setAttribute('y', 10 + 12 + (i * 18));
                        text.textContent = line;
                        textGroup.appendChild(text);
                    });
                }
            }
        }
    });
}

// Render the tree
function renderTree() {
    const nodesContainer = document.getElementById('tree-nodes');
    const edgesContainer = document.getElementById('tree-edges');

    if (!nodesContainer || !edgesContainer) return;

    nodesContainer.innerHTML = '';
    edgesContainer.innerHTML = '';

    const nodes = appState.tree.nodes;
    const selectedId = appState.tree.selected_node_id;

    // Calculate visible nodes
    const visibleIds = calculateVisibleNodes(selectedId, nodes);

    // Calculate focused path for edge styling
    const focusedPath = new Set();
    if (selectedId) {
        let current = nodes[selectedId];
        while (current) {
            focusedPath.add(current.id);
            if (current.parent_id) {
                focusedPath.add(`${current.parent_id}->${current.id}`);
            }
            current = nodes[current.parent_id];
        }
    }

    // Render edges first (behind nodes)
    Object.values(nodes).forEach(node => {
        if (node.parent_id && visibleIds.has(node.id)) {
            const parent = nodes[node.parent_id];
            if (parent) {
                const edgeKey = `${parent.id}->${node.id}`;
                const isOnPath = focusedPath.has(edgeKey);
                const edge = renderEdge(parent, node, isOnPath);
                edgesContainer.appendChild(edge);
            }
        }
    });

    // Render nodes
    Object.values(nodes).forEach(node => {
        if (visibleIds.has(node.id)) {
            const isSelected = node.id === selectedId;
            const isOnPath = focusedPath.has(node.id);
            const nodeElement = renderNode(node, isSelected, isOnPath);
            nodesContainer.appendChild(nodeElement);
        }
    });

    updateStats();
    updateModelLegend();
}

// Render a single node
function renderNode(node, isSelected, isOnPath) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'tree-node' +
        (isSelected ? ' selected' : '') +
        (isOnPath ? ' on-path' : '') +
        (node.loading ? ' loading' : '') +
        (node.error ? ' error' : '')
    );
    g.setAttribute('data-node-id', node.id);
    g.setAttribute('transform', `translate(${node.position.x},${node.position.y})`);

    const dims = calculateNodeDimensions(node.text);
    const PADDING = 10;
    const LINE_HEIGHT = 18;
    const CHARS_PER_LINE = 36;

    // Tooltip
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = node.type === 'human' ? 'human'
        : `${node.model || 'unknown'}\ntemp: ${node.temperature ?? '?'}, min_p: ${node.min_p ?? '?'}, max: ${node.max_tokens ?? '?'}`;
    g.appendChild(title);

    // Background rect (sharp corners, VSCode-like)
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'node-bg');
    rect.setAttribute('width', dims.width);
    rect.setAttribute('height', dims.height);
    rect.setAttribute('rx', '0'); // Sharp corners
    g.appendChild(rect);

    // Text content
    const displayText = node.loading ? '⟳ generating...' : (node.text || '');
    const lines = wrapText(displayText, CHARS_PER_LINE);

    // Clip path for text
    const clipId = `clip-${node.id}`;
    const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clipPath.setAttribute('id', clipId);
    const clipRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    clipRect.setAttribute('width', dims.width);
    clipRect.setAttribute('height', dims.height);
    clipPath.appendChild(clipRect);
    g.appendChild(clipPath);

    const textGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    textGroup.setAttribute('clip-path', `url(#${clipId})`);

    lines.forEach((line, i) => {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('class', 'node-text');
        text.setAttribute('x', PADDING);
        text.setAttribute('y', PADDING + 12 + (i * LINE_HEIGHT));
        text.textContent = line;
        textGroup.appendChild(text);
    });

    g.appendChild(textGroup);

    // Plus button (generate children)
    const plusGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    plusGroup.setAttribute('class', 'plus-group');
    plusGroup.setAttribute('transform', `translate(${dims.width + 12}, ${dims.height / 2})`);

    const plusCircle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    plusCircle.setAttribute('class', 'plus-button');
    plusCircle.setAttribute('x', -10);
    plusCircle.setAttribute('y', -10);
    plusCircle.setAttribute('width', 20);
    plusCircle.setAttribute('height', 20);
    plusCircle.setAttribute('rx', '10');
    plusGroup.appendChild(plusCircle);

    // Use Bootstrap icon via foreignObject
    const plusFO = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    plusFO.setAttribute('x', -10);
    plusFO.setAttribute('y', -10);
    plusFO.setAttribute('width', 20);
    plusFO.setAttribute('height', 20);
    plusFO.setAttribute('class', 'plus-icon-container');

    const plusIcon = document.createElement('i');
    plusIcon.className = 'bi bi-plus plus-symbol';
    plusIcon.style.display = 'flex';
    plusIcon.style.alignItems = 'center';
    plusIcon.style.justifyContent = 'center';
    plusIcon.style.width = '100%';
    plusIcon.style.height = '100%';
    plusIcon.style.fontSize = '16px';
    plusIcon.style.pointerEvents = 'none';

    plusFO.appendChild(plusIcon);
    plusGroup.appendChild(plusFO);

    g.appendChild(plusGroup);

    // Hover buttons
    const hoverButtons = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    hoverButtons.setAttribute('class', 'hover-buttons');
    hoverButtons.setAttribute('opacity', '0');

    // Delete button - inside node, top-right corner
    const deleteBtn = createHoverButton(dims.width - 12, 12, 'bi-trash', 'delete');
    hoverButtons.appendChild(deleteBtn);

    g.appendChild(hoverButtons);

    // Event handlers
    setupNodeEventHandlers(g, node, rect, plusGroup, deleteBtn, hoverButtons);

    return g;
}

// Create hover button
function createHoverButton(x, y, iconClass, className) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `hover-btn ${className}`);
    g.setAttribute('transform', `translate(${x}, ${y})`);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'hover-btn-bg');
    rect.setAttribute('x', -8);
    rect.setAttribute('y', -8);
    rect.setAttribute('width', 16);
    rect.setAttribute('height', 16);
    rect.setAttribute('rx', '0');
    g.appendChild(rect);

    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', -6);
    fo.setAttribute('y', -6);
    fo.setAttribute('width', 12);
    fo.setAttribute('height', 12);

    const icon = document.createElement('i');
    icon.className = `bi ${iconClass} hover-btn-icon`;
    icon.style.display = 'flex';
    icon.style.alignItems = 'center';
    icon.style.justifyContent = 'center';
    icon.style.width = '100%';
    icon.style.height = '100%';

    fo.appendChild(icon);
    g.appendChild(fo);

    return g;
}

// Setup node event handlers
function setupNodeEventHandlers(g, node, rect, plusGroup, deleteBtn, hoverButtons) {
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let nodeStartX = 0, nodeStartY = 0;

    // Show/hide hover buttons
    g.addEventListener('mouseenter', () => {
        hoverButtons.setAttribute('opacity', '1');
    });

    g.addEventListener('mouseleave', () => {
        hoverButtons.setAttribute('opacity', '0');
    });

    // Node dragging
    rect.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.button === 0) {
            isDragging = true;
            const svg = document.getElementById('tree-canvas');
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

            dragStartX = svgP.x;
            dragStartY = svgP.y;
            nodeStartX = node.position.x;
            nodeStartY = node.position.y;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const svg = document.getElementById('tree-canvas');
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

        const dx = (svgP.x - dragStartX) / treeCanvas.zoom;
        const dy = (svgP.y - dragStartY) / treeCanvas.zoom;

        // Move this node
        node.position.x = nodeStartX + dx;
        node.position.y = nodeStartY + dy;
        node.manually_positioned = true;

        // Move all descendants by the same delta
        const descendants = getDescendants(appState.tree.nodes, node.id);
        descendants.forEach(desc => {
            if (!desc._dragOffset) {
                // Store original offset from dragged node
                desc._dragOffset = {
                    x: desc.position.x - nodeStartX,
                    y: desc.position.y - nodeStartY
                };
            }
            desc.position.x = node.position.x + desc._dragOffset.x;
            desc.position.y = node.position.y + desc._dragOffset.y;
        });

        renderTree();
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;

            // Clean up drag offsets
            const descendants = getDescendants(appState.tree.nodes, node.id);
            descendants.forEach(desc => delete desc._dragOffset);

            const dx = Math.abs(node.position.x - nodeStartX);
            const dy = Math.abs(node.position.y - nodeStartY);

            if (dx < 5 && dy < 5) {
                // Click, not drag - select node
                selectNode(node.id);
            } else {
                saveTree();
            }
        }
    });

    // Plus button - generate children
    plusGroup.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!node.loading) {
            selectNode(node.id);
            generateCompletions(node.id);
        }
    });

    // Delete button
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteNodeWithConfirm(node);
    });
}

// Render edge between nodes
function renderEdge(parentNode, childNode, isOnPath) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'tree-edge' + (isOnPath ? ' on-path' : ''));
    path.setAttribute('d', generateSpline(parentNode, childNode));
    path.setAttribute('fill', 'none');
    return path;
}

// Select a node
function selectNode(nodeId) {
    appState.tree.selected_node_id = nodeId;
    renderTree();
    updateEditor();
    saveUIState();
}

// Delete node with confirmation
function deleteNodeWithConfirm(node) {
    const children = getChildren(appState.tree.nodes, node.id);

    if (children.length > 0) {
        if (!confirm('Delete this node and all its children?')) {
            return;
        }
    }

    // If deleting selected node, select parent
    if (appState.tree.selected_node_id === node.id) {
        appState.tree.selected_node_id = node.parent_id;
    }

    deleteNode(appState.tree.nodes, node.id);
    saveTree();
    renderTree();
    updateEditor();
}

// Model color mapping
const modelColorMap = new Map();
const modelColors = [
    '#4fc3f7', // cyan
    '#ce93d8', // purple
    '#81c784', // green
    '#ffb74d', // orange
    '#f06292', // pink
    '#4db6ac', // teal
    '#aed581', // light green
    '#ff8a65'  // deep orange
];
let colorIndex = 0;

function getModelColor(model) {
    if (!model) return '#cccccc';

    if (!modelColorMap.has(model)) {
        modelColorMap.set(model, modelColors[colorIndex % modelColors.length]);
        colorIndex++;
    }

    return modelColorMap.get(model);
}

// Pan to center a node in view
function panToNode(nodeId) {
    const node = appState.tree.nodes[nodeId];
    if (!node) return;

    const svg = document.getElementById('tree-canvas');
    const rect = svg.getBoundingClientRect();

    const dims = calculateNodeDimensions(node.text);
    const nodeCenterX = node.position.x + dims.width / 2;
    const nodeCenterY = node.position.y + dims.height / 2;

    treeCanvas.pan.x = rect.width / 2 - nodeCenterX * treeCanvas.zoom;
    treeCanvas.pan.y = rect.height / 2 - nodeCenterY * treeCanvas.zoom;

    updateTreeViewport();
    saveUIState();
}
