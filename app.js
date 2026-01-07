// app.js - Main application initialization and state management

// Global app state
let appState = {
    tree: {
        nodes: {},
        selected_node_id: null,
        selected_path: []  // DAG: array of node IDs from root to selected, determines which parent path to follow
    },
    settings: {
        model: 'moonshotai/kimi-k2',
        api_key: '',
        temperature: 0.9,
        min_p: 0.01,
        max_tokens: 32,
        n_siblings: 3,
        untitled_trick: false
    },
    ui: {
        sidebar_collapsed: false,
        left_panel_width: 50, // percentage
        canvas: {
            zoom: 1,
            pan: { x: 0, y: 0 }
        }
    }
};

// LocalStorage keys
const STORAGE_KEY_TREE = 'webloom-tree';
const STORAGE_KEY_SETTINGS = 'webloom-settings';
const STORAGE_KEY_UI = 'webloom-ui';

// Initialize application
function init() {
    // Load persisted state
    loadSettings();
    loadTree();
    loadUIState();

    // Apply settings to UI
    applySettingsToUI();

    // Initialize components
    initTreeCanvas();
    initEditor();
    initSidebar();
    initPanelResizer();
    initPanelDrag();
    initBottomBar();
    initToast();
    initPopups();
    initMobile();

    // Restore panel order if swapped
    restorePanelOrder();

    // Initial render
    renderTree();
    updateEditor();
    updateProviderDetection();

    // Set up auto-save
    setupAutoSave();
}

// Restore panel order from saved state (default is Editor-left, Tree-right)
function restorePanelOrder() {
    if (appState.ui.panels_swapped) {
        const mainContent = document.querySelector('.main-content');
        const treePanel = document.getElementById('tree-panel');
        const editorPanel = document.getElementById('editor-panel');
        const resizer = document.getElementById('panel-resizer');

        // Swap to Tree-left, Editor-right
        mainContent.insertBefore(treePanel, editorPanel);
        mainContent.insertBefore(resizer, editorPanel);
    }

    // Apply saved panel width to left panel (after order is set)
    if (appState.ui.left_panel_width) {
        const container = document.querySelector('.main-content');
        const leftPanel = container?.querySelector('.panel');
        if (leftPanel) {
            leftPanel.style.flex = `0 0 ${appState.ui.left_panel_width}%`;
        }
    }
}

// ============================================
// SETTINGS
// ============================================

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_SETTINGS);
        if (saved) {
            appState.settings = { ...appState.settings, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(appState.settings));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

function applySettingsToUI() {
    document.getElementById('model-input').value = appState.settings.model || 'moonshotai/kimi-k2';
    document.getElementById('api-key-input').value = appState.settings.api_key || '';
    document.getElementById('temp-slider').value = appState.settings.temperature || 0.9;
    document.getElementById('temp-value').value = appState.settings.temperature || 0.9;
    document.getElementById('minp-slider').value = appState.settings.min_p || 0.01;
    document.getElementById('minp-value').value = appState.settings.min_p || 0.01;
    document.getElementById('max-tokens-input').value = appState.settings.max_tokens || 32;
    document.getElementById('siblings-input').value = appState.settings.n_siblings || 3;
    document.getElementById('untitled-toggle').checked = appState.settings.untitled_trick || false;

    // Update model display in bottom bar
    document.getElementById('model-display').textContent = appState.settings.model || 'No model';
}

function updateSettingsFromUI() {
    appState.settings.model = document.getElementById('model-input').value;
    appState.settings.api_key = document.getElementById('api-key-input').value;
    appState.settings.temperature = parseFloat(document.getElementById('temp-slider').value);
    appState.settings.min_p = parseFloat(document.getElementById('minp-slider').value);
    appState.settings.max_tokens = parseInt(document.getElementById('max-tokens-input').value);
    appState.settings.n_siblings = parseInt(document.getElementById('siblings-input').value);
    appState.settings.untitled_trick = document.getElementById('untitled-toggle').checked;

    // Update model display
    document.getElementById('model-display').textContent = appState.settings.model || 'No model';

    saveSettings();
}

function setupSettingsListeners() {
    // Slider sync
    const sliderPairs = [
        { slider: 'temp-slider', value: 'temp-value' },
        { slider: 'minp-slider', value: 'minp-value' }
    ];

    sliderPairs.forEach(({ slider, value }) => {
        const sliderEl = document.getElementById(slider);
        const valueEl = document.getElementById(value);

        sliderEl.addEventListener('input', () => {
            valueEl.value = sliderEl.value;
            updateSettingsFromUI();
        });

        valueEl.addEventListener('change', () => {
            sliderEl.value = valueEl.value;
            updateSettingsFromUI();
        });
    });

    // Other inputs
    ['model-input', 'api-key-input', 'max-tokens-input', 'siblings-input', 'untitled-toggle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                updateSettingsFromUI();
                if (id === 'model-input') {
                    updateProviderDetection();
                }
            });

            // Also on input for text fields
            if (el.type === 'text' || el.type === 'password') {
                el.addEventListener('input', () => {
                    updateSettingsFromUI();
                    if (id === 'model-input') {
                        updateProviderDetection();
                    }
                });
            }
        }
    });
}

