/**
 * LocalPM - Main Application Controller
 * Связывает UI, IndexedDB, расчет расписания CPM, экспорт/импорт Excel и передачу проектов
 */

import { db } from './storage/db.js';
import { SyncEngine } from './storage/sync.js';
import { DateUtils } from './core/dates.js';
import { ValidationUtils } from './core/validation.js';
import { WbsUtils } from './core/wbs.js';
import { CpmEngine } from './core/cpm.js';
import { XlsxIO } from './io/xlsx-io.js';
import { TransferUtils } from './io/transfer.js';
import { GanttChart } from './ui/gantt.js';

class AppController {
  constructor() {
    this.projects = [];
    this.currentProject = null;
    this.tasks = [];
    this.dependencies = [];
    this.selectedTaskId = null;
    this.selectedIds = [];
    this.anchorId = null;
    this.gantt = null;
    this.pendingReturnPackage = null;
    this.sync = new SyncEngine(this);

    // 50-snapshot Undo/Redo stack (D-09)
    this.history = {
      undo: [],
      redo: []
    };

    // UI Theme & Style: 'linear' (Linear Bento), 'fluent' (Microsoft Fluent 2), 'classic' (Базовый)
    this.theme = localStorage.getItem('localpm_theme') || 'auto';
    let savedStyle = localStorage.getItem('localpm_style') || 'linear';
    if (savedStyle === 'bento') savedStyle = 'linear';
    this.uiStyle = savedStyle;
  }

