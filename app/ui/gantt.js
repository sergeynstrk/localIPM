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
    this.activeResizeGuide = null; // { x, date, taskName, days }

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

    this.rawMinDate = minD;
    this.rawMaxDate = maxD;
    this.updateDateRange();
    this.render();
  }

  updateDateRange() {
    if (!this.rawMinDate || !this.rawMaxDate) return;
    const scale = this.options.scale || 'day';

    if (scale === 'week') {
      // Актуальная неделя: -3 дня от начала, +3 от конца
      this.minDate = DateUtils.addCalendarDays(this.rawMinDate, -3);
      this.maxDate = DateUtils.addCalendarDays(this.rawMaxDate, 3);
    } else if (scale === 'month') {
      // Настоящий месяц: -5 дней от начала, +5 от конца
      this.minDate = DateUtils.addCalendarDays(this.rawMinDate, -5);
      this.maxDate = DateUtils.addCalendarDays(this.rawMaxDate, 5);
    } else if (scale === 'year') {
      // Годовой масштаб: охват года с полями
      this.minDate = DateUtils.addCalendarDays(this.rawMinDate, -15);
      this.maxDate = DateUtils.addCalendarDays(this.rawMaxDate, 45);
    } else {
      // День (по умолчанию)
      this.minDate = DateUtils.addCalendarDays(this.rawMinDate, -7);
      this.maxDate = DateUtils.addCalendarDays(this.rawMaxDate, 30);
    }

    this.totalDays = DateUtils.diffWorkingDays(this.minDate, this.maxDate, { working_days: [0,1,2,3,4,5,6] }) || 60;
  }

  setScale(scale) {
    this.options.scale = scale;
    if (scale === 'day') this.options.dayWidth = 32;
    else if (scale === 'week') this.options.dayWidth = 24;
    else if (scale === 'month') this.options.dayWidth = 14;
    else if (scale === 'year') this.options.dayWidth = 3.5;
    else this.options.dayWidth = 24;

    this.updateDateRange();
    this.scrollX = 0; // Сброс смещения к началу видимого диапазона
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

  getThemeColors() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      return {
        isLight: true,
        headerBg: '#f8fafc',
        headerBorder: '#e2e8f0',
        headerText: '#1e293b',
        headerTextSub: '#64748b',
        majorBorder: '#e2e8f0',
        weekendBg: 'rgba(241, 245, 249, 0.75)', // Soft, low-contrast weekend background
        gridLine: 'rgba(226, 232, 240, 0.7)',  // Soft subtle grid line
        gridLineMajor: 'rgba(203, 213, 225, 0.9)',
        rowSelected: 'rgba(99, 102, 241, 0.12)',
        guideBg: '#ffffff',
        guideText: '#0f172a'
      };
    }
    return {
      isLight: false,
      headerBg: '#111827',
      headerBorder: '#1f2937',
      headerText: '#f9fafb',
      headerTextSub: '#9ca3af',
      majorBorder: '#374151',
      weekendBg: 'rgba(31, 41, 55, 0.45)',
      gridLine: 'rgba(31, 41, 55, 0.45)',
      gridLineMajor: 'rgba(75, 85, 99, 0.6)',
      rowSelected: 'rgba(59, 130, 246, 0.15)',
      guideBg: '#0f172a',
      guideText: '#fef08a'
    };
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

    // 6. Draw duration resize guideline & date bubble indicator
    if (this.activeResizeGuide) {
      this.renderResizeGuide();
    }

    ctx.restore();
  }

  renderResizeGuide() {
    const guide = this.activeResizeGuide;
    if (!guide) return;

    const ctx = this.ctx;
    const x = guide.x;
    const h = this.canvas.height;
    const headerH = this.options.headerHeight;

    // 1. Vertical dotted guideline line
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, headerH);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    // 2. Glowing target dot at the bottom
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(x, headerH + 6, 5, 0, Math.PI * 2);
    ctx.fill();

    // 3. Floating date and duration badge bubble
    const label = `До: ${DateUtils.formatRU(guide.date)} (${guide.days} дн.)`;
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    const textW = ctx.measureText(label).width;
    const badgeW = textW + 16;
    const badgeH = 24;
    const badgeX = Math.max(10, Math.min(this.canvas.width - badgeW - 10, x - badgeW / 2));
    const badgeY = headerH + 12;

    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    this.roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fef08a';
    ctx.fillText(label, badgeX + 8, badgeY + 16);
  }

  renderTimelineHeader() {
    const ctx = this.ctx;
    const h = this.options.headerHeight;
    const w = this.canvas.width;
    const scale = this.options.scale || 'day';
    const theme = this.getThemeColors();

    ctx.fillStyle = theme.headerBg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = theme.headerBorder;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const startX = this.scrollX;
    const endX = startX + w;
    const startDay = Math.max(0, Math.floor(startX / this.options.dayWidth));
    const endDay = Math.ceil(endX / this.options.dayWidth);

    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = theme.headerTextSub;

    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const monthShortNames = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

    let currentMajor = null;
    let majorStartX = 0;
    let majorLabel = '';

    // Flush last major segment if any
    for (let i = startDay; i <= endDay + 1; i++) {
      const curDate = DateUtils.addCalendarDays(this.minDate, i);
      const [y, m, d] = curDate.split('-').map(Number);
      const x = i * this.options.dayWidth - this.scrollX;

      let majorKey = '';
      let mLabel = '';

      if (scale === 'year' || this.options.dayWidth < 7) {
        majorKey = `${y}`;
        mLabel = `${y} год`;
      } else {
        majorKey = `${y}-${m}`;
        mLabel = `${monthNames[m - 1]} ${y}`;
      }

      if (majorKey !== currentMajor) {
        if (currentMajor !== null) {
          const blockW = x - majorStartX;
          if (blockW > 40) {
            ctx.fillStyle = theme.headerText;
            ctx.fillText(majorLabel, Math.max(10, majorStartX + 8), h / 2 - 7);
          }
        }
        currentMajor = majorKey;
        majorStartX = x;
        majorLabel = mLabel;

        ctx.strokeStyle = theme.majorBorder;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h / 2);
        ctx.stroke();
      }

      // Нижняя шкала: адаптивный шаг в зависимости от реальной ширины дня (dayWidth)
      const dw = this.options.dayWidth;
      if (dw >= 20) {
        // Достаточно места для отображения каждого дня
        const dt = new Date(y, m - 1, d);
        const dayOfWeek = dt.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        ctx.fillStyle = isWeekend ? '#ef4444' : theme.headerText;
        ctx.fillText(String(d), x + Math.max(2, (dw - 10) / 2), h - 8);

        ctx.strokeStyle = theme.headerBorder;
        ctx.beginPath();
        ctx.moveTo(x, h / 2);
        ctx.lineTo(x, h);
        ctx.stroke();
      } else if (dw >= 8) {
        // Недельный шаг: отображаем только каждый понедельник
        const dt = new Date(y, m - 1, d);
        if (dt.getDay() === 1) {
          ctx.fillStyle = '#60a5fa';
          ctx.fillText(String(d), x + 2, h - 8);

          ctx.strokeStyle = theme.headerBorder;
          ctx.beginPath();
          ctx.moveTo(x, h / 2);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      } else if (dw >= 2.5) {
        // Месячный шаг: отображаем 1-е число каждого месяца
        if (d === 1) {
          ctx.fillStyle = theme.headerText;
          ctx.fillText(monthShortNames[m - 1], x + 3, h - 8);

          ctx.strokeStyle = theme.majorBorder;
          ctx.beginPath();
          ctx.moveTo(x, h / 2);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      } else {
        // Очень мелкий масштаб (годовой / квартальный)
        if (d === 1 && (m === 1 || m === 4 || m === 7 || m === 10)) {
          const qNum = Math.ceil(m / 3);
          ctx.fillStyle = '#60a5fa';
          ctx.fillText(`Q${qNum}`, x + 2, h - 8);

          ctx.strokeStyle = theme.majorBorder;
          ctx.beginPath();
          ctx.moveTo(x, h / 2);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
    }

    // Отрисовываем последний незакрытый блок верхнего уровня
    if (currentMajor !== null) {
      const endXVisible = (endDay + 1) * this.options.dayWidth - this.scrollX;
      if (endXVisible - majorStartX > 40) {
        ctx.fillStyle = theme.headerText;
        ctx.fillText(majorLabel, Math.max(10, majorStartX + 8), h / 2 - 7);
      }
    }
  }

  renderGrid() {
    const ctx = this.ctx;
    const h = this.canvas.height;
    const w = this.canvas.width;
    const scale = this.options.scale || 'day';
    const theme = this.getThemeColors();
    const startX = this.scrollX;
    const endX = startX + w;
    const startDay = Math.max(0, Math.floor(startX / this.options.dayWidth));
    const endDay = Math.ceil(endX / this.options.dayWidth);

    for (let i = startDay; i <= endDay; i++) {
      const curDate = DateUtils.addCalendarDays(this.minDate, i);
      const [y, m, d] = curDate.split('-').map(Number);
      const x = i * this.options.dayWidth - this.scrollX;

      let drawLine = false;
      let isMajor = false;

      const dw = this.options.dayWidth;
      if (dw >= 20) {
        drawLine = true;
        const isWork = DateUtils.isWorkingDay(curDate, this.calendar);
        if (!isWork) {
          ctx.fillStyle = theme.weekendBg;
          ctx.fillRect(x, this.options.headerHeight, this.options.dayWidth, h - this.options.headerHeight);
        }
      } else if (dw >= 8) {
        const dt = new Date(y, m - 1, d);
        if (dt.getDay() === 1) drawLine = true;
      } else if (dw >= 2.5) {
        if (d === 1) { drawLine = true; isMajor = true; }
        else if (d === 15) drawLine = true;
      } else {
        if (d === 1) {
          drawLine = true;
          if (m === 1) isMajor = true;
        }
      }

      if (drawLine) {
        ctx.strokeStyle = isMajor ? theme.gridLineMajor : theme.gridLine;
        ctx.beginPath();
        ctx.moveTo(x, this.options.headerHeight);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
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

      // Baseline bar (Section 11, D-08, grey line under task)
      if (this.currentProject?.baseline?.dates?.[t.id]) {
        const base = this.currentProject.baseline.dates[t.id];
        if (base.start && base.finish) {
          const bsX = this.dateToX(base.start) - this.scrollX;
          const bfX = this.dateToX(base.finish) + (this.options.scale === 'day' ? this.options.dayWidth : 0) - this.scrollX;
          const bw = Math.max(3, bfX - bsX);
          ctx.fillStyle = '#64748b';
          ctx.fillRect(bsX, y + rHeight - 6, bw, 3);
        }
      }

      const isCritical = this.options.showCriticalPath && t.is_critical;
      const customStyle = t.custom_style || (t.is_milestone ? 'milestone' : (t.is_summary ? 'bracket' : 'solid'));
      const customColor = t.custom_color || '';

      // Palette definition
      const colorPalettes = {
        blue: { start: '#3b82f6', end: '#1d4ed8', prog: '#1e3a8a', bracket: '#60a5fa' },
        cyan: { start: '#06b6d4', end: '#0891b2', prog: '#164e63', bracket: '#38bdf8' },
        red: { start: '#ef4444', end: '#b91c1c', prog: '#7f1d1d', bracket: '#f87171' },
        emerald: { start: '#10b981', end: '#047857', prog: '#064e3b', bracket: '#34d399' },
        amber: { start: '#f59e0b', end: '#b45309', prog: '#78350f', bracket: '#fbbf24' },
        purple: { start: '#a855f7', end: '#7e22ce', prog: '#581c87', bracket: '#c084fc' }
      };

      const pal = colorPalettes[customColor] || (isCritical 
        ? { start: '#f43f5e', end: '#e11d48', prog: '#9f1239', bracket: '#fb7185' }
        : { start: '#6366f1', end: '#4f46e5', prog: '#3730a3', bracket: '#38bdf8' });

      if (customStyle === 'milestone' || t.is_milestone) {
        // Milestone diamond (FR-8.02)
        const mx = startX;
        const my = y + rHeight / 2;
        const size = 9;

        ctx.fillStyle = pal.start;
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
      } else if (customStyle === 'bracket' || t.is_summary) {
        // Bracket / Phase bar (полоска с концами)
        ctx.fillStyle = pal.bracket;
        ctx.fillRect(startX, barY + 3, barW, 6);

        // Downward brackets on left and right ends
        ctx.beginPath();
        ctx.moveTo(startX, barY + 3);
        ctx.lineTo(startX, barY + 16);
        ctx.lineTo(startX + 8, barY + 8);
        ctx.moveTo(finishX, barY + 3);
        ctx.lineTo(finishX, barY + 16);
        ctx.lineTo(finishX - 8, barY + 8);
        ctx.fill();

        // Label with dark background pill
        const labelText = `${t.name} (${t.duration_days}д)`;
        ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
        const tw = ctx.measureText(labelText).width;
        const tx = finishX + 10;
        const ty = barY + 1;

        ctx.fillStyle = 'rgba(11, 15, 25, 0.85)';
        this.roundRect(ctx, tx - 4, ty, tw + 8, 17, 3);
        ctx.fill();
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(labelText, tx, ty + 12);

        // Visual Resize Grip for custom bracket (if not summary group)
        if (!t.is_summary) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.fillRect(finishX - 4, barY + 2, 3, 14);
        }
      } else {
        // Standard task bar or rounded pill
        const radius = customStyle === 'rounded' ? 10 : 5;
        const grad = ctx.createLinearGradient(startX, barY, startX, barY + barH);
        grad.addColorStop(0, pal.start);
        grad.addColorStop(1, pal.end);
        ctx.fillStyle = grad;

        this.roundRect(ctx, startX, barY, barW, barH, radius);
        ctx.fill();

        // Progress bar (FR-4.9.07)
        if (this.options.showProgress && t.percent_complete > 0) {
          const progW = barW * (t.percent_complete / 100);
          ctx.fillStyle = pal.prog;
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

        // 1. Visual Resize Handle Grip on right edge of bar (Stretch duration)
        if (!t.is_summary) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
          const hX = finishX - 4;
          ctx.fillRect(hX, barY + 3, 3, barH - 6);

          // 2. Draw.io style Link Arrow Button (shows on hover or when dragging link)
          const isHovered = this.hoveredTaskId === t.id;
          const showLinkHandle = isHovered || (this.dragLink && this.dragLink.active);

          if (showLinkHandle) {
            const arrowX = finishX + 16;
            const arrowY = barY + barH / 2;

            // Small connecting dotted stem from bar to arrow handle
            ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(finishX, arrowY);
            ctx.lineTo(arrowX - 8, arrowY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw.io style circular badge with right arrow
            ctx.fillStyle = '#6366f1';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(arrowX, arrowY, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Right arrow icon inside badge
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(arrowX - 2, arrowY - 4);
            ctx.lineTo(arrowX + 3, arrowY);
            ctx.lineTo(arrowX - 2, arrowY + 4);
            ctx.closePath();
            ctx.fill();
          }

          // Target Inport on the left (visible when drag-linking)
          if (this.dragLink && this.dragLink.active && this.dragLink.fromTaskId !== t.id) {
            ctx.fillStyle = '#10b981';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(startX - 6, barY + barH / 2, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
    });

    // Render Drag-to-Link live connecting line (curved Bezier like draw.io)
    if (this.dragLink && this.dragLink.active) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(this.dragLink.fromX, this.dragLink.fromY);
      const c1X = this.dragLink.fromX + 40;
      const c1Y = this.dragLink.fromY;
      const c2X = this.dragLink.curX - 40;
      const c2Y = this.dragLink.curY;
      ctx.bezierCurveTo(c1X, c1Y, c2X, c2Y, this.dragLink.curX, this.dragLink.curY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;

      // Draw glowing target arrow head
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

      const isMilestone = !!succ.is_milestone || succ.duration_days === 0;
      const targetX = isMilestone ? succStartX - 9 : succStartX;
      const targetY = succY;

      // Render with smooth corners
      const points = [];
      points.push({ x: predEndX, y: predY });

      const minXGap = 14;

      if (targetX >= predEndX + minXGap) {
        // Прямой ход по времени: выходим вправо до середины промежутка, спускаемся/поднимаемся строго к целевой строке
        const midX = Math.round(predEndX + (targetX - predEndX) / 2);
        points.push({ x: midX, y: predY });
        points.push({ x: midX, y: targetY });
        points.push({ x: targetX, y: targetY });
      } else {
        // Обратный ход или сильное перекрытие по времени: огибаем в межстрочном коридоре
        const exitX = predEndX + 12;
        const entryX = targetX - 12;
        points.push({ x: exitX, y: predY });

        if (succY > predY) {
          // Идет ВНИЗ: промежуточный коридор строго НИЖЕ predY
          const corridorY = Math.min(predY + rHeight / 2, (predY + succY) / 2);
          points.push({ x: exitX, y: corridorY });
          points.push({ x: entryX, y: corridorY });
          points.push({ x: entryX, y: targetY });
          points.push({ x: targetX, y: targetY });
        } else if (succY < predY) {
          // Идет ВВЕРХ: коридор строго ВЫШЕ predY
          const corridorY = Math.max(predY - rHeight / 2, (predY + succY) / 2);
          points.push({ x: exitX, y: corridorY });
          points.push({ x: entryX, y: corridorY });
          points.push({ x: entryX, y: targetY });
          points.push({ x: targetX, y: targetY });
        } else {
          // На одной строке
          const corridorY = predY + rHeight / 2;
          points.push({ x: exitX, y: corridorY });
          points.push({ x: entryX, y: corridorY });
          points.push({ x: entryX, y: targetY });
          points.push({ x: targetX, y: targetY });
        }
      }

      this.drawRoundedPolyline(ctx, points, 4);
      ctx.stroke();

      // Единая горизонтальная стрелка-наконечник, указывающая вправо на цель
      ctx.beginPath();
      ctx.moveTo(targetX, targetY);
      ctx.lineTo(targetX - 6, targetY - 4);
      ctx.lineTo(targetX - 6, targetY + 4);
      ctx.closePath();
      ctx.fill();
    });
  }

  drawRoundedPolyline(ctx, pts, radius = 4) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      ctx.arcTo(p1.x, p1.y, p2.x, p2.y, radius);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
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

      // 1. Draw.io style Link Arrow Button is at (finishX + 16, barY + barH / 2)
      const arrowCenterX = finishX + 16;
      const arrowCenterY = barY + barH / 2;
      const distToArrow = Math.hypot(mouseX - arrowCenterX, mouseY - arrowCenterY);
      const isArrowButton = distToArrow <= 12;

      // 2. Right edge resize handle (within bar's right border: finishX - 8 to finishX + 3)
      const isNearRightEdge = !isArrowButton && (mouseX >= finishX - 8 && mouseX <= finishX + 4);

      // 3. Target Inport on the left (startX - 6, barY + barH / 2)
      const distToInPort = Math.hypot(mouseX - (startX - 6), mouseY - (barY + barH / 2));
      const isInPort = distToInPort <= 12;

      const isInsideBar = mouseX >= barStartX && mouseX <= finishX;

      return {
        task,
        rowIndex,
        isHandle: isNearRightEdge,
        isArrowButton,
        isInPort,
        arrowX: arrowCenterX,
        arrowY: arrowCenterY,
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
      const prevHovered = this.hoveredTaskId;
      this.hoveredTaskId = hit && hit.task ? hit.task.id : null;
      if (prevHovered !== this.hoveredTaskId) {
        this.render();
      }

      if (hit && hit.isArrowButton) {
        this.canvas.style.cursor = 'crosshair';
      } else if (hit && hit.isHandle) {
        this.canvas.style.cursor = 'ew-resize';
      } else if (hit && hit.isInside) {
        this.canvas.style.cursor = 'pointer';
      } else {
        this.canvas.style.cursor = 'default';
      }

      // Trigger rich hover card callback
      if (this.onTaskHover) {
        this.onTaskHover(hit && hit.isInside ? hit.task : null, hit ? hit.mouseX : 0, hit ? hit.mouseY : 0);
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredTaskId = null;
      this.render();
      if (this.onTaskHover) this.onTaskHover(null, 0, 0);
    });

    this.canvas.addEventListener('mousedown', (e) => {
      const hit = getTaskAtPos(e.clientX, e.clientY);

      // Start Drag-to-Link from Draw.io Arrow Button
      if (hit && hit.isArrowButton) {
        this.dragLink = {
          active: true,
          fromTaskId: hit.task.id,
          fromX: hit.arrowX,
          fromY: hit.arrowY,
          curX: hit.arrowX,
          curY: hit.arrowY
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
        }

        // Calculate projected finish date based on start_date and newDuration
        const projectedFinish = DateUtils.addWorkingDays(resizingTask.start_date, newDuration, this.calendar);
        const finishX = this.dateToX(projectedFinish) + (this.options.scale === 'day' ? this.options.dayWidth : 0) - this.scrollX;

        this.activeResizeGuide = {
          x: finishX,
          date: projectedFinish,
          days: newDuration
        };

        this.render();
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
        this.activeResizeGuide = null;
        this.canvas.style.cursor = 'default';
        this.render();
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

  jumpToToday() {
    const todayISO = DateUtils.formatISO(new Date());
    const x = this.dateToX(todayISO);
    this.scrollX = Math.max(0, x - this.canvas.width / 2);
    this.render();
  }

  fitToScreen() {
    if (!this.tasks || this.tasks.length === 0) return;
    const allStarts = this.tasks.map(t => t.start_date).filter(Boolean);
    const allFinishes = this.tasks.map(t => t.finish_date).filter(Boolean);
    if (!allStarts.length || !allFinishes.length) return;

    allStarts.sort();
    allFinishes.sort();

    const minDate = allStarts[0];
    const maxDate = allFinishes[allFinishes.length - 1];

    const totalDays = Math.max(1, DateUtils.diffDays(minDate, maxDate) + 5);
    const availableWidth = Math.max(400, this.canvas.width - 80);

    const fitDayWidth = Math.max(2, Math.min(60, availableWidth / totalDays));
    this.options.dayWidth = fitDayWidth;

    this.minDate = DateUtils.addCalendarDays(minDate, -2);
    this.scrollX = 0;
    this.render();
  }

  // Export Gantt chart to PNG data URL (FR-9.12)
  exportToPNG() {
    return this.canvas.toDataURL('image/png');
  }
}