function updateProviderDetection() {
    const modelInput = document.getElementById('model-input');
    const detectedSpan = document.getElementById('provider-detected');
    const detection = detectProvider(modelInput.value);

    detectedSpan.textContent = detection.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI-Compatible';

    // Toggle OAI controls visibility
    const oaiKeyGroup = document.getElementById('oai-key-group');
    const oaiModelGroup = document.getElementById('oai-model-group');

    if (detection.provider === 'openai') {
        oaiKeyGroup.style.display = 'block';
        oaiModelGroup.style.display = 'block';
    } else {
        oaiKeyGroup.style.display = 'none';
        oaiModelGroup.style.display = 'none';
    }

    // Auto-enable untitled.txt trick for Anthropic models
    const untitledToggle = document.getElementById('untitled-toggle');
    if (modelInput.value.toLowerCase().includes('anthropic')) {
        untitledToggle.checked = true;
        appState.settings.untitled_trick = true;
        saveSettings();
    }
}

// ============================================
// TREE PERSISTENCE
// ============================================

function loadTree() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_TREE);
        if (saved) {
            const tree = JSON.parse(saved);
            if (tree.nodes && typeof tree.nodes === 'object') {
                appState.tree = tree;

                // Find root node (no parents)
                const root = Object.values(appState.tree.nodes).find(n => isRoot(n));

                // If no root, clear all orphaned nodes
                if (!root && Object.keys(appState.tree.nodes).length > 0) {
                    console.warn('Clearing orphaned nodes - no root found');
                    appState.tree.nodes = {};
                    appState.tree.selected_node_id = null;
                    appState.tree.selected_path = [];
                }

                // Validate selected_node_id exists, fallback to root
                if (!appState.tree.selected_node_id || !appState.tree.nodes[appState.tree.selected_node_id]) {
                    appState.tree.selected_node_id = root ? root.id : null;
                }

                // Initialize/validate selected_path for DAG navigation
                if (!Array.isArray(appState.tree.selected_path)) {
                    appState.tree.selected_path = [];
                }
                // Recompute path if missing or stale (uses stored path as hint for continuity)
                if (appState.tree.selected_node_id) {
                    const path = getPathToNode(appState.tree.nodes, appState.tree.selected_node_id, appState.tree.selected_path);
                    appState.tree.selected_path = path.map(n => n.id);
                }
            }
        }
    } catch (e) {
        console.error('Failed to load tree:', e);
    }
}

function saveTree() {
    try {
        localStorage.setItem(STORAGE_KEY_TREE, JSON.stringify(appState.tree));
    } catch (e) {
        console.error('Failed to save tree:', e);
    }
}

function setupAutoSave() {
    // Auto-save tree every 5 seconds if changed
    let lastSavedTree = JSON.stringify(appState.tree);

    setInterval(() => {
        const currentTree = JSON.stringify(appState.tree);
        if (currentTree !== lastSavedTree) {
            saveTree();
            lastSavedTree = currentTree;
        }
    }, 5000);
}

// ============================================
// UI STATE
// ============================================

function loadUIState() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_UI);
        if (saved) {
            const ui = JSON.parse(saved);
            appState.ui = { ...appState.ui, ...ui };

            // Apply canvas state
            if (ui.canvas) {
                treeCanvas.zoom = ui.canvas.zoom || 1;
                treeCanvas.pan = ui.canvas.pan || { x: 0, y: 0 };
                updateTreeViewport();
            }

            // Store panel width (applied later after panel order is restored)
            const width = ui.left_panel_width || ui.tree_panel_width; // fallback for old saves
            if (width) {
                appState.ui.left_panel_width = width;
            }
        }
    } catch (e) {
        console.error('Failed to load UI state:', e);
    }
}

function saveUIState() {
    try {
        appState.ui.canvas = {
            zoom: treeCanvas.zoom,
            pan: treeCanvas.pan
        };

        localStorage.setItem(STORAGE_KEY_UI, JSON.stringify(appState.ui));
    } catch (e) {
        console.error('Failed to save UI state:', e);
    }
}

