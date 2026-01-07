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

    // Pan: mousedown/move on SVG, stop on leave/up, blur catches tab switches
    svg.addEventListener('mousedown', handleCanvasMouseDown);
    svg.addEventListener('mousemove', handleCanvasMouseMove);
    svg.addEventListener('mouseup', handleCanvasMouseUp);
    svg.addEventListener('mouseleave', handleCanvasMouseUp);
    window.addEventListener('blur', handleCanvasMouseUp);

    // Zoom
    svg.addEventListener('wheel', handleCanvasWheel, { passive: false });

    // Touch support
    svg.addEventListener('touchstart', handleCanvasTouchStart, { passive: false });
    svg.addEventListener('touchmove', handleCanvasTouchMove, { passive: false });
    svg.addEventListener('touchend', handleCanvasTouchEnd);

    // Reset view button (in tree bottom bar)
    document.getElementById('tree-reset-view-btn')?.addEventListener('click', resetView);
}

// Reset view to selected node or root
function resetView() {
    const selectedId = appState.tree.selected_node_id;
    if (selectedId && appState.tree.nodes[selectedId]) {
        panToNode(selectedId);
    } else {
        // Find root and pan to it
        const root = Object.values(appState.tree.nodes).find(n => isRoot(n));
        if (root) {
            panToNode(root.id);
        } else {
            // No nodes - reset to origin
            treeCanvas.pan = { x: 0, y: 0 };
            treeCanvas.zoom = 1;
            updateTreeViewport();
        }
    }
}

function handleCanvasMouseDown(e) {
    // Only pan when clicking on background (not nodes)
    if (e.target.id === 'tree-bg' || e.target.id === 'tree-canvas') {
        treeCanvas.isDragging = true;
        treeCanvas.dragStart = { x: e.clientX, y: e.clientY };
        treeCanvas.panStart = { ...treeCanvas.pan };
        e.currentTarget.classList.add('dragging');
        document.body.classList.add('canvas-dragging'); // Prevent text selection
        e.preventDefault();
    }
}

function handleCanvasMouseMove(e) {
    if (!treeCanvas.isDragging) return;

    treeCanvas.pan.x = treeCanvas.panStart.x + (e.clientX - treeCanvas.dragStart.x);
    treeCanvas.pan.y = treeCanvas.panStart.y + (e.clientY - treeCanvas.dragStart.y);
    updateTreeViewport();
}