  async init() {
    // 1. Init DB
    await db.init();
    this.updateStorageIndicator();

    // 2. Init Gantt Canvas
    const canvas = document.getElementById('gantt-canvas');
    this.resizeCanvas(canvas);
    this.gantt = new GanttChart(canvas);

    window.addEventListener('resize', () => {
      this.resizeCanvas(canvas);
      this.gantt.render();
    });

    // Synchronize vertical scrolling between task table body and Gantt chart (FR-9.01)
    const tableBody = document.getElementById('task-table-body-el');
    if (tableBody) {
      let isTableScrolling = false;
      tableBody.addEventListener('scroll', () => {
        if (!isTableScrolling) {
          this.gantt.scrollY = tableBody.scrollTop;
          this.gantt.render();
        }
      });

      this.gantt.onScrollY = (y) => {
        isTableScrolling = true;
        tableBody.scrollTop = y;
        setTimeout(() => { isTableScrolling = false; }, 50);
      };
    }

    // Connect interactive bar drag duration commit and task select
    this.gantt.onTaskSelect = (taskId) => {
      this.selectedTaskId = taskId;
      document.querySelectorAll('.task-row').forEach(r => r.classList.remove('selected'));
      const row = document.querySelector(`.task-row[data-task-id="${taskId}"]`);
      if (row) {
        row.classList.add('selected');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };

    this.gantt.onTaskDurationCommit = () => {
      this.recalculateSchedule();
    };

    // Drag-to-Link: create dependency on canvas connect
    this.gantt.onLinkCreated = (predId, succId, type = 'FS', lag = 0) => {
      // Check if dependency already exists
      const exists = this.dependencies.some(d => d.pred_id === predId && d.succ_id === succId);
      if (exists) return;

      this.dependencies.push({
        id: `dep-${predId}-${succId}`,
        pred_id: predId,
        succ_id: succId,
        type: type,
        lag_workdays: lag
      });

      this.recalculateSchedule();
    };

    // Floating Rich Tooltip Hover Card
    const tooltipCard = document.getElementById('gantt-tooltip-card');
    const ttName = document.getElementById('tooltip-task-name');
    const ttDates = document.getElementById('tooltip-task-dates');
    const ttDur = document.getElementById('tooltip-task-dur');
    const ttPct = document.getElementById('tooltip-task-pct');
    const ttFloat = document.getElementById('tooltip-task-float');
    const ttCrit = document.getElementById('tooltip-task-crit');

    this.gantt.onTaskHover = (task, mouseX, mouseY) => {
      if (!tooltipCard) return;
      if (!task) {
        tooltipCard.style.display = 'none';
        return;
      }

      ttName.innerText = task.name || 'Задача';
      ttDates.innerText = `${DateUtils.formatRU(task.start_date)} — ${DateUtils.formatRU(task.finish_date)}`;
      ttDur.innerText = `${task.duration_days ?? 1} раб. дн.`;
      ttPct.innerText = `${task.percent_complete ?? 0}%`;
      ttFloat.innerText = `${task.total_float ?? 0} раб. дн.`;
      ttCrit.innerText = task.is_critical ? 'Да (в резерве 0 дней)' : 'Нет';
      ttCrit.style.color = task.is_critical ? '#ef4444' : '#10b981';

      // Position tooltip near cursor, keeping within container
      const parentRect = canvas.parentElement.getBoundingClientRect();
      let left = mouseX + 16;
      let top = mouseY - 10;
      if (left + 240 > parentRect.width) left = mouseX - 250;
      if (top + 160 > parentRect.height) top = parentRect.height - 170;

      tooltipCard.style.left = `${Math.max(10, left)}px`;
      tooltipCard.style.top = `${Math.max(10, top)}px`;
      tooltipCard.style.display = 'block';
    };

    // 3. Service Worker registration (disabled on localhost for immediate hot-reloads)
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost') && window.location.hostname !== '127.0.0.1') {
      try {
        await navigator.serviceWorker.register('./sw.js');
      } catch (e) {
        console.warn('SW registration skipped:', e);
      }
    } else if ('serviceWorker' in navigator) {
      // Unregister any stale worker and purge caches on localhost
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister());
      });
      if ('caches' in window) {
        caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
      }
    }

    // 4. Bind UI Event Listeners
    this.bindEvents();

    // 5. Apply Theme & UI Style
    this.applyTheme();

    // 6. Init Sync Engine (localpm-data.json / File System Access API)
    await this.sync.init();

    // 7. Load Projects
    await this.loadProjects();

    // If no projects exist, create demo project
    if (this.projects.length === 0) {
      await this.createDemoProject();
    } else {
      await this.selectProject(this.projects[0].id);
    }
  }

  resizeCanvas(canvas) {
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
  }

  updateStorageIndicator() {
    const dot = document.getElementById('storage-status-dot');
    const text = document.getElementById('storage-status-text');
    if (db.isPersistent) {
      dot.style.background = '#10b981';
      text.innerText = 'IndexedDB: Постоянное хранилище активно (данные защищены)';
    } else {
      dot.style.background = '#f59e0b';
      text.innerText = 'IndexedDB: Стандартное хранение (рекомендуется делать экспорт)';
    }
  }

  showToast(message, type = 'info', actionText = null, onAction = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    } else {
      iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="display: flex; align-items: center;">${iconSvg}</span>
        <span>${message}</span>
      </div>
    `;

    if (actionText && onAction) {
      const actBtn = document.createElement('button');
      actBtn.className = 'toast-action';
      actBtn.innerText = actionText;
      actBtn.addEventListener('click', () => {
        onAction();
        toast.remove();
      });
      toast.appendChild(actBtn);
    }

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  bindEvents() {
    // Modals
    document.getElementById('btn-new-project')?.addEventListener('click', () => {
      document.getElementById('project-form-start').value = DateUtils.formatISO(new Date());
      this.openModal('modal-project');
    });

    document.getElementById('btn-save-project')?.addEventListener('click', () => this.handleSaveProject());

    // Task manipulations
    document.getElementById('btn-add-task')?.addEventListener('click', () => this.handleAddTask(false));
    document.getElementById('btn-add-milestone')?.addEventListener('click', () => this.handleAddTask(true));
    document.getElementById('btn-indent')?.addEventListener('click', () => this.handleIndent());
    document.getElementById('btn-outdent')?.addEventListener('click', () => this.handleOutdent());
    document.getElementById('btn-create-group')?.addEventListener('click', () => this.handleCreateGroup());
    const btnEditTask = document.getElementById('btn-edit-task');
    if (btnEditTask) btnEditTask.addEventListener('click', () => this.handleOpenTaskCard());
    document.getElementById('btn-move-up')?.addEventListener('click', () => this.handleMoveTask(-1));
    document.getElementById('btn-move-down')?.addEventListener('click', () => this.handleMoveTask(1));
    const btnSaveCard = document.getElementById('btn-save-task-card');
    if (btnSaveCard) btnSaveCard.addEventListener('click', () => this.handleSaveTaskCard());
    document.getElementById('btn-delete-task')?.addEventListener('click', () => this.handleDeleteTask());

    // Planning Mode & Baseline buttons (D-08, D-11)
    document.getElementById('btn-set-auto')?.addEventListener('click', () => this.handleSetSchedulingMode(false));
    document.getElementById('btn-set-manual')?.addEventListener('click', () => this.handleSetSchedulingMode(true));
    document.getElementById('btn-save-baseline')?.addEventListener('click', () => this.handleSaveBaseline());
    document.getElementById('btn-autofit-cols')?.addEventListener('click', () => this.handleAutoFitColumns());

    // Task Search & Filter (FR-6.10)
    const searchInput = document.getElementById('task-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => this.handleSearchTasks(e.target.value));
    }

    // Tab switching helper for Import / Export Hubs
    document.querySelectorAll('.modal-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.dataset.tabTarget;
        const modal = btn.closest('.modal-window');
        if (!modal || !targetId) return;

        modal.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
        modal.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const targetContent = modal.querySelector(`#${targetId}`);
        if (targetContent) targetContent.classList.add('active');
      });
    });

    // Unified Import / Export Hub openers
    const btnOpenImport = document.getElementById('btn-open-import-hub');
    if (btnOpenImport) {
      btnOpenImport.addEventListener('click', () => this.openModal('modal-import-hub'));
    }

    const btnOpenExport = document.getElementById('btn-open-export-hub');
    if (btnOpenExport) {
      btnOpenExport.addEventListener('click', () => this.openModal('modal-export-hub'));
    }

    const btnPeerTab = document.getElementById('btn-import-peer-tab-btn');
    if (btnPeerTab) {
      btnPeerTab.addEventListener('click', () => document.getElementById('input-peer-package').click());
    }

    // Health Audit Modal
    const btnOpenHealth = document.getElementById('btn-open-health');
    if (btnOpenHealth) {
      btnOpenHealth.addEventListener('click', () => this.handleOpenHealthAudit());
    }

    // What-If Sandbox Mode
    this.isSandbox = false;
    this.sandboxBackup = null;
    const btnSandbox = document.getElementById('btn-toggle-sandbox');
    if (btnSandbox) {
      btnSandbox.addEventListener('click', () => this.toggleSandboxMode());
    }

    const btnSandboxApply = document.getElementById('btn-sandbox-apply');
    if (btnSandboxApply) {
      btnSandboxApply.addEventListener('click', () => this.applySandbox());
    }

    const btnSandboxReset = document.getElementById('btn-sandbox-reset');
    if (btnSandboxReset) {
      btnSandboxReset.addEventListener('click', () => this.resetSandbox());
    }

    // Resource Heatmap Panel Toggle
    const btnToggleRes = document.getElementById('btn-toggle-resources');
    const resPanel = document.getElementById('resource-panel');
    const btnCloseRes = document.getElementById('btn-close-resources');

    if (btnToggleRes && resPanel) {
      btnToggleRes.addEventListener('click', () => {
        resPanel.classList.toggle('open');
        this.renderResourceHeatmap();
      });
    }
    if (btnCloseRes && resPanel) {
      btnCloseRes.addEventListener('click', () => resPanel.classList.remove('open'));
    }

    // Scale
    document.getElementById('select-scale').addEventListener('change', (e) => {
      this.gantt.setScale(e.target.value);
    });

    // Excel Import File Picker
    document.getElementById('btn-import-pick-file').addEventListener('click', () => {
      document.getElementById('input-excel-file').click();
    });

    document.getElementById('input-excel-file').addEventListener('change', (e) => this.handleExcelFilePick(e));
    document.getElementById('btn-execute-import').addEventListener('click', () => this.handleExecuteImport());

    // Clipboard paste helper (FR-5.03)
    const btnPaste = document.getElementById('btn-paste-clipboard');
    if (btnPaste) {
      btnPaste.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            document.getElementById('import-tsv-input').value = text;
          }
        } catch (err) {
          alert('Вставьте скопированный текст из буфера в поле ввода вручную (Ctrl+V)');
        }
      });
    }

    // View Mode Switching (Split, Gantt only, Table only)
    const btnViewSplit = document.getElementById('btn-view-split');
    const btnViewGantt = document.getElementById('btn-view-gantt');
    const btnViewTable = document.getElementById('btn-view-table');
    const viewTablePanel = document.getElementById('main-table-panel');
    const viewGanttContainer = document.getElementById('gantt-container');
    const viewResizer = document.getElementById('split-resizer');

    const setViewMode = (mode) => {
      [btnViewSplit, btnViewGantt, btnViewTable].forEach(b => b?.classList.remove('active'));
      if (mode === 'gantt') {
        btnViewGantt?.classList.add('active');
        if (viewTablePanel) viewTablePanel.style.display = 'none';
        if (viewResizer) viewResizer.style.display = 'none';
        if (viewGanttContainer) viewGanttContainer.style.display = 'block';
      } else if (mode === 'table') {
        btnViewTable?.classList.add('active');
        if (viewTablePanel) {
          viewTablePanel.style.display = 'flex';
          viewTablePanel.style.width = '100%';
          viewTablePanel.style.maxWidth = '100vw';
        }
        if (viewResizer) viewResizer.style.display = 'none';
        if (viewGanttContainer) viewGanttContainer.style.display = 'none';
      } else {
        btnViewSplit?.classList.add('active');
        if (viewTablePanel) {
          viewTablePanel.style.display = 'flex';
          viewTablePanel.style.width = '580px';
          viewTablePanel.style.maxWidth = '75vw';
        }
        if (viewResizer) viewResizer.style.display = 'block';
        if (viewGanttContainer) viewGanttContainer.style.display = 'block';
      }
      localStorage.setItem('localpm_view_mode', mode);
      setTimeout(() => {
        const canvas = document.getElementById('gantt-canvas');
        if (canvas) {
          this.resizeCanvas(canvas);
          this.gantt.render();
        }
      }, 50);
    };

    btnViewSplit?.addEventListener('click', () => setViewMode('split'));
    btnViewGantt?.addEventListener('click', () => setViewMode('gantt'));
    btnViewTable?.addEventListener('click', () => setViewMode('table'));

    const savedViewMode = localStorage.getItem('localpm_view_mode');
    if (savedViewMode && savedViewMode !== 'split') {
      setViewMode(savedViewMode);
    }

    // Shortcuts Modal
    document.getElementById('btn-open-shortcuts')?.addEventListener('click', () => {
      this.openModal('modal-shortcuts');
    });

    // Undo / Redo buttons
    document.getElementById('btn-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => this.redo());

    // DB Chip & Modals
    document.getElementById('db-chip')?.addEventListener('click', () => this.openDbSettingsModal());
    document.getElementById('btn-db-link-file')?.addEventListener('click', () => this.sync.linkViaFS());
    document.getElementById('btn-db-save-file')?.addEventListener('click', () => this.sync.createViaFS());
    document.getElementById('btn-db-open-input')?.addEventListener('click', () => this.sync.openFileViaInput());
    document.getElementById('btn-db-download')?.addEventListener('click', () => this.sync.downloadCopy());

    // DB Conflict resolution buttons
    document.getElementById('btn-conflict-use-file')?.addEventListener('click', () => this.sync.resolveConflict('file'));
    document.getElementById('btn-conflict-use-local')?.addEventListener('click', () => this.sync.resolveConflict('local'));

    // Theme selector
    const selTheme = document.getElementById('select-theme');
    if (selTheme) {
      selTheme.value = this.theme;
      selTheme.addEventListener('change', (e) => {
        this.theme = e.target.value;
        localStorage.setItem('localpm_theme', this.theme);
        this.applyTheme();
      });
    }

    // Appearance & Style Modal
    document.getElementById('btn-open-settings')?.addEventListener('click', () => {
      const radio = document.querySelector(`input[name="ui-style-radio"][value="${this.uiStyle}"]`);
      if (radio) radio.checked = true;
      const themeSelect = document.getElementById('modal-theme-select');
      if (themeSelect) themeSelect.value = this.theme;
      this.openModal('modal-appearance');
    });

    document.getElementById('btn-save-appearance')?.addEventListener('click', () => {
      const selectedRadio = document.querySelector('input[name="ui-style-radio"]:checked');
      if (selectedRadio) {
        this.uiStyle = selectedRadio.value;
        localStorage.setItem('localpm_style', this.uiStyle);
      }
      const themeSelect = document.getElementById('modal-theme-select');
      if (themeSelect) {
        this.theme = themeSelect.value;
        localStorage.setItem('localpm_theme', this.theme);
        if (selTheme) selTheme.value = this.theme;
      }
      this.applyTheme();
      this.closeModal('modal-appearance');
      this.showToast('Стиль оформления успешно применён', 'success');
    });

    // Test Runner
    document.getElementById('btn-run-tests')?.addEventListener('click', () => this.runTestSuite());
    document.getElementById('btn-print-test-protocol')?.addEventListener('click', () => window.print());

    // Keyboard Shortcuts (FR-6.08: Insert, Delete, Alt+Up, Alt+Down, Ctrl+Z, Ctrl+Y, ?)
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        this.openModal('modal-shortcuts');
      } else if (e.key === 'Insert') {
        e.preventDefault();
        this.handleAddTask(false);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        this.handleDeleteTask();
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        this.handleMoveTask(-1);
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        this.handleMoveTask(1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openCommandPalette();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.duplicateSelectedTask();
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        this.gantt.jumpToToday();
        this.showToast('Переход к сегодняшней дате', 'info');
      } else if (e.key.toLowerCase() === 'z' && !e.ctrlKey) {
        e.preventDefault();
        this.gantt.fitToScreen();
        this.showToast('Проект вписан в экран', 'info');
      }
    });

    document.getElementById('btn-gantt-today')?.addEventListener('click', () => {
      this.gantt.jumpToToday();
      this.showToast('Переход к сегодняшней дате', 'info');
    });

    document.getElementById('btn-gantt-fit')?.addEventListener('click', () => {
      this.gantt.fitToScreen();
      this.showToast('Проект вписан в экран', 'info');
    });

    document.getElementById('btn-export-excel').addEventListener('click', () => this.handleExportExcel());
    document.getElementById('btn-export-pdf').addEventListener('click', () => this.handlePrintPDF());
    document.getElementById('btn-export-png').addEventListener('click', () => this.handleExportPNG());

    // Transfer Package (FR-17)
    const btnDoTransfer = document.getElementById('btn-do-transfer');
    if (btnDoTransfer) {
      btnDoTransfer.addEventListener('click', () => this.handleExportPeerPackage('transfer'));
    }

    const btnReturnPeer = document.getElementById('btn-return-peer');
    if (btnReturnPeer) {
      btnReturnPeer.addEventListener('click', () => this.handleExportPeerPackage('return'));
    }

    const btnImportPeer = document.getElementById('btn-import-peer-package');
    if (btnImportPeer) {
      btnImportPeer.addEventListener('click', () => document.getElementById('input-peer-package').click());
    }
    document.getElementById('input-peer-package')?.addEventListener('change', (e) => this.handleImportPeerPackage(e));

    // Return Diff actions
    document.getElementById('btn-accept-diff')?.addEventListener('click', () => this.handleAcceptDiff());
    document.getElementById('btn-reject-diff')?.addEventListener('click', () => {
      this.pendingReturnPackage = null;
      this.closeModal('modal-diff');
      alert('Изменения отклонены');
    });

    // Workspace Backup
    document.getElementById('btn-export-workspace')?.addEventListener('click', () => this.handleExportWorkspace());
    document.getElementById('btn-import-workspace')?.addEventListener('click', () => {
      document.getElementById('input-import-workspace')?.click();
    });
    document.getElementById('input-import-workspace')?.addEventListener('change', (e) => this.handleImportWorkspace(e));

    // Sidebar Toggle
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const sidebar = document.querySelector('.sidebar');
    if (btnToggleSidebar && sidebar) {
      btnToggleSidebar.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        setTimeout(() => {
          this.resizeCanvas(document.getElementById('gantt-canvas'));
          this.gantt.render();
        }, 220);
      });
    }

    // Interactive Drag Splitter (Table <-> Gantt)
    const resizer = document.getElementById('split-resizer');
    const tablePanel = document.querySelector('.table-panel');
    const canvas = document.getElementById('gantt-canvas');

    if (resizer && tablePanel) {
      let isDragging = false;
      let startX = 0;
      let startWidth = 0;

      resizer.addEventListener('pointerdown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = tablePanel.getBoundingClientRect().width;
        resizer.classList.add('dragging');
        try { resizer.setPointerCapture(e.pointerId); } catch (_) {}
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
      });

      resizer.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const newWidth = Math.max(280, Math.min(window.innerWidth * 0.75, startWidth + dx));
        tablePanel.style.width = `${newWidth}px`;
        this.resizeCanvas(canvas);
        this.gantt.render();
      });

      const endResize = (e) => {
        if (isDragging) {
          isDragging = false;
          resizer.classList.remove('dragging');
          try { resizer.releasePointerCapture(e.pointerId); } catch (_) {}
          document.body.style.cursor = '';
          this.resizeCanvas(canvas);
          this.gantt.render();
        }
      };

      resizer.addEventListener('pointerup', endResize);
      resizer.addEventListener('pointercancel', endResize);
    }

    // Column Resizing and Drag-and-Drop Reordering (D-04, D-11)
    this.initColumnInteractions();

    // Pro Context Menu
    this.initContextMenu();
  }

  initColumnInteractions() {
    let colDragKey = null;
    let colResizeKey = null;
    let resizeStartX = 0;
    let resizeStartW = 0;

    document.addEventListener('pointerdown', (e) => {
      // 1. Column Resizer (7px right edge)
      const rz = e.target.closest('.col-rz');
      if (rz) {
        e.preventDefault();
        e.stopPropagation();
        colResizeKey = rz.dataset.col;
        const colEl = document.querySelector(`.header-col[data-key="${colResizeKey}"]`);
        if (colEl) {
          resizeStartX = e.clientX;
          resizeStartW = colEl.getBoundingClientRect().width;
          document.body.style.cursor = 'col-resize';
        }
        return;
      }

      // 2. Column Header Drag for Reordering (D-04)
      const th = e.target.closest('.header-col[data-key]');
      if (th && !th.dataset.fixed && e.button === 0) {
        colDragKey = th.dataset.key;
      }
    });

    document.addEventListener('pointermove', (e) => {
      if (colResizeKey) {
        const delta = e.clientX - resizeStartX;
        const newW = Math.max(44, Math.min(640, Math.round(resizeStartW + delta)));
        const colHeaders = document.querySelectorAll(`.header-col[data-key="${colResizeKey}"]`);
        colHeaders.forEach(h => h.style.width = `${newW}px`);
        const rowCells = document.querySelectorAll(`.col-${colResizeKey}`);
        rowCells.forEach(c => c.style.width = `${newW}px`);
        return;
      }

      if (colDragKey) {
        const headers = [...document.querySelectorAll('.task-table-header .header-col')];
        headers.forEach(h => {
          if (h.dataset.key === colDragKey) return;
          const rect = h.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX <= rect.right) {
            h.classList.add('col-drop');
          } else {
            h.classList.remove('col-drop');
          }
        });
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (colResizeKey) {
        const colEl = document.querySelector(`.header-col[data-key="${colResizeKey}"]`);
        if (colEl && this.currentProject) {
          const finalW = Math.round(colEl.getBoundingClientRect().width);
          this.currentProject.view_settings = this.currentProject.view_settings || {};
          this.currentProject.view_settings.columnWidths = this.currentProject.view_settings.columnWidths || {};
          this.currentProject.view_settings.columnWidths[colResizeKey] = finalW;
        }
        colResizeKey = null;
        document.body.style.cursor = '';
      }

      if (colDragKey) {
        const targetHeader = document.querySelector('.task-table-header .header-col.col-drop');
        if (targetHeader && targetHeader.dataset.key && targetHeader.dataset.key !== colDragKey) {
          const container = document.getElementById('task-table-header-el');
          const draggedEl = document.querySelector(`.header-col[data-key="${colDragKey}"]`);
          if (container && draggedEl && targetHeader) {
            container.insertBefore(draggedEl, targetHeader);
            
            // Extract new order from the header DOM
            const newOrder = [...container.querySelectorAll('.header-col')].map(h => h.dataset.key).filter(Boolean);
            if (this.currentProject) {
              this.currentProject.view_settings = this.currentProject.view_settings || {};
              this.currentProject.view_settings.columnOrder = newOrder;
            }
            this.renderTaskTable();
            this.showToast(`Колонка перемещена`, 'info');
          }
        }
        document.querySelectorAll('.header-col').forEach(h => h.classList.remove('col-drop'));
        colDragKey = null;
      }
    });
  }

  openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  applyTheme() {
    let mode = this.theme;
    if (mode === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      mode = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.setAttribute('data-style', this.uiStyle);
  }

  pushHistory() {
    if (!this.currentProject) return;
    const snapshot = {
      projects: JSON.parse(JSON.stringify(this.projects)),
      currentProjectId: this.currentProject.id,
      selectedTaskId: this.selectedTaskId,
      selectedIds: [...this.selectedIds]
    };
    this.history.undo.push(snapshot);
    if (this.history.undo.length > 50) {
      this.history.undo.shift();
    }
    this.history.redo = [];
  }

  async undo() {
    if (this.history.undo.length === 0) {
      this.showToast('Нечего отменять', 'info');
      return;
    }
    const currentSnapshot = {
      projects: JSON.parse(JSON.stringify(this.projects)),
      currentProjectId: this.currentProject ? this.currentProject.id : null,
      selectedTaskId: this.selectedTaskId,
      selectedIds: [...this.selectedIds]
    };
    this.history.redo.push(currentSnapshot);

    const prev = this.history.undo.pop();
    this.projects = prev.projects;
    this.selectedTaskId = prev.selectedTaskId;
    this.selectedIds = prev.selectedIds || [];
    if (prev.currentProjectId) {
      await this.selectProject(prev.currentProjectId);
    } else {
      this.render();
    }
    this.sync.markDirty();
    this.showToast('Действие отменено (Undo)', 'info');
  }

  async redo() {
    if (this.history.redo.length === 0) {
      this.showToast('Нечего повторять', 'info');
      return;
    }
    const currentSnapshot = {
      projects: JSON.parse(JSON.stringify(this.projects)),
      currentProjectId: this.currentProject ? this.currentProject.id : null,
      selectedTaskId: this.selectedTaskId,
      selectedIds: [...this.selectedIds]
    };
    this.history.undo.push(currentSnapshot);

    const next = this.history.redo.pop();
    this.projects = next.projects;
    this.selectedTaskId = next.selectedTaskId;
    this.selectedIds = next.selectedIds || [];
    if (next.currentProjectId) {
      await this.selectProject(next.currentProjectId);
    } else {
      this.render();
    }
    this.sync.markDirty();
    this.showToast('Действие повторено (Redo)', 'info');
  }

  openDbSettingsModal() {
    const fn = document.getElementById('db-modal-filename');
    const md = document.getElementById('db-modal-mode');
    const st = document.getElementById('db-modal-status');
    const sa = document.getElementById('db-modal-saved-at');

    if (fn) fn.textContent = this.sync.fileName;
    if (md) {
      const modeNames = {
        file: 'Файл подключён (FileSystem API, автосохранение 700 мс)',
        fetch: 'Файл прочитан рядом (Fetch, только чтение)',
        'local-pending': 'Ожидается разрешение доступа к файлу',
        local: 'Локальный кэш (IndexedDB)'
      };
      md.textContent = modeNames[this.sync.dbMode] || this.sync.dbMode;
    }
    if (st) st.textContent = this.sync.fileDirty ? 'Есть несохранённые изменения' : 'Синхронно';
    if (sa) sa.textContent = this.sync.fileSavedAt ? new Date(this.sync.fileSavedAt).toLocaleString('ru-RU') : '—';

    this.openModal('modal-db-settings');
  }

  showConflictModal() {
    this.openModal('modal-db-conflict');
  }

  async renderAfterSync() {
    await this.loadProjects();
    if (this.projects.length) {
      await this.selectProject(this.projects[0].id);
    }
  }

  async runTestSuite() {
    this.openModal('modal-test-runner');
    const list = document.getElementById('test-results-list');
    const summary = document.getElementById('test-summary-badge');
    if (!list || !summary) return;

    list.innerHTML = 'Запуск проверок…';
    summary.style.background = 'var(--bg-tertiary)';
    summary.style.color = 'var(--text-primary)';
    summary.textContent = 'Выполняются 25 проверок (Спецификация D-01..D-14, R2-01..R2-12)...';

    try {
      const { runAllTests } = await import('./test_runner.js');
      const results = await runAllTests(this);
      
      list.innerHTML = '';
      let passedCount = 0;
      results.forEach(r => {
        if (r.passed) passedCount++;
        const item = document.createElement('div');
        item.style.padding = '4px 6px';
        item.style.borderRadius = '3px';
        item.style.color = r.passed ? '#10b981' : '#f43f5e';
        item.style.background = r.passed ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)';
        item.textContent = `${r.passed ? '✓ PASS' : '✗ FAIL'}: [${r.code}] ${r.name} ${r.error ? '— ' + r.error : ''}`;
        list.appendChild(item);
      });

      if (passedCount === results.length) {
        summary.style.background = 'rgba(16, 185, 129, 0.2)';
        summary.style.color = '#10b981';
        summary.textContent = `Все проверки успешно пройдены: ${passedCount} из ${results.length} (100%)`;
      } else {
        summary.style.background = 'rgba(244, 63, 94, 0.2)';
        summary.style.color = '#f43f5e';
        summary.textContent = `Пройдено: ${passedCount} из ${results.length}. Ошибок: ${results.length - passedCount}`;
      }
    } catch (e) {
      list.innerHTML = `<span style="color: #f43f5e;">Ошибка запуска тестов: ${e.message}</span>`;
    }
  }

  // --- Projects Registry ---
  async loadProjects() {
    this.projects = await db.getAllProjects();
    const listEl = document.getElementById('project-list-el');
    listEl.innerHTML = '';

    this.projects.forEach(p => {
      const li = document.createElement('li');
      li.className = `project-item ${this.currentProject && this.currentProject.id === p.id ? 'active' : ''}`;
      li.innerHTML = `
        <span class="project-item-name" title="${p.name}">${p.name}</span>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="project-item-count">${p.task_count || 0}</span>
          <button class="project-delete-btn" title="Удалить проект" aria-label="Удалить проект">&times;</button>
        </div>
      `;
      
      const delBtn = li.querySelector('.project-delete-btn');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Удалить проект "${p.name}"? Это действие необратимо.`)) {
          await db.deleteProject(p.id);
          this.projects = this.projects.filter(proj => proj.id !== p.id);
          if (this.currentProject && this.currentProject.id === p.id) {
            this.currentProject = null;
            if (this.projects.length > 0) {
              await this.selectProject(this.projects[0].id);
            } else {
              this.tasks = [];
              this.dependencies = [];
              document.getElementById('task-table-body-el').innerHTML = '';
              this.gantt.setData({ tasks: [], dependencies: [], calendar: null, startDate: null });
              document.getElementById('current-project-badge').innerText = '';
              document.getElementById('metric-tasks-count').innerText = '0';
              document.getElementById('metric-critical-count').innerText = '0';
              document.getElementById('metric-finish-date').innerText = '—';
            }
          }
          await this.loadProjects();
        }
      });

      li.addEventListener('click', () => this.selectProject(p.id));
      listEl.appendChild(li);
    });
  }

  async selectProject(id) {
    const proj = await db.getProject(id);
    if (!proj) return;
    this.currentProject = proj;

    document.getElementById('current-project-badge').innerText = `• ${proj.name}`;
    document.getElementById('print-project-title').innerText = proj.name;
    document.getElementById('print-project-meta').innerText = `Дата начала: ${DateUtils.formatRU(proj.start_date)} | Сформировано: ${new Date().toLocaleDateString('ru-RU')}`;

    // Load tasks & deps
    this.tasks = await db.getProjectTasks(id);
    this.dependencies = await db.getProjectDependencies(id);

    // Recalculate CPM
    this.recalculateSchedule();
    await this.loadProjects(); // update active state in sidebar
  }

  async handleSaveProject() {
    const name = document.getElementById('project-form-name').value.trim();
    if (!name) {
      alert('Укажите название проекта');
      return;
    }

    const startDate = document.getElementById('project-form-start').value || DateUtils.formatISO(new Date());
    const calendarType = document.getElementById('project-form-calendar').value;
    const desc = document.getElementById('project-form-desc').value;

    const newProject = {
      id: `proj-${Date.now()}`,
      name,
      description: desc,
      start_date: startDate,
      calendar: { type: calendarType, working_days: [1,2,3,4,5] },
      task_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      revision: 1
    };

    await db.saveProject(newProject);
    this.closeModal('modal-project');
    await this.loadProjects();
    await this.selectProject(newProject.id);
  }

  async createDemoProject() {
    const demoProj = {
      id: `proj-demo-1`,
      name: 'Внедрение корпоративной ERP/CRM системы (3 месяца)',
      description: 'Комплексный 3-месячный график проекта: Анализ, Архитектура, Разработка, Ввод в промышленную эксплуатацию',
      start_date: DateUtils.formatISO(new Date()),
      calendar: { type: 'rf', working_days: [1,2,3,4,5] },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      revision: 1
    };

    const demoTasks = [
      // Фаза 1: Предпроектное обследование и ТЗ (15 раб. дней)
      { id: 't1', external_number: '1', name: '1. Предпроектный анализ и концепция', duration_days: 15, percent_complete: 100, level: 0 },
      { id: 't2', external_number: '1.1', name: 'Аудит бизнес-процессов и интервью со стейкхолдерами', duration_days: 5, percent_complete: 100, parent_id: 't1' },
      { id: 't3', external_number: '1.2', name: 'Формирование функциональных требований и ТЗ', duration_days: 7, percent_complete: 100, parent_id: 't1' },
      { id: 't4', external_number: '1.3', name: 'Юридическое согласование и подписание ТЗ', duration_days: 3, percent_complete: 100, parent_id: 't1' },
      { id: 't5', external_number: '1.4', name: 'Веха: ТЗ и концепция утверждены', duration_days: 0, is_milestone: true, parent_id: 't1' },

      // Фаза 2: Архитектура и проектирование (18 раб. дней)
      { id: 't6', external_number: '2', name: '2. Архитектура и проектирование решений', duration_days: 18, percent_complete: 85, level: 0 },
      { id: 't7', external_number: '2.1', name: 'Проектирование схемы данных и модели безопасности', duration_days: 8, percent_complete: 100, parent_id: 't6' },
      { id: 't8', external_number: '2.2', name: 'Разработка спецификаций REST API и интеграций', duration_days: 7, percent_complete: 90, parent_id: 't6' },
      { id: 't9', external_number: '2.3', name: 'UX/UI дизайн ключевых экранных форм', duration_days: 9, percent_complete: 70, parent_id: 't6' },
      { id: 't10', external_number: '2.4', name: 'Веха: Архитектурный базис зафиксирован', duration_days: 0, is_milestone: true, parent_id: 't6' },

      // Фаза 3: Реализация и интеграция (22 раб. дня)
      { id: 't11', external_number: '3', name: '3. Разработка функциональных модулей', duration_days: 22, percent_complete: 45, level: 0 },
      { id: 't12', external_number: '3.1', name: 'Реализация бэкенд-сервисов и бизнес-логики', duration_days: 14, percent_complete: 60, parent_id: 't11' },
      { id: 't13', external_number: '3.2', name: 'Клиентский интерфейс и диаграммы Ганта', duration_days: 12, percent_complete: 50, parent_id: 't11' },
      { id: 't14', external_number: '3.3', name: 'Коннекторы импорта/экспорта данных (Excel/XML)', duration_days: 8, percent_complete: 30, parent_id: 't11' },
      { id: 't15', external_number: '3.4', name: 'Интеграционное тестирование модулей', duration_days: 6, percent_complete: 10, parent_id: 't11' },
      { id: 't16', external_number: '3.5', name: 'Веха: Релиз-кандидат (Feature Freeze)', duration_days: 0, is_milestone: true, parent_id: 't11' },

      // Фаза 4: Внедрение и опытно-промышленная эксплуатация (12 раб. дней)
      { id: 't17', external_number: '4', name: '4. ОПЭ, обучение и сдача в эксплуатацию', duration_days: 12, percent_complete: 0, level: 0 },
      { id: 't18', external_number: '4.1', name: 'Миграция справочников и тестовых данных', duration_days: 4, percent_complete: 0, parent_id: 't17' },
      { id: 't19', external_number: '4.2', name: 'Обучение ключевых пользователей и регламенты', duration_days: 5, percent_complete: 0, parent_id: 't17' },
      { id: 't20', external_number: '4.3', name: 'Приёмо-сдаточные испытания (UAT)', duration_days: 5, percent_complete: 0, parent_id: 't17' },
      { id: 't21', external_number: '4.4', name: 'Веха: Проект сдан заказчику в промышленную эксплуатацию', duration_days: 0, is_milestone: true, parent_id: 't17' }
    ];

    const demoDeps = [
      // Фаза 1
      { id: 'd1', pred_id: 't2', succ_id: 't3', type: 'FS', lag_workdays: 0 },
      { id: 'd2', pred_id: 't3', succ_id: 't4', type: 'FS', lag_workdays: 0 },
      { id: 'd3', pred_id: 't4', succ_id: 't5', type: 'FS', lag_workdays: 0 },

      // Переход Фаза 1 -> Фаза 2
      { id: 'd4', pred_id: 't5', succ_id: 't7', type: 'FS', lag_workdays: 0 },
      { id: 'd5', pred_id: 't5', succ_id: 't9', type: 'FS', lag_workdays: 0 },
      { id: 'd6', pred_id: 't7', succ_id: 't8', type: 'FS', lag_workdays: 0 },
      { id: 'd7', pred_id: 't8', succ_id: 't10', type: 'FS', lag_workdays: 0 },
      { id: 'd8', pred_id: 't9', succ_id: 't10', type: 'FS', lag_workdays: 0 },

      // Переход Фаза 2 -> Фаза 3
      { id: 'd9', pred_id: 't10', succ_id: 't12', type: 'FS', lag_workdays: 0 },
      { id: 'd10', pred_id: 't10', succ_id: 't13', type: 'FS', lag_workdays: 1 },
      { id: 'd11', pred_id: 't12', succ_id: 't14', type: 'SS', lag_workdays: 4 },
      { id: 'd12', pred_id: 't12', succ_id: 't15', type: 'FS', lag_workdays: 0 },
      { id: 'd13', pred_id: 't13', succ_id: 't15', type: 'FS', lag_workdays: 0 },
      { id: 'd14', pred_id: 't14', succ_id: 't15', type: 'FS', lag_workdays: 0 },
      { id: 'd15', pred_id: 't15', succ_id: 't16', type: 'FS', lag_workdays: 0 },

      // Переход Фаза 3 -> Фаза 4
      { id: 'd16', pred_id: 't16', succ_id: 't18', type: 'FS', lag_workdays: 0 },
      { id: 'd17', pred_id: 't18', succ_id: 't19', type: 'FS', lag_workdays: 0 },
      { id: 'd18', pred_id: 't19', succ_id: 't20', type: 'FS', lag_workdays: 0 },
      { id: 'd19', pred_id: 't20', succ_id: 't21', type: 'FS', lag_workdays: 0 }
    ];

    await db.saveProject(demoProj);
    await db.saveProjectPlan(demoProj.id, demoTasks, demoDeps);
    await this.loadProjects();
    await this.selectProject(demoProj.id);
  }

  // --- CPM Scheduling & Rendering ---
  recalculateSchedule() {
    if (!this.currentProject) return;

    // Remember currently focused input if any
    const activeEl = document.activeElement;
    let focusedField = null;
    let focusedTaskId = null;
    let selStart = 0;
    let selEnd = 0;

    if (activeEl && activeEl.dataset && activeEl.dataset.field && activeEl.dataset.id) {
      focusedField = activeEl.dataset.field;
      focusedTaskId = activeEl.dataset.id;
      selStart = activeEl.selectionStart || 0;
      selEnd = activeEl.selectionEnd || 0;
    }

    const calendar = this.currentProject.calendar || { type: 'rf', working_days: [1,2,3,4,5] };
    const cpmResult = CpmEngine.calculate({
      tasks: this.tasks,
      dependencies: this.dependencies,
      projectStartDate: this.currentProject.start_date,
      calendar
    });

    this.tasks = cpmResult.tasks;
    this.latestHealthReport = cpmResult;

    // Update metrics
    document.getElementById('metric-tasks-count').innerText = this.tasks.length;
    document.getElementById('metric-critical-count').innerText = cpmResult.criticalPathCount || 0;
    document.getElementById('metric-finish-date').innerText = DateUtils.formatRU(cpmResult.projectFinishDate);
    this.updateSelectionMetrics();

    // Update health badge on toolbar
    const healthBadge = document.getElementById('toolbar-health-badge');
    if (healthBadge) {
      const score = cpmResult.healthScore !== undefined ? cpmResult.healthScore : 100;
      healthBadge.innerText = `${score}%`;
      healthBadge.style.background = score >= 90 ? '#10b981' : (score >= 70 ? '#f59e0b' : '#ef4444');
    }

    // Render Table
    this.renderTaskTable();

    // Restore focus if row still exists
    if (focusedTaskId && focusedField) {
      const restoredInput = document.querySelector(`input[data-id="${focusedTaskId}"][data-field="${focusedField}"]`);
      if (restoredInput) {
        restoredInput.focus();
        try {
          restoredInput.setSelectionRange(selStart, selEnd);
        } catch (e) {}
      }
    }

    // Render Gantt
    this.gantt.setData({
      tasks: this.tasks,
      dependencies: this.dependencies,
      calendar,
      startDate: this.currentProject.start_date
    });

    // Update resources if panel is open
    const resPanel = document.getElementById('resource-panel');
    if (resPanel && resPanel.classList.contains('open')) {
      this.renderResourceHeatmap();
    }

    // Save to DB only if NOT in What-If Sandbox mode
    if (!this.isSandbox) {
      this.currentProject.task_count = this.tasks.length;
      this.currentProject.tasks = this.tasks;
      this.currentProject.dependencies = this.dependencies;
      db.saveProject(this.currentProject);
      db.saveProjectPlan(this.currentProject.id, this.tasks, this.dependencies);
      this.sync.markDirty();

      // Update active project count in sidebar badge without full reload
      const activeBadge = document.querySelector('.project-item.active .project-item-count');
      if (activeBadge) {
        activeBadge.innerText = this.tasks.length;
      }
    }
  }

  // --- What-If Sandbox Mode ---
  toggleSandboxMode() {
    this.isSandbox = !this.isSandbox;
    const banner = document.getElementById('sandbox-banner');
    const btn = document.getElementById('btn-toggle-sandbox');

    if (this.isSandbox) {
      // Save deep snapshot of baseline
      this.sandboxBackup = {
        tasks: JSON.parse(JSON.stringify(this.tasks)),
        dependencies: JSON.parse(JSON.stringify(this.dependencies))
      };
      if (banner) banner.classList.add('active');
      if (btn) {
        btn.style.background = 'linear-gradient(135deg, #d97706, #b45309)';
        btn.style.color = '#fff';
      }
    } else {
      if (banner) banner.classList.remove('active');
      if (btn) {
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  }

  applySandbox() {
    if (!this.isSandbox) return;
    this.isSandbox = false;
    this.sandboxBackup = null;
    const banner = document.getElementById('sandbox-banner');
    const btn = document.getElementById('btn-toggle-sandbox');
    if (banner) banner.classList.remove('active');
    if (btn) {
      btn.style.background = '';
      btn.style.color = '';
    }
    // Now persist scenario changes as new baseline
    this.recalculateSchedule();
    this.showToast('Сценарий «Что-если» утвержден и сохранен в основной план!', 'success');
  }

  resetSandbox() {
    if (!this.isSandbox || !this.sandboxBackup) return;
    this.tasks = JSON.parse(JSON.stringify(this.sandboxBackup.tasks));
    this.dependencies = JSON.parse(JSON.stringify(this.sandboxBackup.dependencies));
    this.isSandbox = false;
    this.sandboxBackup = null;
    const banner = document.getElementById('sandbox-banner');
    const btn = document.getElementById('btn-toggle-sandbox');
    if (banner) banner.classList.remove('active');
    if (btn) {
      btn.style.background = '';
      btn.style.color = '';
    }
    this.recalculateSchedule();
  }

  // --- Schedule Health Audit Modal ---
  handleOpenHealthAudit() {
    const report = this.latestHealthReport || {};
    const score = report.healthScore !== undefined ? report.healthScore : 100;
    const issues = report.issues || [];

    const circle = document.getElementById('health-modal-circle');
    const statusTitle = document.getElementById('health-modal-status');
    const summary = document.getElementById('health-modal-summary');
    const listEl = document.getElementById('health-issues-list');

    if (circle) {
      circle.innerText = `${score}%`;
      circle.style.borderColor = score >= 90 ? '#10b981' : (score >= 70 ? '#f59e0b' : '#ef4444');
      circle.style.boxShadow = `0 0 14px ${score >= 90 ? 'rgba(16, 185, 129, 0.4)' : (score >= 70 ? 'rgba(245, 158, 11, 0.4)' : 'rgba(239, 68, 68, 0.4)')}`;
    }

    if (statusTitle) {
      statusTitle.innerText = score >= 90 ? '✅ План высокого качества (DCMA-14)' : (score >= 70 ? '⚠️ Умеренное качество: есть риски' : '🚨 Низкое качество расписания');
    }

    if (summary) {
      const stats = report.healthStats || {};
      summary.innerText = `Проанализировано ${stats.totalTasks || this.tasks.length} задач. Висячих концов: ${(stats.missingPredsCount || 0) + (stats.missingSuccsCount || 0)}, длинных задач: ${stats.longTasksCount || 0}, отрицательных лагов: ${stats.negativeLagCount || 0}.`;
    }

    if (listEl) {
      listEl.innerHTML = '';
      if (issues.length === 0) {
        listEl.innerHTML = '<div style="color: #10b981; font-size: 0.85rem; padding: 12px; background: rgba(16, 185, 129, 0.08); border-radius: 6px; display: flex; align-items: center; gap: 8px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> <span>Замечаний не найдено. План полностью соответствует стандартам управления проектами!</span></div>';
      } else {
        issues.forEach(iss => {
          const item = document.createElement('div');
          item.className = `issue-item ${iss.severity || 'info'}`;
          let iconSvg = '';
          if (iss.severity === 'error') {
            iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
          } else if (iss.severity === 'warning') {
            iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
          } else {
            iconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
          }
          item.innerHTML = `<span style="display: flex; align-items: center; padding-top: 2px;">${iconSvg}</span><span style="flex: 1;">${iss.message}</span>`;
          if (iss.taskId) {
            item.style.cursor = 'pointer';
            item.title = 'Нажмите для перехода к задаче';
            item.addEventListener('click', () => {
              this.selectedTaskId = iss.taskId;
              this.closeModal('modal-health');
              this.gantt.selectedTaskId = iss.taskId;
              this.gantt.render();
              const row = document.querySelector(`.task-row[data-task-id="${iss.taskId}"]`);
              if (row) {
                document.querySelectorAll('.task-row').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            });
          }
          listEl.appendChild(item);
        });
      }
    }

    this.openModal('modal-health');
  }

  // --- Resource Heatmap & Balancing Panel ---
  renderResourceHeatmap() {
    const listEl = document.getElementById('resource-list-el');
    if (!listEl) return;
    listEl.innerHTML = '';

    // Calculate days allocated per owner
    const ownerLoad = new Map();
    this.tasks.forEach(t => {
      const owner = (t.owner || '').trim();
      if (!owner || t.is_summary || t.is_milestone) return;

      if (!ownerLoad.has(owner)) {
        ownerLoad.set(owner, { totalDays: 0, taskCount: 0, maxConcurrent: 1 });
      }
      const data = ownerLoad.get(owner);
      data.totalDays += (t.duration_days || 1);
      data.taskCount += 1;
    });

    if (ownerLoad.size === 0) {
      listEl.innerHTML = '<div style="color: #94a3b8; font-size: 0.8rem; padding: 12px;">Укажите ответственных в карточке задачи (✏️ Изменить) для расчета балансировки ресурсов.</div>';
      return;
    }

    // Determine max load for percentage scale
    let maxLoad = 1;
    ownerLoad.forEach(v => {
      if (v.totalDays > maxLoad) maxLoad = v.totalDays;
    });

    ownerLoad.forEach((data, owner) => {
      const pct = Math.min(100, Math.round((data.totalDays / maxLoad) * 100));
      const isOverallocated = data.totalDays > 25 || data.taskCount > 4;

      const row = document.createElement('div');
      row.className = 'resource-row';
      const statusBadge = isOverallocated
        ? '<span style="color: #f87171; display: inline-flex; align-items: center; gap: 3px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Перегруз</span>'
        : '<span style="color: #34d399; display: inline-flex; align-items: center; gap: 3px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Норма</span>';

      row.innerHTML = `
        <div class="resource-name" title="${owner}">${owner}</div>
        <div class="resource-bar-track">
          <div class="resource-bar-fill" style="width: ${pct}%; background: ${isOverallocated ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : 'linear-gradient(90deg, #6366f1, #3b82f6)'};"></div>
        </div>
        <div style="font-family: var(--font-mono); font-size: 0.74rem; width: 130px; text-align: right; color: ${isOverallocated ? '#fca5a5' : '#cbd5e1'}; display: flex; align-items: center; justify-content: flex-end; gap: 6px;">
          <span>${data.totalDays} дн. (${data.taskCount} зад.)</span>
          ${statusBadge}
        </div>
      `;
      listEl.appendChild(row);
    });
  }

  renderTaskTable() {
    const bodyEl = document.getElementById('task-table-body-el');
    bodyEl.innerHTML = '';

    const taskMap = new Map(this.tasks.map(t => [t.id, t.external_number]));
    const depsBySucc = new Map();
    this.dependencies.forEach(d => {
      if (!depsBySucc.has(d.succ_id)) depsBySucc.set(d.succ_id, []);
      depsBySucc.get(d.succ_id).push(d);
    });

    if (this.tasks.length === 0) {
      bodyEl.innerHTML = `
        <div class="empty-state-card">
          <div class="empty-state-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </div>
          <div class="empty-state-title">В проекте пока нет задач</div>
          <div class="empty-state-desc">Создайте первую задачу вручную или загрузите готовый план из Excel / TSV.</div>
          <div style="display: flex; gap: 10px;">
            <button class="btn btn-primary btn-sm" id="btn-empty-add-task">+ Добавить задачу</button>
            <button class="btn btn-sm" id="btn-empty-import">📥 Импорт Excel</button>
          </div>
        </div>
      `;
      document.getElementById('btn-empty-add-task')?.addEventListener('click', () => this.handleAddTask(false));
      document.getElementById('btn-empty-import')?.addEventListener('click', () => this.openModal('modal-import-hub'));
      return;
    }

    this.tasks.forEach((t, idx) => {
      const row = document.createElement('div');
      const isChild = (t.level || 0) > 0 || !!t.parent_id;
      const isSelected = (this.selectedIds && this.selectedIds.includes(t.id)) || this.selectedTaskId === t.id;
      row.className = `task-row ${t.is_summary ? 'summary' : ''} ${t.is_critical ? 'critical' : ''} ${isChild ? 'is-child-task' : ''} ${isSelected ? 'selected' : ''}`;
      
      // Clean proportional tree indent: 24px per level without unicode symbols
      const indentPx = (t.level || 0) * 24;
      const predsStr = ValidationUtils.formatPredecessors(depsBySucc.get(t.id) || [], taskMap);

      // Dynamic column rendering following current order (D-04, D-05, D-06)
      const currentOrder = this.currentProject?.view_settings?.columnOrder || ['num', 'name', 'duration', 'start', 'finish', 'preds', 'owner', 'note'];
      const cellGenerators = {
        num: () => `<div class="col-num" title="Потяните для изменения порядка задач" draggable="true">${t.external_number || (idx + 1)}</div>`,
        name: () => `<div class="col-name" style="padding-left: ${indentPx + 12}px; display: flex; align-items: center;">
          ${t.is_milestone ? '<span class="milestone-badge" title="Контрольная точка (веха)"></span>' : ''}
          ${t.is_manual ? '<span style="margin-right: 6px; font-size: 0.85rem;" title="Ручное планирование (даты зафиксированы)">✋</span>' : ''}
          <input type="text" value="${t.name}" data-field="name" data-id="${t.id}">
        </div>`,
        duration: () => `<div class="col-dur">
          <input type="text" style="text-align: center;" value="${DateUtils.formatDuration(t.duration_days)}" data-field="duration" data-id="${t.id}" ${t.is_summary ? 'disabled' : ''}>
        </div>`,
        start: () => `<div class="col-start">${DateUtils.formatRU(t.start_date)}</div>`,
        finish: () => `<div class="col-finish">${DateUtils.formatRU(t.finish_date)}</div>`,
        preds: () => `<div class="col-preds">
          <input type="text" style="text-align: center;" value="${predsStr}" data-field="preds" data-id="${t.id}">
        </div>`,
        owner: () => `<div class="col-owner">
          <input type="text" value="${t.owner || ''}" placeholder="Исполнитель" data-field="owner" data-id="${t.id}">
        </div>`,
        note: () => `<div class="col-note">
          <input type="text" value="${t.note || t.notes || ''}" placeholder="Прим." data-field="note" data-id="${t.id}">
        </div>`
      };

      row.innerHTML = currentOrder.map(k => cellGenerators[k] ? cellGenerators[k]() : '').join('');

      // Drag and Drop reordering by numbers (FR-6.05)
      const numCol = row.querySelector('.col-num');
      row.dataset.taskId = t.id;
      row.dataset.index = idx;

      numCol.addEventListener('dragstart', (e) => {
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
      });

      numCol.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        document.querySelectorAll('.task-row').forEach(r => {
          r.classList.remove('drag-over-top', 'drag-over-bottom');
        });
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          row.classList.add('drag-over-top');
          row.classList.remove('drag-over-bottom');
        } else {
          row.classList.add('drag-over-bottom');
          row.classList.remove('drag-over-top');
        }
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === t.id) return;

        const fromIdx = this.tasks.findIndex(item => item.id === draggedId);
        const toIdx = this.tasks.findIndex(item => item.id === t.id);
        if (fromIdx < 0 || toIdx < 0) return;

        const rect = row.getBoundingClientRect();
        const placeAfter = e.clientY >= rect.top + rect.height / 2;

        const [movedTask] = this.tasks.splice(fromIdx, 1);
        let insertIdx = this.tasks.findIndex(item => item.id === t.id);
        if (placeAfter) insertIdx += 1;

        this.tasks.splice(insertIdx, 0, movedTask);
        this.tasks.forEach((taskItem, i) => {
          taskItem.sort_order = i;
        });

        this.selectedTaskId = movedTask.id;
        this.recalculateSchedule();
      });

      row.addEventListener('click', (e) => {
        // Multi-selection (Shift+Click, Ctrl/Cmd+Click)
        if (e.ctrlKey || e.metaKey) {
          const idx = this.selectedIds.indexOf(t.id);
          if (idx >= 0) {
            this.selectedIds.splice(idx, 1);
            if (this.selectedTaskId === t.id) {
              this.selectedTaskId = this.selectedIds[0] || null;
            }
          } else {
            this.selectedIds.push(t.id);
            this.selectedTaskId = t.id;
          }
          this.anchorId = t.id;
        } else if (e.shiftKey && this.anchorId) {
          const allIds = this.tasks.map(item => item.id);
          const a = allIds.indexOf(this.anchorId);
          const b = allIds.indexOf(t.id);
          if (a >= 0 && b >= 0) {
            const [start, end] = a < b ? [a, b] : [b, a];
            this.selectedIds = allIds.slice(start, end + 1);
            this.selectedTaskId = t.id;
          }
        } else {
          this.selectedTaskId = t.id;
          this.selectedIds = [t.id];
          this.anchorId = t.id;
        }

        this.gantt.selectedTaskId = this.selectedTaskId;
        this.updateSelectionUI();
        this.gantt.render();
      });

      // Double-click row to open Task Card modal (Enterprise UX standard)
      row.addEventListener('dblclick', (e) => {
        if (e.target.tagName !== 'INPUT') {
          this.selectedTaskId = t.id;
          this.handleOpenTaskCard();
        }
      });

      // Also select when any input is focused
      row.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('focus', () => {
          if (!this.selectedIds.includes(t.id)) {
            this.selectedTaskId = t.id;
            this.selectedIds = [t.id];
            this.anchorId = t.id;
            this.gantt.selectedTaskId = t.id;
            this.updateSelectionUI();
            this.gantt.render();
          }
        });
      });

      // Excel-style Keyboard Cell Navigation (Arrows, Tab, Enter)
      const inputFields = ['name', 'duration', 'preds', 'owner', 'note'];
      row.querySelectorAll('input[data-field]').forEach(inp => {
        inp.addEventListener('keydown', (e) => {
          const currentField = inp.dataset.field;
          const fieldIdx = inputFields.indexOf(currentField);

          if (e.key === 'Enter') {
            e.preventDefault();
            inp.blur();
            // Move to same field in next row, or focus ghost input if at bottom
            const nextRow = row.nextElementSibling;
            if (nextRow && !nextRow.classList.contains('ghost-row')) {
              const targetInp = nextRow.querySelector(`input[data-field="${currentField}"]`);
              if (targetInp) targetInp.focus();
            } else {
              const ghost = document.querySelector('input[data-role="ghost-task-input"]');
              if (ghost) ghost.focus();
            }
          } else if (e.key === 'ArrowDown') {
            const nextRow = row.nextElementSibling;
            if (nextRow) {
              const targetInp = nextRow.querySelector(`input[data-field="${currentField}"]`);
              if (targetInp) {
                e.preventDefault();
                targetInp.focus();
              }
            }
          } else if (e.key === 'ArrowUp') {
            const prevRow = row.previousElementSibling;
            if (prevRow) {
              const targetInp = prevRow.querySelector(`input[data-field="${currentField}"]`);
              if (targetInp) {
                e.preventDefault();
                targetInp.focus();
              }
            }
          }
        });
      });

      // Inline edits
      const nameInput = row.querySelector('input[data-field="name"]');
      nameInput.addEventListener('change', (e) => {
        t.name = e.target.value.trim() || 'Без названия';
        this.recalculateSchedule();
      });

      const durInput = row.querySelector('input[data-field="duration"]');
      if (durInput) {
        durInput.addEventListener('change', (e) => {
          const parsed = DateUtils.parseDuration(e.target.value);
          t.duration_days = Math.max(0, isNaN(parsed) ? 1 : parsed);
          t.is_milestone = t.duration_days === 0;
          this.recalculateSchedule();
        });
      }

      const predsInput = row.querySelector('input[data-field="preds"]');
      predsInput.addEventListener('change', (e) => {
        this.updateTaskPredecessors(t.id, e.target.value);
      });

      const ownerInput = row.querySelector('input[data-field="owner"]');
      if (ownerInput) {
        ownerInput.addEventListener('change', (e) => {
          t.owner = e.target.value.trim();
          this.recalculateSchedule();
        });
      }

      const noteInput = row.querySelector('input[data-field="note"]');
      if (noteInput) {
        noteInput.addEventListener('change', (e) => {
          t.note = e.target.value.trim();
          t.notes = t.note;
          this.recalculateSchedule();
        });
      }

      bodyEl.appendChild(row);
    });

    // Ghost Row for fast task creation (FR-6.03)
    const ghostRow = document.createElement('div');
    ghostRow.className = 'task-row ghost-row';
    ghostRow.innerHTML = `
      <div class="col-num" style="opacity: 0.5;">+</div>
      <div class="col-name" style="padding-left: 8px;">
        <input type="text" placeholder="+ Добавить задачу... (нажмите Enter)" data-role="ghost-task-input">
      </div>
      <div class="col-dur"></div>
      <div class="col-start"></div>
      <div class="col-finish"></div>
      <div class="col-preds"></div>
    `;

    const ghostInput = ghostRow.querySelector('input[data-role="ghost-task-input"]');
    if (ghostInput) {
      let isCommitting = false;
      const commitGhostTask = () => {
        if (isCommitting) return;
        const val = ghostInput.value.trim();
        if (val) {
          isCommitting = true;
          ghostInput.value = '';
          const isMilestone = val.startsWith('◆') || val.startsWith('*');
          const cleanName = val.replace(/^[◆*]\s*/, '');
          const newId = `task-${Date.now()}`;
          const newTask = {
            id: newId,
            external_number: String(this.tasks.length + 1),
            name: cleanName,
            duration_days: isMilestone ? 0 : 1,
            is_milestone: isMilestone,
            percent_complete: 0,
            parent_id: null,
            level: 0,
            sort_order: this.tasks.length
          };
          this.tasks.push(newTask);
          this.selectedTaskId = newId;
          this.selectedIds = [newId];
          this.anchorId = newId;
          this.recalculateSchedule();
          setTimeout(() => {
            const nextGhost = document.querySelector('input[data-role="ghost-task-input"]');
            if (nextGhost) nextGhost.focus();
            isCommitting = false;
          }, 60);
        }
      };

      ghostInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitGhostTask();
        }
      });
      ghostInput.addEventListener('blur', () => {
        commitGhostTask();
      });
    }

    bodyEl.appendChild(ghostRow);
  }

  updateTaskPredecessors(taskId, predStr) {
    // Remove existing dependencies for this task
    this.dependencies = this.dependencies.filter(d => d.succ_id !== taskId);

    const parsed = ValidationUtils.parsePredecessors(predStr);
    const numToTask = new Map();
    this.tasks.forEach(t => numToTask.set(String(t.external_number), t));

    parsed.forEach(p => {
      const predTask = numToTask.get(String(p.predNumber));
      if (predTask && predTask.id !== taskId) {
        this.dependencies.push({
          id: `dep-${taskId}-${predTask.id}`,
          pred_id: predTask.id,
          succ_id: taskId,
          type: p.type,
          lag_workdays: p.lag
        });
      }
    });

    this.recalculateSchedule();
  }

  // --- Task Operations ---
  handleAddTask(isMilestone = false) {
    if (!this.currentProject) return;

    // Force commit any active element edits before recalculating
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
    }

    this.pushHistory();

    const newId = `task-${Date.now()}`;
    const selectedIndex = this.selectedTaskId 
      ? this.tasks.findIndex(t => t.id === this.selectedTaskId) 
      : -1;
    const selectedTask = selectedIndex >= 0 ? this.tasks[selectedIndex] : null;

    const newTask = {
      id: newId,
      external_number: String(this.tasks.length + 1),
      name: isMilestone ? 'Новая контрольная точка' : 'Новая задача',
      duration_days: isMilestone ? 0 : 1,
      is_milestone: isMilestone,
      percent_complete: 0,
      parent_id: selectedTask ? (selectedTask.parent_id || null) : null,
      level: selectedTask ? selectedTask.level : 0,
      sort_order: selectedIndex >= 0 ? selectedIndex + 1 : this.tasks.length
    };

    if (selectedIndex >= 0) {
      this.tasks.splice(selectedIndex + 1, 0, newTask);
    } else {
      this.tasks.push(newTask);
    }

    // Re-index sort_order to maintain consistent order
    this.tasks.forEach((t, i) => {
      t.sort_order = i;
    });

    this.selectedTaskId = newId;
    this.recalculateSchedule();

    // Scroll new task into view and auto-focus its name input
    setTimeout(() => {
      const row = document.querySelector(`.task-row.selected`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const input = row.querySelector('input[data-field="name"]');
        if (input) {
          input.focus();
          input.select();
        }
      }
    }, 50);
  }

  updateSelectionUI() {
    const selSet = new Set(this.selectedIds && this.selectedIds.length > 0 ? this.selectedIds : (this.selectedTaskId ? [this.selectedTaskId] : []));
    document.querySelectorAll('.task-row').forEach(r => {
      const id = r.dataset.taskId;
      if (id && selSet.has(id)) {
        r.classList.add('selected');
      } else {
        r.classList.remove('selected');
      }
    });
    this.updateSelectionMetrics();
  }

  updateSelectionMetrics() {
    const count = this.selectedIds ? this.selectedIds.length : (this.selectedTaskId ? 1 : 0);
    const wrap = document.getElementById('metric-selected-wrap');
    const el = document.getElementById('metric-selected-count');
    if (wrap && el) {
      if (count > 1) {
        el.innerText = count;
        wrap.style.display = 'inline';
      } else {
        wrap.style.display = 'none';
      }
    }
  }

  getSelectedTaskIds() {
    if (this.selectedIds && this.selectedIds.length > 0) {
      return [...this.selectedIds];
    }
    return this.selectedTaskId ? [this.selectedTaskId] : [];
  }

  handleIndent() {
    const selIds = this.getSelectedTaskIds();
    if (!selIds.length) return;
    this.pushHistory();
    this.tasks = WbsUtils.indent(this.tasks, selIds);
    this.recalculateSchedule();
    this.showToast(selIds.length > 1 ? `Уровень +1 для ${selIds.length} задач` : 'Уровень +1', 'info');
  }

  handleOutdent() {
    const selIds = this.getSelectedTaskIds();
    if (!selIds.length) return;
    this.pushHistory();
    this.tasks = WbsUtils.outdent(this.tasks, selIds);
    this.recalculateSchedule();
    this.showToast(selIds.length > 1 ? `Уровень -1 для ${selIds.length} задач` : 'Уровень -1', 'info');
  }

  handleDeleteTask() {
    // Force blur any active input
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
    }

    const selIds = this.getSelectedTaskIds();
    if (!selIds.length) {
      if (this.tasks.length > 0) {
        selIds.push(this.tasks[this.tasks.length - 1].id);
      } else {
        return;
      }
    }

    this.pushHistory();

    const backupTasks = [...this.tasks];
    const backupDeps = [...this.dependencies];
    const toDeleteSet = WbsUtils.subtreeIds(this.tasks, selIds);

    this.tasks = this.tasks.filter(t => !toDeleteSet.has(t.id));
    this.dependencies = this.dependencies.filter(d => !toDeleteSet.has(d.pred_id) && !toDeleteSet.has(d.succ_id));

    // Re-index sort order
    this.tasks.forEach((t, i) => {
      t.sort_order = i;
    });

    // Select adjacent task
    if (this.tasks.length > 0) {
      this.selectedTaskId = this.tasks[0].id;
      this.selectedIds = [this.selectedTaskId];
      this.anchorId = this.selectedTaskId;
    } else {
      this.selectedTaskId = null;
      this.selectedIds = [];
      this.anchorId = null;
    }

    this.recalculateSchedule();

    this.showToast(`Удалено задач: ${toDeleteSet.size}`, 'warning', 'Отменить', () => {
      this.tasks = backupTasks;
      this.dependencies = backupDeps;
      this.selectedTaskId = selIds[0];
      this.selectedIds = [...selIds];
      this.anchorId = selIds[0];
      this.recalculateSchedule();
      this.showToast('Удаление отменено', 'info');
    });
  }

  handleMoveTask(direction) {
    const selIds = this.getSelectedTaskIds();
    if (!selIds.length) return;

    // Use applyStructuralMove for robust hierarchical block movement
    const selSet = new Set(selIds);
    const roots = this.tasks.filter(t => selSet.has(t.id) && (!t.parent_id || !selSet.has(t.parent_id)));
    if (!roots.length) return;

    const blockSet = WbsUtils.subtreeIds(this.tasks, roots.map(t => t.id));
    const flags = this.tasks.map(r => blockSet.has(r.id));
    const iF = flags.indexOf(true);
    const iL = flags.lastIndexOf(true);
    if (iF < 0) return;

    let beforeId = null;
    if (direction === -1) {
      let i = iF - 1;
      while (i >= 0 && blockSet.has(this.tasks[i].id)) i--;
      if (i < 0) {
        this.showToast('Блок уже в самом верху', 'info');
        return;
      }
      beforeId = this.tasks[i].id;
    } else {
      let i = iL + 1;
      while (i < this.tasks.length && blockSet.has(this.tasks[i].id)) i++;
      if (i >= this.tasks.length) {
        this.showToast('Блок уже в самом конце', 'info');
        return;
      }
      beforeId = this.tasks[i + 1] ? this.tasks[i + 1].id : null;
    }

    this.pushHistory();
    const targetLevel = this.tasks[iF].level !== undefined ? this.tasks[iF].level : 0;
    const ok = WbsUtils.applyStructuralMove(
      { tasks: this.tasks },
      roots.map(t => t.id),
      { beforeId, level: targetLevel }
    );

    if (ok) {
      this.recalculateSchedule();
      setTimeout(() => {
        const row = document.querySelector(`.task-row.selected`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 40);
    }
  }

  handleOpenTaskCard() {
    if (!this.selectedTaskId) {
      if (this.tasks.length > 0) {
        this.selectedTaskId = this.tasks[0].id;
      } else {
        return;
      }
    }

    const task = this.tasks.find(t => t.id === this.selectedTaskId);
    if (!task) return;

    const taskMap = new Map(this.tasks.map(t => [t.id, t.external_number]));
    const taskDeps = this.dependencies.filter(d => d.succ_id === task.id);
    const predsStr = ValidationUtils.formatPredecessors(taskDeps, taskMap);

    document.getElementById('card-task-id').value = task.id;
    document.getElementById('card-task-name').value = task.name || '';
    document.getElementById('card-task-duration').value = task.duration_days ?? 1;
    document.getElementById('card-task-percent').value = task.percent_complete ?? 0;
    document.getElementById('card-task-start').value = task.start_date || '';
    document.getElementById('card-task-owner').value = task.owner || '';
    document.getElementById('card-task-preds').value = predsStr;
    document.getElementById('card-task-note').value = task.notes || '';
    document.getElementById('card-task-style').value = task.custom_style || (task.is_milestone ? 'milestone' : (task.is_summary ? 'bracket' : 'solid'));
    document.getElementById('card-task-color').value = task.custom_color || '';

    this.openModal('modal-task-card');
  }

  handleSaveTaskCard() {
    const id = document.getElementById('card-task-id').value;
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;

    const name = document.getElementById('card-task-name').value.trim();
    if (!name) {
      alert('Укажите наименование задачи');
      return;
    }

    task.name = name;
    const dur = parseInt(document.getElementById('card-task-duration').value, 10);
    task.duration_days = isNaN(dur) || dur < 0 ? 0 : dur;
    task.is_milestone = task.duration_days === 0;

    const pct = parseInt(document.getElementById('card-task-percent').value, 10);
    task.percent_complete = isNaN(pct) ? 0 : Math.max(0, Math.min(100, pct));

    const startDate = document.getElementById('card-task-start').value;
    if (startDate) {
      task.start_date = startDate;
    }

    task.owner = document.getElementById('card-task-owner').value.trim();
    task.notes = document.getElementById('card-task-note').value.trim();
    task.custom_style = document.getElementById('card-task-style').value;
    task.custom_color = document.getElementById('card-task-color').value;

    const predsStr = document.getElementById('card-task-preds').value.trim();
    this.updateTaskPredecessors(task.id, predsStr);

    this.closeModal('modal-task-card');
    this.recalculateSchedule();
  }

  handleSearchTasks(query) {
    const term = (query || '').trim().toLowerCase();
    const rows = document.querySelectorAll('.task-row:not(.ghost-row)');

    rows.forEach(r => {
      const nameInput = r.querySelector('input[data-field="name"]');
      const text = nameInput ? nameInput.value.toLowerCase() : '';
      if (!term) {
        r.classList.remove('search-match', 'search-hidden');
      } else if (text.includes(term)) {
        r.classList.add('search-match');
        r.classList.remove('search-hidden');
      } else {
        r.classList.remove('search-match');
        r.classList.add('search-hidden');
      }
    });
  }

  // --- Excel Import & Export ---
  async handleExcelFilePick(event) {
    const file = event.target.files[0];
    if (!file) return;

    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const firstSheetName = wb.SheetNames[0];
    const ws = wb.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    if (rows.length < 2) {
      alert('Файл пуст или содержит только заголовки');
      return;
    }

    const header = rows[0];
    const mapping = XlsxIO.mapHeaders(header);
    const parsed = XlsxIO.processRows(rows.slice(1), mapping, this.currentProject.calendar);

    this.executeImportTasks(parsed.tasks, parsed.dependencies);
  }

  handleExecuteImport() {
    const tsvText = document.getElementById('import-tsv-input').value;
    if (!tsvText.trim()) {
      alert('Вставьте данные в поле ввода');
      return;
    }

    const rows = XlsxIO.parseTSV(tsvText);
    if (rows.length < 1) return;

    // If first row looks like header
    let mapping = {};
    let dataRows = rows;
    if (isNaN(parseInt(rows[0][0], 10)) && isNaN(parseInt(rows[0][2], 10))) {
      mapping = XlsxIO.mapHeaders(rows[0]);
      dataRows = rows.slice(1);
    } else {
      // Default order: №, Задача, Длительность, Начало, Окончание, Связи
      mapping = { external_number: 0, name: 1, duration_days: 2, start_date: 3, finish_date: 4, predecessors: 5 };
    }

    const parsed = XlsxIO.processRows(dataRows, mapping, this.currentProject.calendar);
    this.executeImportTasks(parsed.tasks, parsed.dependencies);
  }

  executeImportTasks(newTasks, newDeps) {
    const mode = document.getElementById('import-mode-select').value;
    if (mode === 'replace') {
      this.tasks = newTasks;
      this.dependencies = newDeps;
    } else {
      this.tasks = [...this.tasks, ...newTasks];
      this.dependencies = [...this.dependencies, ...newDeps];
    }

    this.closeModal('modal-import-hub');
    this.closeModal('modal-import');
    this.recalculateSchedule();
    this.showToast(`Успешно импортировано ${newTasks.length} задач!`, 'success');
  }

  handleExportExcel() {
    if (!this.currentProject) return;
    const blob = XlsxIO.exportToXlsx(this.currentProject, this.tasks, this.dependencies);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.currentProject.name.replace(/\s+/g, '_')}_${DateUtils.formatISO(new Date())}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Файл Excel успешно скачан', 'success');
  }

  handlePrintPDF() {
    window.print();
  }

  handleExportPNG() {
    const dataUrl = this.gantt.exportToPNG();
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `Gantt_${this.currentProject.name}.png`;
    a.click();
    this.showToast('Диаграмма Ганта скачана в формате PNG', 'success');
  }

  // --- Peer Transfer Package (FR-17) ---
  async handleExportPeerPackage(kind = 'transfer') {
    if (!this.currentProject) return;

    const senderName = document.getElementById('transfer-sender-name').value || 'Руководитель';
    const recipientName = document.getElementById('transfer-recipient-name').value || '';
    const comment = document.getElementById('transfer-comment').value || '';

    const pkg = await TransferUtils.createPackage({
      project: this.currentProject,
      tasks: this.tasks,
      dependencies: this.dependencies,
      calendar: this.currentProject.calendar,
      senderName,
      recipientName,
      comment,
      kind
    });

    const jsonStr = JSON.stringify(pkg, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.currentProject.name.replace(/\s+/g, '_')}_${DateUtils.formatISO(new Date())}.lpmproject`;
    a.click();
    URL.revokeObjectURL(url);

    this.closeModal('modal-export-hub');
    this.closeModal('modal-transfer');
    this.showToast(kind === 'transfer' ? 'Пакет передачи коллеге сформирован!' : 'Пакет возврата сформирован!', 'success');
  }

  async handleImportPeerPackage(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rawPkg = JSON.parse(text);
      const validation = await TransferUtils.validatePackage(rawPkg);

      if (!validation.valid) {
        alert(`Ошибка импорта: ${validation.error}`);
        return;
      }

      const pkg = validation.pkg;

      // Check if it's return package
      if (pkg.kind === 'return') {
        const localTarget = this.projects.find(p => p.id === pkg.project.projectId);
        if (localTarget) {
          await this.selectProject(localTarget.id);
          const diff = TransferUtils.diffVersions(
            this.tasks,
            pkg.project.tasks,
            this.dependencies,
            pkg.project.dependencies
          );

          this.pendingReturnPackage = pkg;
          this.showDiffModal(diff, pkg);
          return;
        }
      }

      // Standard transfer import: create independent project copy (FR-17.06)
      const newProjId = `proj-${Date.now()}`;
      const importedProject = {
        id: newProjId,
        origin_id: pkg.project.projectId,
        name: `${pkg.project.name} (от ${pkg.sender.name || 'коллеги'})`,
        start_date: pkg.project.calendar && pkg.project.calendar.start_date || DateUtils.formatISO(new Date()),
        calendar: pkg.project.calendar || { type: 'rf', working_days: [1,2,3,4,5] },
        revision: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await db.saveProject(importedProject);
      await db.saveProjectPlan(newProjId, pkg.project.tasks, pkg.project.dependencies);
      await this.loadProjects();
      await this.selectProject(newProjId);

      alert(`Проект "${importedProject.name}" успешно импортирован от ${pkg.sender.name}!`);
    } catch (e) {
      alert(`Не удалось прочитать файл пакета: ${e.message}`);
    }
  }

  showDiffModal(diff, pkg) {
    const diffContainer = document.getElementById('modal-diff-content');
    diffContainer.innerHTML = `
      <p style="font-size: 0.85rem; color: #94a3b8; margin-bottom: 12px;">
        Коллега <b>${pkg.sender.name || 'Пользователь'}</b> вернул изменения плана. Найдено изменений: <b>${diff.totalChanges}</b>.
      </p>
      <div style="font-size: 0.82rem; display: flex; flex-direction: column; gap: 8px;">
        ${diff.addedTasks.map(t => `<div style="color: #10b981;">+ Добавлена задача: <b>${t.name}</b> (${t.duration_days}д)</div>`).join('')}
        ${diff.updatedTasks.map(u => `<div style="color: #3b82f6;">● Изменена задача "<b>${u.task.name}</b>": ${u.changes.join(', ')}</div>`).join('')}
        ${diff.removedTasks.map(r => `<div style="color: #ef4444;">- Удалена задача: <b>${r.name}</b></div>`).join('')}
      </div>
    `;
    this.openModal('modal-diff');
  }

  async handleAcceptDiff() {
    if (!this.pendingReturnPackage || !this.currentProject) return;

    this.tasks = this.pendingReturnPackage.project.tasks;
    this.dependencies = this.pendingReturnPackage.project.dependencies;
    this.currentProject.revision = (this.currentProject.revision || 1) + 1;

    this.closeModal('modal-diff');
    this.recalculateSchedule();
    this.pendingReturnPackage = null;
    alert('Изменения приняты и объединены с текущим планом проекта!');
  }

  // --- Workspace Backup (FR-1.06) ---
  async handleExportWorkspace() {
    const allProjects = await db.getAllProjects();
    const fullData = {
      format: 'localpm-workspace',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      projects: []
    };

    for (const p of allProjects) {
      const pTasks = await db.getProjectTasks(p.id);
      const pDeps = await db.getProjectDependencies(p.id);
      fullData.projects.push({ ...p, tasks: pTasks, dependencies: pDeps });
    }

    const blob = new Blob([JSON.stringify(fullData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `localpm-workspace-backup_${DateUtils.formatISO(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async handleImportWorkspace(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.format !== 'localpm-workspace' || !Array.isArray(data.projects)) {
        alert('Неверный формат резервной копии рабочего пространства');
        return;
      }

      for (const p of data.projects) {
        const { tasks, dependencies, ...projInfo } = p;
        await db.saveProject(projInfo);
        await db.saveProjectPlan(projInfo.id, tasks || [], dependencies || []);
      }

      await this.loadProjects();
      if (data.projects.length > 0) {
        await this.selectProject(data.projects[0].id);
      }
      alert(`Рабочее пространство восстановлено: ${data.projects.length} проектов!`);
    } catch (e) {
      alert(`Ошибка чтения резервной копии: ${e.message}`);
    }
  }

  // --- WBS Grouping & Scheduling Modes (D-03, D-08, D-11, SPEC-LocalPM-003) ---
  handleCreateGroup() {
    if (!this.currentProject) return;
    const selIds = this.getSelectedTaskIds();
    if (!selIds.length) {
      this.showToast('Выберите задачи для объединения в этап', 'warning');
      return;
    }

    const selTasks = this.tasks.filter(t => selIds.includes(t.id));
    if (!selTasks.length) return;

    this.pushHistory();

    const firstTask = selTasks[0];
    const parentId = firstTask.parent_id || null;
    const taskIndex = this.tasks.findIndex(t => t.id === firstTask.id);
    const newGroupId = `group-${Date.now()}`;

    const newGroup = {
      id: newGroupId,
      external_number: String(taskIndex + 1),
      name: 'Новый этап',
      duration_days: 1,
      start_date: firstTask.start_date,
      finish_date: firstTask.finish_date,
      percent_complete: 0,
      parent_id: parentId,
      level: firstTask.level || 0,
      is_summary: true,
      sort_order: taskIndex
    };

    // Make all selected root tasks children of the newly created group
    const selSet = new Set(selIds);
    const roots = this.tasks.filter(t => selSet.has(t.id) && (!t.parent_id || !selSet.has(t.parent_id)));
    roots.forEach(t => {
      t.parent_id = newGroupId;
    });

    this.tasks.splice(taskIndex, 0, newGroup);
    this.tasks.forEach((t, i) => { t.sort_order = i; });

    this.selectedTaskId = newGroupId;
    this.selectedIds = [newGroupId];
    this.anchorId = newGroupId;
    this.recalculateSchedule();
    this.showToast(`Создан суммарный этап «Новый этап» (${roots.length} задач)`, 'success');
  }

  handleSetSchedulingMode(isManual) {
    const selIds = this.getSelectedTaskIds();
    if (!selIds.length) {
      this.showToast('Выберите задачи для изменения режима планирования', 'warning');
      return;
    }

    this.pushHistory();
    const selSet = new Set(selIds);
    let count = 0;
    this.tasks.forEach(t => {
      if (selSet.has(t.id)) {
        t.is_manual = !!isManual;
        count++;
      }
    });

    this.recalculateSchedule();
    this.showToast(isManual ? `Ручной режим ✋ установлен для ${count} задач` : `Автопланирование CPM установлено для ${count} задач`, 'info');
  }

  handleSaveBaseline() {
    if (!this.currentProject) return;
    this.pushHistory();

    const dates = {};
    this.tasks.forEach(t => {
      dates[t.id] = {
        start: t.start_date,
        finish: t.finish_date
      };
    });

    this.currentProject.baseline = {
      savedAt: new Date().toISOString(),
      dates
    };

    if (this.gantt) {
      this.gantt.currentProject = this.currentProject;
      this.gantt.render();
    }

    this.recalculateSchedule();
    this.showToast('Базовый план зафиксирован (серые полосы на Ганте)', 'success');
  }

  handleAutoFitColumns() {
    if (!this.currentProject) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = '12px system-ui, -apple-system, sans-serif';

    const textW = (str) => ctx.measureText(String(str || '')).width;
    const keys = ['name', 'duration', 'start', 'finish', 'preds', 'owner', 'note'];
    const titles = {
      name: 'Задача',
      duration: 'Длит.',
      start: 'Начало',
      finish: 'Конец',
      preds: 'Связи',
      owner: 'Ответственный',
      note: 'Прим.'
    };

    const taskMap = new Map(this.tasks.map(t => [t.id, t.external_number]));
    const depsBySucc = new Map();
    this.dependencies.forEach(d => {
      if (!depsBySucc.has(d.succ_id)) depsBySucc.set(d.succ_id, []);
      depsBySucc.get(d.succ_id).push(d);
    });

    const colWidths = this.currentProject.view_settings?.columnWidths || {};

    keys.forEach(k => {
      let maxW = textW(titles[k] || k) + 12;

      this.tasks.forEach(t => {
        let cellText = '';
        if (k === 'name') {
          const indent = (t.level || 0) * 20 + 26;
          maxW = Math.max(maxW, indent + textW(t.name) + 20);
          return;
        } else if (k === 'duration') {
          cellText = DateUtils.formatDuration(t.duration_days);
        } else if (k === 'start') {
          cellText = DateUtils.formatRU(t.start_date);
        } else if (k === 'finish') {
          cellText = DateUtils.formatRU(t.finish_date);
        } else if (k === 'preds') {
          cellText = ValidationUtils.formatPredecessors(depsBySucc.get(t.id) || [], taskMap);
        } else if (k === 'owner') {
          cellText = t.owner || '';
        } else if (k === 'note') {
          cellText = t.note || t.notes || '';
        }
        maxW = Math.max(maxW, textW(cellText));
      });

      const fitW = Math.max(44, Math.min(640, Math.round(maxW + 24)));
      colWidths[k] = fitW;

      // Apply to live DOM elements
      document.querySelectorAll(`.header-col[data-key="${k}"]`).forEach(h => h.style.width = `${fitW}px`);
      document.querySelectorAll(`.col-${k}`).forEach(c => c.style.width = `${fitW}px`);
    });

    this.currentProject.view_settings = this.currentProject.view_settings || {};
    this.currentProject.view_settings.columnWidths = colWidths;
    this.showToast('Ширина колонок оптимизирована по содержимому', 'info');
  }

  // --- Duplicate Task (Ctrl+D) ---
  duplicateSelectedTask() {
    if (!this.selectedTaskId) {
      this.showToast('Выберите задачу для дублирования', 'warning');
      return;
    }
    const idx = this.tasks.findIndex(t => t.id === this.selectedTaskId);
    if (idx < 0) return;

    this.pushHistory();

    const orig = this.tasks[idx];
    const newId = `task-${Date.now()}`;
    const clone = {
      ...JSON.parse(JSON.stringify(orig)),
      id: newId,
      name: `${orig.name} (копия)`,
      sort_order: idx + 1
    };

    this.tasks.splice(idx + 1, 0, clone);
    this.tasks.forEach((t, i) => { t.sort_order = i; });

    this.selectedTaskId = newId;
    this.recalculateSchedule();
    this.showToast(`Создана копия задачи «${clone.name}»`, 'success');
  }

  // --- Pro Context Menu ---
  initContextMenu() {
    const menu = document.getElementById('task-context-menu');
    if (!menu) return;

    document.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.task-row[data-task-id]');
      if (!row) {
        menu.style.display = 'none';
        return;
      }

      e.preventDefault();
      const taskId = row.dataset.taskId;
      this.selectedTaskId = taskId;
      this.gantt.selectedTaskId = taskId;
      document.querySelectorAll('.task-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      this.gantt.render();

      menu.style.left = `${Math.min(window.innerWidth - 230, e.clientX)}px`;
      menu.style.top = `${Math.min(window.innerHeight - 300, e.clientY)}px`;
      menu.style.display = 'block';
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#task-context-menu')) {
        menu.style.display = 'none';
      }
    });

    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        menu.style.display = 'none';

        if (action === 'card') {
          this.handleOpenTaskCard();
        } else if (action === 'add-task') {
          this.handleAddTask(false);
        } else if (action === 'add-milestone') {
          this.handleAddTask(true);
        } else if (action === 'duplicate') {
          this.duplicateSelectedTask();
        } else if (action === 'group') {
          this.handleCreateGroup();
        } else if (action === 'indent') {
          this.handleIndent();
        } else if (action === 'outdent') {
          this.handleOutdent();
        } else if (action === 'toggle-manual') {
          const t = this.tasks.find(x => x.id === this.selectedTaskId);
          if (t) this.handleSetSchedulingMode(!t.is_manual);
        } else if (action === 'delete') {
          this.handleDeleteTask();
        }
      });
    });
  }

  // --- Command Palette (Ctrl+K) ---
  openCommandPalette() {
    const modal = document.getElementById('modal-cmd-palette');
    const input = document.getElementById('cmd-palette-input');
    const results = document.getElementById('cmd-palette-results');
    if (!modal || !input) return;

    input.value = '';
    this.renderCommandPaletteResults('');
    this.openModal('modal-cmd-palette');
    setTimeout(() => input.focus(), 60);

    input.oninput = (e) => this.renderCommandPaletteResults(e.target.value);
  }

  renderCommandPaletteResults(query) {
    const results = document.getElementById('cmd-palette-results');
    if (!results) return;

    const q = (query || '').trim().toLowerCase();
    const items = [];

    // System Commands
    const commands = [
      { title: '+ Новая задача', desc: 'Создать стандартную задачу проекта', action: () => this.handleAddTask(false) },
      { title: '◆ Новая веха', desc: 'Создать контрольную точку с длительностью 0 дней', action: () => this.handleAddTask(true) },
      { title: '📁 Создать суммарную группу', desc: 'Сгруппировать задачи в этап WBS', action: () => this.handleCreateGroup() },
      { title: '🔍 Вписать весь проект в экран', desc: 'Оптимизировать масштаб Ганта под все даты', action: () => { this.gantt.fitToScreen(); this.showToast('Вписано в экран', 'info'); } },
      { title: '📅 Перейти к сегодняшнему дню', desc: 'Центрировать таймлайн на линии Сегодня', action: () => { this.gantt.jumpToToday(); this.showToast('Переход к сегодня', 'info'); } },
      { title: '📊 Оптимизировать ширину колонок', desc: 'Автоподбор ширины под текст', action: () => this.handleAutoFitColumns() },
      { title: '🎨 Настройки оформления и стилей', desc: 'Linear, Fluent 2, GitHub Primer, Классический', action: () => this.openModal('modal-appearance') },
      { title: '🐙 Стиль: GitHub Primer UI', desc: 'Переключить тему на официальный стиль GitHub', action: () => { this.uiStyle = 'github'; localStorage.setItem('localpm_style', 'github'); this.applyTheme(); this.showToast('Установлен стиль GitHub Primer UI', 'info'); } },
      { title: '📥 Экспорт в Excel (XLSX)', desc: 'Нативная генерация таблицы OOXML', action: () => this.handleExportExcel() },
      { title: '📋 Экспорт резервной копии', desc: 'Полный бэкап рабочего пространства в JSON', action: () => this.handleExportWorkspace() }
    ];

    commands.forEach(cmd => {
      if (!q || cmd.title.toLowerCase().includes(q) || cmd.desc.toLowerCase().includes(q)) {
        items.push({
          type: 'Команда',
          title: cmd.title,
          desc: cmd.desc,
          run: cmd.action
        });
      }
    });

    // Task Items
    this.tasks.forEach(t => {
      if (!q || t.name.toLowerCase().includes(q) || (t.owner && t.owner.toLowerCase().includes(q))) {
        items.push({
          type: 'Задача',
          title: t.name,
          desc: `№${t.external_number || '?'} · ${DateUtils.formatDuration(t.duration_days)} · ${t.owner || 'Без исполнителя'}`,
          run: () => {
            this.selectedTaskId = t.id;
            this.recalculateSchedule();
            setTimeout(() => {
              const row = document.querySelector(`.task-row[data-task-id="${t.id}"]`);
              if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 60);
          }
        });
      }
    });

    if (items.length === 0) {
      results.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">Ничего не найдено по запросу «${q}»</div>`;
      return;
    }

    results.innerHTML = items.slice(0, 15).map((it, i) => `
      <div class="cmd-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
        <div>
          <div style="font-weight: 500;">${it.title}</div>
          <div style="font-size: 0.76rem; color: var(--text-muted);">${it.desc}</div>
        </div>
        <span class="cmd-tag">${it.type}</span>
      </div>
    `).join('');

    results.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        this.closeModal('modal-cmd-palette');
        if (items[idx]) items[idx].run();
      });
    });
  }
}

export const app = new AppController();
window.app = app;
window.addEventListener('DOMContentLoaded', () => app.init());