// ============================================
// SIDEBAR
// ============================================

function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('sidebar-collapse-btn');
    const expandBtn = document.getElementById('sidebar-expand-btn');
    const overlay = document.getElementById('sidebar-overlay');

    const isMobile = () => window.innerWidth <= 768;

    function closeMobileSidebar() {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('show');
    }

    function openMobileSidebar() {
        sidebar.classList.add('mobile-open');
        overlay.classList.add('show');
    }

    collapseBtn.addEventListener('click', (e) => {
        console.log('[sidebar] collapse click', e);
        if (isMobile()) {
            closeMobileSidebar();
        } else {
            sidebar.classList.add('collapsed');
            expandBtn.style.display = 'flex';
            appState.ui.sidebar_collapsed = true;
            saveUIState();
        }
    });

    expandBtn.addEventListener('click', (e) => {
        console.log('[sidebar] expand click', e);
        if (isMobile()) {
            openMobileSidebar();
        } else {
            sidebar.classList.remove('collapsed');
            expandBtn.style.display = 'none';
            appState.ui.sidebar_collapsed = false;
            saveUIState();
        }
    });

    // Click overlay to close (only if clicking directly on overlay, not bubbled)
    overlay?.addEventListener('click', (e) => {
        if (e.target === overlay) {
            console.log('[sidebar] overlay click', e);
            closeMobileSidebar();
        }
    });

    // Prevent sidebar clicks from accidentally closing (touch event weirdness)
    sidebar?.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Apply saved state (desktop only)
    if (appState.ui.sidebar_collapsed && !isMobile()) {
        sidebar.classList.add('collapsed');
        expandBtn.style.display = 'flex';
    }

    // Export/Import
    document.getElementById('export-tree-btn').addEventListener('click', exportTreeToFile);
    document.getElementById('import-tree-btn').addEventListener('click', () => {
        document.getElementById('import-tree-input').click();
    });
    document.getElementById('import-tree-input').addEventListener('change', handleTreeImport);

    // Settings listeners
    setupSettingsListeners();
}

function exportTreeToFile() {
    const treeJson = exportTree(appState.tree);
    const blob = new Blob([treeJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;

    // Generate filename with datetime
    const now = new Date();
    const datetime = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
    a.download = `webloom-tree-${datetime}.json`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function handleTreeImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const tree = importTree(event.target.result);

            if (!confirm('This will replace your current tree. Continue?')) {
                return;
            }

            appState.tree = tree;

            // Validate/fix selected_node_id
            if (!appState.tree.selected_node_id || !appState.tree.nodes[appState.tree.selected_node_id]) {
                const root = findRoot(appState.tree.nodes);
                appState.tree.selected_node_id = root ? root.id : null;
            }

            // Initialize selected_path for DAG navigation
            if (!Array.isArray(appState.tree.selected_path)) {
                appState.tree.selected_path = [];
            }
            if (appState.tree.selected_node_id) {
                const path = getPathToNode(appState.tree.nodes, appState.tree.selected_node_id, appState.tree.selected_path);
                appState.tree.selected_path = path.map(n => n.id);
            }

            saveTree();
            renderTree();
            updateEditor();

            // Pan to selected node
            if (appState.tree.selected_node_id) {
                panToNode(appState.tree.selected_node_id);
            }
        } catch (err) {
            showError('Failed to import tree: ' + err.message);
        }
    };

    reader.readAsText(file);
    e.target.value = ''; // Reset input
}

// ============================================
// PANEL RESIZER
// ============================================

function initPanelResizer() {
    const resizer = document.getElementById('panel-resizer');
    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const container = document.querySelector('.main-content');
        const containerRect = container.getBoundingClientRect();
        const newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;

        // Clamp between 20% and 80%
        const clampedWidth = Math.max(20, Math.min(80, newWidth));

        // Always resize the LEFT panel (first child panel in DOM)
        const leftPanel = container.querySelector('.panel');
        leftPanel.style.flex = `0 0 ${clampedWidth}%`;

        appState.ui.left_panel_width = clampedWidth;
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            saveUIState();
        }
    });
}