function handleCanvasMouseUp() {
    if (treeCanvas.isDragging) {
        treeCanvas.isDragging = false;
        document.getElementById('tree-canvas')?.classList.remove('dragging');
        document.body.classList.remove('canvas-dragging');
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
let touchState = {
    startDistance: 0,
    startZoom: 1,
    isPinching: false,
    startPan: null,
    startWorldCenter: null,  // World point under pinch center
    lastCenter: null         // Track last pinch center for panning while zooming
};

function handleCanvasTouchStart(e) {
    // Prevent all default touch behavior on canvas (browser scroll/zoom)
    e.preventDefault();

    // Safety check
    if (!e.touches || !e.touches[0]) return;

    const svg = document.getElementById('tree-canvas');
    const rect = svg.getBoundingClientRect();

    if (e.touches.length === 1 && !touchState.isPinching) {
        // Single touch = pan (only if not already pinching)
        treeCanvas.isDragging = true;
        treeCanvas.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        treeCanvas.panStart = { ...treeCanvas.pan };
    } else if (e.touches.length >= 2 && e.touches[1]) {
        // Pinch to zoom - cancel any pan, enter pinch mode
        treeCanvas.isDragging = false;
        touchState.isPinching = true;

        // Use raw client coords - simpler and more reliable on mobile
        const t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const t1 = { x: e.touches[1].clientX, y: e.touches[1].clientY };

        const dx = t0.x - t1.x;
        const dy = t0.y - t1.y;
        touchState.startDistance = Math.sqrt(dx * dx + dy * dy);
        touchState.startZoom = treeCanvas.zoom;
        touchState.startPan = { ...treeCanvas.pan };

        // Center between fingers (client coords)
        const screenCenter = { x: (t0.x + t1.x) / 2, y: (t0.y + t1.y) / 2 };
        touchState.lastCenter = screenCenter;

        // Store rect offset at start for consistent calculation
        touchState.rectOffset = { x: rect.left, y: rect.top };

        // Calculate world point under pinch center - this stays fixed during zoom
        // Convert client coords to SVG-relative, then to world
        const svgX = screenCenter.x - rect.left;
        const svgY = screenCenter.y - rect.top;
        touchState.startWorldCenter = {
            x: (svgX - treeCanvas.pan.x) / treeCanvas.zoom,
            y: (svgY - treeCanvas.pan.y) / treeCanvas.zoom
        };
    }
}

function handleCanvasTouchMove(e) {
    // Always prevent default to stop browser scroll/zoom
    e.preventDefault();

    // Safety: ensure touches exist
    if (!e.touches || !e.touches[0]) return;

    if (e.touches.length >= 2 && touchState.isPinching && touchState.rectOffset) {
        if (!e.touches[1]) return; // Safety check
        // Use raw client coords
        const t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const t1 = { x: e.touches[1].clientX, y: e.touches[1].clientY };

        // Current center (client coords) and distance
        const clientCenter = { x: (t0.x + t1.x) / 2, y: (t0.y + t1.y) / 2 };
        const dx = t0.x - t1.x;
        const dy = t0.y - t1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Convert to SVG-relative using stored offset
        const svgCenter = {
            x: clientCenter.x - touchState.rectOffset.x,
            y: clientCenter.y - touchState.rectOffset.y
        };

        // New zoom from pinch ratio
        const scale = touchState.startDistance > 0 ? distance / touchState.startDistance : 1;
        const newZoom = Math.max(0.1, Math.min(3, touchState.startZoom * scale));

        // Pan so that the world point stays under the current pinch center
        // svgPoint = worldPoint * zoom + pan
        // pan = svgPoint - worldPoint * zoom
        treeCanvas.pan.x = svgCenter.x - touchState.startWorldCenter.x * newZoom;
        treeCanvas.pan.y = svgCenter.y - touchState.startWorldCenter.y * newZoom;
        treeCanvas.zoom = newZoom;

        touchState.lastCenter = clientCenter;
        updateTreeViewport();
    } else if (e.touches.length === 1 && treeCanvas.isDragging && !touchState.isPinching) {
        // Single finger pan
        const dx = e.touches[0].clientX - treeCanvas.dragStart.x;
        const dy = e.touches[0].clientY - treeCanvas.dragStart.y;
        treeCanvas.pan.x = treeCanvas.panStart.x + dx;
        treeCanvas.pan.y = treeCanvas.panStart.y + dy;
        updateTreeViewport();
    }
}

function handleCanvasTouchEnd(e) {
    // Only exit pinch mode when all fingers lifted
    if (e.touches.length === 0) {
        treeCanvas.isDragging = false;
        touchState.isPinching = false;
        touchState.startDistance = 0;
        touchState.startCenter = null;
        touchState.startPan = null;
        touchState.rectOffset = null;
        touchState.startWorldCenter = null;
        saveUIState();
    } else if (e.touches.length === 1 && touchState.isPinching) {
        // Went from 2 fingers to 1 - stay in pinch mode to prevent accidental pan
        // User needs to lift all fingers to reset
    }
}

function updateTreeViewport() {
    const viewport = document.getElementById('tree-viewport');
    if (viewport) {
        viewport.setAttribute('transform',
            `translate(${treeCanvas.pan.x},${treeCanvas.pan.y}) scale(${treeCanvas.zoom})`
        );
    }

    // Update background to cover visible area (infinite canvas effect)
    const canvas = document.getElementById('tree-canvas');
    const bg = document.getElementById('tree-bg');
    if (canvas && bg) {
        const screenW = canvas.clientWidth || window.innerWidth;
        const screenH = canvas.clientHeight || window.innerHeight;
        // Convert screen bounds to world coordinates
        const worldX = -treeCanvas.pan.x / treeCanvas.zoom;
        const worldY = -treeCanvas.pan.y / treeCanvas.zoom;
        const worldW = screenW / treeCanvas.zoom;
        const worldH = screenH / treeCanvas.zoom;
        bg.setAttribute('x', worldX);
        bg.setAttribute('y', worldY);
        bg.setAttribute('width', worldW);
        bg.setAttribute('height', worldH);
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

    // Calculate visible nodes (pass selected_path for DAG-aware visibility)
    const visibleIds = calculateVisibleNodes(selectedId, nodes, appState.tree.selected_path);

    // Calculate focused path for edge styling (use selected_path for DAG)
    const focusedPath = new Set();
    const selectedPath = appState.tree.selected_path || [];
    if (selectedPath.length > 0) {
        // Use stored path for accurate DAG traversal
        selectedPath.forEach((nodeId, i) => {
            focusedPath.add(nodeId);
            if (i > 0) {
                // Add edge from previous node to this one
                focusedPath.add(`${selectedPath[i-1]}->${nodeId}`);
            }
        });
    } else if (selectedId) {
        // Fallback: walk up using first parent
        let current = nodes[selectedId];
        while (current) {
            focusedPath.add(current.id);
            const currentParentIds = getParentIds(current);
            currentParentIds.forEach(pid => {
                focusedPath.add(`${pid}->${current.id}`);
            });
            current = currentParentIds.length > 0 ? nodes[currentParentIds[0]] : null;
        }
    }

    // Render edges first (behind nodes) - render ALL parent edges for DAG
    Object.values(nodes).forEach(node => {
        const nodeParentIds = getParentIds(node);
        if (nodeParentIds.length > 0 && visibleIds.has(node.id)) {
            nodeParentIds.forEach(parentId => {
                const parent = nodes[parentId];
                if (parent) {
                    const edgeKey = `${parent.id}->${node.id}`;
                    const isOnPath = focusedPath.has(edgeKey);
                    const edge = renderEdge(parent, node, isOnPath);
                    edgesContainer.appendChild(edge);
                }
            });
        }
    });

    // Render nodes (with hidden branch indicators)
    Object.values(nodes).forEach(node => {
        if (visibleIds.has(node.id)) {
            const isSelected = node.id === selectedId;
            const isOnPath = focusedPath.has(node.id);

            // Check for hidden children to show indicator
            const allChildren = getChildren(nodes, node.id);
            const hiddenChildren = allChildren.filter(child => !visibleIds.has(child.id));

            const nodeElement = renderNode(node, isSelected, isOnPath, hiddenChildren, nodes);
            nodesContainer.appendChild(nodeElement);
        }
    });

    updateStats();
    updateModelLegend();
}

// Render a single node
function renderNode(node, isSelected, isOnPath, hiddenChildren = [], nodes = {}) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'tree-node' +
        (isSelected ? ' selected' : '') +
        (isOnPath ? ' on-path' : '') +
        (node.loading ? ' loading' : '') +
        (node.error ? ' error' : '') +
        (hiddenChildren.length > 0 ? ' has-hidden' : '')
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
    // Model-based border color (human nodes get grey)
    const borderColor = node.type === 'human' ? '#888888' : getModelColor(node.model);
    rect.setAttribute('stroke', borderColor);
    g.appendChild(rect);

    // Hidden branches indicator (inside node, right-center edge)
    if (hiddenChildren.length > 0) {
        let totalHidden = 0;
        hiddenChildren.forEach(child => {
            totalHidden += 1 + getDescendants(nodes, child.id).length;
        });

        const indicatorGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        indicatorGroup.setAttribute('class', 'hidden-indicator');
        indicatorGroup.setAttribute('transform', `translate(${dims.width - 22}, ${dims.height / 2})`);
        indicatorGroup.style.cursor = 'pointer';

        // Small pill background
        const pillW = 28, pillH = 16;
        const pill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        pill.setAttribute('x', -pillW / 2);
        pill.setAttribute('y', -pillH / 2);
        pill.setAttribute('width', pillW);
        pill.setAttribute('height', pillH);
        pill.setAttribute('rx', pillH / 2);
        pill.setAttribute('fill', '#444');
        pill.setAttribute('stroke', '#666');
        pill.setAttribute('stroke-width', '1');
        indicatorGroup.appendChild(pill);

        // "+N" text
        const countText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        countText.setAttribute('x', 0);
        countText.setAttribute('y', 4);
        countText.setAttribute('text-anchor', 'middle');
        countText.setAttribute('fill', '#aaa');
        countText.setAttribute('font-size', '10');
        countText.setAttribute('font-weight', 'bold');
        countText.textContent = `+${totalHidden}`;
        indicatorGroup.appendChild(countText);

        // Tooltip
        const indTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        indTitle.textContent = `${hiddenChildren.length} hidden branch${hiddenChildren.length > 1 ? 'es' : ''}\nClick to expand`;
        indicatorGroup.appendChild(indTitle);

        // Click handler
        indicatorGroup.addEventListener('click', (e) => {
            e.stopPropagation();
            if (hiddenChildren.length > 0) {
                let target = hiddenChildren[0];
                const descendants = getDescendants(nodes, target.id);
                if (descendants.length > 0) {
                    target = descendants[descendants.length - 1];
                }
                selectNode(target.id);
            }
        });

        g.appendChild(indicatorGroup);
    }

    // DAG merge indicator (bottom-right) - shows when node has multiple parents
    const parentIds = getParentIds(node);
    if (parentIds.length > 1) {
        const dagGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        dagGroup.setAttribute('class', 'dag-indicator');
        dagGroup.setAttribute('transform', `translate(${dims.width - 12}, ${dims.height - 8})`);

        // Small pill background
        const pillW = 20, pillH = 14;
        const pill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        pill.setAttribute('x', -pillW / 2);
        pill.setAttribute('y', -pillH / 2);
        pill.setAttribute('width', pillW);
        pill.setAttribute('height', pillH);
        pill.setAttribute('rx', 3);
        pill.setAttribute('fill', '#2a4a6a');
        pill.setAttribute('stroke', '#4a7a9a');
        pill.setAttribute('stroke-width', '1');
        dagGroup.appendChild(pill);

        // Parent count text
        const dagText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        dagText.setAttribute('x', 0);
        dagText.setAttribute('y', 4);
        dagText.setAttribute('text-anchor', 'middle');
        dagText.setAttribute('fill', '#8ac');
        dagText.setAttribute('font-size', '9');
        dagText.setAttribute('font-weight', 'bold');
        dagText.textContent = `${parentIds.length}→`;
        dagGroup.appendChild(dagText);

        // Tooltip
        const dagTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        dagTitle.textContent = `Merge node: ${parentIds.length} parents`;
        dagGroup.appendChild(dagTitle);

        g.appendChild(dagGroup);
    }

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

    // Touch drag state
    let touchHoldTimer = null;
    let isTouchDragging = false;
    let touchStartPos = null;
    const HOLD_TIME = 500; // ms
    const MOVE_THRESHOLD = 10; // px - cancel hold if moved more than this

    // Show/hide hover buttons
    g.addEventListener('mouseenter', () => {
        hoverButtons.setAttribute('opacity', '1');
    });

    g.addEventListener('mouseleave', () => {
        hoverButtons.setAttribute('opacity', '0');
    });

    // Node dragging (mouse)
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

    // Touch: press-and-hold to drag
    rect.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return; // Let multi-touch propagate for pinch zoom
        e.stopPropagation();

        const touch = e.touches[0];
        touchStartPos = { x: touch.clientX, y: touch.clientY };

        // Start hold timer
        touchHoldTimer = setTimeout(() => {
            // Hold complete - enter drag mode
            isTouchDragging = true;
            g.classList.add('drag-ready');
            if (navigator.vibrate) navigator.vibrate(10);

            // Initialize drag positions
            const svg = document.getElementById('tree-canvas');
            const pt = svg.createSVGPoint();
            pt.x = touch.clientX;
            pt.y = touch.clientY;
            const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

            dragStartX = svgP.x;
            dragStartY = svgP.y;
            nodeStartX = node.position.x;
            nodeStartY = node.position.y;
        }, HOLD_TIME);
    }, { passive: false });

    rect.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];

        if (!isTouchDragging && touchStartPos) {
            // Check if moved too much - cancel hold
            const dx = Math.abs(touch.clientX - touchStartPos.x);
            const dy = Math.abs(touch.clientY - touchStartPos.y);
            if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
                clearTimeout(touchHoldTimer);
                touchHoldTimer = null;
                touchStartPos = null;
            }
            return;
        }

        if (isTouchDragging) {
            e.preventDefault();
            e.stopPropagation();

            const svg = document.getElementById('tree-canvas');
            const pt = svg.createSVGPoint();
            pt.x = touch.clientX;
            pt.y = touch.clientY;
            const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

            const dx = (svgP.x - dragStartX) / treeCanvas.zoom;
            const dy = (svgP.y - dragStartY) / treeCanvas.zoom;

            // Move this node
            node.position.x = nodeStartX + dx;
            node.position.y = nodeStartY + dy;
            node.manually_positioned = true;

            // Move all descendants
            const descendants = getDescendants(appState.tree.nodes, node.id);
            descendants.forEach(desc => {
                if (!desc._dragOffset) {
                    desc._dragOffset = {
                        x: desc.position.x - nodeStartX,
                        y: desc.position.y - nodeStartY
                    };
                }
                desc.position.x = node.position.x + desc._dragOffset.x;
                desc.position.y = node.position.y + desc._dragOffset.y;
            });

            renderTree();
        }
    }, { passive: false });

    rect.addEventListener('touchend', (e) => {
        clearTimeout(touchHoldTimer);
        touchHoldTimer = null;

        if (isTouchDragging) {
            // End drag
            isTouchDragging = false;
            g.classList.remove('drag-ready');

            // Clean up drag offsets
            const descendants = getDescendants(appState.tree.nodes, node.id);
            descendants.forEach(desc => delete desc._dragOffset);

            saveTree();
        } else if (touchStartPos) {
            // Tap - select node
            selectNode(node.id);
        }

        touchStartPos = null;
    });

    rect.addEventListener('touchcancel', () => {
        clearTimeout(touchHoldTimer);
        touchHoldTimer = null;
        isTouchDragging = false;
        touchStartPos = null;
        g.classList.remove('drag-ready');
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
    // Validate node exists before selecting
    if (!appState.tree.nodes[nodeId]) return;

    // DAG: compute path using old path as hint (preserves which parent branch you were on)
    const oldPath = appState.tree.selected_path || [];
    const newPath = getPathToNode(appState.tree.nodes, nodeId, oldPath);
    appState.tree.selected_path = newPath.map(n => n.id);
    appState.tree.selected_node_id = nodeId;

    // Clear cursor focus when user explicitly selects a node
    if (typeof editorState !== 'undefined') {
        editorState.cursorNodeId = null;
        editorState.inlineEditNodeId = null;
    }
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

    // If deleting selected node or any ancestor of selected, select parent of deleted
    const selectedId = appState.tree.selected_node_id;
    if (selectedId) {
        const descendants = getDescendants(appState.tree.nodes, node.id);
        const descendantIds = new Set(descendants.map(d => d.id));
        if (selectedId === node.id || descendantIds.has(selectedId)) {
            const nodeParentIds = getParentIds(node);
            // Use selectNode to properly update path
            if (nodeParentIds.length > 0) {
                selectNode(nodeParentIds[0]);
            } else {
                appState.tree.selected_node_id = null;
                appState.tree.selected_path = [];
            }
        }
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
