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
    document.getElementById('btn-move-up').addEventListener('click', () => this.handleMoveTask(-1));
    document.getElementById('btn-move-down').addEventListener('click', () => this.handleMoveTask(1));
    const btnTaskCard = document.getElementById('btn-task-card');
    if (btnTaskCard) btnTaskCard.addEventListener('click', () => this.handleOpenTaskCard());
    const btnSaveCard = document.getElementById('btn-save-task-card');
    if (btnSaveCard) btnSaveCard.addEventListener('click', () => this.handleSaveTaskCard());
    document.getElementById('btn-delete-task').addEventListener('click', () => this.handleDeleteTask());

    // Task Search & Filter (FR-6.10)
    const searchInput = document.getElementById('task-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => this.handleSearchTasks(e.target.value));
    }

    // Scale
    document.getElementById('select-scale').addEventListener('change', (e) => {
      this.gantt.setScale(e.target.value);
    });

    // Excel Import / Export
    document.getElementById('btn-import-excel').addEventListener('click', () => {
      this.openModal('modal-import');
    });

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

    // Keyboard Shortcuts (FR-6.08: Insert, Delete, Alt+Up, Alt+Down)
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      if (e.key === 'Insert') {
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
    document.getElementById('btn-transfer-peer').addEventListener('click', () => {
      this.openModal('modal-transfer');
    });
    document.getElementById('btn-do-transfer').addEventListener('click', () => this.handleExportPeerPackage('transfer'));

    document.getElementById('btn-return-peer').addEventListener('click', () => {
      this.handleExportPeerPackage('return');
    });

    document.getElementById('btn-import-peer-package').addEventListener('click', () => {
      document.getElementById('input-peer-package').click();
    });
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
      name: 'Внедрение корпоративной системы (Пример)',
      description: 'Демонстрационный план проекта по ТЗ LocalPM',
      start_date: DateUtils.formatISO(new Date()),
      calendar: { type: 'rf', working_days: [1,2,3,4,5] },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      revision: 1
    };

    const demoTasks = [
      { id: 't1', external_number: '1', name: 'Инициация и согласование ТЗ', duration_days: 5, percent_complete: 100, level: 0 },
      { id: 't2', external_number: '2', name: 'Анализ требований заказчика', duration_days: 3, percent_complete: 100, parent_id: 't1' },
      { id: 't3', external_number: '3', name: 'Утверждение ТЗ заказчиком', duration_days: 0, is_milestone: true, parent_id: 't1' },
      { id: 't4', external_number: '4', name: 'Разработка архитектуры и ядра', duration_days: 8, percent_complete: 70, level: 0 },
      { id: 't5', external_number: '5', name: 'Диаграмма Ганта на Canvas 2D', duration_days: 5, percent_complete: 50, parent_id: 't4' },
      { id: 't6', external_number: '6', name: 'Модули импорта и экспорта Excel', duration_days: 4, percent_complete: 30, parent_id: 't4' },
      { id: 't7', external_number: '7', name: 'Приёмочные испытания и сдача', duration_days: 0, is_milestone: true, level: 0 }
    ];

    const demoDeps = [
      { id: 'd1', pred_id: 't2', succ_id: 't3', type: 'FS', lag_workdays: 0 },
      { id: 'd2', pred_id: 't3', succ_id: 't4', type: 'FS', lag_workdays: 0 },
      { id: 'd3', pred_id: 't5', succ_id: 't7', type: 'FS', lag_workdays: 0 },
      { id: 'd4', pred_id: 't6', succ_id: 't7', type: 'FS', lag_workdays: 0 }
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

    // Update metrics
    document.getElementById('metric-tasks-count').innerText = this.tasks.length;
    document.getElementById('metric-critical-count').innerText = cpmResult.criticalPathCount || 0;
    document.getElementById('metric-finish-date').innerText = DateUtils.formatRU(cpmResult.projectFinishDate);

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

    // Save to DB and update project task count
    this.currentProject.task_count = this.tasks.length;
    db.saveProject(this.currentProject);
    db.saveProjectPlan(this.currentProject.id, this.tasks, this.dependencies);

    // Update active project count in sidebar badge without full reload
    const activeBadge = document.querySelector('.project-item.active .project-item-count');
    if (activeBadge) {
      activeBadge.innerText = this.tasks.length;
    }
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

    this.tasks.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = `task-row ${t.is_summary ? 'summary' : ''} ${t.is_critical ? 'critical' : ''} ${this.selectedTaskId === t.id ? 'selected' : ''}`;
      
      const indentPx = (t.level || 0) * 16;
      const predsStr = ValidationUtils.formatPredecessors(depsBySucc.get(t.id) || [], taskMap);

      row.innerHTML = `
        <div class="col-num" title="Потяните для изменения порядка задач" draggable="true">${t.external_number || (idx + 1)}</div>
        <div class="col-name" style="padding-left: ${indentPx + 8}px;">
          ${t.is_milestone ? '◆ ' : ''}
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
    
    // Filter out deleted task and any of its children
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

    this.closeModal('modal-import');
    this.recalculateSchedule();
    alert(`Успешно импортировано ${newTasks.length} задач!`);
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

    this.closeModal('modal-transfer');
    alert(kind === 'transfer' ? 'Пакет передачи сформирован и скачан!' : 'Пакет возврата сформирован!');
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