// Setup panel tab drag-and-drop for reordering
function initPanelDrag() {
    const tabs = document.querySelectorAll('.panel-title[draggable="true"]');
    const headers = document.querySelectorAll('.panel-header');
    let draggedTab = null;
    let draggedPanel = null;

    tabs.forEach(tab => {
        tab.addEventListener('dragstart', (e) => {
            draggedTab = tab;
            draggedPanel = tab.dataset.panel;
            tab.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tab.dataset.panel);
        });

        tab.addEventListener('dragend', () => {
            tab.classList.remove('dragging');
            headers.forEach(h => h.classList.remove('drag-over'));
            draggedTab = null;
            draggedPanel = null;
        });
    });

    // Make entire header a valid drop zone
    headers.forEach(header => {
        const panel = header.closest('.panel');
        const panelId = panel?.dataset.panel;

        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (draggedPanel && draggedPanel !== panelId) {
                header.classList.add('drag-over');
            }
        });

        header.addEventListener('dragleave', (e) => {
            // Only remove if actually leaving the header (not entering a child)
            if (!header.contains(e.relatedTarget)) {
                header.classList.remove('drag-over');
            }
        });

        header.addEventListener('drop', (e) => {
            e.preventDefault();
            header.classList.remove('drag-over');

            if (!draggedPanel || draggedPanel === panelId) return;

            // Swap panels
            const mainContent = document.querySelector('.main-content');
            const treePanel = document.getElementById('tree-panel');
            const editorPanel = document.getElementById('editor-panel');
            const resizer = document.getElementById('panel-resizer');

            // Determine current order and swap
            const treePanelFirst = treePanel.compareDocumentPosition(editorPanel) & Node.DOCUMENT_POSITION_FOLLOWING;

            if (treePanelFirst) {
                // Tree is first, swap to Editor first
                mainContent.insertBefore(editorPanel, treePanel);
                mainContent.insertBefore(resizer, treePanel);
            } else {
                // Editor is first, swap to Tree first
                mainContent.insertBefore(treePanel, editorPanel);
                mainContent.insertBefore(resizer, editorPanel);
            }

            // Save the order
            appState.ui.panels_swapped = !treePanelFirst;
            saveUIState();
        });
    });
}

// ============================================
// BOTTOM BAR
// ============================================

function initBottomBar() {
    // Generate button - splits at cursor if not at end, then generates
    document.getElementById('generate-btn').addEventListener('click', () => {
        generateFromCursor();
    });

    // Cancel button
    document.getElementById('cancel-btn').addEventListener('click', () => {
        cancelAllGenerations();
    });

    // Tree panel autoformat button (mobile)
    document.getElementById('tree-autoformat-btn')?.addEventListener('click', () => {
        autoformatTree(appState.tree.nodes);
        renderTree();
        saveTree();
    });

    // Tree panel reset view button (mobile)
    document.getElementById('tree-reset-view-btn')?.addEventListener('click', () => {
        resetViewToSelected();
    });

    // Continue button - splits at cursor if not at end, generates single child and selects it
    document.getElementById('continue-btn').addEventListener('click', () => {
        continueFromCursor();
    });

    // Reroll button
    document.getElementById('reroll-btn').addEventListener('click', () => {
        rerollSiblings();
    });

    // Copy button
    document.getElementById('copy-text-btn').addEventListener('click', () => {
        const selectedId = appState.tree.selected_node_id;
        if (selectedId) {
            const text = getFullText(appState.tree.nodes, selectedId);
            navigator.clipboard.writeText(text).then(() => {
                // Brief visual feedback
                const btn = document.getElementById('copy-text-btn');
                btn.innerHTML = '<i class="bi bi-check"></i>';
                setTimeout(() => {
                    btn.innerHTML = '<i class="bi bi-clipboard"></i>';
                }, 1000);
            });
        }
    });

    // Split button - split node at cursor position
    document.getElementById('split-btn').addEventListener('click', () => {
        splitAtCursor();
    });
}

