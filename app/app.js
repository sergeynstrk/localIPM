/**
 * LocalPM - Main Application Controller
 * Связывает UI, IndexedDB, расчет расписания CPM, экспорт/импорт Excel и передачу проектов
 */

import { db } from './storage/db.js';
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
    this.gantt = null;
    this.pendingReturnPackage = null;
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

    // 5. Load Projects
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
    
    const icon = type === 'success' ? '✓' : (type === 'error' ? '✕' : (type === 'warning' ? '⚠️' : 'ℹ️'));
    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-weight: 700;">${icon}</span>
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
    document.getElementById('btn-new-project').addEventListener('click', () => {
      document.getElementById('project-form-start').value = DateUtils.formatISO(new Date());
      this.openModal('modal-project');
    });

    document.getElementById('btn-save-project').addEventListener('click', () => this.handleSaveProject());

    // Task manipulations
    document.getElementById('btn-add-task').addEventListener('click', () => this.handleAddTask(false));
    document.getElementById('btn-add-milestone').addEventListener('click', () => this.handleAddTask(true));
    document.getElementById('btn-indent').addEventListener('click', () => this.handleIndent());
    document.getElementById('btn-outdent').addEventListener('click', () => this.handleOutdent());
    const btnEditTask = document.getElementById('btn-edit-task');
    if (btnEditTask) btnEditTask.addEventListener('click', () => this.handleOpenTaskCard());
    document.getElementById('btn-move-up').addEventListener('click', () => this.handleMoveTask(-1));
    document.getElementById('btn-move-down').addEventListener('click', () => this.handleMoveTask(1));
    const btnSaveCard = document.getElementById('btn-save-task-card');
    if (btnSaveCard) btnSaveCard.addEventListener('click', () => this.handleSaveTaskCard());
    document.getElementById('btn-delete-task').addEventListener('click', () => this.handleDeleteTask());

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

    // Keyboard Shortcuts (FR-6.08: Insert, Delete, Alt+Up, Alt+Down, ?)
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
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
      }
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
    document.getElementById('input-peer-package').addEventListener('change', (e) => this.handleImportPeerPackage(e));

    // Return Diff actions
    document.getElementById('btn-accept-diff').addEventListener('click', () => this.handleAcceptDiff());
    document.getElementById('btn-reject-diff').addEventListener('click', () => {
      this.pendingReturnPackage = null;
      this.closeModal('modal-diff');
      alert('Изменения отклонены');
    });

    // Workspace Backup
    document.getElementById('btn-export-workspace').addEventListener('click', () => this.handleExportWorkspace());
    document.getElementById('btn-import-workspace').addEventListener('click', () => {
      document.getElementById('input-import-workspace').click();
    });
    document.getElementById('input-import-workspace').addEventListener('change', (e) => this.handleImportWorkspace(e));

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

      resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = tablePanel.getBoundingClientRect().width;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const newWidth = Math.max(280, Math.min(window.innerWidth * 0.75, startWidth + dx));
        tablePanel.style.width = `${newWidth}px`;
        this.resizeCanvas(canvas);
        this.gantt.render();
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          resizer.classList.remove('dragging');
          document.body.style.cursor = '';
          this.resizeCanvas(canvas);
          this.gantt.render();
        }
      });
    }
  }

  openModal(id) {
    document.getElementById(id).classList.add('open');
  }

  closeModal(id) {
    document.getElementById(id).classList.remove('open');
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
      db.saveProject(this.currentProject);
      db.saveProjectPlan(this.currentProject.id, this.tasks, this.dependencies);

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
        listEl.innerHTML = '<div style="color: #10b981; font-size: 0.85rem; padding: 12px; background: rgba(16, 185, 129, 0.08); border-radius: 6px;">Замечаний не найдено. План полностью соответствует стандартам управления проектами!</div>';
      } else {
        issues.forEach(iss => {
          const item = document.createElement('div');
          item.className = `issue-item ${iss.severity || 'info'}`;
          const icon = iss.severity === 'error' ? '❌' : (iss.severity === 'warning' ? '⚠️' : 'ℹ️');
          item.innerHTML = `<span>${icon}</span><span style="flex: 1;">${iss.message}</span>`;
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
      row.innerHTML = `
        <div class="resource-name" title="${owner}">${owner}</div>
        <div class="resource-bar-track">
          <div class="resource-bar-fill" style="width: ${pct}%; background: ${isOverallocated ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : 'linear-gradient(90deg, #6366f1, #3b82f6)'};"></div>
        </div>
        <div style="font-family: var(--font-mono); font-size: 0.74rem; width: 110px; text-align: right; color: ${isOverallocated ? '#fca5a5' : '#cbd5e1'};">
          ${data.totalDays} дн. (${data.taskCount} зад.) ${isOverallocated ? '⚠️ Перегруз' : '✓ Ок'}
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
      row.className = `task-row ${t.is_summary ? 'summary' : ''} ${t.is_critical ? 'critical' : ''} ${isChild ? 'is-child-task' : ''} ${this.selectedTaskId === t.id ? 'selected' : ''}`;
      
      // Micro-shift: 20px per level + 6px base shift for tree children
      const indentPx = (t.level || 0) * 20 + (isChild ? 6 : 0);
      const predsStr = ValidationUtils.formatPredecessors(depsBySucc.get(t.id) || [], taskMap);

      const treeBranchIcon = isChild ? `<span class="tree-branch-icon" title="Подзадача (WBS)">↳</span>` : '';

      row.innerHTML = `
        <div class="col-num" title="Потяните для изменения порядка задач" draggable="true">${t.external_number || (idx + 1)}</div>
        <div class="col-name" style="padding-left: ${indentPx + 8}px; display: flex; align-items: center;">
          ${treeBranchIcon}
          ${t.is_milestone ? '<span class="milestone-badge" title="Контрольная точка (веха)"></span>' : ''}
          <input type="text" value="${t.name}" data-field="name" data-id="${t.id}">
        </div>
        <div class="col-dur">
          <input type="text" style="text-align: center;" value="${DateUtils.formatDuration(t.duration_days)}" data-field="duration" data-id="${t.id}" ${t.is_summary ? 'disabled' : ''}>
        </div>
        <div class="col-start">${DateUtils.formatRU(t.start_date)}</div>
        <div class="col-finish">${DateUtils.formatRU(t.finish_date)}</div>
        <div class="col-preds">
          <input type="text" style="text-align: center;" value="${predsStr}" data-field="preds" data-id="${t.id}">
        </div>
      `;

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
        if (this.selectedTaskId !== t.id) {
          this.selectedTaskId = t.id;
          this.gantt.selectedTaskId = t.id;
          document.querySelectorAll('.task-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          this.gantt.render();
        }
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
          if (this.selectedTaskId !== t.id) {
            this.selectedTaskId = t.id;
            this.gantt.selectedTaskId = t.id;
            document.querySelectorAll('.task-row').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            this.gantt.render();
          }
        });
      });

      // Inline edits
      const nameInput = row.querySelector('input[data-field="name"]');
      nameInput.addEventListener('change', (e) => {
        t.name = e.target.value.trim() || 'Без названия';
        this.recalculateSchedule();
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameInput.blur();
      });

      const durInput = row.querySelector('input[data-field="duration"]');
      if (durInput) {
        durInput.addEventListener('change', (e) => {
          const parsed = DateUtils.parseDuration(e.target.value);
          t.duration_days = Math.max(0, isNaN(parsed) ? 1 : parsed);
          t.is_milestone = t.duration_days === 0;
          this.recalculateSchedule();
        });
        durInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') durInput.blur();
        });
      }

      const predsInput = row.querySelector('input[data-field="preds"]');
      predsInput.addEventListener('change', (e) => {
        this.updateTaskPredecessors(t.id, e.target.value);
      });
      predsInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') predsInput.blur();
      });

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
      const commitGhostTask = () => {
        const val = ghostInput.value.trim();
        if (val) {
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
          this.recalculateSchedule();
          setTimeout(() => {
            const nextGhost = document.querySelector('input[data-role="ghost-task-input"]');
            if (nextGhost) nextGhost.focus();
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

  handleIndent() {
    if (!this.selectedTaskId) return;
    this.tasks = WbsUtils.indent(this.tasks, this.selectedTaskId);
    this.recalculateSchedule();
  }

  handleOutdent() {
    if (!this.selectedTaskId) return;
    this.tasks = WbsUtils.outdent(this.tasks, this.selectedTaskId);
    this.recalculateSchedule();
  }

  handleDeleteTask() {
    // Force blur any active input
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
    }

    if (!this.selectedTaskId) {
      // If none selected, default to the last task
      if (this.tasks.length > 0) {
        this.selectedTaskId = this.tasks[this.tasks.length - 1].id;
      } else {
        return;
      }
    }

    const id = this.selectedTaskId;
    const taskIndex = this.tasks.findIndex(t => t.id === id);
    
    // Filter out deleted task and any of its children (with Undo backup)
    const backupTasks = [...this.tasks];
    const backupDeps = [...this.dependencies];
    const deletedTask = this.tasks.find(t => t.id === id);

    this.tasks = this.tasks.filter(t => t.id !== id && t.parent_id !== id);
    this.dependencies = this.dependencies.filter(d => d.pred_id !== id && d.succ_id !== id);

    // Re-index sort order
    this.tasks.forEach((t, i) => {
      t.sort_order = i;
    });

    // Pick adjacent task as selected
    if (this.tasks.length > 0) {
      const nextIndex = Math.min(taskIndex, this.tasks.length - 1);
      this.selectedTaskId = this.tasks[nextIndex >= 0 ? nextIndex : 0].id;
    } else {
      this.selectedTaskId = null;
    }

    this.recalculateSchedule();

    this.showToast(`Удалена задача «${deletedTask?.name || 'Задача'}»`, 'warning', 'Отменить', () => {
      this.tasks = backupTasks;
      this.dependencies = backupDeps;
      this.selectedTaskId = id;
      this.recalculateSchedule();
      this.showToast('Удаление отменено', 'info');
    });
  }

  handleMoveTask(direction) {
    if (!this.selectedTaskId) return;
    const index = this.tasks.findIndex(t => t.id === this.selectedTaskId);
    if (index < 0) return;

    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= this.tasks.length) return;

    // Swap tasks
    const [moved] = this.tasks.splice(index, 1);
    this.tasks.splice(targetIndex, 0, moved);

    // Re-index sort order
    this.tasks.forEach((t, i) => {
      t.sort_order = i;
    });

    this.recalculateSchedule();

    setTimeout(() => {
      const row = document.querySelector(`.task-row.selected`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 40);
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
}

export const app = new AppController();
window.app = app;
window.addEventListener('DOMContentLoaded', () => app.init());
