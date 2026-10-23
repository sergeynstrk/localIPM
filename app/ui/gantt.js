/**
 * LocalPM - Canvas 2D Interactive Gantt Chart Engine
 * Высокопроизводительная отрисовка на Canvas 2D с виртуализацией строк,
 * шкалой (день/неделя/месяц/квартал), связями, вехами, критическим путем и линией "сегодня"
 */

import { DateUtils } from '../core/dates.js';

export class GanttChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = {
      rowHeight: 40,
      headerHeight: 48,
      scale: 'day', // 'day' | 'week' | 'month' | 'quarter'
      dayWidth: 32, // pixels per day in 'day' scale
      showDependencies: true,
      showCriticalPath: true,
      showTodayLine: true,
      showProgress: true,
      ...options
    };

    this.tasks = [];
    this.dependencies = [];
    this.calendar = null;
    this.minDate = null;
    this.maxDate = null;

    this.scrollX = 0;
    this.scrollY = 0;

    this.selectedTaskId = null;
    this.hoveredTaskId = null;

    this.initEvents();
  }

  setData({ tasks = [], dependencies = [], calendar = null, startDate = null }) {
    this.tasks = tasks;
    this.dependencies = dependencies;
    this.calendar = calendar;

    // Determine min and max dates
    let minD = startDate || DateUtils.formatISO(new Date());
    let maxD = minD;

    tasks.forEach(t => {
      if (t.start_date && t.start_date < minD) minD = t.start_date;
      if (t.finish_date && t.finish_date > maxD) maxD = t.finish_date;
    });

    // Add padding around min & max dates (7 days before, 30 days after)
    this.minDate = DateUtils.addCalendarDays(minD, -7);
    this.maxDate = DateUtils.addCalendarDays(maxD, 45);

    this.totalDays = DateUtils.diffWorkingDays(this.minDate, this.maxDate, { working_days: [0,1,2,3,4,5,6] }) || 60;
    this.render();
  }

  setScale(scale) {
    this.options.scale = scale;
    if (scale === 'day') this.options.dayWidth = 32;
    else if (scale === 'week') this.options.dayWidth = 12;
    else if (scale === 'month') this.options.dayWidth = 4;
    else if (scale === 'quarter') this.options.dayWidth = 1.8;
    this.render();
  }

  // Convert date to X coordinate
  dateToX(dateISO) {
    if (!dateISO || !this.minDate) return 0;
    const [y1, m1, d1] = this.minDate.split('-').map(Number);
    const [y2, m2, d2] = dateISO.split('-').map(Number);
    const dt1 = new Date(y1, m1 - 1, d1);
    const dt2 = new Date(y2, m2 - 1, d2);
    const diffDays = Math.round((dt2 - dt1) / (1000 * 60 * 60 * 24));
    return diffDays * this.options.dayWidth;
  }

  // Convert X coordinate to date
  xToDate(x) {
    const days = Math.floor(x / this.options.dayWidth);
    return DateUtils.addCalendarDays(this.minDate, days);
  }

  render() {
    if (!this.canvas || !this.ctx) return;
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, width, height);

    ctx.save();
    // 1. Draw timeline header background
    this.renderTimelineHeader();

    // 2. Draw vertical grid & non-working days
    this.renderGrid();

    // 3. Draw today line
    if (this.options.showTodayLine) {
      this.renderTodayLine();
    }

    // 4. Draw dependencies lines
    if (this.options.showDependencies) {
      this.renderDependencies();
    }

    // 5. Draw task bars & milestones
    this.renderTasks();

    ctx.restore();
  }

  renderTimelineHeader() {
    const ctx = this.ctx;
    const h = this.options.headerHeight;
    const w = this.canvas.width;

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1f2937';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Top & bottom scales
    const startX = this.scrollX;
    const endX = startX + w;
    const startDay = Math.max(0, Math.floor(startX / this.options.dayWidth));
    const endDay = Math.ceil(endX / this.options.dayWidth);

    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#9ca3af';

    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

    let currentMonth = -1;
    let monthStartX = 0;

    for (let i = startDay; i <= endDay; i++) {
      const curDate = DateUtils.addCalendarDays(this.minDate, i);
      const [y, m, d] = curDate.split('-').map(Number);
      const x = i * this.options.dayWidth - this.scrollX;

      // Month block
      if (m !== currentMonth) {
        if (currentMonth !== -1) {
          ctx.fillStyle = '#f9fafb';
          ctx.fillText(`${monthNames[currentMonth - 1]} ${y}`, monthStartX + 10, h / 2 - 8);
        }
        currentMonth = m;
        monthStartX = x;
        ctx.strokeStyle = '#374151';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h / 2);
        ctx.stroke();
      }

      // Day / Week tick
      if (this.options.scale === 'day') {
        const dt = new Date(y, m - 1, d);
        const dayOfWeek = dt.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        ctx.fillStyle = isWeekend ? '#ef4444' : '#cbd5e1';
        ctx.fillText(String(d), x + 10, h - 8);

        ctx.strokeStyle = '#1f2937';
        ctx.beginPath();
        ctx.moveTo(x, h / 2);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
  }

  renderGrid() {
    const ctx = this.ctx;
    const h = this.canvas.height;
    const w = this.canvas.width;
    const startX = this.scrollX;
    const endX = startX + w;
    const startDay = Math.max(0, Math.floor(startX / this.options.dayWidth));
    const endDay = Math.ceil(endX / this.options.dayWidth);

    for (let i = startDay; i <= endDay; i++) {
      const curDate = DateUtils.addCalendarDays(this.minDate, i);
      const isWork = DateUtils.isWorkingDay(curDate, this.calendar);
      const x = i * this.options.dayWidth - this.scrollX;

      if (!isWork && this.options.scale === 'day') {
        ctx.fillStyle = 'rgba(31, 41, 55, 0.45)';
        ctx.fillRect(x, this.options.headerHeight, this.options.dayWidth, h - this.options.headerHeight);
      }

      ctx.strokeStyle = 'rgba(31, 41, 55, 0.5)';
      ctx.beginPath();
      ctx.moveTo(x, this.options.headerHeight);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  renderTodayLine() {
    const todayISO = DateUtils.formatISO(new Date());
    const x = this.dateToX(todayISO) - this.scrollX;
    if (x >= 0 && x <= this.canvas.width) {
      const ctx = this.ctx;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, this.options.headerHeight);
      ctx.lineTo(x, this.canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;

      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.arc(x, this.options.headerHeight + 4, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  renderTasks() {
    const ctx = this.ctx;
    const rHeight = this.options.rowHeight;
    const headerH = this.options.headerHeight;

    this.tasks.forEach((t, idx) => {
      const y = headerH + idx * rHeight - this.scrollY;
      if (y + rHeight < headerH || y > this.canvas.height) return; // virtualize rows outside viewport

      const isSelected = this.selectedTaskId === t.id;
      if (isSelected) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fillRect(0, y, this.canvas.width, rHeight);
      }

      const startX = this.dateToX(t.start_date) - this.scrollX;
      const finishX = this.dateToX(t.finish_date) + (this.options.scale === 'day' ? this.options.dayWidth : 0) - this.scrollX;
      const barW = Math.max(4, finishX - startX);
      const barH = 20;
      const barY = y + (rHeight - barH) / 2;

      const isCritical = this.options.showCriticalPath && t.is_critical;

      if (t.is_milestone) {
        // Milestone diamond (FR-8.02)
        const mx = startX;
        const my = y + rHeight / 2;
        const size = 9;

        ctx.fillStyle = isCritical ? '#ef4444' : '#eab308';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mx, my - size);
        ctx.lineTo(mx + size, my);
        ctx.lineTo(mx, my + size);
        ctx.lineTo(mx - size, my);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Draw milestone label with background pill
        const labelText = `${t.name} (${DateUtils.formatRU(t.start_date)})`;
        ctx.font = '11px system-ui, -apple-system, sans-serif';
        const tw = ctx.measureText(labelText).width;
        const tx = mx + size + 8;
        const ty = my - 8;

        ctx.fillStyle = 'rgba(11, 15, 25, 0.75)';
        ctx.fillRect(tx - 3, ty, tw + 6, 16);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(labelText, tx, ty + 12);
      } else if (t.is_summary) {
        // Summary bracket bar (FR-9.03)
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(startX, barY + 3, barW, 5);

        // Brackets left and right
        ctx.beginPath();
        ctx.moveTo(startX, barY + 3);
        ctx.lineTo(startX, barY + 15);
        ctx.lineTo(startX + 8, barY + 7);
        ctx.moveTo(finishX, barY + 3);
        ctx.lineTo(finishX, barY + 15);
        ctx.lineTo(finishX - 8, barY + 7);
        ctx.fill();

        // Label with dark background pill
        const labelText = `${t.name}`;
        ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
        const tw = ctx.measureText(labelText).width;
        const tx = finishX + 10;
        const ty = barY + 1;

        ctx.fillStyle = 'rgba(11, 15, 25, 0.75)';
        ctx.fillRect(tx - 3, ty, tw + 6, 16);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(labelText, tx, ty + 12);
      } else {
        // Standard task bar (Modern gradient & subtle border)
        const radius = 5;
        if (isCritical) {
          const grad = ctx.createLinearGradient(startX, barY, startX, barY + barH);
          grad.addColorStop(0, '#f43f5e');
          grad.addColorStop(1, '#e11d48');
          ctx.fillStyle = grad;
        } else {
          const grad = ctx.createLinearGradient(startX, barY, startX, barY + barH);
          grad.addColorStop(0, '#6366f1');
          grad.addColorStop(1, '#4f46e5');
          ctx.fillStyle = grad;
        }
        this.roundRect(ctx, startX, barY, barW, barH, radius);
        ctx.fill();

        // Progress bar (FR-4.9.07)
        if (this.options.showProgress && t.percent_complete > 0) {
          const progW = barW * (t.percent_complete / 100);
          ctx.fillStyle = isCritical ? '#9f1239' : '#3730a3';
          this.roundRect(ctx, startX, barY, progW, barH, radius);
          ctx.fill();
        }

        // Percentage inside bar if wide enough
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        if (barW > 36) {
          ctx.fillText(`${t.percent_complete || 0}%`, startX + 6, barY + 14);
        }

        // Label outside bar with dark background pill
        const labelText = `${t.name} (${t.duration_days}д)`;
        ctx.font = '500 11px "Inter", -apple-system, sans-serif';
        const tw = ctx.measureText(labelText).width;
        const tx = finishX + 10;
        const ty = barY + 2;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        this.roundRect(ctx, tx - 4, ty, tw + 8, 17, 3);
        ctx.fill();
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(labelText, tx, ty + 12);

        // Connection Ports for Drag-to-Link
        if (!t.is_summary) {
          // Outport on the right
          ctx.fillStyle = '#6366f1';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(finishX, barY + barH / 2, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // Inport on the left
          ctx.fillStyle = '#10b981';
          ctx.beginPath();
          ctx.arc(startX, barY + barH / 2, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    });

    // Render Drag-to-Link live connecting line
    if (this.dragLink && this.dragLink.active) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.dragLink.fromX, this.dragLink.fromY);
      ctx.lineTo(this.dragLink.curX, this.dragLink.curY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;

      // Draw pulsing target circle
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(this.dragLink.curX, this.dragLink.curY, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  renderDependencies() {
    const ctx = this.ctx;
    const rHeight = this.options.rowHeight;
    const headerH = this.options.headerHeight;
    const taskMap = new Map();
    this.tasks.forEach((t, idx) => taskMap.set(t.id, { ...t, index: idx }));

    this.dependencies.forEach(d => {
      const pred = taskMap.get(d.pred_id);
      const succ = taskMap.get(d.succ_id);
      if (!pred || !succ) return;

      const predY = headerH + pred.index * rHeight + rHeight / 2 - this.scrollY;
      const succY = headerH + succ.index * rHeight + rHeight / 2 - this.scrollY;

      const predEndX = this.dateToX(pred.finish_date) + (this.options.scale === 'day' ? this.options.dayWidth : 0) - this.scrollX;
      const succStartX = this.dateToX(succ.start_date) - this.scrollX;

      const isCritical = this.options.showCriticalPath && pred.is_critical && succ.is_critical;
      ctx.strokeStyle = isCritical ? '#ef4444' : '#64748b';
      ctx.fillStyle = isCritical ? '#ef4444' : '#64748b';
      ctx.lineWidth = isCritical ? 2 : 1.5;

      // Orthogonal arrow routing
      ctx.beginPath();
      ctx.moveTo(predEndX, predY);
      const midX = predEndX + 12;
      ctx.lineTo(midX, predY);
      ctx.lineTo(midX, succY);
      ctx.lineTo(succStartX, succY);
      ctx.stroke();

      // Arrow head
      ctx.beginPath();
      ctx.moveTo(succStartX, succY);
      ctx.lineTo(succStartX - 6, succY - 4);
      ctx.lineTo(succStartX - 6, succY + 4);
      ctx.closePath();
      ctx.fill();
    });
  }

  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  initEvents() {
    let isPanning = false;
    let isResizing = false;
    let resizingTask = null;
    let initialDuration = 0;
    let resizeStartX = 0;
    let startX = 0;
    let startY = 0;

    // Helper to find task bar at coordinates and check if near right edge (handle) or port
    const getTaskAtPos = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      const rHeight = this.options.rowHeight;
      const headerH = this.options.headerHeight;

      if (mouseY < headerH) return null;

      const rowIndex = Math.floor((mouseY - headerH + this.scrollY) / rHeight);
      if (rowIndex < 0 || rowIndex >= this.tasks.length) return null;

      const task = this.tasks[rowIndex];
      if (task.is_milestone || task.is_summary) return { task, isHandle: false, isOutPort: false, isInPort: false, mouseX, mouseY };

      const barStartX = this.dateToX(task.start_date) - this.scrollX;
      const finishX = this.dateToX(task.finish_date) + (this.options.scale === 'day' ? this.options.dayWidth : 0) - this.scrollX;
      const barH = 20;
      const rowY = headerH + rowIndex * rHeight - this.scrollY;
      const barY = rowY + (rHeight - barH) / 2;

      // Ports are at (finishX, barY + barH / 2) and (barStartX, barY + barH / 2)
      const distToOutPort = Math.hypot(mouseX - finishX, mouseY - (barY + barH / 2));
      const distToInPort = Math.hypot(mouseX - barStartX, mouseY - (barY + barH / 2));

      const isOutPort = distToOutPort <= 8;
      const isInPort = distToInPort <= 8;
      const isNearRightEdge = Math.abs(mouseX - finishX) <= 10 && !isOutPort;
      const isInsideBar = mouseX >= barStartX && mouseX <= finishX;

      return {
        task,
        rowIndex,
        isHandle: isNearRightEdge,
        isOutPort,
        isInPort,
        portX: isOutPort ? finishX : barStartX,
        portY: barY + barH / 2,
        isInside: isInsideBar,
        mouseX,
        mouseY
      };
    };

    this.dragLink = null;

    this.canvas.addEventListener('mousemove', (e) => {
      if (isResizing) return;
      if (isPanning) return;
      if (this.dragLink && this.dragLink.active) {
        const rect = this.canvas.getBoundingClientRect();
        this.dragLink.curX = e.clientX - rect.left;
        this.dragLink.curY = e.clientY - rect.top;
        this.render();
        return;
      }

      const hit = getTaskAtPos(e.clientX, e.clientY);
      if (hit && (hit.isOutPort || hit.isInPort)) {
        this.canvas.style.cursor = 'crosshair';
      } else if (hit && hit.isHandle) {
        this.canvas.style.cursor = 'ew-resize';
      } else if (hit && hit.isInside) {
        this.canvas.style.cursor = 'pointer';
      } else {
        this.canvas.style.cursor = 'default';
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      const hit = getTaskAtPos(e.clientX, e.clientY);

      // Start Drag-to-Link from right port
      if (hit && hit.isOutPort) {
        this.dragLink = {
          active: true,
          fromTaskId: hit.task.id,
          fromX: hit.portX,
          fromY: hit.portY,
          curX: hit.portX,
          curY: hit.portY
        };
        e.preventDefault();
        return;
      }

      if (hit && hit.isHandle && !hit.task.is_summary && !hit.task.is_milestone) {
        // Start duration resize
        isResizing = true;
        resizingTask = hit.task;
        initialDuration = hit.task.duration_days || 1;
        resizeStartX = e.clientX;
        this.canvas.style.cursor = 'ew-resize';
        e.preventDefault();
        return;
      }

      if (hit && hit.isInside) {
        this.selectedTaskId = hit.task.id;
        if (this.onTaskSelect) this.onTaskSelect(hit.task.id);
        this.render();
      }

      // Default: panning
      isPanning = true;
      startX = e.clientX;
      startY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (isResizing && resizingTask) {
        const dx = e.clientX - resizeStartX;
        const daysDiff = Math.round(dx / this.options.dayWidth);
        const newDuration = Math.max(1, initialDuration + daysDiff);

        if (resizingTask.duration_days !== newDuration) {
          resizingTask.duration_days = newDuration;
          if (this.onTaskDurationChange) {
            this.onTaskDurationChange(resizingTask.id, newDuration);
          }
          this.render();
        }
        return;
      }

      if (!isPanning) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;

      this.scrollX = Math.max(0, this.scrollX - dx);
      this.scrollY = Math.max(0, this.scrollY - dy);
      if (this.onScrollY) this.onScrollY(this.scrollY);
      this.render();
    });

    window.addEventListener('mouseup', (e) => {
      if (this.dragLink && this.dragLink.active) {
        const hit = getTaskAtPos(e.clientX, e.clientY);
        if (hit && hit.task && hit.task.id !== this.dragLink.fromTaskId) {
          if (this.onLinkCreated) {
            this.onLinkCreated(this.dragLink.fromTaskId, hit.task.id, 'FS', 0);
          }
        }
        this.dragLink = null;
        this.canvas.style.cursor = 'default';
        this.render();
      }

      if (isResizing) {
        isResizing = false;
        resizingTask = null;
        this.canvas.style.cursor = 'default';
        if (this.onTaskDurationCommit) {
          this.onTaskDurationCommit();
        }
      }
      isPanning = false;
    });

    // Zoom with Ctrl + Wheel
    this.canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          this.options.dayWidth = Math.min(80, this.options.dayWidth * 1.15);
        } else {
          this.options.dayWidth = Math.max(2, this.options.dayWidth * 0.85);
        }
        this.render();
      } else {
        this.scrollY = Math.max(0, this.scrollY + e.deltaY);
        this.scrollX = Math.max(0, this.scrollX + e.deltaX);
        if (this.onScrollY) this.onScrollY(this.scrollY);
        this.render();
      }
    }, { passive: false });
  }

  // Export Gantt chart to PNG data URL (FR-9.12)
  exportToPNG() {
    return this.canvas.toDataURL('image/png');
  }
}