// Update stats display
function updateStats() {
    const selectedId = appState.tree.selected_node_id;

    if (selectedId) {
        const text = getFullText(appState.tree.nodes, selectedId);
        const charCount = text.length;
        const tokenCount = Math.ceil(charCount / 4); // Rough estimate

        document.getElementById('char-count').textContent = `${charCount} chars`;
        document.getElementById('token-count').textContent = `~${tokenCount} tokens`;
    } else {
        document.getElementById('char-count').textContent = '0 chars';
        document.getElementById('token-count').textContent = '~0 tokens';
    }

    document.getElementById('node-count').textContent = `${Object.keys(appState.tree.nodes).length} nodes`;
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================

function initToast() {
    const toast = document.getElementById('error-toast');
    const closeBtn = toast.querySelector('.toast-close');

    closeBtn.addEventListener('click', () => {
        toast.classList.remove('show');
    });
}

function showError(message) {
    const toast = document.getElementById('error-toast');
    const body = document.getElementById('error-toast-body');

    // Parse status code if present
    const statusCode = parseErrorStatus(message);
    let displayMessage = message;

    if (statusCode) {
        displayMessage = `Error ${statusCode}: ${getErrorDescription(statusCode)}`;
    }

    body.textContent = displayMessage;
    toast.classList.add('show');

    // Auto-hide after 8 seconds
    setTimeout(() => {
        toast.classList.remove('show');
    }, 8000);
}

// ============================================
// INFO POPUPS
// ============================================

function initPopups() {
    // Endpoint info popup
    const endpointBtn = document.getElementById('endpoint-info-btn');
    const endpointPopup = document.getElementById('endpoint-info-popup');
    const endpointClose = document.getElementById('endpoint-info-close');

    endpointBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        endpointPopup.classList.add('show');
    });

    endpointClose?.addEventListener('click', () => {
        endpointPopup.classList.remove('show');
    });

    // Close on overlay click
    endpointPopup?.addEventListener('click', (e) => {
        if (e.target === endpointPopup) {
            endpointPopup.classList.remove('show');
        }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            endpointPopup?.classList.remove('show');
        }
    });
}

// ============================================
// MOBILE
// ============================================

function initMobile() {
    const mobileTabs = document.getElementById('mobile-tabs');
    const editorPanel = document.getElementById('editor-panel');
    const treePanel = document.getElementById('tree-panel');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    // Check if mobile
    const isMobile = () => window.innerWidth <= 768;

    // Set initial mobile state
    function applyMobileState() {
        console.log('[mobile] applyMobileState, isMobile:', isMobile());
        if (isMobile()) {
            // Mobile: show tabs, activate current tab's panel
            const activeTab = mobileTabs.querySelector('.mobile-tab.active')?.dataset.tab || 'editor';
            setMobileTab(activeTab);
            // Don't close sidebar on resize (keyboard open/close triggers resize)
            // Sidebar is off-screen by default anyway via CSS transform
        } else {
            // Desktop: show both panels side by side
            editorPanel.classList.remove('mobile-active');
            treePanel.classList.remove('mobile-active');
            // Reset inline styles that might override CSS
            editorPanel.style.display = '';
            treePanel.style.display = '';
            // Close mobile sidebar state
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('show');
            // Restore desktop sidebar state
            const expandBtn = document.getElementById('sidebar-expand-btn');
            if (appState.ui.sidebar_collapsed) {
                sidebar.classList.add('collapsed');
                expandBtn.style.display = 'flex';
            } else {
                sidebar.classList.remove('collapsed');
                expandBtn.style.display = 'none';
            }
        }
    }

    // Switch mobile tab
    function setMobileTab(tab) {
        // Update tab buttons
        mobileTabs.querySelectorAll('.mobile-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Show/hide panels
        editorPanel.classList.toggle('mobile-active', tab === 'editor');
        treePanel.classList.toggle('mobile-active', tab === 'tree');
    }

    // Tab click handlers
    mobileTabs?.querySelectorAll('.mobile-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            console.log('[mobile] tab click:', tab.dataset.tab, e);
            if (isMobile()) {
                setMobileTab(tab.dataset.tab);
            }
        });
    });

    // Handle resize
    window.addEventListener('resize', applyMobileState);

    // Handle virtual keyboard (move bottom bar above keyboard)
    const editorBottomBar = document.querySelector('.editor-bottom-bar');
    if (window.visualViewport && editorBottomBar) {
        const adjustForKeyboard = () => {
            if (!isMobile()) {
                editorBottomBar.classList.remove('keyboard-open');
                editorBottomBar.style.removeProperty('bottom');
                return;
            }
            // Calculate where bottom of visual viewport is relative to layout viewport
            const vv = window.visualViewport;
            const keyboardHeight = window.innerHeight - vv.height;

            if (keyboardHeight > 100) { // Keyboard is likely open
                // Position bar at bottom of visual viewport (right above keyboard)
                // Account for both keyboard height AND any viewport offset from scrolling
                const bottomPosition = window.innerHeight - vv.height - vv.offsetTop;
                editorBottomBar.classList.add('keyboard-open');
                editorBottomBar.style.bottom = Math.max(0, bottomPosition) + 'px';
            } else {
                editorBottomBar.classList.remove('keyboard-open');
                editorBottomBar.style.removeProperty('bottom');
            }
        };
        window.visualViewport.addEventListener('resize', adjustForKeyboard);
        window.visualViewport.addEventListener('scroll', adjustForKeyboard);
    }

    // Initial setup
    applyMobileState();
}

// ============================================
// START APPLICATION
// ============================================

document.addEventListener('DOMContentLoaded', init);
